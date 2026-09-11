// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { inspectDerivedPreview, recoverDerivedPreview, type DerivedPreviewRecord } from './derived-recovery';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function record(sha256: string | null = null): DerivedPreviewRecord {
  return {
    id: 'preview-1', storageKey: 'preview.pdf', sha256,
    backupPolicy: 'REGENERATE',
    regenerationRecipe: { schemaVersion: 1, operation: 'presentation-to-pdf' },
    sourceAsset: { storageKey: 'source.pptx' },
  };
}

it('regenerates a missing preview atomically from its required source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openpbl-preview-recovery-'));
  roots.push(root);
  await writeFile(path.join(root, 'source.pptx'), 'source');
  const convert = vi.fn(async ({ targetPath }: { sourcePath: string; targetPath: string }) => {
    await writeFile(targetPath, '%PDF-restored');
    return { size: 13, mimeType: 'application/pdf' as const };
  });

  expect(await inspectDerivedPreview(record(), root)).toBe('missing');
  const result = await recoverDerivedPreview(record(), root, convert);
  expect(result).toMatchObject({ state: 'missing', size: 13 });
  expect(result.sha256).toBe(createHash('sha256').update('%PDF-restored').digest('hex'));
  expect(await readFile(path.join(root, 'preview.pdf'), 'utf8')).toBe('%PDF-restored');
});

it('detects corruption and never tries to recreate a preview without its source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openpbl-preview-recovery-'));
  roots.push(root);
  await writeFile(path.join(root, 'source.pptx'), 'source');
  await writeFile(path.join(root, 'preview.pdf'), 'bad');
  expect(await inspectDerivedPreview(record('0'.repeat(64)), root)).toBe('corrupt');
  await rm(path.join(root, 'source.pptx'));
  expect(await inspectDerivedPreview(record(), root)).toBe('source-missing');
});
