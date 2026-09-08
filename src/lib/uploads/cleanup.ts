// @ts-nocheck
// Upload cleanup tasks (Stage 6).
//
// Three operations:
//   - cleanupOrphanFiles(): scan the uploads directory and remove any files
//     that have no UploadFile row in the database.
//   - cleanupCourseFiles(courseId): bulk-delete every upload belonging to a
//     course — disk files + DB rows. Used when a course is deleted.
//   - cleanupExpiredFiles(retentionDays): for courses whose status is
//     "finished", remove upload files older than `retentionDays` days.

import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db/client";

const dataDir = process.env.UPLOAD_DIR?.trim()
  || path.join(process.cwd(), ".openpbl-data", "uploads");

export type CleanupResult = { deleted: string[]; failed: string[] };

async function safeUnlink(storedName: string): Promise<void> {
  try {
    await unlink(path.join(dataDir, storedName));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
}

/**
 * Scan `.openpbl-data/uploads/` and delete every regular file that has no
 * corresponding UploadFile row. Subdirectories are skipped. Missing files
 * inside an UploadFile row are NOT touched here — that is the
 * reference-tracker's responsibility.
 */
export async function cleanupOrphanFiles(): Promise<CleanupResult> {
  const deleted: string[] = [];
  const failed: string[] = [];

  let entries: string[];
  try {
    entries = await readdir(dataDir);
  } catch {
    // Directory does not exist yet — nothing to clean.
    return { deleted, failed };
  }

  const records = await prisma.uploadFile.findMany({
    select: { storedName: true, previewStoredName: true },
  });
  const known = new Set(records.flatMap(storedNamesFor));

  for (const entry of entries) {
    const full = path.join(dataDir, entry);
    try {
      const info = await stat(full);
      if (info.isDirectory()) continue;
    } catch {
      // stat failed (race / permission) — skip rather than risk deleting
      // something we cannot inspect.
      continue;
    }
    if (known.has(entry)) continue;
    try {
      await unlink(full);
      deleted.push(entry);
    } catch {
      failed.push(entry);
    }
  }

  return { deleted, failed };
}

/**
 * Delete every UploadFile (disk + DB row) associated with a course. Used by
 * the DELETE_COURSE action handler so that course deletion cascades to
 * uploaded artifacts. Idempotent — returns empty arrays when no files exist.
 */
export async function cleanupCourseFiles(courseId: string): Promise<CleanupResult> {
  const deleted: string[] = [];
  const failed: string[] = [];

  const records = await prisma.uploadFile.findMany({
    where: { courseId },
    select: { id: true, storedName: true, previewStoredName: true },
  });

  for (const record of records) {
    for (const storedName of storedNamesFor(record)) {
      try {
        await safeUnlink(storedName);
        deleted.push(storedName);
      } catch {
        failed.push(storedName);
      }
    }
  }

  if (records.length > 0) {
    await prisma.uploadFile.deleteMany({
      where: { id: { in: records.map((r) => r.id) } },
    });
  }

  return { deleted, failed };
}

/**
 * Remove uploads for courses whose status is "finished" and whose files are
 * older than `retentionDays` days (based on UploadFile.createdAt). Disk files
 * and DB rows are both deleted.
 */
export async function cleanupExpiredFiles(retentionDays: number): Promise<CleanupResult> {
  const deleted: string[] = [];
  const failed: string[] = [];

  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return { deleted, failed };
  }

  const finishedCourses = await prisma.course.findMany({
    where: { status: "finished" },
    select: { id: true },
  });
  if (finishedCourses.length === 0) return { deleted, failed };

  const courseIds = finishedCourses.map((c) => c.id);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const records = await prisma.uploadFile.findMany({
    where: {
      courseId: { in: courseIds },
      createdAt: { lt: cutoff },
    },
    select: { id: true, storedName: true, previewStoredName: true },
  });

  for (const record of records) {
    for (const storedName of storedNamesFor(record)) {
      try {
        await safeUnlink(storedName);
        deleted.push(storedName);
      } catch {
        failed.push(storedName);
      }
    }
  }

  if (records.length > 0) {
    await prisma.uploadFile.deleteMany({
      where: { id: { in: records.map((r) => r.id) } },
    });
  }

  return { deleted, failed };
}

function storedNamesFor(record: {
  storedName: string;
  previewStoredName?: string | null;
}): string[] {
  return record.previewStoredName
    ? [record.storedName, record.previewStoredName]
    : [record.storedName];
}
