import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { contentGenerationJobs, designGenerationJobs, resourcePackageJobs, type CourseGenerationJob } from "@/lib/course-generation/job-storage";
import { loadPblTemplateCourse } from "@/lib/platform/pbl-template-repository";
import { updateCourse } from "@/lib/session/server-store";
import type { GenerationReferenceMaterial } from "@/lib/course-design/generation-references";
import type { Course } from "@/lib/session/types";
import { normalizePackageStructure, readDocx, readMarkdown, ResourcePackageError, resourcePackageDraftSchema, type ResourcePackageSelections } from "./parser";
import { adaptResourcePackageDraft, inspectPackageCompatibility, packageDraftSignature, stablePackageSignature } from "./compatibility";
import { resourcePackageDraftErrors, stagePlanFromResourcePackage, type CourseResourcePackage, type ResourcePackageDraft, type ResourcePackageFile, type ResourcePackageJobSnapshot, type ResourcePackageRole } from "./types";

export { ResourcePackageError } from "./archive";
export const resourcePackageDataDir = () => process.env.UPLOAD_DIR?.trim() || path.resolve(".openpbl-data", "uploads");
export type ResourcePackageRequest = {
  uploadId: string; source: ResourcePackageFile; courseId: string; requestedBy: string;
  revision: number; selections: ResourcePackageSelections; previousLaunchResourceId?: string;
};
export type ResourcePackageResult = {
  package?: CourseResourcePackage; candidates?: Partial<Record<ResourcePackageRole, string[]>>;
  referenceMaterials?: GenerationReferenceMaterial[];
};
export const packageResult = (job: CourseGenerationJob): ResourcePackageResult => (job.result && typeof job.result === "object" ? job.result : {}) as ResourcePackageResult;
export function resourcePackageSnapshot(job: CourseGenerationJob | null): ResourcePackageJobSnapshot | null {
  if (!job) return null;
  const result = packageResult(job);
  return { id: job.id, status: job.status, message: job.message, error: job.error, progress: job.progress,
    candidates: result.candidates, package: result.package ?? null };
}
/** Finish a confirmation whose durable template save succeeded before a worker/process exit. */
export async function loadResourcePackageJob(courseId: string): Promise<CourseGenerationJob | null> {
  const job = await resourcePackageJobs.findUnique({ where: { courseId } });
  if (job?.status !== "ready") return job;
  const result = packageResult(job);
  const current = (await loadPblTemplateCourse(courseId))?.content.resourcePackage;
  if (current && current.id === result.package?.id && current.revision > result.package.revision) {
    return resourcePackageJobs.update({ where: { id: job.id, status: "ready", version: job.version }, data: { result: JSON.parse(JSON.stringify({ ...result, package: current })), message: current.confirmedAt ? "资源包信息已确认，可以生成课堂" : job.message } });
  }
  return job;
}
function invalidateGeneratedClassroom(course: Course): Course {
  return { ...course, status: "draft", aiLearningClassroomId: undefined, teacherClassroomId: undefined,
    content: { ...course.content, _openmaicClassroomId: undefined, _openmaicScenesCount: undefined,
      _openmaicSceneOutlines: undefined, moduleTimingPlan: undefined, stagePlan: undefined, teacherClassroomId: undefined,
      knowledgeGraph: undefined, knowledgePoints: [], lessonOutline: [], knowledgeLectureSections: undefined,
      teacherReview: undefined, qualityReview: undefined, renderReview: undefined,
      designGenerationTrace: undefined } };
}
export async function assertResourcePackageEditable(courseId: string): Promise<void> {
  const active = ["queued", "running", "review_available", "paused", "cancelling"];
  const [design, content] = await Promise.all([
    designGenerationJobs.findUnique({ where: { courseId, status: { in: active } } }),
    contentGenerationJobs.findUnique({ where: { courseId, status: { in: active } } }),
  ]);
  if (design || content) throw new ResourcePackageError("课程正在生成或等待审阅，请先结束本次生成再修改资源包。", "RESOURCE_PACKAGE_GENERATION_ACTIVE", 409);
}
export async function readPrivatePackageFile(id: string, userId: string) {
  const file = await prisma.fileAsset.findFirst({ where: { id, uploadedById: userId, offeringId: null, deletedAt: null } });
  if (!file || path.basename(file.storageKey) !== file.storageKey) throw new ResourcePackageError("资源文件不存在或无权访问。", "RESOURCE_PACKAGE_FILE_NOT_FOUND", 404);
  const filePath = path.join(resourcePackageDataDir(), file.storageKey);
  const info = await stat(/* turbopackIgnore: true */ filePath).catch(() => null);
  if (!info?.isFile() || info.size > 50 * 1024 * 1024 || info.size !== Number(file.size)) throw new ResourcePackageError("资源文件缺失、过大或已损坏，请重新上传。", "RESOURCE_PACKAGE_FILE_UNAVAILABLE", 422);
  return { file, bytes: await readFile(/* turbopackIgnore: true */ filePath), filePath };
}
async function requireOwnedTemplate(courseId: string, userId: string) {
  const template = await prisma.classroomTemplate.findUnique({ where: { id: courseId }, select: { ownerId: true, status: true } });
  if (!template || template.ownerId !== userId || ["DELETED", "ARCHIVED"].includes(template.status.toUpperCase())) throw new ResourcePackageError("课程不存在或无权修改。", "RESOURCE_PACKAGE_COURSE_NOT_FOUND", 404);
}
export async function submitResourcePackage(courseId: string, userId: string, uploadId: string, selections: ResourcePackageSelections = {}): Promise<CourseGenerationJob> {
  await requireOwnedTemplate(courseId, userId);
  await assertResourcePackageEditable(courseId);
  const existing = await resourcePackageJobs.findUnique({ where: { courseId } });
  if (existing && ["queued", "running"].includes(existing.status)) throw new ResourcePackageError("资源包正在处理中，请等待完成后重试。", "RESOURCE_PACKAGE_BUSY", 409);
  const { file } = await readPrivatePackageFile(uploadId, userId);
  const provenance = file.regenerationRecipe as Record<string, unknown> | null;
  if (file.mimeType !== "application/zip" || provenance?.operation !== "course-resource-package-upload" || provenance?.courseId !== courseId) throw new ResourcePackageError("请选择为当前课程上传的 ZIP 资源包。", "RESOURCE_PACKAGE_FILE_NOT_FOUND", 404);
  const course = await loadPblTemplateCourse(courseId);
  const previousPackage = course?.content.resourcePackage;
  const request: ResourcePackageRequest = { uploadId, source: { id: file.id, fileName: file.originalName, url: `/api/uploads/${file.id}`, ...(file.sha256 ? { sha256: file.sha256 } : {}) }, courseId, requestedBy: userId,
    revision: (previousPackage?.revision ?? (existing ? (existing.request as unknown as ResourcePackageRequest).revision : 0) ?? 0) + 1,
    selections, previousLaunchResourceId: previousPackage?.launchResourceId };
  const patch = { courseId, requestedBy: userId, status: "queued", step: "queued", message: "等待解析资源包", progress: 0,
    request: JSON.parse(JSON.stringify(request)) as Prisma.InputJsonValue, result: Prisma.JsonNull, error: null, completedAt: null, lastHeartbeatAt: null, version: { increment: 1 } };
  let job: CourseGenerationJob;
  try {
    job = await resourcePackageJobs.upsert({ where: { courseId }, create: patch, update: patch, rejectStatuses: ["queued", "running"] });
  } catch (error) {
    if (error instanceof Error && error.message === "GENERATION_JOB_BUSY") throw new ResourcePackageError("资源包正在处理中，请等待完成后重试。", "RESOURCE_PACKAGE_BUSY", 409);
    throw error;
  }
  // Invalidate confirmation as soon as a new input has been accepted.
  await updateCourse(courseId, (current) => {
    const invalidated = invalidateGeneratedClassroom(current);
    const latest = current.content.resourcePackage;
    const preserved = latest && latest.revision >= request.revision ? latest : previousPackage;
    return { ...invalidated, resources: (current.resources ?? []).filter((resource) => resource.id !== previousPackage?.launchResourceId), content: { ...invalidated.content, resourcePackage: preserved ? { ...preserved, confirmedAt: undefined } : undefined } };
  });
  return job;
}
export async function retryResourcePackage(courseId: string, userId: string, selections?: ResourcePackageSelections): Promise<CourseGenerationJob> {
  await requireOwnedTemplate(courseId, userId);
  await assertResourcePackageEditable(courseId);
  const job = await resourcePackageJobs.findUnique({ where: { courseId } });
  if (!job || job.requestedBy !== userId) throw new ResourcePackageError("没有可重试的资源包，请先上传。", "RESOURCE_PACKAGE_NOT_FOUND", 404);
  const input = job.request as unknown as ResourcePackageRequest;
  const result = packageResult(job);
  // Conversion retries preserve parsed material; changed candidate selection requires re-extraction.
  const changedSelection = selections && Object.entries(selections).some(([key, value]) => input.selections[key as ResourcePackageRole] !== value);
  if (!["failed", "needs_selection"].includes(job.status) && !(changedSelection && ["blocked", "ready"].includes(job.status))) throw new ResourcePackageError("当前资源包无需重试。", "RESOURCE_PACKAGE_BUSY", 409);
  if (changedSelection) await updateCourse(courseId, (course) => { const invalidated = invalidateGeneratedClassroom(course); return { ...invalidated, resources: (course.resources ?? []).filter((item) => item.id !== result.package?.launchResourceId), content: { ...invalidated.content, resourcePackage: course.content.resourcePackage ? { ...course.content.resourcePackage, confirmedAt: undefined, adaptation: undefined, launchResourceId: undefined } : undefined } }; });
  try { return await resourcePackageJobs.update({ where: { id: job.id, version: job.version, status: job.status }, data: { status: "queued", step: "queued", version: { increment: 1 }, progress: result.package && !changedSelection ? 65 : 0,
    message: result.package && !changedSelection ? "等待重试项目启动课件转换" : "等待重新解析资源包", error: null, completedAt: null, lastHeartbeatAt: null,
    request: JSON.parse(JSON.stringify({ ...input, ...(changedSelection ? { revision: (result.package?.revision ?? input.revision) + 1, previousLaunchResourceId: result.package?.launchResourceId } : {}), selections: { ...input.selections, ...selections } })),
    ...(changedSelection ? { result: Prisma.JsonNull } : {}) } });
  } catch (error) {
    if (error instanceof Error && error.message === "GENERATION_JOB_NOT_FOUND") throw new ResourcePackageError("资源包正在处理中，请等待完成后重试。", "RESOURCE_PACKAGE_BUSY", 409);
    throw error;
  }
}
export async function confirmResourcePackage(courseId: string, userId: string, revision: number, input: ResourcePackageDraft,
  acknowledgement?: { issueVersion: string; issueIds: string[] }): Promise<CourseGenerationJob> {
  await requireOwnedTemplate(courseId, userId);
  await assertResourcePackageEditable(courseId);
  const job = await loadResourcePackageJob(courseId);
  const result = job ? packageResult(job) : null;
  const current = result?.package;
  if (!job || !["ready", "blocked"].includes(job.status) || !current) throw new ResourcePackageError("请等待资源包处理完成。", "RESOURCE_PACKAGE_NOT_READY", 409);
  if (job.requestedBy !== userId) throw new ResourcePackageError("无权修改此资源包。", "RESOURCE_PACKAGE_NOT_FOUND", 404);
  if (current.revision !== revision) throw new ResourcePackageError("资源包内容已更新，请刷新后重新确认。", "RESOURCE_PACKAGE_REVISION_CONFLICT", 409);
  const parsed = resourcePackageDraftSchema.safeParse(input);
  if (!parsed.success) throw new ResourcePackageError("资源包信息格式无效，请检查补充内容。", "RESOURCE_PACKAGE_INVALID_DRAFT", 422);
  parsed.data.parsingVersion = current.draft.parsingVersion;
  parsed.data.sourceEvidence = current.draft.sourceEvidence;
  const errors = resourcePackageDraftErrors(parsed.data);
  if (errors.length) throw new ResourcePackageError(errors.join("\n"), "RESOURCE_PACKAGE_INVALID_DRAFT", 422);
  const requiredIssueIds = (current.planningIssues ?? []).filter((issue) => issue.requiresAcknowledgement).map((issue) => issue.id).sort();
  if (requiredIssueIds.length) {
    const acknowledged = [...new Set(acknowledgement?.issueIds ?? [])].sort();
    if (!current.planningIssueVersion || acknowledgement?.issueVersion !== current.planningIssueVersion || acknowledged.join("\n") !== requiredIssueIds.join("\n")) {
      throw new ResourcePackageError("请先核对并确认资源包中的规划问题。", "RESOURCE_PACKAGE_PLANNING_ACKNOWLEDGEMENT_REQUIRED", 422);
    }
  }
  const normalized = normalizePackageStructure(parsed.data);
  if (current.draft.evaluationRubric && normalized.evaluationRubric && stablePackageSignature([current.draft.evaluationRubric.dimensions, current.draft.evaluationRubric.sourceWeights]) !== stablePackageSignature([normalized.evaluationRubric.dimensions, normalized.evaluationRubric.sourceWeights])) normalized.evaluationRubric.version = current.draft.evaluationRubric.version + 1;
  if (current.draft.reflectionQuestionSet && normalized.reflectionQuestionSet && stablePackageSignature(current.draft.reflectionQuestionSet.questions) !== stablePackageSignature(normalized.reflectionQuestionSet.questions)) normalized.reflectionQuestionSet.version = current.draft.reflectionQuestionSet.version + 1;
  const changed = packageDraftSignature(normalized) !== packageDraftSignature(current.draft);
  const editedConflicts = inspectPackageCompatibility(normalized.stages.map((stage) => [stage.title, stage.requirements, stage.teacherActions, stage.outputs].join('\n')).join('\n'), []);
  if (current.draft.parsingVersion === 2 && ((current.conflicts?.length && (!current.adaptation || changed)) || job.status === "blocked" || editedConflicts.conflicts.length)) {
    const pending = { ...current, ...(editedConflicts.conflicts.length && !current.conflicts?.length ? editedConflicts : {}), draft: normalized, revision: changed ? revision + 1 : revision, confirmedAt: undefined, adaptation: undefined, launchResourceId: undefined, classroomPresentation: undefined };
    await updateCourse(courseId, (course) => ({ ...invalidateGeneratedClassroom(course), resources: (course.resources ?? []).filter((item) => item.id !== current.launchResourceId), content: { ...invalidateGeneratedClassroom(course).content, resourcePackage: pending } }));
    return resourcePackageJobs.update({ where: { id: job.id, version: job.version }, data: { status: "blocked", message: "教学要求已保存；请修正上游资源包，或明确授权按系统流程统一适配。", request: JSON.parse(JSON.stringify({ ...(job.request as unknown as ResourcePackageRequest), revision: pending.revision })), result: JSON.parse(JSON.stringify({ ...result, package: pending })) } });
  }
  if (!current.launchResourceId) throw new ResourcePackageError("请等待启动课件处理完成。", "RESOURCE_PACKAGE_NOT_READY", 409);
  const resourcePackage: CourseResourcePackage = { ...current, draft: normalized, revision: revision + 1, confirmedAt: new Date().toISOString(),
    ...(requiredIssueIds.length ? { planningAcknowledgement: { sourceRevision: revision, issueVersion: current.planningIssueVersion!, issueIds: requiredIssueIds,
      acknowledgedBy: userId, acknowledgedAt: new Date().toISOString() } } : { planningAcknowledgement: undefined }) };
  const draft = resourcePackage.draft;
  await updateCourse(courseId, (course) => {
    if (course.content.resourcePackage?.revision !== revision) throw new ResourcePackageError("资源包内容已更新，请刷新后重新确认。", "RESOURCE_PACKAGE_REVISION_CONFLICT", 409);
    const invalidated = invalidateGeneratedClassroom(course);
    return { ...invalidated, name: draft.courseName, subject: draft.subject, grade: draft.grade,
      hours: draft.totalMinutes! / 60, drivingQuestion: draft.drivingQuestion, learningObjectives: draft.learningObjectives, expectedOutcome: draft.expectedOutcome,
      content: { ...invalidated.content, resourcePackage, stagePlan: stagePlanFromResourcePackage(draft) } };
  });
  return resourcePackageJobs.update({ where: { id: job.id, status: "ready", version: job.version }, data: { message: "资源包信息已确认，可以生成课堂", result: JSON.parse(JSON.stringify({ ...result, package: resourcePackage })) } });
}

