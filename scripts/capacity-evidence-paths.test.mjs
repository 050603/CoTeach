import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { capacityEvidenceDirectory, capacityReportCandidates, assertCapacityReportPath, resolveCapacityReportPath } from './capacity-evidence-paths.mjs';
const run = 'capacity-00000000-0000-4000-8000-000000000001';
async function setup(t) { const root = await mkdtemp(path.join(os.tmpdir(), 'capacity-evidence-test-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
async function report(filename) { await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, '{}'); }
test('defaults outside Playwright output and strictly validates UUID', () => {
  assert.equal(capacityEvidenceDirectory(run, '/project'), `/project/.openpbl-data/capacity-evidence/${run}`);
  for (const invalid of [null, 'capacity-' + '-'.repeat(36), run + '/..', '../' + run, run.toUpperCase()]) assert.throws(() => capacityEvidenceDirectory(invalid));
});
test('supports original canonical path and prefers new report when both exist', async t => {
  const root = await setup(t); const [current, legacy] = capacityReportCandidates(run, root);
  await report(legacy); assert.equal(await resolveCapacityReportPath(run, root), legacy);
  await report(current); assert.equal(await resolveCapacityReportPath(run, root), current);
  assert.equal(await assertCapacityReportPath(legacy, run, root), legacy);
});
test('rejects foreign run, arbitrary report, missing report and symlink', async t => {
  const root = await setup(t); const [current, legacy] = capacityReportCandidates(run, root);
  await assert.rejects(resolveCapacityReportPath(run, root), { code: 'ENOENT' });
  await report(current);
  await assert.rejects(assertCapacityReportPath(current, run.replace(/1$/, '2'), root));
  await assert.rejects(assertCapacityReportPath(path.join(root, 'report.json'), run, root));
  await mkdir(path.dirname(legacy), { recursive: true }); await symlink(current, legacy);
  await assert.rejects(assertCapacityReportPath(legacy, run, root), /symlinks/);
});
test('rejects parent symlink even if it resolves inside root', async t => {
  const root = await setup(t); const current = capacityReportCandidates(run, root)[0];
  await mkdir(path.join(root, 'real')); await symlink(path.join(root, 'real'), path.join(root, '.openpbl-data'));
  await report(current); await assert.rejects(resolveCapacityReportPath(run, root), /symlinks/);
});
