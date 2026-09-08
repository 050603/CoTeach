// @ts-nocheck
import { createReadStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import type { AuthClaims } from "@/lib/auth/session";
import { randomUUID } from "node:crypto";
import { publishCourseEvent } from "@/lib/realtime/event-bus";
import { canAccessLegacyCourse } from "@/lib/platform/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });
const DisplayModeSchema = z.object({
  displayMode: z.enum(["document", "slides"]),
});
const dataDir =
  process.env.UPLOAD_DIR?.trim() ||
  path.resolve(".openpbl-data", "uploads");

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;
  const parsed = ParamsSchema.safeParse(await context.params);
  if (!parsed.success) return new Response(null, { status: 404 });

  const file = await prisma.uploadFile.findFirst({
    where: { id: parsed.data.id, deletedAt: null },
  });
  if (!file || !canAccess(auth.claims, file.courseId, file.uploadedById)
    || (file.courseId && !(await canAccessLegacyCourse(auth.claims, file.courseId, "read")))) {
    return new Response(null, { status: 404 });
  }
  if (auth.claims.role === "student" && isFinalArtifactUpload(file.referencedBy)) {
    const courseId = file.courseId;
    const references = finalArtifactReferences(file.referencedBy);
    const [ownDocument, ownPdf, activePresentation] = await Promise.all([
      courseId
        ? prisma.projectDocumentVersion.findFirst({
            where: { courseId, studentId: auth.claims.studentId, docxUploadId: file.id, status: "submitted" },
            select: { id: true },
          })
        : null,
      courseId
        ? prisma.projectPdfVersion.findFirst({
            where: { courseId, studentId: auth.claims.studentId, uploadId: file.id, status: "submitted" },
            select: { id: true },
          })
        : null,
      courseId
        ? prisma.showcasePresentation.findFirst({
            where: { courseId, status: "active", artifactVersionId: { in: references } },
            select: { id: true },
          })
        : null,
    ]);
    if (!ownDocument && !ownPdf && !activePresentation) return new Response(null, { status: 404 });
  }
  const classroomVariant = new URL(request.url).searchParams.get("variant") === "classroom";
  const selectedStoredName = classroomVariant ? file.previewStoredName : file.storedName;
  const selectedMimeType = classroomVariant ? file.previewMimeType : file.mimeType;
  const download = new URL(request.url).searchParams.get("download") === "1";
  if (
    !selectedStoredName
    || !selectedMimeType
    || path.basename(selectedStoredName) !== selectedStoredName
  ) {
    return new Response(null, { status: 404 });
  }
  const target = path.join(dataDir, selectedStoredName);
  let info;
  try {
    info = await stat(/* turbopackIgnore: true */ target);
  } catch {
    return new Response(null, { status: 404 });
  }

  const range = parseRange(request.headers.get("range"), info.size);
  if (request.headers.has("range") && !range) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${info.size}` },
    });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? info.size - 1;
  const etag = `\"${file.id}-${classroomVariant ? "classroom" : "source"}-${info.size}-${Math.floor(info.mtimeMs)}\"`;
  if (!range && request.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        "Cache-Control": "private, max-age=3600, immutable",
      },
    });
  }
  const stream = createReadStream(/* turbopackIgnore: true */ target, { start, end });
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
    status: range ? 206 : 200,
    headers: {
      "Content-Type": selectedMimeType,
      "Content-Length": String(end - start + 1),
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${info.size}` } : {}),
      "Accept-Ranges": "bytes",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(
        classroomVariant ? classroomPreviewName(file.fileName) : file.fileName,
      )}`,
      ETag: etag,
      "Last-Modified": info.mtime.toUTCString(),
      "Cache-Control": "private, max-age=3600, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;
  if (auth.claims.role !== "teacher") {
    return Response.json({ message: "只有教师可以修改资源展示方式。" }, { status: 403 });
  }
  const parsedParams = ParamsSchema.safeParse(await context.params);
  if (!parsedParams.success) return new Response(null, { status: 404 });
  const parsedBody = DisplayModeSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsedBody.success) {
    return Response.json({ message: "资源展示方式无效。" }, { status: 400 });
  }
  const resource = await prisma.courseResource.findFirst({
    where: { id: parsedParams.data.id },
    select: {
      id: true,
      courseId: true,
      type: true,
      previewType: true,
    },
  });
  const isPdf = resource?.type.toUpperCase() === "PDF"
    || resource?.previewType?.toUpperCase() === "PDF";
  if (!resource || !isPdf) {
    return Response.json({ message: "只有 PDF 资源可以切换展示方式。" }, { status: 404 });
  }
  if (!(await canAccessLegacyCourse(auth.claims, resource.courseId, "write"))) {
    return Response.json({ message: "课程当前不允许修改资源。" }, { status: 403 });
  }

  const durableEvent = await prisma.$transaction(async (tx) => {
    await tx.courseResource.update({
      where: { id: resource.id },
      data: { displayMode: parsedBody.data.displayMode },
    });
    const updatedCourse = await tx.course.update({
      where: { id: resource.courseId },
      data: { version: { increment: 1 } },
      select: { version: true },
    });
    return tx.courseEvent.create({
      data: {
        courseId: resource.courseId,
        requestId: randomUUID(),
        type: "UPDATE_COURSE",
        actorId: auth.claims.sub!,
        actorRole: auth.claims.role,
        courseVersion: updatedCourse.version,
        payload: { source: "course-resource-display-mode", scope: "course" },
      },
      select: { cursor: true, courseVersion: true },
    });
  });
  try {
    await publishCourseEvent(resource.courseId, {
      type: "course-updated",
      courseId: resource.courseId,
      at: new Date().toISOString(),
      payload: {
        actionType: "UPDATE_COURSE",
        courseVersion: durableEvent.courseVersion,
        eventCursor: durableEvent.cursor.toString(),
      },
    });
  } catch (error) {
    console.error("[uploads] display mode saved; realtime publish failed", {
      courseId: resource.courseId,
      eventCursor: durableEvent.cursor.toString(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return Response.json({
    id: resource.id,
    displayMode: parsedBody.data.displayMode,
  });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;
  const parsed = ParamsSchema.safeParse(await context.params);
  if (!parsed.success) return new Response(null, { status: 404 });
  const file = await prisma.uploadFile.findFirst({
    where: { id: parsed.data.id, deletedAt: null },
  });
  if (!file || (auth.claims.role !== "teacher" && file.uploadedById !== auth.claims.sub)) {
    return new Response(null, { status: 404 });
  }
  if (file.courseId && !(await canAccessLegacyCourse(auth.claims, file.courseId, "write"))) {
    return new Response(null, { status: 403 });
  }
  if (isFinalArtifactUpload(file.referencedBy)) {
    return Response.json({ code: "IMMUTABLE_ARTIFACT", message: "最终成果版本不可删除。" }, { status: 409 });
  }
  if (path.basename(file.storedName) !== file.storedName) {
    return new Response(null, { status: 404 });
  }

  const durableEvent = await prisma.$transaction(async (tx) => {
    const removedResource = await tx.courseResource.deleteMany({
      where: { id: file.id, ...(file.courseId ? { courseId: file.courseId } : {}) },
    });
    await tx.uploadFile.update({
      where: { id: file.id },
      data: { deletedAt: new Date(), referencedBy: [], refCount: 0 },
    });
    if (file.courseId && removedResource.count > 0) {
      const updatedCourse = await tx.course.update({
        where: { id: file.courseId },
        data: { version: { increment: 1 } },
        select: { version: true },
      });
      return tx.courseEvent.create({
        data: {
          courseId: file.courseId,
          requestId: randomUUID(),
          type: "UPDATE_COURSE",
          actorId: auth.claims.sub!,
          actorRole: auth.claims.role,
          courseVersion: updatedCourse.version,
          payload: { source: "course-resource-delete", scope: "course" },
        },
        select: { cursor: true, courseVersion: true },
      });
    }
    return null;
  });
  if (durableEvent && file.courseId) {
    try {
      await publishCourseEvent(file.courseId, {
        type: "course-updated",
        courseId: file.courseId,
        at: new Date().toISOString(),
        payload: {
          actionType: "UPDATE_COURSE",
          courseVersion: durableEvent.courseVersion,
          eventCursor: durableEvent.cursor.toString(),
        },
      });
    } catch (error) {
      console.error("[uploads] resource deletion publish failed; clients will reconcile by cursor", {
        courseId: file.courseId,
        eventCursor: durableEvent.cursor.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await unlink(
    /* turbopackIgnore: true */ path.join(dataDir, file.storedName),
  ).catch((error) => {
    console.warn("[uploads] Resource metadata deleted but disk cleanup failed", {
      uploadId: file.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  if (file.previewStoredName && path.basename(file.previewStoredName) === file.previewStoredName) {
    await unlink(
      /* turbopackIgnore: true */ path.join(dataDir, file.previewStoredName),
    ).catch((error) => {
      console.warn("[uploads] Resource preview metadata deleted but disk cleanup failed", {
        uploadId: file.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return new Response(null, { status: 204 });
}

function classroomPreviewName(fileName: string): string {
  const parsed = path.parse(fileName);
  return `${parsed.name}-课堂版.pdf`;
}

function finalArtifactReferences(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string =>
    typeof item === "string" && /^(?:project-pdf-version|project-version):/.test(item),
  ).map((item) => item.slice(item.indexOf(":") + 1)).filter(Boolean);
}

function isFinalArtifactUpload(value: unknown): boolean {
  return finalArtifactReferences(value).length > 0;
}

function canAccess(
  claims: AuthClaims,
  courseId: string | null,
  uploadedById: string,
): boolean {
  if (claims.role === "teacher") return true;
  if (claims.sub === uploadedById) return true;
  return !!courseId && claims.courseId === courseId;
}

function parseRange(
  header: string | null,
  totalSize: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, totalSize - suffix), end: totalSize - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : totalSize - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= totalSize ||
    end < start
  ) {
    return null;
  }
  return { start, end: Math.min(end, totalSize - 1) };
}
