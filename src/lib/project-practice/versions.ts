import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { ProjectDocumentVersion } from "@/lib/session/types";
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Immutable V2 artifact versions projected to the editor's historical response shape. */
export async function listProjectDocumentVersions(input: { courseId: string; studentId?: string; submissionId?: string; stageKey?: string }, db: Prisma.TransactionClient = prisma): Promise<ProjectDocumentVersion[]> {
  const [versions, receipts] = await Promise.all([
    db.artifactVersion.findMany({ where: { artifact: { type: "DOCUMENT_ARCHIVE", participation: { instanceId: input.courseId, ...(input.studentId ? { enrollment: { userId: input.studentId } } : {}) } } }, include: { artifact: { include: { participation: { include: { enrollment: true } } } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
    db.domainEvent.findMany({ where: { classroomInstanceId: input.courseId, eventType: "document_version_submitted" } }),
  ]);
  const metadata = new Map(receipts.map(row => { const payload = object(row.payload); return [String(payload.versionId), payload]; }));
  return versions.flatMap((row): ProjectDocumentVersion[] => {
    const detail = metadata.get(row.id) ?? {};
    const submissionId = String(detail.submissionId ?? row.artifact.id.replace(/^document:/, ""));
    const stageKey = String(detail.stageKey ?? "make");
    if ((input.submissionId && input.submissionId !== submissionId) || (input.stageKey && input.stageKey !== stageKey)) return [];
    return [{ id: row.id, courseId: input.courseId, submissionId, studentId: row.artifact.participation.enrollment.userId, stageKey, sequence: row.sequence, sourceVersion: Number(detail.sourceVersion ?? row.sequence), title: String(detail.title ?? row.artifact.title), sourceHtml: row.sourceHtml ?? "", docxUploadId: row.fileAssetId ?? undefined, docxSha256: row.sha256 ?? undefined, docxSize: row.size == null ? undefined : Number(row.size), status: row.status.toUpperCase() === "SUBMITTED" ? "submitted" : row.status.toUpperCase() === "FAILED" ? "failed" : "processing", submittedAt: row.submittedAt?.toISOString(), createdAt: row.createdAt.toISOString(), requestId: typeof detail.requestId === "string" ? detail.requestId : undefined }];
  });
}
