import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { learningEventFingerprint, retainLearningAcknowledgement, verifyLearningEventRecord } from './verify-capacity-learning-records.mjs';
function setup() {
  const user = { id: 'student' }, fixture = { instanceId: 'course', offeringId: 'offering' }, participation = { id: 'participation', enrollmentId: 'enrollment', enrollment: { researchKey: 'research' } };
  const event = { id: 'event', idempotencyKey: 'key', courseId: 'course', studentId: 'student', stageKey: 'ai-learning', sceneId: 'scene', type: 'heartbeat', durationMs: 10000, visible: true, occurredAt: '2026-09-27T00:00:00Z', content: { sceneTitle: '课程' } };
  const row = { userId: user.id, classroomInstanceId: fixture.instanceId, offeringId: fixture.offeringId, participationId: participation.id, enrollmentId: participation.enrollmentId, researchKey: 'research', source: 'legacy-classroom', eventType: event.type, durationMs: event.durationMs, occurredAt: new Date(event.occurredAt),
    idempotencyKey: `legacy:${createHash('sha256').update(JSON.stringify([fixture.instanceId, event.idempotencyKey])).digest('hex')}`,
    metadata: { requestFingerprint: learningEventFingerprint(event), legacy: structuredClone(event) } };
  return { row, event, user, fixture, participation };
}
test('exact ACK keeps original immutable body; duplicate ACK cannot replace content', () => {
  const { event } = setup(), state = {}; retainLearningAcknowledgement(state, event, { acceptedIds: [event.id] });
  retainLearningAcknowledgement(state, event, { acceptedIds: [event.id] }); assert.equal(state.eventReceipts.length, 1);
  assert.throws(() => retainLearningAcknowledgement(state, { ...event, durationMs: 1 }, { acceptedIds: [event.id] }));
  assert.throws(() => retainLearningAcknowledgement({}, event, { acceptedIds: [] }));
});
test('canonical fingerprint matches reordered properties and normalized timestamp', () => {
  const { event } = setup(); assert.equal(learningEventFingerprint(event), learningEventFingerprint({ ...Object.fromEntries(Object.entries(event).reverse()), occurredAt: '2026-09-27T00:00:00.000Z' }));
});
test('complete event body, columns and ownership reconcile with permitted enrichment', () => {
  const args = setup(); args.row.metadata.legacy.content.knowledgePointLabels = ['课堂标注']; verifyLearningEventRecord(args);
});
for (const [name, mutate] of Object.entries({
  'duration column': args => { args.row.durationMs = 0; },
  'scene metadata': args => { args.row.metadata.legacy.sceneId = 'other'; },
  'stage metadata': args => { args.row.metadata.legacy.stageKey = 'make'; },
  'research key': args => { args.row.researchKey = 'other'; },
  'wrong participant': args => { args.row.participationId = 'other'; },
  'changed raw fingerprint': args => { args.row.metadata.requestFingerprint = 'wrong'; },
  'occurred time': args => { args.row.occurredAt = new Date('2026-09-28'); },
})) test(`rejects ${name} corruption even with matching event ID`, () => { const args = setup(); mutate(args); assert.throws(() => verifyLearningEventRecord(args)); });
