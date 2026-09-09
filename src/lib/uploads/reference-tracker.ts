// V2 references are derived from real relations; no mutable reference counter.
import type { FileAsset, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';

export function extractUploadIdsFromHtml(html: string): string[] {
  return [...new Set(Array.from(html.matchAll(/\/api\/uploads\/([0-9a-f-]{36})(?:[?"'\s>]|$)/gi), (match) => match[1]))];
}

/** Validate embedded file ownership. Referencing documents retain their own HTML snapshot. */
export async function reconcileUploadReferences(tx: Prisma.TransactionClient, input: { courseId: string; refBy: string; previousHtml: string; nextHtml: string }): Promise<void> {
  const ids = extractUploadIdsFromHtml(input.nextHtml);
  if (!ids.length) return;
  const count = await tx.fileAsset.count({ where: { id: { in: ids }, offeringId: input.courseId, deletedAt: null } });
  if (count !== ids.length) throw new Error('Upload reference does not belong to this offering.');
}

/** Kept for retired callers; V2 Resource/ArtifactVersion writes establish relations. */
export async function incrementRef(fileId: string, _refBy: string): Promise<void> {
  void _refBy;
  await prisma.fileAsset.findUniqueOrThrow({ where: { id: fileId } });
}

/** Removing a legacy reference must never destroy experimental evidence. */
export async function decrementRef(_fileId: string, _refBy: string): Promise<void> { void _fileId; void _refBy; }

export async function getRefCount(fileId: string): Promise<number> {
  const file = await prisma.fileAsset.findUnique({ where: { id: fileId }, select: { _count: { select: { artifactVersions: true } }, resource: { select: { id: true } } } });
  return file ? file._count.artifactVersions + Number(Boolean(file.resource)) : 0;
}

/** Diagnostic only: unbound assets may still occur inside immutable JSON/HTML snapshots. */
export async function listOrphans(): Promise<FileAsset[]> {
  return prisma.fileAsset.findMany({ where: { deletedAt: null, resource: null, artifactVersions: { none: {} } } });
}
