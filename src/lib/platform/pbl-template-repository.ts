import { isDeepStrictEqual } from "node:util";
import type { Prisma } from "@prisma/client";
import type { Course } from "@/lib/session/types";
import { prisma } from "@/lib/db/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import type { PlatformDb } from "./access";
import { PlatformError } from "./repository";
import { createPblTemplateCourse, decodePblTemplate, encodePblTemplate } from "./pbl-template";

export type PblTemplatePublicationState = {
  latestVersion: number | null;
  publishedVersion: number | null;
  draftVersion: number | null;
};

export type PblTemplateVersionSummary = {
  version: number;
  status: string;
  createdAt: string;
  name: string;
  subject: string;
  grade: string;
  pageCount: number;
  resourceCount: number;
  stageMinutes: number | null;
  measuredSpeechSeconds: number | null;
  restorable: boolean;
};

export type PblTemplateVersionDetail = PblTemplateVersionSummary & {
  summary: string;
  drivingQuestion: string;
  learningObjectives: string[];
  classroomId: string | null;
  stagePlan: Array<{ key: string; title: string; minutes: number }>;
  pages: Array<{ id: string; title: string; stageLabel: string; seconds: number }>;
  resources: Array<{ id: string; title: string }>;
  timingAudit: { complete: boolean; measuredSegmentCount: number; narrationSegmentCount: number; budgetSeconds: number; source: string } | null;
  classroomAvailable: boolean;
};

function versionSummary(version: { version: number; status: string; createdAt: Date; snapshot: unknown }): PblTemplateVersionSummary {
  const design = decodePblTemplate(version.snapshot);
  const studentPages = design?.content._openmaicSceneOutlines?.filter((page) => page.audience !== "teacher") ?? [];
  const audit = design?.content.teachingTimingAudit;
  return {
    version: version.version,
    status: version.status,
    createdAt: version.createdAt.toISOString(),
    name: design?.name ?? "无法读取的旧版课程",
    subject: design?.subject ?? "",
    grade: design?.grade ?? "",
    pageCount: studentPages.length,
    resourceCount: design?.resources?.length ?? 0,
    stageMinutes: design?.content.stagePlan?.totalMinutes ?? null,
    measuredSpeechSeconds: audit?.narrationDurationSource === "actual-audio"
      ? audit.substantiveTeachingDurationSec + audit.assessmentAudioDurationSec : null,
    restorable: Boolean(design),
  };
}

export async function getPblTemplateVersionHistory(id: string, selectedVersion?: number, db: PlatformDb = prisma) {
  const template = await db.classroomTemplate.findUnique({
    where: { id },
    select: { updatedAt: true, versions: { orderBy: { version: "desc" }, select: { version: true, status: true, createdAt: true, snapshot: true } } },
  });
  if (!template) throw new PlatformError("NOT_FOUND", "课程不存在", 404);
  const selected = template.versions.find((version) => version.version === (selectedVersion ?? template.versions[0]?.version));
  if (!selected) throw new PlatformError("VERSION_NOT_FOUND", "所选历史版本不存在", 404);
  const design = decodePblTemplate(selected.snapshot);
  const classroomId = design?.aiLearningClassroomId || design?.content._openmaicClassroomId || null;
  const teacherClassroomId = design?.teacherClassroomId || design?.content.teacherClassroomId || null;
  const { isValidClassroomId, readClassroom } = await import("@/lib/openmaic/server/classroom-storage");
  const classroomAvailable = (await Promise.all([...new Set([classroomId, teacherClassroomId].filter((value): value is string => Boolean(value)))]
    .map((id) => isValidClassroomId(id) ? readClassroom(id) : Promise.resolve(null)))).every(Boolean);
  const detail: PblTemplateVersionDetail = {
    ...versionSummary(selected),
    summary: design?.summary ?? "",
    drivingQuestion: design?.drivingQuestion ?? "",
    learningObjectives: design?.learningObjectives ?? [],
    classroomId,
    stagePlan: design?.content.stagePlan?.stages.map((stage) => ({ key: stage.key, title: stage.title, minutes: stage.durationMin ?? 0 })) ?? [],
    pages: design?.content._openmaicSceneOutlines?.filter((page) => page.audience !== "teacher").map((page) => ({
      id: page.id, title: page.title, stageLabel: page.stageLabel ?? "", seconds: page.targetDurationSec ?? page.estimatedDuration ?? 0,
    })) ?? [],
    resources: design?.resources?.map((resource) => ({ id: resource.id, title: resource.title })) ?? [],
    timingAudit: design?.content.teachingTimingAudit ? {
      complete: design.content.teachingTimingAudit.complete,
      measuredSegmentCount: design.content.teachingTimingAudit.measuredSegmentCount,
      narrationSegmentCount: design.content.teachingTimingAudit.narrationSegmentCount,
      budgetSeconds: design.content.teachingTimingAudit.totalBudgetSec,
      source: design.content.teachingTimingAudit.narrationDurationSource,
    } : null,
    classroomAvailable,
  };
  return { courseVersion: template.updatedAt.getTime(), latestVersion: template.versions[0]?.version ?? null,
    versions: template.versions.map(versionSummary), selected: detail };
}

