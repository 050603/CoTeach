import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';

export function assetMetadata(value: Prisma.JsonValue | null | undefined): Prisma.JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** JSON/HTML snapshots can reference uploads without an ArtifactVersion.fileAssetId FK. */
export async function hasSnapshotReference(tx: Prisma.TransactionClient, fileId: string): Promise<boolean> {
  const needle = `%/api/uploads/${fileId}%`;
  const rows = await tx.$queryRaw<Array<{ referenced: boolean }>>`SELECT EXISTS (
    SELECT 1 FROM "ArtifactVersion" WHERE "sourceHtml" LIKE ${needle}
    UNION ALL SELECT 1 FROM "ActivitySubmission" WHERE "payload"::text LIKE ${needle} OR "activitySnapshot"::text LIKE ${needle}
    UNION ALL SELECT 1 FROM "ClassroomSubmission" WHERE "payload"::text LIKE ${needle}
    UNION ALL SELECT 1 FROM "ClassroomTemplateVersion" WHERE "snapshot"::text LIKE ${needle} OR "mediaRefs"::text LIKE ${needle}
    UNION ALL SELECT 1 FROM "StudentProjectWorkspace" WHERE "projectState"::text LIKE ${needle}
  ) AS referenced`;
  return rows[0]?.referenced ?? false;
}

export async function recordOfferingMutation(tx: Prisma.TransactionClient, offeringId: string, actorId: string, source: string) {
  const offering = await tx.courseOffering.update({ where: { id: offeringId }, data: { version: { increment: 1 } }, select: { version: true } });
  const event = await tx.domainEvent.create({ data: { offeringId, actorId, idempotencyKey: randomUUID(), eventType: 'resource_updated', payload: { source, offeringVersion: offering.version } } });
  return { courseVersion: offering.version, cursor: event.id };
}

export async function persistUpload(tx: Prisma.TransactionClient, input: {
  id: string; originalName: string; storageKey: string; offeringId: string | null; uploadedById: string;
  size: number; mimeType: string; title: string; type: string; bind: boolean; stageKey?: string;
  displayMode?: string | null; previewStorageKey?: string | null; previewMimeType?: string | null; previewSize?: number | null;
  sha256?: string | null; previewSha256?: string | null;
}) {
  await tx.fileAsset.create({ data: { id: input.id, originalName: input.originalName, storageKey: input.storageKey,
    offeringId: input.offeringId, uploadedById: input.uploadedById, size: BigInt(input.size), mimeType: input.mimeType,
    sha256: input.sha256 } });
  let previewAssetId: string | undefined;
  if (input.previewStorageKey && input.previewMimeType && input.previewSize != null) {
    const preview = await tx.fileAsset.create({ data: { originalName: `${input.originalName}.pdf`, storageKey: input.previewStorageKey,
      offeringId: input.offeringId, uploadedById: input.uploadedById, size: BigInt(input.previewSize), mimeType: input.previewMimeType,
      sha256: input.previewSha256, assetRole: 'CLASSROOM_PREVIEW', backupPolicy: 'REGENERATE', sourceAssetId: input.id,
      regenerationRecipe: { schemaVersion: 1, operation: 'presentation-to-pdf', outputMimeType: 'application/pdf' } } });
    previewAssetId = preview.id;
  }
  if (!input.bind || !input.offeringId) return null;
  await tx.resource.create({ data: { id: input.id, fileAssetId: input.id, offeringId: input.offeringId,
    createdById: input.uploadedById, title: input.title, type: input.type,
    metadata: { ...(input.stageKey ? { stageKey: input.stageKey } : {}), ...(input.displayMode ? { displayMode: input.displayMode } : {}),
      ...(previewAssetId ? { previewAssetId, previewType: 'PDF', previewUrl: `/api/uploads/${input.id}?variant=classroom` } : {}) } } });
  return recordOfferingMutation(tx, input.offeringId, input.uploadedById, 'resource-upload');
}
