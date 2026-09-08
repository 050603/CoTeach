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
  if (auth.claims.role === "student" && auth.claims.courseId !== courseId) return new Response(null, { status: 404 });
  if (!(await canAccessLegacyCourse(auth.claims, courseId, "read"))) return new Response(null, { status: 403 });
  if (auth.claims.role === "student") {
    const member = await prisma.student.findFirst({ where: { courseId, id: auth.claims.studentId }, select: { id: true } });
    if (!member) return new Response(null, { status: 404 });
  }

  const [document, pdf] = await Promise.all([
    prisma.projectDocumentVersion.findFirst({ where: { id: versionId, courseId, stageKey: "make", status: "submitted" } }),
    prisma.projectPdfVersion.findFirst({ where: { id: versionId, courseId, stageKey: "make", status: "submitted" } }),
  ]);
  const artifact = document ?? pdf;
  if (!artifact) return new Response(null, { status: 404 });

  if (auth.claims.role === "student" && artifact.studentId !== auth.claims.studentId) {
    const active = await prisma.showcasePresentation.findFirst({
      where: { courseId, status: "active", artifactVersionId: versionId },
      select: { id: true },
    });
    if (!active) return new Response(null, { status: 404 });
  }

  if (document) {
    return Response.json({
      kind: "document",
      versionId: document.id,
      title: document.title,
      sequence: document.sequence,
      submittedAt: document.submittedAt?.toISOString(),
      html: document.sourceHtml,
    }, { headers: { "Cache-Control": "private, no-store" } });
  }

  const file = await prisma.uploadFile.findFirst({
    where: { id: pdf!.uploadId, courseId, deletedAt: null },
    select: { storedName: true, mimeType: true, fileName: true, size: true },
  });
  if (!file || path.basename(file.storedName) !== file.storedName) return new Response(null, { status: 404 });
  const dataDir = process.env.UPLOAD_DIR?.trim() || path.resolve(".openpbl-data", "uploads");
  const target = path.join(dataDir, file.storedName);
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
  const disposition = download || pdf!.kind === "file" ? "attachment" : "inline";
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
    status: range ? 206 : 200,
    headers: {
      "Content-Type": file.mimeType || "application/pdf",
      "Content-Length": String(end - start + 1),
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${info.size}` } : {}),
      "Accept-Ranges": "bytes",
      "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
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
