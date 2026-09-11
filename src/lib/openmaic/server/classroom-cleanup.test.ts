// @vitest-environment node
import { mkdtemp, mkdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { cleanupClassroomStorage } from './classroom-cleanup';

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openpbl-classroom-cleanup-'));
  roots.push(root);
  return root;
}

async function old(filePath: string) {
  const timestamp = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(filePath, timestamp, timestamp);
}

it('removes a stale classroom with no durable reference', async () => {
  const root = await fixture();
  await mkdir(path.join(root, 'orphan', 'audio'), { recursive: true });
  await writeFile(path.join(root, 'orphan.json'), JSON.stringify({ id: 'orphan' }));
  await writeFile(path.join(root, 'orphan', 'audio', 'old.wav'), 'old');
  await old(path.join(root, 'orphan.json'));
  await old(path.join(root, 'orphan', 'audio', 'old.wav'));

  const result = await cleanupClassroomStorage({ rootDir: root, durableReferences: [] });
  expect(result.deleted).toEqual(expect.arrayContaining(['orphan.json', 'orphan/']));
  await expect(readFile(path.join(root, 'orphan.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps referenced classroom media and removes its superseded files', async () => {
  const root = await fixture();
  await mkdir(path.join(root, 'active', 'audio'), { recursive: true });
  const currentUrl = '/api/openmaic/classroom-media/active/audio/current.wav';
  await writeFile(path.join(root, 'active.json'), JSON.stringify({ id: 'active', audioUrl: currentUrl }));
  await writeFile(path.join(root, 'active', 'audio', 'current.wav'), 'current');
  await writeFile(path.join(root, 'active', 'audio', 'old.wav'), 'old');
  await old(path.join(root, 'active', 'audio', 'current.wav'));
  await old(path.join(root, 'active', 'audio', 'old.wav'));

  const result = await cleanupClassroomStorage({ rootDir: root, durableReferences: [{ id: 'active', audioUrl: currentUrl }] });
  expect(result.deleted).toContain('active/audio/old.wav');
  expect(await readFile(path.join(root, 'active', 'audio', 'current.wav'), 'utf8')).toBe('current');
  expect(result.missingReferences).toEqual([]);
});

it('keeps fresh orphans and never follows symbolic links', async () => {
  const root = await fixture();
  const outside = path.join(root, '..', `${path.basename(root)}-outside`);
  await writeFile(path.join(root, 'fresh.json'), JSON.stringify({ id: 'fresh' }));
  await writeFile(outside, 'outside');
  await symlink(outside, path.join(root, 'external-link'));

  const result = await cleanupClassroomStorage({ rootDir: root, durableReferences: [] });
  expect(result.deleted).toEqual([]);
  expect(await readFile(outside, 'utf8')).toBe('outside');
  const { rm } = await import('node:fs/promises');
  await rm(outside, { force: true });
});
