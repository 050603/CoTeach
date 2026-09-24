import type { Prisma } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { contentGenerationJobs, qualityReviewJobs } from "@/lib/course-generation/job-storage";
import { getCourse, updateCourse } from "@/lib/session/server-store";
import { readClassroom } from "@/lib/openmaic/server/classroom-storage";
import type { SceneOutline } from "@/lib/openmaic/types/generation";
import type { AICallFn } from "@/lib/openmaic/generation/pipeline-types";
import { callLLM } from "@/lib/llm/client";
import { runWithCourseGenerationLlmContext } from "@/lib/course-generation/llm-concurrency";
import { createCourseGenerationAiCall } from "@/lib/openmaic/server/course-generation-ai-call";
import { resolveModel } from "@/lib/openmaic/server/resolve-model";
import { findServerDefaultModelString } from "@/lib/openmaic/server/provider-config";
import { computeCourseQualitySignature } from "./signature";
import { collectCourseStructureIssues, courseReviewSections, reviewCourseSection } from "./semantic-review";
import { getCourseQualityReviewSettings } from "./settings";
import { COURSE_QUALITY_REVIEW_POLICY_VERSION, type CourseQualityReport } from "./types";
import { REVIEW_SOURCE_LIMIT } from "./source-selection";

type ReviewRequest = {
  courseId: string;
  classroomId: string;
  signature: string;
  sourceContext: string;
  reviewModelString?: string;
  reviewPolicyVersion?: string;
  runId?: string;
  reviewScopeKind?: "full-course" | "test-lesson";
  checkedSectionId?: string;
};
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
let started = false;
let stopping = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const controllers = new Map<string, AbortController>();
const STALE_MS = 120000;

type ReviewSection = NonNullable<CourseQualityReport["sections"]>[number];
const sectionId = (sceneIds: string[]) => createHash("sha256").update(JSON.stringify(sceneIds)).digest("hex").slice(0, 20);

export function initializeReviewSections(groups: Array<Array<{ id: string }>>, previous?: CourseQualityReport): ReviewSection[] {
  return groups.map((scenes) => {
    const sceneIds = scenes.map((scene) => scene.id);
    const id = sectionId(sceneIds);
    const saved = previous?.sections?.find((section) => section.id === id && section.status === "completed");
    return saved ? { ...saved } : { id, sceneIds, status: "pending", issues: [] };
  });
}

export function mergeReviewIssues(base: CourseQualityReport["issues"], sections: ReviewSection[]): CourseQualityReport["issues"] {
  return [...new Map([...base, ...sections.flatMap((section) => section.issues)].map((issue) => [issue.id, issue])).values()];
}

function sourceCoverageIssue(source: string): CourseQualityReport["issues"] {
  return source.length > REVIEW_SOURCE_LIMIT ? [{ id: "source-partial-coverage", origin: "semantic", severity: "suggestion", title: "长资料采用分节相关片段核查",
    evidence: `资料共 ${source.length} 字，每节最多选取 ${REVIEW_SOURCE_LIMIT} 字，优先保留教师确认内容与本节相关原文；没有把未选中的资料视为已检查。`,
    suggestion: "教师终审时结合完整知识文档和教案，补充核对未覆盖段落中的条件与依据。" }] : [];
}

export async function readCourseQualityReview(courseId: string): Promise<CourseQualityReport | null> {
  const job = await qualityReviewJobs.findUnique({ where: { courseId } });
  const request = job?.request as unknown as ReviewRequest | undefined;
  const report = job?.result ? job.result as unknown as CourseQualityReport : null;
  return report?.reviewPolicyVersion === COURSE_QUALITY_REVIEW_POLICY_VERSION
    && request?.reviewPolicyVersion === COURSE_QUALITY_REVIEW_POLICY_VERSION
    && report.runId && report.runId === request.runId && report.signature === request.signature
    ? report : null;
}

