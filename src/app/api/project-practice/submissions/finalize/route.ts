import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { prisma } from "@/lib/db/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { authorizeLegacyAiScope, legacyAiError } from "@/lib/ai-collaboration/legacy-scope";
import { buildProjectDocumentDocx, ProjectDocumentArchiveError } from "@/lib/project-practice/document-archive";
import { PlatformError } from "@/lib/platform/repository";
import { publishCourseEvent } from "@/lib/realtime/event-bus";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
const BodySchema = z.object({ courseId: z.string().min(1).max(128), submissionId: z.string().min(1).max(128), studentId: z.string().min(1).max(128).optional(), stageKey: z.literal("make"), expectedVersion: z.number().int().positive(), requestId: z.string().min(1).max(160).optional() }).strict();
const DATA_DIR = process.env.UPLOAD_DIR?.trim() || path.resolve(".openpbl-data", "uploads");
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function response(payload: Record<string, unknown>) { return Response.json({ ok: true, versionId: payload.versionId, sequence: payload.sequence, submittedAt: payload.submittedAt, docxUploadId: payload.docxUploadId, downloadUrl: `/api/uploads/${payload.docxUploadId}?download=1`, sha256: payload.sha256 }); }
export async function POST(request: Request) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "student"); if ("response" in auth) return auth.response;
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ code: "INVALID_REQUEST", message: "提交参数无效。" }, { status: 400 });
  const body = parsed.data;
  let writtenPath: string | undefined;
  let writtenAssetId: string | undefined;
  let committed = false;
  try {
    const scope = await authorizeLegacyAiScope(auth.claims, body.courseId, body.studentId, true);
    const participation = scope.participation!;
    const requestId = body.requestId ?? request.headers.get("x-request-id") ?? randomUUID();
    const receiptKey = `document-finalize:${createHash("sha256").update(JSON.stringify([participation.id, scope.user.id, requestId])).digest("hex")}`;
    const fingerprint = createHash("sha256").update(JSON.stringify([body.submissionId, body.expectedVersion, body.stageKey])).digest("hex");
    const existing = await prisma.domainEvent.findUnique({ where: { idempotencyKey: receiptKey } });
    if (existing) {
      const payload = object(existing.payload);
      if (payload.fingerprint !== fingerprint) throw new PlatformError("IDEMPOTENCY_CONFLICT", "请求标识已用于其他提交", 409);
      return response(payload);
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
    const archive = await buildProjectDocumentDocx({ html: sourceHtml, courseId: body.courseId, studentId: scope.user.id, title });
    const uploadId = randomUUID();
    writtenAssetId = uploadId;
    const storageKey = `${uploadId}.docx`;
    writtenPath = path.join(DATA_DIR, storageKey);
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(writtenPath, archive.bytes, { flag: "wx", mode: 0o600 });
    const result = await runMutationTransaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "ClassroomInstance" WHERE id = ${body.courseId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "ClassroomParticipation" WHERE id = ${participation.id} FOR UPDATE`;
      const duplicate = await tx.domainEvent.findUnique({ where: { idempotencyKey: receiptKey } });
      if (duplicate) {
        const payload = object(duplicate.payload);
        if (payload.fingerprint !== fingerprint) throw new PlatformError("IDEMPOTENCY_CONFLICT", "请求标识已用于其他提交", 409);
        return { payload, reused: true };
      }
      const current = await tx.classroomSubmission.findUniqueOrThrow({ where: { id: submission.id } });
      if (JSON.stringify(current.payload) !== JSON.stringify(submission.payload)) throw new PlatformError("DRAFT_VERSION_CONFLICT", "归档期间文档已变化，请重新提交", 409);
      const instance = await tx.classroomInstance.findUniqueOrThrow({ where: { id: body.courseId }, include: { activity: { include: { chapter: { include: { offering: true } } } } } });
      const enrollment = await tx.enrollment.findUniqueOrThrow({ where: { id: participation.enrollmentId } });
      if (instance.status.toUpperCase() !== "TEACHING" || instance.activity.chapter.offering.status.toUpperCase() !== "OPEN" || enrollment.status.toUpperCase() !== "ACTIVE") throw new PlatformError("COURSE_LOCKED", "课堂已结束，无法提交", 409);
      const artifactId = `document:${submission.id}`;
      await tx.artifact.upsert({ where: { id: artifactId }, create: { id: artifactId, participationId: participation.id, title, type: "DOCUMENT_ARCHIVE", status: "SUBMITTED" }, update: { title, status: "SUBMITTED" } });
      const last = await tx.artifactVersion.findFirst({ where: { artifactId }, orderBy: { sequence: "desc" }, select: { sequence: true } });
      const submittedAt = new Date();
      await tx.fileAsset.create({ data: { id: uploadId, originalName: `${title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 96)}.docx`, storageKey, offeringId: scope.offering.id, uploadedById: scope.user.id, size: BigInt(archive.bytes.length), mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sha256: archive.sha256 } });
      const version = await tx.artifactVersion.create({ data: { artifactId, sequence: (last?.sequence ?? 0) + 1, sourceHtml: archive.sourceHtml, fileAssetId: uploadId, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sha256: archive.sha256, size: BigInt(archive.bytes.length), status: "SUBMITTED", submittedAt } });
      const payload = { fingerprint, requestId, submissionId: body.submissionId, sourceVersion: body.expectedVersion, title, versionId: version.id, sequence: version.sequence, docxUploadId: uploadId, sha256: archive.sha256, size: archive.bytes.length, submittedAt: submittedAt.toISOString(), stageKey: "make" };
      const nextDraft = { ...draft, status: "submitted", submittedAt: submittedAt.toISOString() };
      await tx.classroomSubmission.update({ where: { id: submission.id }, data: { status: "SUBMITTED", submittedAt, payload: JSON.parse(JSON.stringify(originalPayload.view ? { ...originalPayload, view: nextDraft } : nextDraft)) as Prisma.InputJsonValue } });
      await tx.domainEvent.create({ data: { idempotencyKey: receiptKey, actorId: scope.user.id, offeringId: scope.offering.id, classroomInstanceId: body.courseId, participationId: participation.id, researchKey: enrollment.researchKey, eventType: "document_version_submitted", payload } });
      await tx.aiInteractionEvent.create({ data: { idempotencyKey: `ai:${receiptKey}`, userId: scope.user.id, offeringId: scope.offering.id, participationId: participation.id, researchKey: enrollment.researchKey, eventType: "submit", actor: "student", requestId, content: `提交项目实践文档第 ${version.sequence} 版`, payload: { legacy: { stageKey: "make", source: "submission", actorId: scope.user.id }, detail: payload, schemaVersion: 1 } } });
      const runtimeConfig = object(instance.runtimeConfig);
      await tx.classroomInstance.update({ where: { id: body.courseId }, data: { runtimeConfig: JSON.parse(JSON.stringify({ ...runtimeConfig, version: Number(runtimeConfig.version ?? 1) + 1 })) as Prisma.InputJsonValue } });
      return { payload, reused: false };
    });
    committed = !result.reused;
    if (result.reused) await unlink(writtenPath).catch(() => undefined);
    try { await publishCourseEvent(body.courseId, { type: "course-updated", courseId: body.courseId, at: new Date().toISOString(), payload: { source: "document-finalized", studentId: scope.user.id } }); }
    catch (error) { console.error("[document-finalize] realtime notification failed", error); }
    return response(result.payload);
  } catch (error) {
    if (writtenPath && writtenAssetId && !committed) {
      // A lost commit acknowledgement must not delete an already referenced archive.
      try {
        const durableFile = await prisma.fileAsset.findUnique({ where: { id: writtenAssetId }, select: { id: true } });
        if (!durableFile) await unlink(writtenPath).catch(() => undefined);
      } catch (cleanupError) { console.error("[document-finalize] keeping file until database commit can be verified", cleanupError); }
    }
    if (error instanceof ProjectDocumentArchiveError) return Response.json({ code: error.code, message: error.message }, { status: 422 });
    return legacyAiError(error);
  }
}
