/** Durable task evidence lives outside Playwright's disposable test-results. */
import assert from 'node:assert/strict';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const CAPACITY_RUN_ID = /^capacity-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function capacityEvidenceDirectory(runId, root = projectRoot) {
  assert.match(runId ?? '', CAPACITY_RUN_ID, 'Require exact capacity run UUID');
  return path.resolve(root, '.openpbl-data/capacity-evidence', runId);
}
export function capacityReportCandidates(runId, root = projectRoot) {
  return [path.join(capacityEvidenceDirectory(runId, root), 'report.json'),
    path.resolve(root, 'test-results/capacity', runId, 'report.json')];
}
export async function assertCapacityReportPath(reportPath, runId, root = projectRoot) {
  const absolute = path.resolve(reportPath);
  assert.ok(capacityReportCandidates(runId, root).includes(absolute), 'Require canonical run-owned report path');
  const relative = path.relative(path.resolve(root), absolute);
  let current = path.resolve(root);
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    assert.equal((await lstat(current)).isSymbolicLink(), false, 'Evidence path cannot contain symlinks');
  }
  assert.equal(await realpath(absolute), path.join(await realpath(root), relative), 'Require canonical run-owned report path');
  assert.ok((await lstat(absolute)).isFile(), 'Report must be a regular file');
  return absolute;
}
export async function resolveCapacityReportPath(runId, root = projectRoot) {
  for (const candidate of capacityReportCandidates(runId, root)) {
    try { return await assertCapacityReportPath(candidate, runId, root); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw Object.assign(new Error('No canonical report found for capacity run'), { code: 'ENOENT' });
}
