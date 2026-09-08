import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { prisma, isDatabaseConfigured } from "@/lib/db/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { appendAiInteractionEvents } from "@/lib/ai-collaboration/audit-store";
import {
  buildProjectDocumentDocx,
  ProjectDocumentArchiveError,
} from "@/lib/project-practice/document-archive";
import { persistCourseUpdateInvalidation } from "@/lib/realtime/course-update-invalidation";
import { findLegacyParticipation } from "@/lib/platform/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const BodySchema = z.object({
  courseId: z.string().min(1).max(128),
  submissionId: z.string().min(1).max(128),
  studentId: z.string().min(1).max(128).optional(),
  stageKey: z.literal("make"),
  expectedVersion: z.number().int().positive(),
  requestId: z.string().min(1).max(160).optional(),
}).strict();

const DATA_DIR = process.env.UPLOAD_DIR?.trim() || path.resolve(".openpbl-data", "uploads");

function errorResponse(code: string, message: string, status: number): Response {
  return Response.json({ code, message }, { status });
}

async function getStudentId(request: Request, requested?: string): Promise<string | Response> {
  const auth = await authenticateRequest(request, "student");
  if ("response" in auth) return auth.response;
  if (auth.claims.role !== "student") return errorResponse("FORBIDDEN", "只有学生可以提交项目实践文档。", 403);
  if (requested && requested !== auth.claims.studentId) return errorResponse("STUDENT_SCOPE_MISMATCH", "不能提交其他学生的文档。", 403);
  return auth.claims.studentId;
}

