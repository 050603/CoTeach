import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { assetMetadata, hasSnapshotReference, recordOfferingMutation } from "@/lib/uploads/assets";
import { canReadTemplateAsset } from "@/lib/uploads/scope";
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

  const file = await prisma.fileAsset.findFirst({
    where: { id: parsed.data.id, deletedAt: null }, include: { resource: true, textbookFigures: { select: { id: true } }, artifactVersions: { select: { artifact: { select: { participation: { select: { enrollment: { select: { userId: true } } } } } } } } },
  });
  if (!file) return new Response(null, { status: 404 });
  const owns = file.uploadedById === auth.claims.sub;
  const courseAccess = file.offeringId && await canAccessLegacyCourse(auth.claims, file.offeringId, 'read');
  const templateAccess = !file.offeringId && !owns && auth.claims.role === 'student' && auth.claims.sub
    && await canReadTemplateAsset(auth.claims.sub, file.id);
  const sharedTextbookFigure = auth.claims.role === "teacher" && Boolean(file.textbookFigures?.length);
  if (!owns && !templateAccess && !sharedTextbookFigure && (!courseAccess || (!file.resource && auth.claims.role !== 'teacher'))) return new Response(null, { status: 404 });
  if (file.offeringId && !courseAccess) return new Response(null, { status: 404 });
  // Student outcomes remain private; teachers with offering access may review them.
  if (auth.claims.role === 'student' && file.artifactVersions.some((version) => version.artifact.participation.enrollment.userId !== auth.claims.sub)) return new Response(null, { status: 404 });
  const classroomVariant = new URL(request.url).searchParams.get('variant') === 'classroom';
  const metadata = assetMetadata(file.resource?.metadata);
  const preview = classroomVariant
    ? await prisma.fileAsset.findFirst({ where: { ...(typeof metadata.previewAssetId === 'string'
      ? { id: metadata.previewAssetId } : { storageKey: `${file.id}.classroom.pdf`, uploadedById: file.uploadedById }),
      offeringId: file.offeringId, deletedAt: null } }) : null;
  const selectedStoredName = classroomVariant ? preview?.storageKey : file.storageKey;
  const selectedMimeType = classroomVariant ? preview?.mimeType : file.mimeType;
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
  const responseHeaders = {
    "Content-Type": selectedMimeType,
    "Accept-Ranges": "bytes",
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(
      classroomVariant ? classroomPreviewName(file.originalName) : file.originalName,
    )}`,
    ETag: etag,
    "Last-Modified": info.mtime.toUTCString(),
    "Cache-Control": "private, max-age=3600, immutable",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  };
  if (
    request.headers.get("x-openpbl-accel-redirect") === "1"
    && (info.mode & 0o004) !== 0
  ) {
    // Nginx sets the trusted request header only after this authenticated API
    // route is selected. The internal redirect lets sendfile serve large media
    // without tying up the Next.js process that handles classroom controls.
    return new Response(null, {
      headers: {
        ...responseHeaders,
        "X-Accel-Redirect": `/_openpbl_uploads/${encodeURIComponent(selectedStoredName)}`,
      },
    });
  }
  const stream = createReadStream(/* turbopackIgnore: true */ target, { start, end });
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
    status: range ? 206 : 200,
    headers: {
      ...responseHeaders,
      "Content-Length": String(end - start + 1),
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${info.size}` } : {}),
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
  const resource = await prisma.resource.findFirst({ where: { fileAssetId: parsedParams.data.id }, include: { fileAsset: true } });
  const metadata = assetMetadata(resource?.metadata);
  if (!resource || resource.fileAsset?.deletedAt || !(resource.type.toUpperCase() === 'PDF' || metadata.previewType === 'PDF')) {
    return Response.json({ message: '只有 PDF 资源可以切换展示方式。' }, { status: 404 });
  }
  if (!(await canAccessLegacyCourse(auth.claims, resource.offeringId, 'write'))) return new Response(null, { status: 403 });
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Resource" WHERE "id" = ${resource.id} FOR UPDATE`;
    const current = await tx.resource.findUniqueOrThrow({ where: { id: resource.id } });
    await tx.resource.update({ where: { id: resource.id }, data: { metadata: { ...assetMetadata(current.metadata), displayMode: parsedBody.data.displayMode } } });
    await recordOfferingMutation(tx, resource.offeringId, auth.claims.sub!, 'resource-display-mode');
  });
  return Response.json({ id: resource.id, displayMode: parsedBody.data.displayMode });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;
  const auth = await authenticateRequest(request);
  if ('response' in auth) return auth.response;
  const parsed = ParamsSchema.safeParse(await context.params);
  if (!parsed.success) return new Response(null, { status: 404 });
  const file = await prisma.fileAsset.findFirst({ where: { id: parsed.data.id, deletedAt: null }, include: { resource: true } });
  if (!file || (!file.offeringId && file.uploadedById !== auth.claims.sub)
    || (auth.claims.role === 'student' && file.uploadedById !== auth.claims.sub)) return new Response(null, { status: 404 });
  if (file.offeringId && !(await canAccessLegacyCourse(auth.claims, file.offeringId, 'write'))) return new Response(null, { status: 403 });
  if (file.resource && auth.claims.role !== 'teacher') return new Response(null, { status: 403 });
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "FileAsset" WHERE "id" = ${file.id} FOR UPDATE`;
    if (await tx.artifactVersion.count({ where: { fileAssetId: file.id } }) || await hasSnapshotReference(tx, file.id)) return false;
    // Logical deletion preserves metadata; disk removal is deferred to cleanup.
    await tx.fileAsset.update({ where: { id: file.id }, data: { deletedAt: new Date() } });
    if (file.resource && file.offeringId) {
      const previewId = assetMetadata(file.resource.metadata).previewAssetId;
      if (typeof previewId === 'string' && !await tx.artifactVersion.count({ where: { fileAssetId: previewId } })
        && !await hasSnapshotReference(tx, previewId)) {
        await tx.fileAsset.updateMany({ where: { id: previewId, offeringId: file.offeringId, resource: null }, data: { deletedAt: new Date() } });
      }
      await tx.resource.delete({ where: { id: file.resource.id } });
      await recordOfferingMutation(tx, file.offeringId, auth.claims.sub!, 'resource-delete');
    }
    return true;
  });
  if (!result) return Response.json({ code: 'IMMUTABLE_ARTIFACT', message: '成果版本引用的文件不可删除。' }, { status: 409 });
  return new Response(null, { status: 204 });
}

function classroomPreviewName(fileName: string): string {
  const parsed = path.parse(fileName);
  return `${parsed.name}-课堂版.pdf`;
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
