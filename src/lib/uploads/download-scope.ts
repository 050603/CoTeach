import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';

export type DownloadFile = {
  id: string; offeringId: string | null; uploadedById: string;
  originalName: string; storageKey: string; mimeType: string;
  resource: { metadata: Prisma.JsonValue | null } | null;
};
type StudentDownloadScope = { kind: 'legacy' | 'denied' } | { kind: 'allowed'; file: DownloadFile };

/** Authenticated students only. Offering-less template assets retain their
 * existing resolver; an offering denial must never fall through to it.
 */
export async function readStudentOfferingDownload(
  studentId: string, fileId: string, db: Prisma.TransactionClient = prisma,
): Promise<StudentDownloadScope> {
  const [row] = await db.$queryRaw<Array<Omit<DownloadFile, 'resource'> & {
    resourceId: string | null; resourceMetadata: Prisma.JsonValue | null; allowed: boolean;
  }>>`SELECT f.id, f."offeringId", f."uploadedById", f."originalName", f."storageKey", f."mimeType",
      r.id AS "resourceId", r.metadata AS "resourceMetadata",
      (EXISTS (SELECT 1 FROM "User" u WHERE u.id = ${studentId}
          AND lower(u.status) = 'active' AND lower(u.role) = 'student')
        AND NOT EXISTS (SELECT 1 FROM "ClassroomTemplate" t WHERE t.id = f."offeringId")
        AND EXISTS (SELECT 1 FROM "Enrollment" e JOIN "CourseOffering" o ON o.id = e."offeringId"
          WHERE o.id = f."offeringId" AND e."userId" = ${studentId}
            AND e.status IN ('ACTIVE', 'active', 'COMPLETED', 'completed'))
        AND (f."uploadedById" = ${studentId} OR r.id IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM "ArtifactVersion" v JOIN "Artifact" a ON a.id = v."artifactId"
          JOIN "ClassroomParticipation" p ON p.id = a."participationId"
          JOIN "Enrollment" e ON e.id = p."enrollmentId"
          WHERE v."fileAssetId" = f.id AND e."userId" <> ${studentId})) AS allowed
    FROM "FileAsset" f LEFT JOIN "Resource" r ON r."fileAssetId" = f.id
    WHERE f.id = ${fileId} AND f."deletedAt" IS NULL`;
  if (!row) return { kind: 'denied' };
  if (!row.offeringId) return { kind: 'legacy' };
  if (!row.allowed) return { kind: 'denied' };
  return { kind: 'allowed', file: {
    id: row.id, offeringId: row.offeringId, uploadedById: row.uploadedById,
    originalName: row.originalName, storageKey: row.storageKey, mimeType: row.mimeType,
    resource: row.resourceId === null ? null : { metadata: row.resourceMetadata },
  } };
}