export async function enqueueCourseQualityReview(courseId: string, options: { mode?: "check" | "retry" } = {}): Promise<CourseQualityReport | null> {
  const course = await getCourse(courseId);
  const classroomId = course?.aiLearningClassroomId || course?.content._openmaicClassroomId;
  if (!course || !classroomId || (!course.content.qualityReviewRequired && course.content.resourcePackage?.schemaVersion !== 2 && course.content.stagePlan?.schemaVersion !== 2)) return null;
  const classroom = await readClassroom(classroomId);
  if (!classroom) return null;
  const signature = computeCourseQualitySignature(course, classroom);
  const [generation, reviewSettings] = await Promise.all([
    contentGenerationJobs.findUnique({ where: { courseId } }),
    getCourseQualityReviewSettings(),
  ]);
  const generationRequest = generation?.request as {
    generationModelString?: string;
    teachingSourceContext?: string;
  } | undefined;
  // An independent reviewer is opt-in. Without one, review follows the exact
  // model locked onto this course-generation job instead of resolving a new
  // model based on visual capability or a stage route.
  const reviewModelString = reviewSettings.modelString
    ?? generationRequest?.generationModelString
    ?? findServerDefaultModelString();
  const sourceContext = generationRequest?.teachingSourceContext
    ?? JSON.stringify({ teacherConfirmed: course.content.resourcePackage?.draft, knowledgePoints: course.content.knowledgePoints });
  const generationRun = course.content.classroomGenerationRun;
  const reviewScopeKind = generationRun?.scope === "test-lesson" ? "test-lesson" : "full-course";
  const checkedOutlineIds = reviewScopeKind === "test-lesson"
    ? generationRun?.testLesson?.sceneOutlineIds ?? generationRun?.generatedOutlineIds ?? [] : [];
  const existing = await qualityReviewJobs.findUnique({ where: { courseId } });
  const existingRequest = existing?.request as unknown as ReviewRequest | undefined;
  const existingReport = existing?.result as unknown as CourseQualityReport | undefined;
  const sameInput = existingRequest?.signature === signature
    && existingRequest.reviewModelString === reviewModelString
    && existingRequest.sourceContext === sourceContext
    && existingRequest.reviewPolicyVersion === COURSE_QUALITY_REVIEW_POLICY_VERSION
    && existingRequest.reviewScopeKind === reviewScopeKind
    && existingRequest.checkedSectionId === generationRun?.testLesson?.sectionId
    && JSON.stringify(existingReport?.reviewScope?.checkedOutlineIds ?? []) === JSON.stringify(checkedOutlineIds);
  const savedReport = sameInput ? existing?.result as unknown as CourseQualityReport | undefined : undefined;
  const previous = savedReport?.reviewPolicyVersion === COURSE_QUALITY_REVIEW_POLICY_VERSION && savedReport.runId === existingRequest?.runId
    ? savedReport
    : undefined;
  if (previous && options.mode === undefined) {
    if (JSON.stringify(course.content.qualityReview) !== JSON.stringify(previous)) {
      await updateCourse(courseId, (current) => computeCourseQualitySignature(current, classroom) !== signature ? current : ({
        ...current, content: { ...current.content, qualityReviewRequired: true, qualityReview: previous },
      }));
    }
    if (existing?.status === "queued") void runCourseQualityReviewJob(existing.id).catch(() => undefined);
    return previous;
  }
  if (existing) controllers.get(existing.id)?.abort();
  const sections = initializeReviewSections(courseReviewSections(course, classroom.scenes), options.mode === "retry" ? previous : undefined);
  const reviewScope: NonNullable<CourseQualityReport["reviewScope"]> = generationRun?.scope === "test-lesson"
    ? { kind: "test-lesson", checkedOutlineIds, uncheckedOutlineCount: Math.max(0, generationRun.fullOutlineCount - checkedOutlineIds.length),
      checkedSectionId: generationRun.testLesson?.sectionId, checkedSectionTitle: generationRun.testLesson?.sectionTitle,
      ...(course.content.teachingBlueprint?.sections?.length ? { unreviewedSectionCount: Math.max(0, course.content.teachingBlueprint.sections.length - 1) } : {}) }
    : { kind: "full-course", checkedOutlineIds: [], uncheckedOutlineCount: 0 };
  const runId = randomUUID();
  const report: CourseQualityReport = { schemaVersion: 1, reviewPolicyVersion: COURSE_QUALITY_REVIEW_POLICY_VERSION,
    runId, reviewScope, signature, courseId, classroomId, classroomRevision: classroom.revision ?? 1, status: "pending",
    ...(reviewModelString ? { reviewModelString } : {}),
    sections, sourceCoverage: { totalChars: sourceContext.length, perSectionLimit: REVIEW_SOURCE_LIMIT, partial: sourceContext.length > REVIEW_SOURCE_LIMIT },
    issues: mergeReviewIssues([...collectCourseStructureIssues(course, classroom.scenes), ...sourceCoverageIssue(sourceContext)], sections) };
  const data = { courseId, status: "queued", request: json({ courseId, classroomId, signature, sourceContext, reviewPolicyVersion: COURSE_QUALITY_REVIEW_POLICY_VERSION, runId, reviewScopeKind,
    ...(generationRun?.testLesson?.sectionId ? { checkedSectionId: generationRun.testLesson.sectionId } : {}), ...(reviewModelString ? { reviewModelString } : {}) }), result: json(report), qualityReport: json(report), error: null,
    step: "queued", message: "课堂草稿已生成，正在后台核对讲授、练习与知识依据", progress: Math.round(sections.filter((section) => section.status === "completed").length / Math.max(1, sections.length) * 100), completedAt: null, startedAt: null, version: { increment: 1 } };
  const job = await qualityReviewJobs.upsert({ where: { courseId }, create: data, update: data });
  await updateCourse(courseId, (current) => computeCourseQualitySignature(current, classroom) !== signature ? current : ({ ...current, content: { ...current.content, qualityReviewRequired: true, qualityReview: report } }));
  void runCourseQualityReviewJob(job.id).catch(() => undefined);
  return report;
}