/** Restore a historical snapshot as a new draft; every previous version keeps its snapshot. */
export async function restorePblTemplateVersion(id: string, ownerId: string, sourceVersion: number, expectedCourseVersion: number) {
  return runMutationTransaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pbl-template:${id}`}, 0))`;
    const template = await tx.classroomTemplate.findUnique({
      where: { id }, include: { versions: { orderBy: { version: "desc" }, take: 1 } },
    });
    if (!template || template.status.toUpperCase() === "DELETED") throw new PlatformError("NOT_FOUND", "课程不存在", 404);
    if (template.ownerId !== ownerId) throw new PlatformError("FORBIDDEN", "无权修改此课程", 403);
    if (template.status.toUpperCase() === "ARCHIVED") throw new PlatformError("TEMPLATE_ARCHIVED", "归档模板不可修改", 409);
    if (template.updatedAt.getTime() !== expectedCourseVersion) throw new PlatformError("VERSION_CONFLICT", "课程已更新，请刷新版本记录后重试", 409);
    const latest = template.versions[0];
    if (latest?.version === sourceVersion) throw new PlatformError("ALREADY_CURRENT", "所选版本已经是当前版本", 409);
    const source = await tx.classroomTemplateVersion.findUnique({ where: { templateId_version: { templateId: id, version: sourceVersion } } });
    if (!source) throw new PlatformError("VERSION_NOT_FOUND", "所选历史版本不存在", 404);
    const design = decodePblTemplate(source.snapshot);
    if (!design) throw new PlatformError("INVALID_VERSION", "旧版课程格式无法恢复", 409);
    const resourceIds = [...new Set((design.resources ?? []).map((resource) => resource.id))];
    if (resourceIds.length) {
      const assets = await tx.fileAsset.findMany({ where: { id: { in: resourceIds }, uploadedById: ownerId, deletedAt: null }, select: { id: true } });
      if (assets.length !== resourceIds.length) throw new PlatformError("MISSING_VERSION_RESOURCE", "历史版本引用的上传资源已不可用，无法完整恢复", 409);
    }
    const classroomId = design.aiLearningClassroomId || design.content._openmaicClassroomId;
    const teacherClassroomId = design.teacherClassroomId || design.content.teacherClassroomId;
    const { isValidClassroomId, readClassroom } = await import("@/lib/openmaic/server/classroom-storage");
    for (const referencedClassroomId of new Set([classroomId, teacherClassroomId].filter((value): value is string => Boolean(value)))) {
      if (!isValidClassroomId(referencedClassroomId) || !await readClassroom(referencedClassroomId)) {
        throw new PlatformError("MISSING_VERSION_CLASSROOM", "历史版本引用的课堂资源已不可用，无法完整恢复", 409);
      }
    }
    const restored = createPblTemplateCourse(id, {
      ...design,
      content: { ...design.content, qualityReview: undefined, renderReview: undefined, teacherReview: undefined },
    });
    const snapshot = JSON.parse(JSON.stringify(encodePblTemplate(restored))) as Prisma.InputJsonValue;
    if (latest?.status.toUpperCase() === "DRAFT") {
      await tx.classroomTemplateVersion.update({ where: { id: latest.id }, data: { status: "SUPERSEDED" } });
    }
    const nextVersion = (latest?.version ?? 0) + 1;
    await tx.classroomTemplateVersion.create({ data: {
      templateId: id, version: nextVersion, status: "DRAFT", snapshot,
      ...(source.mediaRefs ? { mediaRefs: source.mediaRefs as Prisma.InputJsonValue } : {}),
    } });
    const updatedAt = new Date(Math.max(Date.now(), template.updatedAt.getTime() + 1));
    await tx.classroomTemplate.update({ where: { id }, data: { title: restored.name, description: restored.summary, updatedAt } });
    return { version: nextVersion, courseVersion: updatedAt.getTime() };
  });
}

