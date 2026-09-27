import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { ensureCapacityPersonalGroups, uploadCapacityExternalArtifacts } from './verify-capacity-external-artifacts.mjs';

function setup() {
  const users = [{ id: 'teacher', role: 'teacher' }, ...[1, 2].map(index => ({ id: `student-${index}`, role: 'student', username: `student-${index}`, index }))];
  const fixture = { classroomId: 'capacity-unit-fixture', instanceId: 'unit-instance', userIds: users.map(user => user.id) };
  const expected = new Map(users.slice(1).map(user => [user.id, {}]));
  const checks = [];
  const record = (...args) => checks.push(args);
  const course = { status: 'teaching', version: 1, stages: [{ key: 'make' }], currentStageIndex: 0, groups: [] };
  const receipts = new Map();
  const files = new Map();
  const sequences = new Map();
  const request = async (user, method, endpoint, body, options = {}) => {
    if (method === 'GET' && endpoint.endsWith('/state')) return { course: structuredClone(course) };
    if (method === 'POST' && endpoint.endsWith('/actions')) { course.groups = body.action.payload.patch.groups; return { ok: true }; }
    if (method === 'GET' && endpoint.startsWith('/api/uploads/')) {
      assert.equal(options.raw, true); return files.get(endpoint.split('/').at(-1));
    }
    assert.equal(method, 'POST'); assert.ok(endpoint.endsWith('/showcase/artifacts/pdf'));
    const id = body.get('requestId'); const bytes = Buffer.from(await body.get('file').arrayBuffer());
    const existing = receipts.get(id);
    if (existing) {
      if (!files.get(existing.uploadId).equals(bytes)) { assert.equal(options.expectedStatus, 409); return { code: 'ARTIFACT_REQUEST_CONFLICT' }; }
      assert.equal(options.expectedStatus, 200); return existing;
    }
    assert.equal(options.expectedStatus, 201);
    assert.ok(bytes.length >= 1024 * 1024 && bytes.length <= 2 * 1024 * 1024);
    const sequence = (sequences.get(user.id) ?? 0) + 1; sequences.set(user.id, sequence);
    const saved = { ok: true, versionId: randomUUID(), uploadId: randomUUID(), sequence, requestId: id, kind: 'file', mimeType: 'text/plain' };
    files.set(saved.uploadId, bytes); receipts.set(id, saved); course.version++;
    return saved;
  };
  return { users, fixture, expected, record, request, checks, course, files, receipts };
}

test('creates missing personal groups and leaves existing groups intact on repeat', async () => {
  const args = setup();
  await ensureCapacityPersonalGroups(args);
  await ensureCapacityPersonalGroups(args);
  assert.equal(args.course.groups.length, 2);
  assert.ok(args.course.groups.every(group => Array.isArray(group.keywords) && Array.isArray(group.selectedForms)));
  assert.equal(args.checks[0][2].created, 2);
  assert.equal(args.checks[1][2].created, 0);
});

test('two rounds keep one version per student per round across replay and content conflicts', async () => {
  const args = setup();
  await uploadCapacityExternalArtifacts({ ...args, round: 1 });
  await uploadCapacityExternalArtifacts({ ...args, round: 2 });
  assert.equal(args.receipts.size, 4); assert.equal(args.files.size, 4);
  for (const state of args.expected.values()) {
    assert.deepEqual(state.externalArtifacts.map(item => item.sequence), [1, 2]);
    assert.ok(state.externalArtifacts.every(item => item.sha256.length === 64));
  }
});

test('waits for remaining student writes and records accepted manifests before throwing', async () => {
  const args = setup();
  const original = args.request;
  let secondFinished = false;
  args.request = async (user, method, endpoint, body, options) => {
    if (method === 'POST' && user.id === 'student-1') throw new Error('injected first-student failure');
    if (method === 'POST' && user.id === 'student-2') await delay(30);
    const result = await original(user, method, endpoint, body, options);
    if (method === 'GET' && endpoint.startsWith('/api/uploads/')) secondFinished = true;
    return result;
  };
  await assert.rejects(uploadCapacityExternalArtifacts({ ...args, round: 1 }), AggregateError);
  assert.equal(secondFinished, true);
  assert.equal(args.expected.get('student-2').externalArtifacts.length, 1);
  assert.equal(args.checks.at(-1)[1], '未通过');
  assert.equal(args.checks.at(-1)[2].completed, 1);
});