export async function runCourseQualityReviewJob(jobId: string): Promise<void> {
  const claim = await qualityReviewJobs.updateMany({ where: { id: jobId, status: "queued" }, data: { status: "running", startedAt: new Date(), lastHeartbeatAt: new Date(), attempt: { increment: 1 } } });
  if (!claim.count) return;
  const job = await qualityReviewJobs.findUnique({ where: { id: jobId } });
  if (!job) return;
  const request = job.request as unknown as ReviewRequest;
  const controller = new AbortController();
  controllers.set(jobId, controller);
  const owner = { id: jobId, version: job.version, status: "running" };
  const heartbeat = setInterval(() => { void qualityReviewJobs.updateMany({ where: owner, data: { lastHeartbeatAt: new Date() } }).catch(() => undefined); }, 10000);
  heartbeat.unref?.();
  const storedReport = job.result as unknown as CourseQualityReport;
  if (request.reviewPolicyVersion !== COURSE_QUALITY_REVIEW_POLICY_VERSION
    || !request.runId || !storedReport || storedReport.runId !== request.runId) {
    clearInterval(heartbeat);
    if (controllers.get(jobId) === controller) controllers.delete(jobId);
    await qualityReviewJobs.updateMany({ where: owner, data: { status: "cancelled", message: "审核规则已更新，请重新运行内容检查" } });
    return;
  }
  const reusableStoredSections = storedReport.reviewPolicyVersion === COURSE_QUALITY_REVIEW_POLICY_VERSION;
  let report = { ...storedReport, reviewPolicyVersion: COURSE_QUALITY_REVIEW_POLICY_VERSION, status: "running" as CourseQualityReport["status"] };
  const persist = async (next: CourseQualityReport, status: string) => {
    const currentJob = await qualityReviewJobs.findUnique({ where: { id: jobId } });
    const currentRequest = currentJob?.request as unknown as ReviewRequest | undefined;
    if (currentRequest?.runId !== request.runId
      || currentRequest?.reviewPolicyVersion !== request.reviewPolicyVersion
      || currentRequest?.signature !== request.signature
      || currentRequest.reviewModelString !== request.reviewModelString) return;
    const completed = next.sections?.filter((section) => section.status === "completed").length ?? 0;
    const total = next.sections?.length ?? 1;
    const changed = await qualityReviewJobs.updateMany({ where: owner, data: { status, progress: next.status === "completed" ? 100 : Math.round(completed / Math.max(1, total) * 100), result: json(next), qualityReport: json(next),
      message: next.status === "completed" ? "后台核查完成，请教师结合问题报告终审" : next.status === "failed" ? "部分内容尚未核查，请教师复核或重试检查" : "正在按知识小节核对课堂内容",
      completedAt: next.status === "running" ? null : new Date(), lastHeartbeatAt: new Date(), error: next.error ?? null } });
    if (!changed.count) return;
    await updateCourse(request.courseId, (current) => current.content.qualityReview?.runId !== request.runId || current.content.qualityReview?.signature !== request.signature ? current : {
      ...current, content: { ...current.content, qualityReview: next },
    });
  };
  try {
    const course = await getCourse(request.courseId);
    const classroom = await readClassroom(request.classroomId);
    if (!course || !classroom || computeCourseQualitySignature(course, classroom) !== request.signature) {
      await qualityReviewJobs.updateMany({ where: owner, data: { status: "cancelled", message: "课堂内容已变更，旧核查结果不会覆盖新草稿" } });
      return;
    }
    const groups = courseReviewSections(course, classroom.scenes);
    const sections = initializeReviewSections(groups, reusableStoredSections ? report : undefined);
    const baseIssues = [...collectCourseStructureIssues(course, classroom.scenes), ...sourceCoverageIssue(request.sourceContext)];
    report = { ...report, sections, error: undefined, checkedAt: undefined, issues: mergeReviewIssues(baseIssues, sections) };
    await persist(report, "running");
    const pendingIndexes = sections.flatMap((section, index) => section.status === "completed" ? [] : [index]);
    let reviewAiCall: AICallFn;
    if (request.reviewModelString) {
      const resolved = await resolveModel({ modelString: request.reviewModelString });
      const selectedCall = createCourseGenerationAiCall({
        model: resolved.model,
        vision: resolved.modelInfo?.capabilities?.vision === true,
        source: "course-quality-review",
        signal: controller.signal,
        maxOutputTokens: resolved.modelInfo?.outputWindow,
        thinking: resolved.thinkingConfig,
        timeoutMs: 180_000,
      });
      reviewAiCall = (system, user, images) => runWithCourseGenerationLlmContext(
        () => selectedCall(system, user, images),
      );
    } else {
      // Legacy jobs created before generation-model locking keep the prior
      // default-model behavior. New jobs always carry the generation model.
      reviewAiCall = (system, user) => runWithCourseGenerationLlmContext(() => callLLM(
        [{ role: "system", content: system }, { role: "user", content: user }],
        { jsonMode: true, abortSignal: controller.signal, requestClass: "long-generation", maxTransientRetries: 1 },
      ));
    }
    // Two independent section calls at a time, one semantic pass, no visual-LLM retry loop.
    for (let index = 0; index < pendingIndexes.length; index += 2) {
      controller.signal.throwIfAborted();
      const batch = pendingIndexes.slice(index, index + 2);
      const result = await Promise.allSettled(batch.map((sectionIndex) => reviewCourseSection({ course, scenes: groups[sectionIndex],
        outlines: (course.content._openmaicSceneOutlines ?? []) as SceneOutline[], sourceContext: request.sourceContext, includeKnowledgeGraph: true },
      reviewAiCall)));
      for (const [offset, item] of result.entries()) {
        const sectionIndex = batch[offset];
        sections[sectionIndex] = { ...sections[sectionIndex], checkedAt: new Date().toISOString(),
          ...(item.status === "fulfilled" ? { status: "completed", issues: item.value, error: undefined } : { status: "failed", issues: [], error: `小节 ${sectionIndex + 1} 尚未完成内容核对` }) };
      }
      report = { ...report, sections, issues: mergeReviewIssues(baseIssues, sections) };
      await persist(report, "running");
    }
    controller.signal.throwIfAborted();
    const failures = sections.filter((section) => section.status !== "completed").map((section) => section.error ?? "小节核查尚未完成");
    report = { ...report, status: failures.length ? "failed" : "completed", checkedAt: new Date().toISOString(), ...(failures.length ? { error: failures.join("；") } : {}) };
    await persist(report, failures.length ? "failed" : "completed");
  } catch {
    if (controller.signal.aborted) {
      await qualityReviewJobs.updateMany({ where: owner, data: { status: "queued", message: "服务恢复后继续核对课堂内容" } });
    } else {
      await persist({ ...report, status: "failed", error: "后台内容核对暂不可用，请教师复核或重试检查" }, "failed");
    }
  } finally { clearInterval(heartbeat); if (controllers.get(jobId) === controller) controllers.delete(jobId); }
}

async function tick(): Promise<void> {
  if (stopping) return;
  try {
    await qualityReviewJobs.updateMany({ where: { status: "running", OR: [{ lastHeartbeatAt: null }, { lastHeartbeatAt: { lt: new Date(Date.now() - STALE_MS) } }] }, data: { status: "queued", version: { increment: 1 } } });
    const next = await qualityReviewJobs.findFirst({ where: { status: "queued" }, orderBy: { createdAt: "asc" } });
    if (next) await runCourseQualityReviewJob(next.id);
  } catch { /* A temporarily unavailable database will be retried. */ }
  finally { if (!stopping) { timer = setTimeout(() => void tick(), 2000); timer.unref?.(); } }
}
export async function startCourseQualityReviewWorker(): Promise<void> {
  if (started) return;
  started = true; stopping = false; void tick();
}
export async function stopCourseQualityReviewWorker(): Promise<void> {
  started = false; stopping = true;
  if (timer) clearTimeout(timer);
  for (const controller of controllers.values()) controller.abort();
  if (controllers.size) await qualityReviewJobs.updateMany({ where: { id: { in: [...controllers.keys()] }, status: "running" }, data: { status: "queued", version: { increment: 1 }, message: "服务恢复后继续核对已保存的小节" } });
}
