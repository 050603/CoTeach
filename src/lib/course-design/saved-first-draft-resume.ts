import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getCourse } from "@/lib/session/server-store";
import type { Course, TeachingBlueprint } from "@/lib/session/types";
import { designGenerationJobs, resourcePackageJobs, type CourseDesignGenerationJob } from "@/lib/course-generation/job-storage";
import { loadGenerationCheckpoints, saveGenerationCheckpoint } from "@/lib/course-generation/checkpoint-storage";
import { fingerprintGenerationValue } from "@/lib/course-generation/page-checkpoints";
import { isNewSystemAiTimingPlan } from "@/lib/classroom/new-system-course";
import { resolveModel } from "@/lib/openmaic/server/resolve-model";
import { findServerDefaultModelString } from "@/lib/openmaic/server/provider-config";
import { ZH_CN_COURSE_LANGUAGE_DIRECTIVE } from "@/lib/openmaic/generation/course-language";
import { prepareTeachingPageCapacity, TeachingPagePreflightError } from "@/lib/openmaic/generation/teaching-page-preflight";
import { assertRequiredTextbookFiguresAvailable,
  bindRequiredTextbookFiguresToBlueprint, bindRequiredTextbookFiguresToOutlines } from "@/lib/textbook/course-visual-binding";
import { generateTeachingBlueprint, legacyTeachingBlueprintInputFingerprint, revalidateStoredTeachingBlueprint,
  teachingBlueprintContentFingerprint, teachingBlueprintInputFingerprint, teachingBlueprintToOutlines,
  validateTeachingBlueprintBudget, type TeachingBlueprintInput } from "./teaching-blueprint";
import { canResumeCourseDesignWithPackageState } from "./resume-policy";
import type { QuickDesignRequest } from "./job-runner";

export type SavedCourseDesignReplayGuard = {
  contentFingerprint: string;
  modelFingerprint: string;
  authoringRequestId?: string;
};
type ReplayRequest = QuickDesignRequest & { savedFirstDraftReplay?: SavedCourseDesignReplayGuard };

