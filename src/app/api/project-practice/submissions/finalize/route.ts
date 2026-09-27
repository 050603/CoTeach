import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { prisma } from "@/lib/db/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { authorizeDocumentArchiveScope, commitDocumentArchive } from "@/lib/project-practice/document-finalize";
import { legacyAiError } from "@/lib/ai-collaboration/legacy-scope";
import { buildProjectDocumentDocx, ProjectDocumentArchiveError } from "@/lib/project-practice/document-archive";
import { isDocumentConversionBusy } from "@/lib/project-practice/document-conversion-queue";
import { PlatformError } from "@/lib/platform/repository";
import { publishCourseEvent } from "@/lib/realtime/event-bus";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
const BodySchema = z.object({ courseId: z.string().min(1).max(128), submissionId: z.string().min(1).max(128), studentId: z.string().min(1).max(128).optional(), stageKey: z.literal("make"), expectedVersion: z.number().int().positive(), requestId: z.string().min(1).max(160).optional() }).strict();
const DATA_DIR = process.env.UPLOAD_DIR?.trim() || path.resolve(".openpbl-data", "uploads");
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function response(payload: Record<string, unknown>, timings: string[]) { return Response.json({ ok: true, versionId: payload.versionId, sequence: payload.sequence, submittedAt: payload.submittedAt, docxUploadId: payload.docxUploadId, submissionVersion: payload.submissionVersion, downloadUrl: `/api/uploads/${payload.docxUploadId}?download=1`, sha256: payload.sha256 }, { headers: { "Server-Timing": timings.join(", ") } }); }
export async function POST(request: Request) {
  const timings: string[] = [];
  let phaseStart = performance.now();
  const mark = (name: string) => { const now = performance.now(); timings.push(`${name};dur=${(now - phaseStart).toFixed(2)}`); phaseStart = now; };
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "student"); if ("response" in auth) return auth.response;
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ code: "INVALID_REQUEST", message: "提交参数无效。" }, { status: 400 });
  const body = parsed.data;
  mark("authentication");
  let writtenPath: string | undefined;
  let writtenAssetId: string | undefined;
  let committed = false;
  try {
    const scope = await authorizeDocumentArchiveScope(auth.claims, body.courseId, body.studentId);
    const participation = scope.participation;
    const requestId = body.requestId ?? request.headers.get("x-request-id") ?? randomUUID();
    const receiptKey = `document-finalize:${createHash("sha256").update(JSON.stringify([participation.id, scope.user.id, requestId])).digest("hex")}`;
    const fingerprint = createHash("sha256").update(JSON.stringify([body.submissionId, body.expectedVersion, body.stageKey])).digest("hex");
    const existing = await prisma.domainEvent.findUnique({ where: { idempotencyKey: receiptKey } });
    mark("authorization");
    if (existing) {
      const payload = object(existing.payload);
      if (payload.fingerprint !== fingerprint) throw new PlatformError("IDEMPOTENCY_CONFLICT", "请求标识已用于其他提交", 409);
      return response(payload, timings);
    }
    const submission = await prisma.classroomSubmission.findFirst({ where: { participationId: participation.id, OR: [{ id: body.submissionId }, { payload: { path: ["view", "id"], equals: body.submissionId } }] } });
    if (!submission) throw new PlatformError("SUBMISSION_NOT_FOUND", "找不到可提交的项目文档", 404);
    const originalPayload = object(submission.payload);
    const draft = object(originalPayload.view ?? originalPayload);
    if (draft.type !== "document" || String(draft.stageKey ?? submission.stageKey).split(":")[0] !== "make") throw new PlatformError("DOCUMENT_REQUIRED", "只有项目实践文档可生成 Word 归档", 422);
    if (Number(draft.version ?? 1) !== body.expectedVersion) throw new PlatformError("DRAFT_VERSION_CONFLICT", "文档已变化，请保存最新内容后提交", 409);
    const sourceHtml = typeof draft.content === "string" ? draft.content : "";
    const title = typeof draft.title === "string" && draft.title.trim() ? draft.title.trim() : "项目实践成果";
    if (sourceHtml.length > 120000) throw new PlatformError("DOCUMENT_TOO_LARGE", "文档过长，请拆分后提交", 413);
    mark("draft");
    const archive = await buildProjectDocumentDocx({ html: sourceHtml, courseId: body.courseId, studentId: scope.user.id, title });
    mark("docx");
    const uploadId = randomUUID();
    writtenAssetId = uploadId;
    const storageKey = `${uploadId}.docx`;
    writtenPath = path.join(DATA_DIR, storageKey);
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(writtenPath, archive.bytes, { flag: "wx", mode: 0o600 });
    mark("file");
    const transactionStart = performance.now();
    let firstCallbackStart: number | undefined;
    let lastCallbackEnd = transactionStart;
    let callbackMs = 0;
    const commitPhases: Partial<Record<"lock" | "scope" | "lock_scope" | "lock_scope_write" | "write", number>> = {};
    const result = await runMutationTransaction(async tx => {
      const callbackStart = performance.now();
      firstCallbackStart ??= callbackStart;
      let segmentStart = callbackStart;
      try {
        return await commitDocumentArchive(tx, {
          courseId: body.courseId, studentId: scope.user.id, participationId: participation.id, offeringId: scope.offering.id,
          sessionVersion: auth.claims.sv,
          submissionId: submission.id, submissionViewId: body.submissionId, originalPayload: submission.payload,
          expectedVersion: body.expectedVersion, receiptKey, fingerprint, requestId, title, uploadId, storageKey,
          size: archive.bytes.length, sha256: archive.sha256, sourceHtml: archive.sourceHtml,
        }, phase => {
          const now = performance.now(); commitPhases[phase] = (commitPhases[phase] ?? 0) + now - segmentStart; segmentStart = now;
        });
      } finally { lastCallbackEnd = performance.now(); callbackMs += lastCallbackEnd - callbackStart; }
    }, {
      lowPriorityCourseId: body.courseId,
      admissionTimeoutError: () => new PlatformError("COURSE_BUSY", "课堂提交繁忙，请稍后重试", 503),
    });
    const transactionEnd = performance.now();
    mark("commit");
    // Callback segments accumulate across retries. Remaining combines FIFO/
    // admission, BEGIN/COMMIT and retry handling; it is not a DB COMMIT measurement.
    for (const [name, duration] of Object.entries({ ...commitPhases, callback: callbackMs,
      before_callback: (firstCallbackStart ?? transactionEnd) - transactionStart,
      after_callback: transactionEnd - lastCallbackEnd,
      remaining: Math.max(0, transactionEnd - transactionStart - callbackMs),
    })) timings.push(`archive_${name};dur=${duration.toFixed(2)}`);
    committed = !result.reused;
    if (result.reused) await unlink(writtenPath).catch(() => undefined);
    try { await publishCourseEvent(body.courseId, { type: "course-updated", courseId: body.courseId, at: new Date().toISOString(), payload: { source: "document-finalized", studentId: scope.user.id } }); }
    catch (error) { console.error("[document-finalize] realtime notification failed", error); }
    mark("notification");
    return response(result.payload, timings);
  } catch (error) {
    if (writtenPath && writtenAssetId && !committed) {
      // A lost commit acknowledgement must not delete an already referenced archive.
      try {
        const durableFile = await prisma.fileAsset.findUnique({ where: { id: writtenAssetId }, select: { id: true } });
        if (!durableFile) await unlink(writtenPath).catch(() => undefined);
      } catch (cleanupError) { console.error("[document-finalize] keeping file until database commit can be verified", cleanupError); }
    }
    if (isDocumentConversionBusy(error)) return Response.json({ code: error.code, message: error.message }, { status: 503, headers: { "Retry-After": "1" } });
    if (error instanceof ProjectDocumentArchiveError) return Response.json({ code: error.code, message: error.message }, { status: 422 });
    return legacyAiError(error);
  }
}
