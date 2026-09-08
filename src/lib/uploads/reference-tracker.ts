// @ts-nocheck
// File reference tracker for upload management (Stage 6).
//
// Each UploadFile row tracks which uploads (by upload ID) currently reference
// the underlying disk file. When refCount drops to 0 the disk file is removed
// and the DB row is deleted, so unreferenced files do not accumulate.

import { unlink } from "node:fs/promises";
import path from "node:path";
import type { UploadFile } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";

const dataDir = process.env.UPLOAD_DIR?.trim()
  || path.join(process.cwd(), ".openpbl-data", "uploads");

function normalizeRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((r): r is string => typeof r === "string");
}

export function extractUploadIdsFromHtml(html: string): string[] {
  const ids = new Set<string>();
  const pattern = /\/api\/uploads\/([0-9a-f-]{36})(?:[?"'\s>]|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) ids.add(match[1]);
  return [...ids];
}

/**
 * Reconcile document image references inside the same transaction as a draft
 * submission. We intentionally do not unlink files here: cleanup can safely
 * remove refCount=0 orphans after the transaction commits.
 */
export async function reconcileUploadReferences(
  tx: Prisma.TransactionClient,
  input: { courseId: string; refBy: string; previousHtml: string; nextHtml: string },
): Promise<void> {
  const previous = new Set(extractUploadIdsFromHtml(input.previousHtml));
  const next = new Set(extractUploadIdsFromHtml(input.nextHtml));
  const affected = new Set([...previous, ...next]);
  for (const fileId of affected) {
    const record = await tx.uploadFile.findFirst({
      where: { id: fileId, courseId: input.courseId, deletedAt: null },
    });
    if (!record) continue;
    const refs = normalizeRefs(record.referencedBy).filter((ref) => ref !== input.refBy);
    if (next.has(fileId)) refs.push(input.refBy);
    await tx.uploadFile.update({
      where: { id: fileId },
      data: { referencedBy: refs, refCount: refs.length },
    });
  }
}

/**
 * Mark `fileId` as referenced by `refBy` (an upload ID). Idempotent — adding
 * the same refBy twice is a no-op. refCount is recomputed from the array
 * length so it never drifts from reality.
 */
export async function incrementRef(fileId: string, refBy: string): Promise<void> {
  const record = await prisma.uploadFile.findUnique({ where: { id: fileId } });
  if (!record) return;
  const refs = normalizeRefs(record.referencedBy);
  if (refs.includes(refBy)) return;
  const nextRefs = [...refs, refBy];
  await prisma.uploadFile.update({
    where: { id: fileId },
    data: {
      referencedBy: nextRefs,
      refCount: nextRefs.length,
    },
  });
}

/**
 * Remove `refBy` from the file's reference list. When the list becomes empty
 * the disk file is unlinked and the DB row is deleted. Missing files on disk
 * (ENOENT) are tolerated — the row is still removed.
 */
export async function decrementRef(fileId: string, refBy: string): Promise<void> {
  const record = await prisma.uploadFile.findUnique({ where: { id: fileId } });
  if (!record) return;
  const refs = normalizeRefs(record.referencedBy);
  const nextRefs = refs.filter((r) => r !== refBy);

  if (nextRefs.length === 0) {
    for (const storedName of [record.storedName, record.previewStoredName].filter(
      (value): value is string => Boolean(value),
    )) {
      try {
        await unlink(path.join(dataDir, storedName));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw err;
      }
    }
    await prisma.uploadFile.delete({ where: { id: fileId } }).catch(() => undefined);
    return;
  }

  await prisma.uploadFile.update({
    where: { id: fileId },
    data: {
      referencedBy: nextRefs,
      refCount: nextRefs.length,
    },
  });
}

/**
 * Current refCount for a file. Returns 0 when the row does not exist.
 */
export async function getRefCount(fileId: string): Promise<number> {
  const record = await prisma.uploadFile.findUnique({
    where: { id: fileId },
    select: { refCount: true },
  });
  return record?.refCount ?? 0;
}

/**
 * List UploadFile rows with refCount = 0. Useful for diagnosing leaks; the
 * actual cleanup of orphan disk files lives in `./cleanup`.
 */
export async function listOrphans(): Promise<UploadFile[]> {
  return prisma.uploadFile.findMany({ where: { refCount: 0 } });
}