export async function authorizeResourcePackageAdaptation(courseId: string, userId: string, revision: number, conflictVersion: string, input: ResourcePackageDraft): Promise<CourseGenerationJob> {
  await requireOwnedTemplate(courseId, userId); await assertResourcePackageEditable(courseId);
  const job = await loadResourcePackageJob(courseId); const result = job ? packageResult(job) : null; const current = result?.package;
  if (!job || job.requestedBy !== userId || !current || !["blocked", "ready"].includes(job.status)) throw new ResourcePackageError("当前资源包不可授权适配。", "RESOURCE_PACKAGE_NOT_READY", 409);
  if (current.revision !== revision || current.conflictVersion !== conflictVersion) throw new ResourcePackageError("资源包或冲突清单已更新，请重新核对。", "RESOURCE_PACKAGE_REVISION_CONFLICT", 409);
  const parsed = resourcePackageDraftSchema.safeParse(input);
  if (!parsed.success) throw new ResourcePackageError("教学要求格式无效。", "RESOURCE_PACKAGE_INVALID_DRAFT", 422);
  parsed.data.parsingVersion = current.draft.parsingVersion;
  parsed.data.sourceEvidence = current.draft.sourceEvidence;
  const errors = resourcePackageDraftErrors(parsed.data); if (errors.length) throw new ResourcePackageError(errors.join("\n"), "RESOURCE_PACKAGE_INVALID_DRAFT", 422);
  const adapted = adaptResourcePackageDraft(normalizePackageStructure(parsed.data));
  const next: CourseResourcePackage = { ...current, draft: adapted.draft, revision: revision + 1, confirmedAt: undefined, launchResourceId: undefined, classroomPresentation: undefined,
    adaptation: { sourceRevision: revision, conflictVersion, authorizedBy: userId, authorizedAt: new Date().toISOString(), draftSignature: packageDraftSignature(adapted.draft), changes: adapted.changes } };
  await updateCourse(courseId, (course) => { const invalidated = invalidateGeneratedClassroom(course); return { ...invalidated, resources: (course.resources ?? []).filter((item) => item.id !== current.launchResourceId), content: { ...invalidated.content, resourcePackage: next } }; });
  return resourcePackageJobs.update({ where: { id: job.id, status: job.status, version: job.version }, data: { status: "queued", step: "adapt", progress: 65, error: null, completedAt: null, message: "已记录教师授权，正在统一适配课堂要求和启动课件", request: JSON.parse(JSON.stringify({ ...(job.request as unknown as ResourcePackageRequest), revision: next.revision })), result: JSON.parse(JSON.stringify({ ...result, package: next })) } });
}

