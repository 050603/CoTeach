// Controlled blocked-thread test of the real pool. No DB/HTTP/model or production artifact changes.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const namespace = await import('../src/lib/project-practice/document-conversion-pool.ts');
const pool = namespace.default ?? namespace;
const temporary = await mkdtemp(path.join(tmpdir(), 'openpbl-docx-deadline-'));
const cwd = process.cwd();
try {
  await mkdir(path.join(temporary, 'workers'));
  await writeFile(path.join(temporary, 'workers/docx-converter.cjs'), `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', job => {
  if (job.input.title === 'blocked') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  if (job.input.title === 'expired-never-run') throw new Error('Expired work executed');
  parentPort.postMessage({ type: 'result', id: job.id, bytes: new Uint8Array([1]), sha256: 'a'.repeat(64) });
});
parentPort.postMessage({ type: 'ready', protocol: 1 });
`);
  process.chdir(temporary);
  await pool.initializeDocumentConversionPool();
  const input = { html: '<p>controlled fixture</p>', title: 'blocked', imageCount: 0 };
  const start = performance.now();
  const active = Array.from({ length: 2 }, () => pool.convertDocumentInWorker(input).catch(error => error));
  await delay(10);
  const original = globalThis.__openPblDocumentConversionPool.slots.map(slot => slot.worker);
  const expired = await pool.convertDocumentInWorker({ ...input, title: 'expired-never-run' }).catch(error => error);
  assert.equal(expired.code, 'DOCUMENT_CONVERSION_BUSY');
  assert.equal(pool.documentConversionHealth().busy, 2);
  const results = await Promise.all(active);
  assert.ok(results.every(error => error.code === 'DOCUMENT_CONVERSION_UNAVAILABLE'));
  assert.ok(performance.now() - start >= 30000);
  assert.ok(original.every(worker => worker.threadId === -1), 'Reject only after actual thread termination');
  const deadline = performance.now() + 20000;
  while (!pool.documentConversionHealth().ok && performance.now() < deadline) await delay(10);
  assert.equal(pool.documentConversionHealth().ok, true);
  await pool.convertDocumentInWorker({ ...input, title: 'explicit-retry' });
  console.log(JSON.stringify({ passed: true, elapsedMs: performance.now() - start, checks: ['10s waiting expires without execution', 'both 30s blocked workers actually terminated before rejection', 'no false success', 'replacement workers recover explicit retry'] }));
} finally {
  await pool.stopDocumentConversionPool();
  process.chdir(cwd);
  await rm(temporary, { recursive: true, force: true });
}
