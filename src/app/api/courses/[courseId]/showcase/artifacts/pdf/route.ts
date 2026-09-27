import { createHash, randomUUID } from "node:crypto";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { checkDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";
import { rateLimitedResponse } from "@/lib/auth/rate-limit";
import { isDatabaseConfigured, prisma } from "@/lib/db/client";
import { publishCourseEvent } from "@/lib/realtime/event-bus";
import { canAccessLegacyCourse } from "@/lib/platform/access";
import { ArtifactUploadError, persistArtifactUpload, readArtifactUploadReceipt } from "@/lib/showcase/artifact-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const dataDir = process.env.UPLOAD_DIR?.trim() || path.resolve(".openpbl-data", "uploads");
type AllowedArtifact = { detected?: string[]; mimeType: string; plainText?: boolean; kind: "pdf" | "file" };
const ALLOWED_ARTIFACTS: Record<string, AllowedArtifact> = {
  ".pdf": { detected: ["pdf"], mimeType: "application/pdf", kind: "pdf" },
  ".doc": { detected: ["doc"], mimeType: "application/msword", kind: "file" },
  ".docx": { detected: ["docx", "zip"], mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "file" },
  // Office Open XML files are ZIP containers; file-type versions differ on
  // whether they identify the package as the specific office subtype or just
  // `zip`, so accept both signatures after the extension has been checked.
  ".pptx": { detected: ["pptx", "zip"], mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", kind: "file" },
  ".xlsx": { detected: ["xlsx", "zip"], mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "file" },
  ".zip": { detected: ["zip"], mimeType: "application/zip", kind: "file" },
  ".rar": { detected: ["rar"], mimeType: "application/vnd.rar", kind: "file" },
  ".7z": { detected: ["7z"], mimeType: "application/x-7z-compressed", kind: "file" },
  ".mp4": { detected: ["mp4", "m4v"], mimeType: "video/mp4", kind: "file" },
  ".mov": { detected: ["mov", "mp4", "m4v"], mimeType: "video/quicktime", kind: "file" },
  ".webm": { detected: ["webm"], mimeType: "video/webm", kind: "file" },
  ".mp3": { detected: ["mp3"], mimeType: "audio/mpeg", kind: "file" },
  ".wav": { detected: ["wav"], mimeType: "audio/wav", kind: "file" },
  ".m4a": { detected: ["m4a", "mp4"], mimeType: "audio/mp4", kind: "file" },
  ".ogg": { detected: ["ogg", "opus"], mimeType: "audio/ogg", kind: "file" },
  ".png": { detected: ["png"], mimeType: "image/png", kind: "file" },
  ".jpg": { detected: ["jpg"], mimeType: "image/jpeg", kind: "file" },
  ".jpeg": { detected: ["jpg"], mimeType: "image/jpeg", kind: "file" },
  ".webp": { detected: ["webp"], mimeType: "image/webp", kind: "file" },
  ".gif": { detected: ["gif"], mimeType: "image/gif", kind: "file" },
  ".txt": { mimeType: "text/plain", plainText: true, kind: "file" },
  ".md": { mimeType: "text/markdown", plainText: true, kind: "file" },
  ".csv": { mimeType: "text/csv", plainText: true, kind: "file" },
  ".json": { mimeType: "application/json", plainText: true, kind: "file" },
  ".xml": { mimeType: "application/xml", plainText: true, kind: "file" },
  ".yaml": { mimeType: "application/yaml", plainText: true, kind: "file" },
  ".yml": { mimeType: "application/yaml", plainText: true, kind: "file" },
  ".sql": { mimeType: "application/sql", plainText: true, kind: "file" },
  ".py": { mimeType: "text/x-python", plainText: true, kind: "file" },
  ".js": { mimeType: "text/javascript", plainText: true, kind: "file" },
  ".jsx": { mimeType: "text/jsx", plainText: true, kind: "file" },
  ".ts": { mimeType: "text/typescript", plainText: true, kind: "file" },
  ".tsx": { mimeType: "text/tsx", plainText: true, kind: "file" },
  ".html": { mimeType: "text/html", plainText: true, kind: "file" },
  ".css": { mimeType: "text/css", plainText: true, kind: "file" },
  ".java": { mimeType: "text/x-java-source", plainText: true, kind: "file" },
  ".c": { mimeType: "text/x-c", plainText: true, kind: "file" },
  ".cpp": { mimeType: "text/x-c++src", plainText: true, kind: "file" },
  ".h": { mimeType: "text/x-c", plainText: true, kind: "file" },
};
const MetadataSchema = z.object({
  title: z.string().trim().max(200).optional(),
  requestId: z.string().uuid().optional(),
}).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;
  const auth = await authenticateRequest(request, "student");
  if ("response" in auth) return auth.response;
  if (auth.claims.role !== "student") return errorResponse("FORBIDDEN", "只有学生可以提交本地成果。", 403);
  const studentId = auth.claims.sub!;
  if (!isDatabaseConfigured()) return errorResponse("DATABASE_REQUIRED", "本地成果提交需要连接数据库。", 503);
  const { courseId } = await context.params;
  if (!(await canAccessLegacyCourse(auth.claims, courseId, "read"))) return errorResponse("COURSE_LOCKED", "课程当前不允许提交成果。", 403);
  let targetPath: string | undefined;
  let databaseCommitAttempted = false;
  let committed = false;
  try {
    const form = await request.formData();
    const files = form.getAll("file");
    if (files.length !== 1 || !(files[0] instanceof File)) return errorResponse("FILE_REQUIRED", "请选择一个成果文件。", 400);
    const file = files[0];
    const originalName = path.basename(file.name).normalize("NFC");
    const extension = path.extname(originalName).toLowerCase();
    const allowed = ALLOWED_ARTIFACTS[extension];
    if (!allowed) return errorResponse("FILE_TYPE_UNSUPPORTED", "支持 PDF、Word、PPTX、表格、图片、音视频、压缩包、代码和文本文件。", 415);
    if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) return errorResponse("FILE_TOO_LARGE", "成果文件不能为空且不能超过 100 MiB。", 413);
    const metadata = MetadataSchema.safeParse({
      title: form.get("title") ?? undefined,
      requestId: form.get("requestId") ?? undefined,
    });
    if (!metadata.success) return errorResponse("INVALID_METADATA", "成果提交信息无效。", 400);
    const title = metadata.data.title || originalName;
    if (title.length > 200) return errorResponse("INVALID_METADATA", "成果标题不能超过 200 个字符。", 400);
    const bytes = Buffer.from(await file.arrayBuffer());
    const detected = await fileTypeFromBuffer(bytes).catch(() => null);
    if (allowed.plainText) {
      if (bytes.includes(0)) return errorResponse("FILE_SIGNATURE_MISMATCH", "代码或文本成果不能包含二进制内容。", 415);
    } else if (!detected || !allowed.detected?.includes(detected.ext)) {
      return errorResponse("FILE_SIGNATURE_MISMATCH", "文件内容与扩展名不一致。", 415);
    }

    const headerRequestId = request.headers.get('idempotency-key');
    if (headerRequestId && !z.string().uuid().safeParse(headerRequestId).success) return errorResponse('INVALID_METADATA', '成果提交编号无效。', 400);
    if (headerRequestId && metadata.data.requestId && headerRequestId !== metadata.data.requestId) return errorResponse('INVALID_METADATA', '成果提交编号不一致。', 400);
    const legacyTraceId = request.headers.get('x-request-id');
    const requestId = metadata.data.requestId ?? headerRequestId
      ?? (legacyTraceId && legacyTraceId.length <= 160 ? legacyTraceId : undefined) ?? randomUUID();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const input = { courseId, studentId, requestId, title, originalName, mimeType: allowed.mimeType, size: bytes.length, sha256, kind: allowed.kind };
    const previous = await readArtifactUploadReceipt(input);
    if (previous) return Response.json(previous);
    const limit = await checkDistributedRateLimit({ namespace: 'showcase-artifact-submit', key: `${studentId}:${courseId}`, limit: 10, windowSeconds: 60 * 60 });
    if (!limit.allowed) return rateLimitedResponse(limit.retryAfterMs);
    const uploadId = randomUUID();
    const versionId = randomUUID();
    const storedName = `${uploadId}${extension}`;
    targetPath = path.join(dataDir, storedName);
    await mkdir(dataDir, { recursive: true });
    await writeFile(targetPath, bytes, { flag: "wx", mode: 0o600 });
    const info = await stat(targetPath);
    if (info.size !== bytes.length) throw new Error('Incomplete artifact file write');
    databaseCommitAttempted = true;
    const durable = await persistArtifactUpload({ ...input, uploadId, versionId, storageKey: storedName });
    committed = !durable.duplicate;
    if (durable.duplicate) {
      await unlink(targetPath).catch(() => undefined);
      targetPath = undefined;
      return Response.json(durable.response);
    }
    await publishCourseEvent(courseId, {
      type: "course-updated",
      courseId,
      at: new Date().toISOString(),
      payload: {
        actionType: "UPDATE_COURSE",
        courseVersion: durable.courseVersion,
        eventCursor: durable.eventCursor,
        scope: "student",
        studentId,
      },
    }).catch(() => undefined);
    return Response.json(durable.response, { status: 201 });
  } catch (error) {
    if (databaseCommitAttempted && !committed && targetPath) {
      try { committed = Boolean(await prisma.fileAsset.findUnique({ where: { storageKey: path.basename(targetPath) }, select: { id: true } })); }
      catch { committed = true; } // Ambiguous COMMIT: preserve bytes until the database can confirm ownership.
    }
    if (targetPath && !committed) await unlink(targetPath).catch(() => undefined);
    if (error instanceof ArtifactUploadError) return errorResponse(error.code, error.message, error.status);
    console.error("[showcase/artifact] upload failed", error);
    return errorResponse("ARTIFACT_SUBMIT_FAILED", "成果文件提交失败，请稍后重试。", 500);
  }
}

function errorResponse(code: string, message: string, status: number): Response {
  return Response.json({ code, message }, { status });
}
