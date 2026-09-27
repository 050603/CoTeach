import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReport, validateUsers, deletionOrder, fixturePolicy, validateProjectionRecords, validateOwnedProjectionRoots } from './cleanup-capacity-run.mjs';

const runId = 'capacity-12345678-1234-1234-1234-123456789abc';

test('cleanup rejects running, unverified and unrelated reports', () => {
  assert.throws(() => validateReport({ runId, outcome: 'running' }, runId));
  assert.throws(() => validateReport({ runId, outcome: 'passed', checks: [] }));
  assert.throws(() => validateReport({ runId: 'production', outcome: 'failed' }, 'production'));
  assert.throws(() => validateReport({ runId, outcome: 'failed' }, `${runId}-other`));
  validateReport({ runId, outcome: 'failed' }, runId);
  validateReport({ runId, outcome: 'passed', checks: [{ name: 'per-student-database-file-reconciliation', status: '通过' }] });
});

test('user ownership requires the complete run prefix and numeric fixture suffix', () => {
  validateUsers(runId, [{ username: `${runId}-0`, usernameKey: `${runId}-0` }]);
  assert.throws(() => validateUsers(runId, [{ username: `${runId}-real-teacher`, usernameKey: `${runId}-real-teacher` }]));
  assert.throws(() => validateUsers(runId, [{ username: 'formal-student', usernameKey: 'formal-student' }]));
});

test('partial smoke runs require explicit abort of the complete matching run ID', () => {
  const report = { runId, outcome: 'partial', checks: [{ name: 'per-student-database-file-reconciliation', status: '通过' }] };
  assert.throws(() => validateReport(report));
  assert.throws(() => validateReport(report, 'capacity-12345678'));
  assert.throws(() => validateReport(report, 'capacity-12345678-1234-1234-1234-123456789abd'));
  validateReport(report, runId);
});

test('explicit abort of a partial run does not bypass fixture ownership validation', () => {
  assert.throws(() => validateReport({ runId, outcome: 'partial', fixture: { classroomId: 'formal-classroom' } }, runId));
  assert.throws(() => validateReport({ runId, outcome: 'partial', fixture: { userIds: ['formal-student'] } }, runId));
  validateReport({ runId, outcome: 'partial', fixture: { classroomId: `${runId}-lesson`, userIds: ['12345678-1234-1234-1234-123456789abc'] } }, runId);
});

test('deletes dependents first and rejects a cross-table cycle before deletion', () => {
  const owned = new Map([['User', new Set(['u'])], ['Enrollment', new Set(['e'])], ['Submission', new Set(['s'])]]);
  assert.deepEqual(deletionOrder(owned, [{ parent: 'User', child: 'Enrollment' }, { parent: 'Enrollment', child: 'Submission' }]), ['Submission', 'Enrollment', 'User']);
  assert.throws(() => deletionOrder(owned, [{ parent: 'User', child: 'Enrollment' }, { parent: 'Enrollment', child: 'User' }]));
});

const id = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const projectionReport = () => ({ runId, origin: 'https://coteach.cn', outcome: 'latency-failed', rounds: 2, heartbeats: true, includeState: true, modes: ['draft', 'mixed'],
  startedAt: '2026-09-27T01:00:00.000Z', finishedAt: '2026-09-27T01:05:00.000Z', batches: [], errors: [], databaseWaitSamples: [],
  workload: 'real HTTP/42 WebSocket receivers; no mocked API; practice=40 draft+40 state+40 heartbeat; extra cross-stage stress=those plus40 quiz+40 progress',
  fixture: { offeringId: id(100), templateId: id(101), instanceId: id(102), activityId: id(103), chapterId: id(104),
    classroomId: `${runId}-projection-load`, userIds: Array.from({ length: 42 }, (_, index) => id(index + 1)) } });
const projectionUsers = report => report.fixture.userIds.map((userId, index) => ({ id: userId, username: `${runId}-projection-${index}`,
  usernameKey: `${runId}-projection-${index}`, role: index < 2 ? 'TEACHER' : 'STUDENT' }));
const projectionRecords = report => {
  const fixture = report.fixture, { title } = fixturePolicy(report, 'projection-contention');
  return { offerings: [{ id: fixture.offeringId, name: title, description: runId }],
    templates: [{ id: fixture.templateId, title, ownerId: fixture.userIds[0] }],
    chapter: { id: fixture.chapterId, offeringId: fixture.offeringId, title: '独立混合锁验收', position: 0 },
    activity: { id: fixture.activityId, chapterId: fixture.chapterId, title, type: 'CLASSROOM', position: 0 },
    instance: { id: fixture.instanceId, activityId: fixture.activityId, templateVersion: { templateId: fixture.templateId,
      snapshot: { design: { aiLearningClassroomId: fixture.classroomId } } } } };
};

test('projection report requires explicit kind and complete abort ID, including measured reports', () => {
  for (const outcome of ['latency-failed', 'measured', 'failed']) {
    const report = { ...projectionReport(), outcome };
    assert.throws(() => validateReport(report, runId));
    assert.throws(() => validateReport(report, undefined, 'projection-contention'));
    assert.throws(() => validateReport(report, `${runId}-other`, 'projection-contention'));
    const before = structuredClone(report);
    const policy = validateReport(report, runId, 'projection-contention');
    assert.equal(policy.classroomId, `${runId}-projection-load`);
    assert.equal(policy.title, `投屏混合验收 ${runId}`);
    assert.deepEqual(report, before, 'Validating must not rewrite the historical report or outcome');
  }
  assert.throws(() => validateReport(projectionReport(), runId, 'projection'));
  assert.throws(() => validateReport({ ...projectionReport(), kind: 'classroom-capacity' }, runId, 'projection-contention'));
});

