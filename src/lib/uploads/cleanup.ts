// V2 cleanup never expires active assets or experimental evidence based on age alone.
import { readdir, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '@/lib/db/client';

const dataDir = process.env.UPLOAD_DIR?.trim() || path.join(process.cwd(), '.openpbl-data', 'uploads');
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
export type CleanupResult = { deleted: string[]; failed: string[] };

export async function cleanupOrphanFiles(): Promise<CleanupResult> {
  const result: CleanupResult = { deleted: [], failed: [] };
  let entries: string[];
  try { entries = await readdir(dataDir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw error;
  }
  const assets = await prisma.fileAsset.findMany({ select: { storageKey: true } });
  const known = new Set(assets.map((asset) => asset.storageKey));
  for (const entry of entries) {
    if (known.has(entry)) continue;
    try {
      const info = await lstat(path.join(dataDir, entry));
      if (!info.isFile() || Date.now() - info.mtimeMs < ORPHAN_GRACE_MS) continue;
      // Recheck after filesystem inspection in case an upload committed meanwhile.
      if (await prisma.fileAsset.count({ where: { storageKey: entry } })) continue;
      await unlink(path.join(dataDir, entry));
      result.deleted.push(entry);
    } catch { result.failed.push(entry); }
  }
  return result;
}

async function cleanupDeletedFiles(offeringId?: string, cutoff?: Date): Promise<CleanupResult> {
  const result: CleanupResult = { deleted: [], failed: [] };
  const records = await prisma.fileAsset.findMany({ where: { offeringId, deletedAt: cutoff ? { lt: cutoff } : { not: null },
    resource: null, artifactVersions: { none: {} } } });
  for (const record of records) {
    if (path.basename(record.storageKey) !== record.storageKey) { result.failed.push(record.id); continue; }
    try {
      await unlink(path.join(dataDir, record.storageKey)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      // Keep the tombstone and file identity for audit/research exports.
      result.deleted.push(record.storageKey);
    } catch { result.failed.push(record.storageKey); }
  }
  return result;
}

/** A course cleanup processes only assets explicitly soft-deleted by an authorized user. */
export async function cleanupCourseFiles(courseId: string): Promise<CleanupResult> { return cleanupDeletedFiles(courseId); }
export async function cleanupExpiredFiles(retentionDays: number): Promise<CleanupResult> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return { deleted: [], failed: [] };
  return cleanupDeletedFiles(undefined, new Date(Date.now() - retentionDays * ORPHAN_GRACE_MS));
}
