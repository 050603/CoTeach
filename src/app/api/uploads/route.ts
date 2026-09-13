import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, open, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import { z } from "zod";
import { prisma, isDatabaseConfigured } from "@/lib/db/client";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { checkDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";
import { rateLimitedResponse } from "@/lib/auth/rate-limit";
import { publishCourseEvent } from "@/lib/realtime/event-bus";
import { resolveUploadScope } from "@/lib/uploads/scope";
import { persistUpload } from "@/lib/uploads/assets";
import { canAccessLegacyCourse } from "@/lib/platform/access";
import type { AuthClaims } from "@/lib/auth/session";
import {
  convertPresentationToPdf,
  PresentationConversionError,
} from "@/lib/uploads/presentation-converter";
import {
  GENERATION_REFERENCE_ACCEPT,
} from "@/lib/course-design/generation-references";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dataDir = process.env.UPLOAD_DIR?.trim() || path.resolve(".openpbl-data", "uploads");
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 256 * 1024;
const MAX_VIDEO_UPLOAD_BYTES = 500 * 1024 * 1024;
const STREAM_SIGNATURE_BYTES = 8 * 1024;

const UploadFieldsSchema = z.object({
  title: z.string().trim().max(200).optional(),
  courseId: z.string().trim().min(1).max(128).optional(),
  bindAsCourseResource: z.literal("true").optional(),
  stageKey: z.string().trim().min(1).max(64).optional(),
  pdfDisplayMode: z.enum(["document", "slides"]).optional(),
  purpose: z.enum(["generation-reference", "course-resource-package"]).optional(),
});

type AllowedUploadType = {
  detected?: string[];
  mime: string;
  plainText?: boolean;
};

const ALLOWED_TYPES: Record<string, AllowedUploadType> = {
  ".pdf": { detected: ["pdf"], mime: "application/pdf" },
  ".pptx": {
    detected: ["pptx"],
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
  ".xlsx": {
    detected: ["xlsx"],
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  ".docx": {
    detected: ["docx"],
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  ".doc": { detected: ["doc"], mime: "application/msword" },
  ".mp4": { detected: ["mp4", "m4v"], mime: "video/mp4" },
  ".mov": { detected: ["mov", "mp4", "m4v"], mime: "video/quicktime" },
  ".webm": { detected: ["webm"], mime: "video/webm" },
  ".mp3": { detected: ["mp3"], mime: "audio/mpeg" },
  ".wav": { detected: ["wav"], mime: "audio/wav" },
  ".m4a": { detected: ["m4a", "mp4"], mime: "audio/mp4" },
  ".ogg": { detected: ["ogg", "opus"], mime: "audio/ogg" },
  ".png": { detected: ["png"], mime: "image/png" },
  ".jpg": { detected: ["jpg"], mime: "image/jpeg" },
  ".jpeg": { detected: ["jpg"], mime: "image/jpeg" },
  ".webp": { detected: ["webp"], mime: "image/webp" },
  ".gif": { detected: ["gif"], mime: "image/gif" },
  ".zip": { detected: ["zip"], mime: "application/zip" },
  ".rar": { detected: ["rar"], mime: "application/vnd.rar" },
  ".7z": { detected: ["7z"], mime: "application/x-7z-compressed" },
  ".txt": { mime: "text/plain", plainText: true },
  ".md": { mime: "text/markdown", plainText: true },
  ".markdown": { mime: "text/markdown", plainText: true },
  ".csv": { mime: "text/csv", plainText: true },
  ".json": { mime: "application/json", plainText: true },
  ".py": { mime: "text/x-python", plainText: true },
  ".js": { mime: "text/javascript", plainText: true },
  ".jsx": { mime: "text/jsx", plainText: true },
  ".ts": { mime: "text/typescript", plainText: true },
  ".tsx": { mime: "text/tsx", plainText: true },
  ".html": { mime: "text/html", plainText: true },
  ".css": { mime: "text/css", plainText: true },
  ".xml": { mime: "application/xml", plainText: true },
  ".yaml": { mime: "application/yaml", plainText: true },
  ".yml": { mime: "application/yaml", plainText: true },
  ".sql": { mime: "application/sql", plainText: true },
  ".java": { mime: "text/x-java-source", plainText: true },
  ".c": { mime: "text/x-c", plainText: true },
  ".cpp": { mime: "text/x-c++src", plainText: true },
  ".h": { mime: "text/x-c", plainText: true },
};

export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;
  if (!isDatabaseConfigured()) {
    return apiError(requestId, "DATABASE_REQUIRED", "上传功能需要连接数据库。", 503);
  }

  const limit = await checkDistributedRateLimit({
    namespace: "upload",
    key: auth.claims.sub ?? "unknown",
    limit: 20,
    windowSeconds: 60 * 60,
  });
  if (!limit.allowed) return rateLimitedResponse(limit.retryAfterMs);

  const contentLength = Number(request.headers.get("content-length") ?? "");
  if (request.headers.get("x-openpbl-upload-mode") === "stream") {
    return uploadStreamedVideo(request, auth.claims, requestId, contentLength);
  }
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return apiError(requestId, "FILE_TOO_LARGE", "单个文件不能超过 50 MiB。", 413);
  }
  const contentType = request.headers.get("content-type");
  if (!contentType?.toLowerCase().startsWith("multipart/form-data")) {
    return apiError(requestId, "INVALID_CONTENT_TYPE", "请求必须使用 multipart/form-data。", 415);
  }

  let targetPath: string | null = null;
  let previewTargetPath: string | null = null;
  let failureStage = "parse-form-data";
  try {
    const form = await request.formData().catch(() => {
      throw new UploadHttpError("INVALID_MULTIPART", "无法解析上传内容，请重新选择文件后重试。", 400);
    });
    const files = form.getAll("file");
    if (files.length !== 1 || !(files[0] instanceof File)) {
      throw new UploadHttpError("FILE_REQUIRED", "请选择一个文件上传。", 400);
    }

    const file = files[0];
    const originalName = path.basename(file.name).normalize("NFC");
    const extension = path.extname(originalName).toLowerCase();
    const expected = ALLOWED_TYPES[extension];
    if (!expected) {
      throw new UploadHttpError("UNSUPPORTED_FILE", "暂不支持该文件格式。", 415);
    }
    if (file.size <= 0) {
      throw new UploadHttpError("EMPTY_FILE", "不能上传空文件。", 400);
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new UploadHttpError("FILE_TOO_LARGE", "单个文件不能超过 50 MiB。", 413);
    }

    failureStage = "validate-metadata";
    const rawFields = {
      title: getOptionalText(form, "title"),
      courseId: getOptionalText(form, "courseId"),
      bindAsCourseResource: getOptionalText(form, "bindAsCourseResource"),
      stageKey: getOptionalText(form, "stageKey"),
      pdfDisplayMode: getOptionalText(form, "pdfDisplayMode"),
      purpose: getOptionalText(form, "purpose"),
    };
    const parsedFields = UploadFieldsSchema.safeParse(rawFields);
    if (!parsedFields.success) {
      throw new UploadHttpError("INVALID_METADATA", "课程或文件信息无效，请刷新页面后重试。", 400);
    }

    const courseId = parsedFields.data.courseId ?? null;
    const bindAsCourseResource = parsedFields.data.bindAsCourseResource === "true";
    const isGenerationReference = parsedFields.data.purpose === "generation-reference";
    const isResourcePackage = parsedFields.data.purpose === "course-resource-package";
    if (isResourcePackage && (auth.claims.role !== "teacher" || !courseId || bindAsCourseResource)) {
      throw new UploadHttpError("INVALID_RESOURCE_PACKAGE_UPLOAD", "资源包必须由教师上传至备课课程，并作为私有生成资料保存。", 400);
    }
    if (isResourcePackage && extension !== ".zip") {
      throw new UploadHttpError("INVALID_RESOURCE_PACKAGE_UPLOAD", "请上传 ZIP 格式的完整资源包。", 415);
    }
    if (bindAsCourseResource && auth.claims.role !== "teacher") {
      throw new UploadHttpError("FORBIDDEN", "只有教师可以发布课程资源。", 403);
    }
    if (bindAsCourseResource && !courseId) {
      throw new UploadHttpError("COURSE_REQUIRED", "发布课程资源时必须指定课程。", 400);
    }
    if (isGenerationReference && auth.claims.role !== "teacher") {
      throw new UploadHttpError("FORBIDDEN", "只有教师可以上传课程生成参考资料。", 403);
    }
    if (isGenerationReference && !courseId) {
      throw new UploadHttpError("COURSE_REQUIRED", "上传课程生成参考资料时必须指定课程。", 400);
    }
    if (isGenerationReference && !GENERATION_REFERENCE_ACCEPT.split(",").includes(extension)) {
      throw new UploadHttpError(
        "UNSUPPORTED_GENERATION_REFERENCE",
        "课程生成参考资料支持 PDF、Word、PPT、TXT 和 Markdown 文件。",
        415,
      );
    }
    if (auth.claims.role === "student" && !courseId) {
      throw new UploadHttpError("FORBIDDEN", "学生只能向当前课程上传文件。", 403);
    }
    if (courseId && !(await canAccessLegacyCourse(auth.claims, courseId, "write"))) {
      throw new UploadHttpError("FORBIDDEN", "课程当前不允许上传文件。", 403);
    }
    const storageScope = courseId ? await resolveUploadScope(courseId) : null;
    if (courseId && (!storageScope || (storageScope.templateOwnerId && storageScope.templateOwnerId !== auth.claims.sub))) {
      throw new UploadHttpError('COURSE_NOT_FOUND', '课程不存在或无权上传。', 404);
    }
    if (isResourcePackage && !storageScope?.templateId) {
      throw new UploadHttpError("RESOURCE_PACKAGE_TEMPLATE_REQUIRED", "请在课程备课页面上传资源包。", 400);
    }
    const isNewClassroomPptx = extension === ".pptx"
      && bindAsCourseResource
      && Boolean(parsedFields.data.stageKey);
    if (isNewClassroomPptx && !isPresentationConversionEnabled()) {
      throw new UploadHttpError(
        "PPTX_CLASSROOM_REQUIRES_PDF",
        "为避免字体、图形和版式错位，请先在 PowerPoint 中导出 PDF，再上传到课堂。",
        415,
      );
    }

    failureStage = "inspect-file";
    const bytes = Buffer.from(await file.arrayBuffer());
    const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
    const detected = await fileTypeFromBuffer(bytes).catch(() => null);
    const isValidPlainText = expected.plainText
      ? !detected && isUtf8PlainText(bytes)
      : false;
    const hasExpectedSignature = expected.detected
      ? Boolean(detected && expected.detected.includes(detected.ext))
      : false;
    if (!isValidPlainText && !hasExpectedSignature) {
      throw new UploadHttpError("FILE_SIGNATURE_MISMATCH", "文件内容与扩展名不匹配，可能是文件已损坏或仅修改了后缀名。", 415);
    }

    const id = randomUUID();
    const storedName = `${id}${extension}`;
    targetPath = path.join(dataDir, storedName);
    failureStage = "write-file";
    await mkdir(/* turbopackIgnore: true */ dataDir, { recursive: true });
    await writeFile(/* turbopackIgnore: true */ targetPath, bytes, {
      flag: "wx",
      mode: 0o600,
    });
    // HTTP access remains protected by the authenticated upload route and an
    // Nginx `internal` location. World-readable file mode only lets the
    // unprivileged gateway process use sendfile after authorization succeeds.
    await chmod(/* turbopackIgnore: true */ targetPath, 0o644);
    const info = await stat(/* turbopackIgnore: true */ targetPath);
    if (info.size <= 0 || info.size > MAX_UPLOAD_BYTES) {
      throw new UploadHttpError("INVALID_FILE_SIZE", "文件大小无效。", 413);
    }

    let previewStoredName: string | null = null;
    let previewMimeType: string | null = null;
    let previewSize: number | null = null;
    let previewSha256: string | null = null;
    let previewUrl: string | null = null;
    let previewType: string | null = null;
    const needsClassroomPdf = isNewClassroomPptx && isPresentationConversionEnabled();
    if (needsClassroomPdf) {
      failureStage = "convert-presentation";
      previewStoredName = `${id}.classroom.pdf`;
      previewTargetPath = path.join(dataDir, previewStoredName);
      try {
        const preview = await convertPresentationToPdf({
          sourcePath: targetPath,
          targetPath: previewTargetPath,
        });
        previewMimeType = preview.mimeType;
        previewSize = preview.size;
        previewSha256 = await sha256File(previewTargetPath);
        previewUrl = `/api/uploads/${id}?variant=classroom`;
        previewType = "PDF";
      } catch (error) {
        if (error instanceof PresentationConversionError) {
          console.warn("[uploads] Presentation conversion rejected", {
            requestId,
            code: error.code,
            diagnostic: error.diagnostic,
          });
          throw new UploadHttpError(
            "PRESENTATION_CONVERSION_FAILED",
            "这份 PPT 无法生成稳定的课堂版，请将演示文稿导出为 PDF 后重新上传。",
            error.code === "CONVERTER_UNAVAILABLE" ? 503 : 422,
          );
        }
        throw error;
      }
    }

    const title = parsedFields.data.title || originalName;
    const fileType = extension.slice(1).toUpperCase();
    const formattedSize = formatSize(info.size);
    const url = `/api/uploads/${id}`;
    const displayMode = needsClassroomPdf
      ? "slides"
      : extension === ".pdf" && bindAsCourseResource
        ? parsedFields.data.pdfDisplayMode ?? null
        : null;
    failureStage = "bind-database";
    const durableEvent = await prisma.$transaction((tx) => persistUpload(tx, {
      id, originalName, storageKey: storedName, offeringId: storageScope?.offeringId ?? null, uploadedById: auth.claims.sub!,
      size: info.size, mimeType: expected.mime, title, type: fileType, bind: bindAsCourseResource,
      stageKey: parsedFields.data.stageKey, displayMode, previewStorageKey: previewStoredName, previewMimeType, previewSize,
      sha256: sourceSha256, previewSha256,
      ...(isResourcePackage ? { provenance: { schemaVersion: 1, operation: "course-resource-package-upload", courseId } } : {}),
    }));

    if (durableEvent && courseId) {
      try {
        await publishCourseEvent(courseId, {
          type: "course-updated",
          courseId,
          at: new Date().toISOString(),
          payload: {
            actionType: "UPDATE_COURSE",
            courseVersion: durableEvent.courseVersion,
            eventCursor: durableEvent.cursor.toString(),
          },
        });
      } catch (error) {
        console.error("[uploads] resource publish failed; clients will reconcile by cursor", {
          courseId,
          eventCursor: durableEvent.cursor.toString(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return Response.json(
      {
        id,
        title,
        fileName: originalName,
        fileType,
        size: formattedSize,
        sizeBytes: info.size,
        url,
        previewUrl: previewUrl ?? undefined,
        previewType: previewType ?? undefined,
        convertedToPdf: Boolean(previewUrl),
        displayMode: displayMode ?? undefined,
        stageKey: parsedFields.data.stageKey,
        boundToCourse: bindAsCourseResource && Boolean(storageScope?.offeringId),
        purpose: parsedFields.data.purpose,
      },
      { status: 201, headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    if (targetPath) {
      await unlink(/* turbopackIgnore: true */ targetPath).catch(() => undefined);
    }
    if (previewTargetPath) {
      await unlink(/* turbopackIgnore: true */ previewTargetPath).catch(() => undefined);
    }
    if (error instanceof UploadHttpError) {
      return apiError(requestId, error.code, error.message, error.status);
    }
    const detail = serializeUploadError(error);
    console.error(`[uploads] Unexpected upload failure ${JSON.stringify({ requestId, failureStage, ...detail })}`);
    return apiError(requestId, "UPLOAD_SERVICE_ERROR", "上传服务暂时不可用，请稍后重试。", 500);
  }
}

async function uploadStreamedVideo(
  request: Request,
  claims: AuthClaims,
  requestId: string,
  contentLength: number,
): Promise<Response> {
  if (claims.role !== "teacher") {
    return apiError(requestId, "FORBIDDEN", "只有教师可以发布课堂视频。", 403);
  }
  if (Number.isFinite(contentLength) && contentLength > MAX_VIDEO_UPLOAD_BYTES) {
    return apiError(requestId, "FILE_TOO_LARGE", "单个视频不能超过 500 MiB。", 413);
  }

  const originalName = decodeUploadHeader(request.headers.get("x-upload-file-name"));
  const rawFields = {
    title: decodeUploadHeader(request.headers.get("x-upload-title")),
    courseId: request.headers.get("x-upload-course-id") || undefined,
    bindAsCourseResource: request.headers.get("x-upload-bind-course-resource") || undefined,
    stageKey: request.headers.get("x-upload-stage-key") || undefined,
  };
  const fields = UploadFieldsSchema.safeParse(rawFields);
  if (!originalName || path.basename(originalName) !== originalName || !fields.success) {
    return apiError(requestId, "INVALID_METADATA", "课程或文件信息无效，请刷新页面后重试。", 400);
  }
  if (fields.data.bindAsCourseResource !== "true" || !fields.data.courseId) {
    return apiError(requestId, "COURSE_REQUIRED", "发布课堂视频时必须指定课程。", 400);
  }
  if (!(await canAccessLegacyCourse(claims, fields.data.courseId, "write"))) {
    return apiError(requestId, "FORBIDDEN", "课程当前不允许上传文件。", 403);
  }
  const extension = path.extname(originalName).toLowerCase();
  const expected = ALLOWED_TYPES[extension];
  if (!expected || ![".mp4", ".mov", ".webm"].includes(extension)) {
    return apiError(requestId, "UNSUPPORTED_FILE", "课堂视频支持 MP4、MOV 和 WebM 格式。", 415);
  }
  const storageScope = await resolveUploadScope(fields.data.courseId);
  if (!storageScope || (storageScope.templateOwnerId && storageScope.templateOwnerId !== claims.sub)) {
    return apiError(requestId, 'COURSE_NOT_FOUND', '课程不存在或无权上传。', 404);
  }
  if (!request.body) {
    return apiError(requestId, "FILE_REQUIRED", "请选择一个视频上传。", 400);
  }

  const id = randomUUID();
  const storedName = `${id}${extension}`;
  const targetPath = path.join(dataDir, storedName);
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(/* turbopackIgnore: true */ dataDir, { recursive: true });
    fileHandle = await open(/* turbopackIgnore: true */ targetPath, "wx", 0o600);
    const reader = request.body.getReader();
    const sourceHasher = createHash("sha256");
    let size = 0;
    let signature = Buffer.alloc(0);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_VIDEO_UPLOAD_BYTES) {
        await reader.cancel("video-too-large").catch(() => undefined);
        throw new UploadHttpError("FILE_TOO_LARGE", "单个视频不能超过 500 MiB。", 413);
      }
      if (signature.length < STREAM_SIGNATURE_BYTES) {
        const remaining = STREAM_SIGNATURE_BYTES - signature.length;
        signature = Buffer.concat([signature, Buffer.from(value.subarray(0, remaining))]);
      }
      const chunk = Buffer.from(value);
      sourceHasher.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await fileHandle.write(
          chunk,
          offset,
          chunk.length - offset,
          null,
        );
        if (bytesWritten <= 0) {
          throw new Error("Video upload stopped while writing to disk");
        }
        offset += bytesWritten;
      }
    }
    await fileHandle.close();
    fileHandle = undefined;
    if (size <= 0) throw new UploadHttpError("EMPTY_FILE", "不能上传空视频。", 400);
    if (Number.isFinite(contentLength) && contentLength > 0 && size !== contentLength) {
      throw new UploadHttpError(
        "UPLOAD_INCOMPLETE",
        `视频上传不完整（应收到 ${formatSize(contentLength)}，实际收到 ${formatSize(size)}），请重新上传。`,
        400,
      );
    }
    const storedInfo = await stat(/* turbopackIgnore: true */ targetPath);
    if (storedInfo.size !== size) {
      throw new UploadHttpError("UPLOAD_INCOMPLETE", "视频写入不完整，请重新上传。", 500);
    }
    await chmod(/* turbopackIgnore: true */ targetPath, 0o644);

    const detected = await fileTypeFromBuffer(signature).catch(() => null);
    if (!detected || !expected.detected?.includes(detected.ext)) {
      throw new UploadHttpError(
        "FILE_SIGNATURE_MISMATCH",
        "视频内容与扩展名不匹配，可能是文件已损坏或仅修改了后缀名。",
        415,
      );
    }

    const title = fields.data.title || originalName;
    const fileType = extension.slice(1).toUpperCase();
    const url = `/api/uploads/${id}`;
    const courseId = fields.data.courseId;
    const durableEvent = await prisma.$transaction((tx) => persistUpload(tx, {
      id, originalName, storageKey: storedName, offeringId: storageScope.offeringId, uploadedById: claims.sub!,
      size, mimeType: expected.mime, title, type: fileType, bind: true, stageKey: fields.data.stageKey,
      sha256: sourceHasher.digest("hex"),
    }));


    if (durableEvent) try {
      await publishCourseEvent(courseId, {
        type: "course-updated",
        courseId,
        at: new Date().toISOString(),
        payload: {
          actionType: "UPDATE_COURSE",
          courseVersion: durableEvent.courseVersion,
          eventCursor: durableEvent.cursor.toString(),
        },
      });
    } catch (error) {
      console.error("[uploads] video saved; realtime publish failed, clients will reconcile", {
        courseId,
        eventCursor: durableEvent.cursor.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return Response.json({
      id,
      title,
      fileName: originalName,
      fileType,
      size: formatSize(size),
      sizeBytes: size,
      url,
      stageKey: fields.data.stageKey,
      boundToCourse: Boolean(storageScope.offeringId),
    }, { status: 201, headers: { "x-request-id": requestId } });
  } catch (error) {
    await fileHandle?.close().catch(() => undefined);
    await unlink(/* turbopackIgnore: true */ targetPath).catch(() => undefined);
    if (error instanceof UploadHttpError) {
      return apiError(requestId, error.code, error.message, error.status);
    }
    console.error("[uploads] Unexpected streaming video upload failure", {
      requestId,
      ...serializeUploadError(error),
    });
    return apiError(requestId, "UPLOAD_SERVICE_ERROR", "视频上传服务暂时不可用，请稍后重试。", 500);
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(/* turbopackIgnore: true */ filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function decodeUploadHeader(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const decoded = decodeURIComponent(value).normalize("NFC");
    return decoded.length <= 500 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function isUtf8PlainText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

class UploadHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function getOptionalText(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function serializeUploadError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: String(error) };
  const databaseError = error as Error & { code?: string; meta?: unknown };
  return {
    name: databaseError.name,
    message: databaseError.message,
    code: databaseError.code,
    meta: databaseError.meta,
  };
}

function apiError(requestId: string, code: string, message: string, status: number): Response {
  return Response.json(
    { code, message, requestId },
    { status, headers: { "x-request-id": requestId } },
  );
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function isPresentationConversionEnabled(): boolean {
  return /^(?:1|true|yes|on)$/i.test(
    process.env.OPENPBL_PPTX_CLASSROOM_CONVERSION_ENABLED?.trim() ?? "",
  );
}
