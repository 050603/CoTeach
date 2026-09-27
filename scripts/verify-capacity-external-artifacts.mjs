/** Real HTTP checks for fixture-owned student local artifact submissions.
 * The caller supplies the campus-network request transport and retains cookies.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

function participants(users, fixture) {
  assert.ok(fixture.classroomId?.startsWith('capacity-'), 'Only capacity fixtures may be mutated');
  const students = users.filter(user => user.role === 'student');
  const teacher = users.find(user => user.role === 'teacher');
  assert.ok(teacher && students.length > 0);
  assert.ok([teacher, ...students].every(user => fixture.userIds.includes(user.id)), 'Users must belong to this capacity run');
  return { teacher, students };
}

export async function ensureCapacityPersonalGroups({ users, fixture, request, record }) {
  const { teacher, students } = participants(users, fixture);
  const endpoint = `/api/courses/${fixture.instanceId}`;
  const course = (await request(teacher, 'GET', `${endpoint}/state`, undefined, { category: 'external-artifact-groups' })).course;
  const groups = [...(course.groups ?? [])];
  let added = 0;
  for (const student of students) {
    const existing = groups.filter(group => group.members.some(member => member.studentId === student.id));
    assert.ok(existing.length <= 1, 'Each fixture student must belong to one personal project group');
    if (existing.length) {
      assert.equal(existing[0].members.length, 1, 'An existing fixture group must be personal');
      continue;
    }
    const now = new Date().toISOString();
    groups.push({ id: `grp-${student.id}`, name: `验收个人项目 ${student.index ?? added}`, topic: '测量证据', keywords: [], selectedForms: [],
      members: [{ studentId: student.id, name: student.username, role: '组长' }], createdAt: now, updatedAt: now });
    added++;
  }
  if (added) await request(teacher, 'POST', `${endpoint}/actions`, {
    requestId: randomUUID(), action: { type: 'UPDATE_COURSE', payload: { id: fixture.instanceId, patch: { groups } } },
  }, { category: 'external-artifact-groups' });
  const confirmed = (await request(teacher, 'GET', `${endpoint}/state`, undefined, { category: 'external-artifact-groups' })).course.groups ?? [];
  for (const student of students) {
    const memberships = confirmed.filter(group => group.members.some(member => member.studentId === student.id));
    assert.equal(memberships.length, 1);
    assert.equal(memberships[0].members.length, 1);
  }
  record('all-student-personal-artifact-groups', '通过', { students: students.length, created: added });
  return confirmed;
}

const receipt = result => ({ versionId: result.versionId, uploadId: result.uploadId, sequence: result.sequence, requestId: result.requestId });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function uploadCapacityExternalArtifacts({ users, fixture, request, record, expected, round }) {
  const { teacher, students } = participants(users, fixture);
  assert.ok(Number.isSafeInteger(round) && round >= 1);
  assert.ok(students.every(student => expected.has(student.id)), 'Initialize expected records before uploading');
  const endpoint = `/api/courses/${fixture.instanceId}`;
  const course = (await request(teacher, 'GET', `${endpoint}/state`, undefined, { category: 'external-artifact-state' })).course;
  assert.equal(course.status, 'teaching');
  assert.equal(course.stages[course.currentStageIndex]?.key, 'make', 'External artifact acceptance runs during project practice');
  const makeForm = (item, content = item.bytes) => {
    const form = new FormData();
    form.set('title', item.title); form.set('requestId', item.requestId);
    form.set('file', new Blob([content], { type: 'text/plain' }), item.fileName);
    return form;
  };
  const work = students.map((student, index) => {
    const size = 1024 * 1024 + (index % 5) * 256 * 1024; // 1–2 MiB per student.
    const bytes = Buffer.alloc(size, 'Measured energy before=120 after=95; same room, duration and occupancy.\n');
    bytes.write(`Capacity ${fixture.instanceId}; student ${student.id}; round ${round}\n`);
    return { student, bytes, requestId: randomUUID(), title: `验收本地作品第${round}轮`, fileName: `evidence-round-${round}.txt` };
  });
  const outcomes = await Promise.allSettled(work.map(async item => {
    const state = expected.get(item.student.id);
    const previous = state.externalArtifacts?.at(-1);
    const saved = await request(item.student, 'POST', `${endpoint}/showcase/artifacts/pdf`, makeForm(item), {
      expectedStatus: 201, category: 'external-artifact-upload', timeout: 90000,
    });
    assert.equal(saved.ok, true); assert.equal(saved.requestId, item.requestId);
    assert.equal(saved.kind, 'file'); assert.equal(saved.mimeType, 'text/plain');
    assert.ok(saved.versionId && saved.uploadId && Number.isSafeInteger(saved.sequence));
    const manifest = { ...receipt(saved), sha256: digest(item.bytes), size: item.bytes.length, url: `/api/uploads/${saved.uploadId}` };
    // Keep every acknowledged write in the report even if replay or download fails.
    state.externalArtifacts ??= [];
    state.externalArtifacts.push(manifest);
    assert.equal(saved.sequence, (previous?.sequence ?? 0) + 1, 'Retries/conflicts must not consume an artifact sequence');
    const replay = await request(item.student, 'POST', `${endpoint}/showcase/artifacts/pdf`, makeForm(item), {
      expectedStatus: 200, category: 'external-artifact-replay', timeout: 90000,
    });
    assert.deepEqual(receipt(replay), receipt(saved));
    const downloaded = await request(item.student, 'GET', manifest.url, undefined, { raw: true, category: 'external-artifact-download', timeout: 90000 });
    assert.equal(downloaded.byteLength, manifest.size);
    assert.equal(digest(downloaded), manifest.sha256);
    return manifest;
  }));
  const failures = outcomes.flatMap((outcome, index) => outcome.status === 'rejected' ? [{ studentId: students[index].id, error: outcome.reason }] : []);
  if (failures.length) {
    record(`all-student-external-artifacts-${round}`, '未通过', { students: students.length, completed: outcomes.length - failures.length,
      failures: failures.map(({ studentId, error }) => ({ studentId, message: String(error) })) });
    throw new AggregateError(failures.map(item => item.error), `${failures.length} student external artifact checks failed after all requests settled`);
  }
  // Run the conflict after the concurrent batch to make the course-version
  // comparison meaningful. Root also reconciles the exact ArtifactVersion count.
  const probe = work[0];
  const accepted = expected.get(probe.student.id).externalArtifacts.at(-1);
  const before = (await request(teacher, 'GET', `${endpoint}/state`, undefined, { category: 'external-artifact-state' })).course.version;
  const changed = Buffer.from(probe.bytes); changed[changed.length - 1] = changed.at(-1) === 65 ? 66 : 65;
  const conflict = await request(probe.student, 'POST', `${endpoint}/showcase/artifacts/pdf`, makeForm(probe, changed), {
    expectedStatus: 409, category: 'expected-conflict', timeout: 90000,
  });
  assert.equal(conflict.code, 'ARTIFACT_REQUEST_CONFLICT');
  const after = (await request(teacher, 'GET', `${endpoint}/state`, undefined, { category: 'external-artifact-state' })).course.version;
  assert.equal(after, before, 'A conflicting upload must not mutate the course');
  const replay = await request(probe.student, 'POST', `${endpoint}/showcase/artifacts/pdf`, makeForm(probe), {
    expectedStatus: 200, category: 'external-artifact-replay', timeout: 90000,
  });
  assert.deepEqual(receipt(replay), receipt(accepted));
  record(`external-artifact-same-id-content-conflict-${round}`, '通过', { studentId: probe.student.id, code: conflict.code, courseVersionUnchanged: true, originalReceiptPreserved: true });
  const detail = { students: students.length, minBytes: Math.min(...work.map(item => item.bytes.length)),
    maxBytes: Math.max(...work.map(item => item.bytes.length)), totalBytes: work.reduce((sum, item) => sum + item.bytes.length, 0), replays: students.length + 1, conflicts: 1 };
  record(`all-student-external-artifacts-${round}`, '通过', detail);
  return detail;
}
