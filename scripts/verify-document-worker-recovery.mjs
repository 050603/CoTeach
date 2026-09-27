// Pure isolated converter verification; never imports DB/auth or model clients.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const namespace = await import('../src/lib/project-practice/document-conversion-pool.ts');
const { convertDocumentInWorker, documentConversionHealth, initializeDocumentConversionPool, stopDocumentConversionPool } = namespace.default ?? namespace;
const input = { html: '<h1>恢复验证</h1><p>不可丢失的成果正文</p>', title: '恢复验证', imageCount: 0 };
await initializeDocumentConversionPool();
try {
  assert.equal(documentConversionHealth().ready, 2);
  await assert.rejects(convertDocumentInWorker({ ...input, imageCount: 1 }), error => error.code === 'DOCX_INVALID');
  const original = await convertDocumentInWorker(input);
  assert.equal(createHash('sha256').update(original.bytes).digest('hex'), original.sha256);
  const active = convertDocumentInWorker({ ...input, html: '<p>线程退出时不得确认成功。</p>'.repeat(4000) }).catch(error => error);
  await Promise.resolve();
  const slot = globalThis.__openPblDocumentConversionPool.slots.find(value => value.job);
  assert.ok(slot, 'Terminate only a worker holding this test task');
  await slot.worker.terminate();
  assert.equal((await active).code, 'DOCUMENT_CONVERSION_UNAVAILABLE');
  assert.equal(documentConversionHealth().ok, false);
  const deadline = performance.now() + 20000;
  while (!documentConversionHealth().ok && performance.now() < deadline) await delay(20);
  assert.equal(documentConversionHealth().ready, 2);
  assert.equal(documentConversionHealth().busy, 0, 'Failed active task must not be silently replayed');
  const retry = await convertDocumentInWorker(input);
  assert.equal(createHash('sha256').update(retry.bytes).digest('hex'), retry.sha256);
  console.log('PASS two warmed release workers, DOCX_INVALID media guard, exact output SHA, real active-thread termination returns failure, bounded replacement becomes ready, explicit retry succeeds without hidden replay');
} finally { await stopDocumentConversionPool(); }
assert.equal(documentConversionHealth().ok, false);
console.log('PASS explicit shutdown terminates workers and leaves readiness false');
