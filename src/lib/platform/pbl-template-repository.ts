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