test('projection rejects active, missing/invalid finish, unknown workload and incomplete manifests', () => {
  const mutations = [
    r => { r.outcome = 'running'; }, r => { r.outcome = 'partial'; }, r => { delete r.finishedAt; r.endedAt = r.startedAt; },
    r => { r.finishedAt = '2026-09-26T00:00:00.000Z'; }, r => { r.finishedAt = 'invalid'; },
    r => { r.fixture.classroomId = `${runId}-lesson`; }, r => { r.fixture.classroomId = '../real-course'; },
    r => { delete r.fixture.chapterId; }, r => { r.fixture.instanceId = 'real-course'; },
    r => { r.fixture.userIds.pop(); }, r => { r.fixture.userIds[41] = r.fixture.userIds[0]; },
    r => { r.fixture.userIds[41] = 'non-uuid'; }, r => { r.workload = 'arbitrary load'; }, r => { r.modes = ['unknown']; },
  ];
  for (const mutate of mutations) {
    const report = projectionReport(); mutate(report);
    assert.throws(() => validateReport(report, runId, 'projection-contention'));
  }
});

test('projection supports the two exact historical probe shapes without weakening ownership', () => {
  const original = projectionReport(); delete original.includeState; delete original.modes; delete original.heartbeats;
  original.workload = 'real HTTP/42 WebSocket receivers; no mocked API; artificial same-tick quiz/progress/draft burst';
  validateReport(original, runId, 'projection-contention');
  const noState = projectionReport(); noState.includeState = false;
  noState.workload = noState.workload.replace('+40 state', '');
  validateReport(noState, runId, 'projection-contention');
});

test('projection users require fixed 0..41 suffixes, exact manifest indices and teacher/student roles', () => {
  const report = projectionReport();
  validateUsers(runId, projectionUsers(report), 'projection-contention', report.fixture.userIds);
  validateUsers(runId, [projectionUsers(report)[10]], 'projection-contention', report.fixture.userIds); // Idempotent cleanup may see a subset.
  for (const suffix of ['0', 'projection-42', 'projection-01', 'projection-0-extra', 'projection-admin']) {
    const user = { ...projectionUsers(report)[0], username: `${runId}-${suffix}`, usernameKey: `${runId}-${suffix}` };
    assert.throws(() => validateUsers(runId, [user], 'projection-contention', report.fixture.userIds));
  }
  for (const index of [0, 1, 2, 41]) {
    const user = projectionUsers(report)[index]; user.role = index < 2 ? 'STUDENT' : 'TEACHER';
    assert.throws(() => validateUsers(runId, [user], 'projection-contention', report.fixture.userIds));
  }
  const wrongId = { ...projectionUsers(report)[0], id: report.fixture.userIds[1] };
  assert.throws(() => validateUsers(runId, [wrongId], 'projection-contention', report.fixture.userIds));
  assert.throws(() => validateUsers(runId, projectionUsers(report), 'projection-contention'));
  assert.throws(() => validateUsers(runId, projectionUsers(report)));
});

test('projection database records reject wrong titles, cross-course relations, owners and manifest IDs', () => {
  const report = projectionReport(); validateProjectionRecords(report, projectionRecords(report));
  const mutations = [
    r => { r.offerings[0].name = `并发验收 ${runId}`; }, r => { r.templates[0].title += ' other'; },
    r => { r.offerings[0].description = 'real-course'; }, r => { r.offerings[0].id = id(200); },
    r => { r.templates[0].id = id(200); }, r => { r.templates[0].ownerId = report.fixture.userIds[1]; },
    r => { r.chapter.title = '正式课程'; }, r => { r.chapter.offeringId = id(200); },
    r => { r.chapter.id = id(200); }, r => { r.activity.id = id(200); }, r => { r.activity.chapterId = id(200); },
    r => { r.activity.title = '正式课程'; }, r => { r.activity.type = 'ASSIGNMENT'; },
    r => { r.instance.id = id(200); }, r => { r.instance.activityId = id(200); },
    r => { r.instance.templateVersion.templateId = id(200); },
    r => { r.instance.templateVersion.snapshot.design.aiLearningClassroomId = '../other'; },
  ];
  for (const mutate of mutations) {
    const records = projectionRecords(report); mutate(records);
    assert.throws(() => validateProjectionRecords(report, records));
  }
  validateProjectionRecords(report, { offerings: [], templates: [], chapter: null, activity: null, instance: null });
});

test('projection descendant traversal cannot add another classroom, offering, activity, template or user', () => {
  const report = projectionReport();
  const owned = new Map([['User', new Set(report.fixture.userIds)], ...[
    ['CourseOffering', 'offeringId'], ['ClassroomTemplate', 'templateId'], ['ClassroomInstance', 'instanceId'], ['Chapter', 'chapterId'], ['Activity', 'activityId'],
  ].map(([table, key]) => [table, new Set([report.fixture[key]])])]);
  validateOwnedProjectionRoots(report, owned);
  for (const [table, values] of owned) {
    const changed = new Map(owned); changed.set(table, new Set([...values, id(200)]));
    assert.throws(() => validateOwnedProjectionRoots(report, changed));
  }
});
