import { lstat, readFile, readdir, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';

export const CLASSROOM_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

export type ClassroomCleanupResult = {
  deleted: string[];
  deletedBytes: number;
  failed: string[];
  missingReferences: string[];
};

type ReferenceIndex = {
  ids: Set<string>;
  paths: Set<string>;
};

const MEDIA_ROUTE = /\/api\/openmaic\/classroom-media\/([a-zA-Z0-9_-]+)\/([^?#\s"'<>]+)/g;
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

function addStringReference(value: string, index: ReferenceIndex) {
  if (SAFE_ID.test(value)) index.ids.add(value);
  for (const match of value.matchAll(MEDIA_ROUTE)) {
    let relativePath: string;
    try {
      relativePath = decodeURIComponent(match[2]);
    } catch {
      continue;
    }
    const parts = relativePath.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..')) continue;
    index.ids.add(match[1]);
    index.paths.add(path.posix.join(match[1], ...parts));
  }
}

function addReferences(value: unknown, index: ReferenceIndex) {
  if (typeof value === 'string') {
    addStringReference(value, index);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => addReferences(item, index));
    return;
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => addReferences(item, index));
  }
}

async function statOrNull(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function listRegularFiles(rootDir: string, currentDir = rootDir): Promise<Array<{ absolute: string; relative: string; size: number; mtimeMs: number }>> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: Array<{ absolute: string; relative: string; size: number; mtimeMs: number }> = [];
  for (const entry of entries) {
    const absolute = path.join(currentDir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      files.push(...await listRegularFiles(rootDir, absolute));
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await lstat(absolute);
    files.push({ absolute, relative: path.relative(rootDir, absolute).split(path.sep).join('/'), size: info.size, mtimeMs: info.mtimeMs });
  }
  return files;
}

async function removeEmptyDirectories(rootDir: string, currentDir = rootDir): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    await removeEmptyDirectories(rootDir, path.join(currentDir, entry.name));
  }
  if (currentDir !== rootDir) await rmdir(currentDir).catch(() => undefined);
}

/**
 * Delete generated-classroom files only when they have no durable database
 * reference and have been untouched for the grace period. References from a
 * retained classroom's JSON file are included so a newer on-disk media update
 * is never removed merely because an older published snapshot lacks it.
 */
export async function cleanupClassroomStorage(input: {
  rootDir: string;
  durableReferences: unknown[];
  now?: number;
  graceMs?: number;
}): Promise<ClassroomCleanupResult> {
  const result: ClassroomCleanupResult = { deleted: [], deletedBytes: 0, failed: [], missingReferences: [] };
  const now = input.now ?? Date.now();
  const graceMs = input.graceMs ?? CLASSROOM_ORPHAN_GRACE_MS;
  const index: ReferenceIndex = { ids: new Set(), paths: new Set() };
  const graceProtectedDirectories = new Set<string>();
  input.durableReferences.forEach((value) => addReferences(value, index));

  let entries;
  try {
    entries = await readdir(input.rootDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw error;
  }

  for (const entry of entries) {
    const match = /^([a-zA-Z0-9_-]+)\.json$/.exec(entry.name);
    if (!match || !entry.isFile() || entry.isSymbolicLink()) continue;
    const classroomId = match[1];
    const jsonPath = path.join(input.rootDir, entry.name);
    const mediaDir = path.join(input.rootDir, classroomId);
    const jsonInfo = await lstat(jsonPath);
    const mediaInfo = await statOrNull(mediaDir);
    const mediaFiles = mediaInfo?.isDirectory() && !mediaInfo.isSymbolicLink()
      ? await listRegularFiles(mediaDir)
      : [];
    const newestMtime = Math.max(jsonInfo.mtimeMs, ...mediaFiles.map((file) => file.mtimeMs));

    if (!index.ids.has(classroomId) && now - newestMtime >= graceMs) {
      try {
        await rm(jsonPath);
        result.deleted.push(entry.name);
        result.deletedBytes += jsonInfo.size;
        if (mediaInfo?.isDirectory() && !mediaInfo.isSymbolicLink()) {
          await rm(mediaDir, { recursive: true });
          result.deleted.push(`${classroomId}/`);
          result.deletedBytes += mediaFiles.reduce((sum, file) => sum + file.size, 0);
        }
      } catch {
        result.failed.push(classroomId);
      }
      continue;
    }

    if (index.ids.has(classroomId)) {
      try {
        addReferences(JSON.parse(await readFile(jsonPath, 'utf8')), index);
      } catch {
        result.failed.push(entry.name);
      }
    } else {
      // A generator may create the JSON before its database transaction
      // commits. Preserve the whole fresh directory for the grace period.
      graceProtectedDirectories.add(classroomId);
    }
  }

  const allFiles = await listRegularFiles(input.rootDir);
  for (const file of allFiles) {
    const topDirectory = file.relative.split('/')[0];
    if (file.relative.endsWith('.json') || graceProtectedDirectories.has(topDirectory)
      || index.paths.has(file.relative) || now - file.mtimeMs < graceMs) continue;
    try {
      await rm(file.absolute);
      result.deleted.push(file.relative);
      result.deletedBytes += file.size;
    } catch {
      result.failed.push(file.relative);
    }
  }
  await removeEmptyDirectories(input.rootDir);

  for (const referencedPath of [...index.paths].sort()) {
    if (!await statOrNull(path.join(input.rootDir, ...referencedPath.split('/')))) {
      result.missingReferences.push(referencedPath);
    }
  }
  return result;
}