export class SavedCourseDesignFirstDraftResumeError extends Error {
  readonly isRetryable = false;
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
    this.name = "SavedCourseDesignFirstDraftResumeError";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function replayInputFingerprint(input: TeachingBlueprintInput): string {
  // Cases derived from this accepted draft are outputs of the same request,
  // not new authoring inputs. Its original full response identity stays intact.
  return teachingBlueprintContentFingerprint({ ...input, priorSourceExamples: undefined });
}

/** Only the exact accepted checkpoint may lock a resumed page plan. An older
 * course draft or a response awaiting validation is not a confirmed outline. */
export function hasAcceptedSavedCourseDesignOutline(course: Course, value: unknown): boolean {
  const checkpoint = record(value);
  return checkpoint?.schemaVersion === 1 && checkpoint.status === "validated"
    && Boolean(record(checkpoint.blueprint)) && Boolean(record(course.content.teachingBlueprint))
    && Array.isArray(course.content._openmaicSceneOutlines) && course.content._openmaicSceneOutlines.length > 0
    && fingerprintGenerationValue(checkpoint.blueprint) === fingerprintGenerationValue(course.content.teachingBlueprint);
}

function stopped(code: string, message: string, status = 409): never {
  throw new SavedCourseDesignFirstDraftResumeError(code, message, status);
}

function assertConfirmedSources(course: Course, request: ReplayRequest): void {
  if (course.id !== request.courseId || request.systemMode !== "new"
    || (request.generationContractVersion ?? 0) < 2 || request.sourceContractRepair) {
    stopped("SAVED_FIRST_DRAFT_NOT_SUPPORTED", "该任务不是可复用首稿的新版课程设计。");
  }
  const current = course.content.resourcePackage, saved = request.resourcePackage;
  if (saved ? !saved.confirmedAt || !current?.confirmedAt || current.id !== saved.id || current.revision !== saved.revision
    || fingerprintGenerationValue({ source: current.source, documents: current.documents, draft: current.draft })
      !== fingerprintGenerationValue({ source: saved.source, documents: saved.documents, draft: saved.draft }) : Boolean(current)) {
    stopped("SAVED_FIRST_DRAFT_SOURCE_CHANGED", "已确认资源包已经变化，保留原首稿，不应用旧课程设计。");
  }
  if (fingerprintGenerationValue(course.content.textbookSelections ?? [])
      !== fingerprintGenerationValue(request.textbookSelections ?? [])
    || course.content.courseEvidence?.fingerprint !== request.textbookEvidence?.fingerprint) {
    stopped("SAVED_FIRST_DRAFT_SOURCE_CHANGED", "教材版本或采用的证据已经变化，保留原首稿，不应用旧课程设计。");
  }
}

async function prepareReplayInput(course: Course, request: ReplayRequest) {
  assertConfirmedSources(course, request);
  const packageJob = await resourcePackageJobs.findUnique({ where: { courseId: course.id } });
  if (!canResumeCourseDesignWithPackageState(request, packageJob)) {
    stopped("SAVED_FIRST_DRAFT_SOURCE_CHANGED", "资源包正在导入或修改，不能恢复旧首稿。");
  }
  const timing = course.content.moduleTimingPlan;
  if (!course.content.knowledgePoints.length || !isNewSystemAiTimingPlan(timing, course.hours, course.content.stagePlan)) {
    stopped("SAVED_FIRST_DRAFT_PREREQUISITES_MISSING", "已验收的知识结构或固定时长不可用，不能自动重新创作。");
  }
  const aiDurationMin = timing.allocations.filter((allocation) => allocation.stageKey === "ai-learning")
    .reduce((sum, allocation) => sum + allocation.durationMin, 0);
  // The worker imports this module. Load its shared projections only when a
  // caller requests replay, after both module initializers have completed.
  const runner = await import("./job-runner");
  const resolved = await resolveModel({ modelString: request.generationModelString ?? findServerDefaultModelString(),
    stage: "scene-outlines-stream" });
  const modelFingerprint = runner.resolvedCourseDesignModelFingerprint(resolved);
  return { ...await runner.prepareTeachingBlueprintInput(course, course.content, request, aiDurationMin,
    modelFingerprint, course.content), modelFingerprint, runner };
}

/** Validate immediately before the worker's first course write. A replay
 * permission never permits replacing a concurrent teacher edit or authoring. */
export async function assertSavedCourseDesignReplayInput(course: Course, request: ReplayRequest): Promise<void> {
  const guard = request.savedFirstDraftReplay;
  if (!guard) return;
  if (guard.authoringRequestId !== request.authoringRequestId) {
    stopped("SAVED_FIRST_DRAFT_REQUEST_CHANGED", "首稿恢复请求身份已经变化，未应用已保存设计。");
  }
  const prepared = await prepareReplayInput(course, request);
  if (guard.modelFingerprint !== prepared.modelFingerprint
    || guard.contentFingerprint !== replayInputFingerprint(prepared.input)) {
    stopped("SAVED_FIRST_DRAFT_INPUT_CHANGED", "知识、时长、模型或教学来源已变化，未应用已保存设计。");
  }
}

const LIVE_STATUSES = ["queued", "running", "review_available", "paused"];

async function queueSavedCourseDesignReplay(job: CourseDesignGenerationJob, replayRequest: ReplayRequest) {
  try {
    return await designGenerationJobs.replace({ where: { id: job.id, status: "failed", version: job.version },
      checkpointPolicy: {}, data: { status: "queued", step: "lessonOutline",
        message: "正在复用已保存首稿继续课程设计", request: replayRequest as unknown as Prisma.InputJsonValue,
        error: null, completedAt: null, currentCall: null, retryAt: null,
        executionId: null, executionOwner: null, leaseExpiresAt: null, lastHeartbeatAt: new Date(),
        version: { increment: 1 } } });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "GENERATION_JOB_NOT_FOUND") throw error;
    const current = await designGenerationJobs.findUnique({ where: { courseId: job.courseId } });
    const currentRequest = current?.request as unknown as ReplayRequest | undefined;
    if (current?.id === job.id && currentRequest && currentRequest.authoringRequestId === replayRequest.authoringRequestId
      && fingerprintGenerationValue(currentRequest.savedFirstDraftReplay) === fingerprintGenerationValue(replayRequest.savedFirstDraftReplay)
      && [...LIVE_STATUSES, "completed"].includes(current.status)) return current;
    stopped("SAVED_FIRST_DRAFT_JOB_CONFLICT", "任务已被其他操作更新，未覆盖当前任务。");
  }
}