async function reserveVersion(input: {
  courseId: string;
  submissionId: string;
  studentId: string;
  stageKey: string;
  sourceVersion: number;
  title: string;
  sourceHtml: string;
  requestId: string;
}) {
  return runMutationTransaction(async (tx) => {
    // Serialize sequence allocation per live submission. The UI disables
    // duplicate clicks, but this also keeps two API callers from receiving
    // the same immutable version number.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${input.submissionId}, 0))
    `;
    const existing = await tx.projectDocumentVersion.findFirst({
      where: { submissionId: input.submissionId, requestId: input.requestId },
    });
    if (existing) {
      if (existing.status === "submitted") return { row: existing, reused: true };
      const row = await tx.projectDocumentVersion.update({
        where: { id: existing.id },
        data: {
          status: "processing",
          error: null,
          sourceHtml: input.sourceHtml,
          sourceVersion: input.sourceVersion,
          title: input.title,
        },
      });
      return { row, reused: false };
    }
    const latest = await tx.projectDocumentVersion.findFirst({
      where: { submissionId: input.submissionId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    const row = await tx.projectDocumentVersion.create({
      data: {
        id: randomUUID(),
        courseId: input.courseId,
        submissionId: input.submissionId,
        studentId: input.studentId,
        stageKey: input.stageKey,
        sequence: (latest?.sequence ?? 0) + 1,
        sourceVersion: input.sourceVersion,
        title: input.title,
        sourceHtml: input.sourceHtml,
        requestId: input.requestId,
        status: "processing",
        participationId: (await findLegacyParticipation(tx, input.courseId, input.studentId))?.id,
      },
    });
    return { row, reused: false };
  });
}

export async function POST(request: Request) {
  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;
  if (!isDatabaseConfigured()) return errorResponse("DATABASE_REQUIRED", "提交归档需要连接数据库。", 503);
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse("INVALID_REQUEST", "提交参数无效。", 400);
  const body = parsed.data;
  const studentId = await getStudentId(request, body.studentId);
  if (studentId instanceof Response) return studentId;
  const requestId = body.requestId ?? request.headers.get("x-request-id") ?? randomUUID();

  const submission = await prisma.classroomSubmission.findFirst({
    where: {
      id: body.submissionId,
      courseId: body.courseId,
      studentId,
      stageKey: "make",
    },
  });
  if (!submission) return errorResponse("SUBMISSION_NOT_FOUND", "找不到可提交的项目实践文档。", 404);
  const payload = submission.payload as { type?: unknown; title?: unknown; content?: unknown };
  if (payload.type !== "document") return errorResponse("DOCUMENT_REQUIRED", "只有项目实践文档可以生成 Word 归档。", 422);
  if (submission.version !== body.expectedVersion) {
    return errorResponse("DRAFT_VERSION_CONFLICT", "文档刚刚发生了变化，请先保存最新内容后再提交。", 409);
  }
  const sourceHtml = typeof payload.content === "string" ? payload.content : "";
  const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : "项目实践成果";
  if (sourceHtml.length > 120_000) return errorResponse("DOCUMENT_TOO_LARGE", "文档内容过长，请拆分后再提交。", 413);

  const reservation = await reserveVersion({
    courseId: body.courseId,
    submissionId: body.submissionId,
    studentId,
    stageKey: body.stageKey,
    sourceVersion: submission.version,
    title,
    sourceHtml,
    requestId,
  });
  if (reservation.reused && reservation.row.docxUploadId) {
    return Response.json({
      ok: true,
      versionId: reservation.row.id,
      sequence: reservation.row.sequence,
      submittedAt: reservation.row.submittedAt?.toISOString(),
      docxUploadId: reservation.row.docxUploadId,
      downloadUrl: `/api/uploads/${reservation.row.docxUploadId}?download=1`,
      sha256: reservation.row.docxSha256,
    });
  }

  let archive: Awaited<ReturnType<typeof buildProjectDocumentDocx>>;
  try {
    archive = await buildProjectDocumentDocx({
      html: sourceHtml,
      courseId: body.courseId,
      studentId,
      title,
    });
  } catch (error) {
    const message = error instanceof ProjectDocumentArchiveError
      ? error.message
      : "Word 文件生成失败，请稍后重试。";
    await prisma.projectDocumentVersion.update({
      where: { id: reservation.row.id },
      data: { status: "failed", error: message },
    }).catch(() => undefined);
    return errorResponse(error instanceof ProjectDocumentArchiveError ? error.code : "DOCX_FAILED", message, 422);
  }

  const uploadId = randomUUID();
  const storedName = `${uploadId}.docx`;
  const targetPath = path.join(DATA_DIR, storedName);
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(targetPath, archive.bytes, { flag: "wx", mode: 0o600 });
    const submittedAt = new Date();
    const durable = await prisma.$transaction(async (tx) => {
      const file = await tx.uploadFile.create({
        data: {
          id: uploadId,
          fileName: `${title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 96) || "项目实践成果"}.docx`,
          storedName,
          courseId: body.courseId,
          uploadedById: studentId,
          uploadedByRole: "student",
          size: archive.bytes.length,
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          referencedBy: [`project-version:${reservation.row.id}`],
          refCount: 1,
        },
      });
      for (const imageId of archive.uploadIds) {
        const image = await tx.uploadFile.findFirst({ where: { id: imageId, courseId: body.courseId, deletedAt: null } });
        if (!image) continue;
        const refs = Array.isArray(image.referencedBy)
          ? (image.referencedBy as string[])
          : [];
        const reference = `project-version:${reservation.row.id}`;
        if (!refs.includes(reference)) {
          await tx.uploadFile.update({
            where: { id: image.id },
            data: { referencedBy: [...refs, reference], refCount: { increment: 1 } },
          });
        }
      }
      const participationId = (await findLegacyParticipation(tx, body.courseId, studentId))?.id;
      await tx.projectDocumentVersion.update({
        where: { id: reservation.row.id },
        data: {
          status: "submitted",
          sourceHtml: archive.sourceHtml,
          docxUploadId: file.id,
          docxSha256: archive.sha256,
          docxSize: archive.bytes.length,
          submittedAt,
          error: null,
          participationId,
        },
      });
      await tx.classroomSubmission.update({
        where: { id: submission.id },
        data: { status: "submitted", submittedAt: submittedAt.toISOString(), participationId },
      });
      const course = await tx.course.update({
        where: { id: body.courseId },
        data: { version: { increment: 1 } },
        select: { version: true },
      });
      return { file, courseVersion: course.version, submittedAt };
    });
    try {
      await persistCourseUpdateInvalidation({
        courseId: body.courseId,
        courseVersion: durable.courseVersion,
        updatedAt: durable.submittedAt.toISOString(),
        targetStudentId: studentId,
      });
    } catch (invalidationError) {
      // The submission transaction above is authoritative. A transient
      // realtime cursor failure must not invalidate an already saved Word
      // snapshot; clients will reconcile on their next poll.
      console.error("[project-practice/finalize] realtime invalidation failed", invalidationError);
    }
    try {
      await appendAiInteractionEvents([{
        courseId: body.courseId,
        studentId,
        stageKey: body.stageKey,
        source: "submission",
        eventType: "submit",
        actorRole: "student",
        actorId: studentId,
        content: `提交项目实践文档第 ${reservation.row.sequence} 版`,
        payload: {
          versionId: reservation.row.id,
          sequence: reservation.row.sequence,
          docxUploadId: uploadId,
          sha256: archive.sha256,
          size: archive.bytes.length,
          imageCount: archive.imageCount,
        },
        requestId,
      }]);
    } catch (auditError) {
      // The immutable Word snapshot is already durable. An audit replica
      // outage must not turn a successful submission into a failed one.
      console.error("[project-practice/finalize] audit event write failed", auditError);
    }
    return Response.json({
      ok: true,
      versionId: reservation.row.id,
      sequence: reservation.row.sequence,
      submittedAt: durable.submittedAt.toISOString(),
      docxUploadId: uploadId,
      downloadUrl: `/api/uploads/${uploadId}?download=1`,
      sha256: archive.sha256,
    });
  } catch (error) {
    await unlink(targetPath).catch(() => undefined);
    await prisma.projectDocumentVersion.update({
      where: { id: reservation.row.id },
      data: { status: "failed", error: "归档文件保存失败，请重试。" },
    }).catch(() => undefined);
    console.error("[project-practice/finalize] archive failed", error);
    return errorResponse("ARCHIVE_FAILED", "归档文件保存失败，请重试。", 503);
  }
}
