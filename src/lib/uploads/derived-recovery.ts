import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { convertPresentationToPdf } from './presentation-converter';

export type DerivedPreviewRecord = {
  id: string;
  storageKey: string;
  sha256: string | null;
  backupPolicy: string;
  regenerationRecipe: unknown;
  sourceAsset: { storageKey: string } | null;
};

export type DerivedPreviewState = 'present' | 'missing' | 'corrupt' | 'source-missing' | 'unsupported';

function safeUploadPath(rootDir: string, storageKey: string): string | null {
  return path.basename(storageKey) === storageKey ? path.join(rootDir, storageKey) : null;
}

function operation(recipe: unknown): string | null {
  return recipe && typeof recipe === 'object' && !Array.isArray(recipe)
    && typeof (recipe as Record<string, unknown>).operation === 'string'
    ? String((recipe as Record<string, unknown>).operation)
    : null;
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function inspectDerivedPreview(
  record: DerivedPreviewRecord,
  rootDir: string,
): Promise<DerivedPreviewState> {
  if (record.backupPolicy !== 'REGENERATE' || operation(record.regenerationRecipe) !== 'presentation-to-pdf') {
    return 'unsupported';
  }
  const sourcePath = record.sourceAsset && safeUploadPath(rootDir, record.sourceAsset.storageKey);
  const targetPath = safeUploadPath(rootDir, record.storageKey);
  if (!sourcePath || !targetPath || !await stat(sourcePath).catch(() => null)) return 'source-missing';
  const target = await stat(targetPath).catch(() => null);
  if (!target?.isFile()) return 'missing';
  if (record.sha256 && await sha256File(targetPath) !== record.sha256) return 'corrupt';
  return 'present';
}

/** Regenerate to a temporary path, then atomically replace the missing/corrupt preview. */
export async function recoverDerivedPreview(
  record: DerivedPreviewRecord,
  rootDir: string,
  convert: typeof convertPresentationToPdf = convertPresentationToPdf,
): Promise<{ state: DerivedPreviewState; size?: number; sha256?: string }> {
  const state = await inspectDerivedPreview(record, rootDir);
  if (state === 'present' || state === 'unsupported' || state === 'source-missing') return { state };
  const sourcePath = safeUploadPath(rootDir, record.sourceAsset!.storageKey)!;
  const targetPath = safeUploadPath(rootDir, record.storageKey)!;
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.rehydrate`;
  try {
    const converted = await convert({ sourcePath, targetPath: temporaryPath });
    const sha256 = await sha256File(temporaryPath);
    await rename(temporaryPath, targetPath);
    return { state, size: converted.size, sha256 };
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}
