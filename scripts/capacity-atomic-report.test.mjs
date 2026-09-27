import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, open, rename, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeCapacityReport } from './capacity-atomic-report.mjs';
async function fixture(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'capacity-atomic-report-')); const file = path.join(dir, 'report.json');
  try { await writeCapacityReport(file, { original: true }); await fn({ dir, file }); }
  finally { await rm(dir, { recursive: true }); }
}
test('successful replacement is complete, private and leaves no temporary file', async () => fixture(async ({ dir, file }) => {
  const replacement = { outcome: 'failed', evidence: ['one', 'two'] };
  await writeCapacityReport(file, replacement);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), replacement);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ['report.json']);
}));
test('partial temporary write failure preserves original and rejects', async () => fixture(async ({ dir, file }) => {
  await assert.rejects(writeCapacityReport(file, { replacement: true }, { rename, unlink,
    open: async (...args) => {
      const handle = await open(...args);
      return { writeFile: async () => { await handle.writeFile('{partial'); throw new Error('disk full'); }, sync: () => handle.sync(), close: () => handle.close() };
    },
  }), /disk full/);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { original: true });
  assert.deepEqual(await readdir(dir), ['report.json']);
}));
test('rename failure preserves original, cleans only own temporary and rejects', async () => fixture(async ({ dir, file }) => {
  await assert.rejects(writeCapacityReport(file, {}, { open, unlink, rename: async () => { throw new Error('rename denied'); } }), /rename denied/);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { original: true });
  assert.deepEqual(await readdir(dir), ['report.json']);
}));
test('fsync failure before rename preserves original', async () => fixture(async ({ file }) => {
  await assert.rejects(writeCapacityReport(file, {}, { rename, unlink,
    open: async (...args) => { const handle = await open(...args); return { writeFile: (...values) => handle.writeFile(...values), sync: async () => { throw new Error('sync failed'); }, close: () => handle.close() }; },
  }), /sync failed/);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { original: true });
}));
test('directory sync failure after replacement is not swallowed or described as rollback', async () => fixture(async ({ file }) => {
  await assert.rejects(writeCapacityReport(file, { replacement: true }, { rename, unlink,
    open: async (...args) => {
      const handle = await open(...args);
      if (args[1] !== 'r') return handle;
      return { sync: async () => { throw new Error('directory sync failed'); }, close: () => handle.close() };
    },
  }), /directory sync failed/);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { replacement: true });
}));