/** Resolve server-owned confirmed input. Never trust a package snapshot supplied by a browser. */
export async function resolveConfirmedResourcePackage(courseId: string, id: string, revision: number, userId: string): Promise<{ resourcePackage: CourseResourcePackage; referenceMaterials: GenerationReferenceMaterial[] }> {
  await requireOwnedTemplate(courseId, userId);
  const [course, job] = await Promise.all([loadPblTemplateCourse(courseId), resourcePackageJobs.findUnique({ where: { courseId } })]);
  const resourcePackage = course?.content.resourcePackage;
  if (!resourcePackage || !resourcePackage.confirmedAt || !resourcePackage.launchResourceId || job?.status !== "ready") throw new ResourcePackageError("请先上传资源包并确认课程关键信息。", "RESOURCE_PACKAGE_CONFIRMATION_REQUIRED", 422);
  if (resourcePackage.id !== id || resourcePackage.revision !== revision) throw new ResourcePackageError("资源包或补充回答已更新，请使用最新确认结果生成。", "RESOURCE_PACKAGE_REVISION_CONFLICT", 409);
  if (resourcePackageDraftErrors(resourcePackage.draft).length) throw new ResourcePackageError("资源包课程信息不完整，请重新确认。", "RESOURCE_PACKAGE_INVALID_DRAFT", 422);
  const referenceMaterials: GenerationReferenceMaterial[] = [];
  for (const role of ["knowledge", "lessonPlan"] as const) {
    const document = resourcePackage.documents[role];
    if (!document) throw new ResourcePackageError("资源包缺少必要的课程文档。", "RESOURCE_PACKAGE_INVALID_DRAFT", 422);
    const { file, bytes } = await readPrivatePackageFile(document.id, userId);
    if (file.sourceAssetId !== resourcePackage.source.id) throw new ResourcePackageError("资源包文档来源不匹配。", "RESOURCE_PACKAGE_FILE_NOT_FOUND", 404);
    const isMarkdown = document.format === "markdown" || file.mimeType === "text/markdown" || /\.md$/i.test(file.originalName);
    const text = isMarkdown ? readMarkdown(bytes, file.originalName).text : readDocx(bytes).text;
    // Keep complete source text; split into bounded, ordered materials so no document tail is silently discarded.
    for (let start = 0; start < text.length; start += 24000) referenceMaterials.push({ id: `${file.id}${start ? `:part-${start / 24000 + 1}` : ""}`, fileName: `${file.originalName}${text.length > 24000 ? `（第${start / 24000 + 1}段）` : ""}`, mimeType: file.mimeType, content: text.slice(start, start + 24000) });
  }
  return { resourcePackage, referenceMaterials };
}
