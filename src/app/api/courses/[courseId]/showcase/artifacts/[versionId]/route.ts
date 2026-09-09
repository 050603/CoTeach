import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { authenticateRequest } from "@/lib/auth/request-guards";
import { canAccessLegacyCourse } from "@/lib/platform/access";
import { isDatabaseConfigured, prisma } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({
  courseId: z.string().min(1).max(128),
  versionId: z.string().uuid(),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ courseId: string; versionId: string }> },
) {
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;
  if (!isDatabaseConfigured()) return Response.json({ code: "DATABASE_REQUIRED", message: "最终成果读取需要连接数据库。" }, { status: 503 });
  const parsed = ParamsSchema.safeParse(await context.params);
  if (!parsed.success) return new Response(null, { status: 404 });
  const { courseId, versionId } = parsed.data;
  if (!(await canAccessLegacyCourse(auth.claims, courseId, 'read'))) return new Response(null, { status: 403 });
  const version = await prisma.artifactVersion.findFirst({ where: { id: versionId, status: 'SUBMITTED', artifact: { participation: { instanceId: courseId } } },
    include: { artifact: { include: { participation: { include: { enrollment: true } } } }, fileAsset: true } });
  if (!version) return new Response(null, { status: 404 });
  if (auth.claims.role === 'student' && version.artifact.participation.enrollment.userId !== auth.claims.sub) {
    const active = await prisma.showcasePresentation.findFirst({ where: { status: 'ACTIVE', artifactVersionId: versionId, participation: { instanceId: courseId } } });
    if (!active) return new Response(null, { status: 404 });
  }
  if (version.artifact.type === 'DOCUMENT_ARCHIVE') return Response.json({ kind: 'document', versionId: version.id,
    title: version.artifact.title, sequence: version.sequence, submittedAt: version.submittedAt?.toISOString(), html: version.sourceHtml ?? '' },
    { headers: { 'Cache-Control': 'private, no-store' } });
  const file = version.fileAsset;
  if (!file || file.deletedAt || path.basename(file.storageKey) !== file.storageKey) return new Response(null, { status: 404 });
  const dataDir = process.env.UPLOAD_DIR?.trim() || path.resolve(".openpbl-data", "uploads");
  const target = path.join(dataDir, file.storageKey);
  let info;
  try {
    info = await stat(target);
  } catch {
    return new Response(null, { status: 404 });
  }
  const range = parseRange(request.headers.get("range"), info.size);
  if (request.headers.has("range") && !range) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${info.size}` } });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? info.size - 1;
  const stream = createReadStream(target, { start, end });
  const download = new URL(request.url).searchParams.get("download") === "1";
  const disposition = download || version.artifact.type === "FILE_ARCHIVE" ? "attachment" : "inline";
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
    status: range ? 206 : 200,
    headers: {
      "Content-Type": file.mimeType || "application/pdf",
      "Content-Length": String(end - start + 1),
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${info.size}` } : {}),
      "Accept-Ranges": "bytes",
      "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

function parseRange(value: string | null, size: number): { start: number; end: number } | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) return null;
  const startText = match[1];
  const endText = match[2];
  if (!startText && !endText) return null;
  let start: number;
  let end: number;
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}