/** Recheck an existing complete blueprint without buying another response.
 * No accepted projection, raw response, attempt, media or receipt is reset. */
export async function resumeSavedCourseDesignFirstDraft(
  courseId: string, actorId?: string,
): Promise<CourseDesignGenerationJob | null> {
  const job = await designGenerationJobs.findUnique({ where: { courseId } });
  if (!job) return null;
  const request = job.request as unknown as ReplayRequest;
  if (request.courseId !== courseId) stopped("SAVED_FIRST_DRAFT_REQUEST_CHANGED", "课程任务身份不一致。");
  if (LIVE_STATUSES.includes(job.status) || (job.status === "completed" && request.savedFirstDraftReplay)) return job;
  if (job.status !== "failed") stopped("SAVED_FIRST_DRAFT_NOT_FAILED", "当前设计没有可恢复的失败首稿。");
  const [course, saved, rawRow] = await Promise.all([
    getCourse(courseId), loadGenerationCheckpoints(job.id),
    prisma.generationCheckpoint.findUnique({ where: { jobId_step: { jobId: job.id, step: "design-authoring:teachingBlueprint" } },
      select: { state: true } }),
  ]);
  if (!course) stopped("SAVED_FIRST_DRAFT_COURSE_MISSING", "课程不存在。");
  const knowledge = record(saved.knowledgeStructure), duration = record(saved.aiDuration);
  const checkpoint = record(saved.teachingBlueprint), attempt = record(saved.teachingBlueprintAttempt);
  const storedResponse = record(rawRow?.state) ?? checkpoint;
  // A first-draft replay can finish the outline and later fail at handoff or
  // after teacher confirmation. Continue that accepted plan, including the
  // teacher's selected test section, instead of rejecting it as a new draft.
  if (knowledge?.status === "validated" && duration?.status === "validated"
    && checkpoint?.schemaVersion === 1 && checkpoint.status === "validated"
    && request.savedFirstDraftReplay && course.content.teachingBlueprint
    && course.content._openmaicSceneOutlines?.length
    && (hasAcceptedSavedCourseDesignOutline(course, checkpoint)
      || request.resumeFromOutlineReview && request.resumeReviewKind === "outline")) {
    const currentCourse = await getCourse(courseId);
    if (!currentCourse) stopped("SAVED_FIRST_DRAFT_COURSE_MISSING", "课程不存在。");
    await assertSavedCourseDesignReplayInput(currentCourse, request);
    await saveGenerationCheckpoint(job.id, `course-design:local-blueprint-replay:${randomUUID()}`, {
      schemaVersion: 1, status: "validated", originalJobVersion: job.version,
      authoringRequestId: request.authoringRequestId, originalJobError: job.error,
      ...request.savedFirstDraftReplay, providerCalls: 0, authorCalls: 0,
      preservedAcceptedBlueprintFingerprint: fingerprintGenerationValue(currentCourse.content.teachingBlueprint),
      preservedOutlineFingerprint: fingerprintGenerationValue(currentCourse.content._openmaicSceneOutlines),
      createdAt: new Date().toISOString(), ...(actorId ? { actorId } : {}),
    });
    return queueSavedCourseDesignReplay(job, { ...request, resumeFromOutlineReview: true, resumeReviewKind: "outline" });
  }
  if (knowledge?.status !== "validated" || duration?.status !== "validated"
    || checkpoint?.schemaVersion !== 1 || !["invalid-output", "response-complete"].includes(String(checkpoint.status))) {
    stopped("SAVED_FIRST_DRAFT_NOT_SUPPORTED", "仅支持知识与时长已验收、蓝图首稿尚未通过的设计任务。");
  }
  if (checkpoint.complete === false || storedResponse?.complete === false
    || !["response-complete", "invalid-output", "rejected", "validated"].includes(String(storedResponse?.status))) {
    stopped("SAVED_FIRST_DRAFT_INCOMPLETE", "蓝图响应来自截断请求，保留原文，不自动重发或采用。");
  }
  const rawResponse = storedResponse?.rawResponse;
  if (typeof rawResponse !== "string" || !rawResponse.trim()
    || (checkpoint.rawResponse !== undefined && checkpoint.rawResponse !== rawResponse)) {
    stopped("SAVED_FIRST_DRAFT_RESPONSE_MISSING", "已保存完整蓝图原文不可用或来源不一致，不能自动重新创作。");
  }
  const prepared = await prepareReplayInput(course, request);
  const { input, modelFingerprint, textbookFigureResources, legacyFingerprints, runner } = prepared;
  const inputFingerprint = teachingBlueprintInputFingerprint(input);
  const contentFingerprint = teachingBlueprintContentFingerprint(input);
  const legacyFingerprint = legacyTeachingBlueprintInputFingerprint(input);
  const compatibleInputs = [inputFingerprint, legacyFingerprint, legacyFingerprints.inputFingerprint,
    ...legacyFingerprints.previousInputs];
  const matches = (value: Record<string, unknown> | undefined) => value?.schemaVersion === 1
    && value.modelFingerprint === modelFingerprint && typeof value.inputFingerprint === "string"
    && compatibleInputs.includes(value.inputFingerprint);
  if (!matches(checkpoint) || !matches(storedResponse) || !matches(attempt)
    || typeof attempt?.attemptsStarted !== "number" || !Number.isInteger(attempt.attemptsStarted) || attempt.attemptsStarted < 1) {
    stopped("SAVED_FIRST_DRAFT_INPUT_CHANGED", "原蓝图、模型或已消耗请求身份与当前教学输入不匹配，不能恢复。");
  }
  const guard: SavedCourseDesignReplayGuard = { contentFingerprint: replayInputFingerprint(input), modelFingerprint,
    ...(request.authoringRequestId ? { authoringRequestId: request.authoringRequestId } : {}) };
  const replayRequest: ReplayRequest = { ...request, savedFirstDraftReplay: guard };
  const diagnosticStep = `course-design:local-blueprint-replay:${randomUUID()}`;
  const diagnostic = { schemaVersion: 1, originalJobVersion: job.version, authoringRequestId: request.authoringRequestId,
    originalJobError: job.error, originalValidationIssues: checkpoint.validationIssues ?? [],
    inputFingerprint, ...guard, rawFingerprint: fingerprintGenerationValue(rawResponse),
    attemptsStarted: attempt.attemptsStarted, providerCalls: 0, authorCalls: 0,
    createdAt: new Date().toISOString(), ...(actorId ? { actorId } : {}) };
  let local: { blueprint: TeachingBlueprint; capacity: Awaited<ReturnType<typeof prepareTeachingPageCapacity>> };
  try {
    const migrated = runner.migrateCourseDesignCheckpointIdentity(checkpoint, inputFingerprint, modelFingerprint, compatibleInputs);
    const source = runner.restoreTeachingBlueprintRepairSource(migrated, inputFingerprint, contentFingerprint,
      legacyFingerprint, modelFingerprint, [legacyFingerprints.contentFingerprint], input);
    const blueprint = await generateTeachingBlueprint(input, async () => {
      stopped("SAVED_FIRST_DRAFT_AUTHORING_FORBIDDEN", "首稿恢复禁止新的模型创作请求。");
    }, { repairFrom: source ?? { response: rawResponse, issues: [] },
      firstAuthoringContract: source?.firstAuthoringContract
        ?? (checkpoint.firstAuthoringContract === 'blueprint-v5' || storedResponse?.firstAuthoringContract === 'blueprint-v5'
          ? 'blueprint-v5' : undefined), resourceCapabilities: {
      imageGenerationEnabled: request.options?.enableImageGeneration === true,
      videoGenerationEnabled: request.options?.enableVideoGeneration === true,
    } });
    assertRequiredTextbookFiguresAvailable(textbookFigureResources);
    let boundBlueprint = bindRequiredTextbookFiguresToBlueprint(blueprint, textbookFigureResources, input.sourceSequences);
    const outlines = bindRequiredTextbookFiguresToOutlines(teachingBlueprintToOutlines(boundBlueprint, ZH_CN_COURSE_LANGUAGE_DIRECTIVE),
      textbookFigureResources, input.sourceSequences);
    const locked = request.resumeFromOutlineReview && request.resumeReviewKind === "outline"
      || source?.preserveAcceptedPagePlans === true;
    const capacity = await prepareTeachingPageCapacity(outlines, {
      lockedOutlineIds: locked ? outlines.map((outline) => outline.id) : [],
      explanationNodes: boundBlueprint.sections.flatMap((section) => section.units.flatMap((unit) => unit.explanationNodes ?? [])),
      resourceSequences: Object.fromEntries(textbookFigureResources.flatMap((resource) =>
        resource.orderedSteps?.length ? [[resource.id, resource.orderedSteps]] : [])),
      resourceDimensions: Object.fromEntries(textbookFigureResources.flatMap((resource) => resource.width && resource.height
        ? [[resource.id, { width: resource.width, height: resource.height }]] : [])),
    });
    if (capacity.changed) {
      const contentRunner = await import("@/lib/course-generation/job-runner");
      boundBlueprint = contentRunner.applyVersionedOutlinePlanToCourseContent({ ...course.content,
        teachingBlueprint: boundBlueprint, _openmaicSceneOutlines: outlines }, capacity.outlines).teachingBlueprint as TeachingBlueprint;
    }
    const rechecked = revalidateStoredTeachingBlueprint(boundBlueprint, input, { qualityMode: 'diagnostic' });
    if (!rechecked.blueprint) stopped("SAVED_FIRST_DRAFT_STRUCTURE_FAILED", rechecked.issues.join("；"), 422);
    boundBlueprint = rechecked.blueprint;
    const budgetIssues = validateTeachingBlueprintBudget(boundBlueprint, capacity.outlines, { reviewContent: false });
    boundBlueprint.qualityDiagnostics = [...new Set([...(boundBlueprint.qualityDiagnostics ?? []), ...(capacity.diagnostics ?? []), ...budgetIssues])];
    local = { blueprint: boundBlueprint, capacity };
  } catch (error) {
    await saveGenerationCheckpoint(job.id, diagnosticStep, { ...diagnostic, status: "rejected",
      issues: [error instanceof Error ? error.message : String(error)],
      ...(error instanceof TeachingPagePreflightError ? { outlines: error.outlines, assessments: error.assessments } : {}) });
    if (error instanceof SavedCourseDesignFirstDraftResumeError) throw error;
    throw Object.assign(new SavedCourseDesignFirstDraftResumeError("SAVED_FIRST_DRAFT_QUALITY_FAILED",
      error instanceof Error ? error.message : String(error), 422), { cause: error });
  }
  // Reads and receipt writes stay outside the content-validation catch:
  // a persistence outage must not be reported as a rejected teaching draft.
  const currentCourse = await getCourse(courseId);
  if (!currentCourse) stopped("SAVED_FIRST_DRAFT_COURSE_MISSING", "课程不存在。");
  try {
    await assertSavedCourseDesignReplayInput(currentCourse, replayRequest);
  } catch (error) {
    if (error instanceof SavedCourseDesignFirstDraftResumeError) {
      await saveGenerationCheckpoint(job.id, diagnosticStep, { ...diagnostic, status: "rejected",
        issues: [error.message] });
    }
    throw error;
  }
  await saveGenerationCheckpoint(job.id, diagnosticStep, { ...diagnostic, status: "validated",
    qualityGateMode: 'diagnostic', qualityDiagnostics: local.blueprint.qualityDiagnostics ?? [],
    blueprint: local.blueprint, outlines: local.capacity.outlines, assessments: local.capacity.assessments,
    deterministicPaginationChanged: local.capacity.changed });
  return queueSavedCourseDesignReplay(job, replayRequest);
}