export async function getPblTemplatePublicationState(
  id: string,
  db: PlatformDb = prisma,
): Promise<PblTemplatePublicationState> {
  const template = await db.classroomTemplate.findUnique({
    where: { id },
    select: { versions: { orderBy: { version: "desc" }, select: { version: true, status: true } } },
  });
  const latest = template?.versions[0];
  const published = template?.versions.find((version) => version.status.toUpperCase() === "PUBLISHED");
  return {
    latestVersion: latest?.version ?? null,
    publishedVersion: published?.version ?? null,
    draftVersion: latest?.status.toUpperCase() === "DRAFT" ? latest.version : null,
  };
}

export async function loadPblTemplateCourse(id: string, db: PlatformDb = prisma): Promise<Course | null> {
  const template = await db.classroomTemplate.findUnique({ where: { id }, include: { versions: { orderBy: { version: "desc" }, take: 1 } } });
  if (!template || template.status.toUpperCase() === "DELETED") return null;
  const version = template.versions[0];
  const design = decodePblTemplate(version?.snapshot);
  if (!design) return null;
  return { ...createPblTemplateCourse(id, design, { createdAt: template.createdAt.toISOString(), updatedAt: template.updatedAt.toISOString() }), version: template.updatedAt.getTime(), status: version.status === "PUBLISHED" ? "ready" : "preparing" };
}

/** Internal persistence boundary; request callers must establish template ownership first. */
export async function savePblTemplateCourse(course: Course, ownerId?: string, db?: Prisma.TransactionClient): Promise<Course> {
  const save = async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pbl-template:${course.id}`}, 0))`;
    const template = await tx.classroomTemplate.findUnique({ where: { id: course.id }, include: { versions: { orderBy: { version: "desc" }, take: 1 } } });
    if (!template && !ownerId) throw new PlatformError("NOT_FOUND", "备课模板不存在", 404);
    if (template?.status.toUpperCase() === "ARCHIVED") throw new PlatformError("TEMPLATE_ARCHIVED", "归档模板不可修改", 409);
    if (template?.status.toUpperCase() === "DELETED") throw new PlatformError("NOT_FOUND", "备课模板不存在", 404);
    if (template && ownerId && template.ownerId !== ownerId) throw new PlatformError("FORBIDDEN", "无权修改此备课模板", 403);
    if (template && course.version !== undefined && course.version !== template.updatedAt.getTime()) throw new PlatformError("VERSION_CONFLICT", "备课内容已更新，请刷新后重试", 409);
    const resourceIds = [...new Set((course.resources ?? []).map((resource) => resource.id))];
    if (resourceIds.length) {
      const assets = await tx.fileAsset.findMany({ where: { id: { in: resourceIds }, uploadedById: template?.ownerId ?? ownerId, deletedAt: null }, select: { id: true } });
      if (assets.length !== resourceIds.length) throw new PlatformError("INVALID_TEMPLATE_RESOURCE", "备课资源不存在或不属于当前教师", 400);
    }
    const snapshot = JSON.parse(JSON.stringify(encodePblTemplate(course))) as Prisma.InputJsonValue;
    const published = course.status === "ready";
    const latest = template?.versions[0];
    if (published && (!latest || latest.status === "DRAFT")) {
      const { assertCourseTeacherReview, CourseReviewError } = await import("@/lib/course-quality-review/review-service");
      try { await assertCourseTeacherReview(course, template?.ownerId ?? ownerId); }
      catch (error) { if (error instanceof CourseReviewError) throw new PlatformError(error.code, error.message, error.status); throw error; }
    }
    if (!template) {
      await tx.classroomTemplate.create({ data: { id: course.id, ownerId: ownerId!, title: course.name, description: course.summary, status: "ACTIVE", versions: { create: { version: 1, status: published ? "PUBLISHED" : "DRAFT", snapshot } } } });
    } else {
      await tx.classroomTemplate.update({ where: { id: course.id }, data: { title: course.name, description: course.summary, updatedAt: new Date(Math.max(Date.now(), template.updatedAt.getTime() + 1)) } });
      if (latest?.status === "DRAFT") {
        await tx.classroomTemplateVersion.update({ where: { id: latest.id }, data: { snapshot, status: published ? "PUBLISHED" : "DRAFT" } });
      } else if (!latest || !isDeepStrictEqual(latest.snapshot, snapshot)) {
        await tx.classroomTemplateVersion.create({ data: { templateId: course.id, version: (latest?.version ?? 0) + 1, status: "DRAFT", snapshot } });
      }
    }
    return (await loadPblTemplateCourse(course.id, tx))!;
  };
  return db ? save(db) : runMutationTransaction(save);
}
