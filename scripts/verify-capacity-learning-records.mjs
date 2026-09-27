import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function learningEventFingerprint(event) { return hash(canonical({ ...event, occurredAt: new Date(event.occurredAt).toISOString() })); }
export function retainLearningAcknowledgement(state, event, ack, collection = 'eventReceipts') {
  assert.ok(Array.isArray(ack.acceptedIds) && ack.acceptedIds.includes(event.id), 'HTTP 200 must explicitly acknowledge the sent learning event ID');
  state[collection] ??= [];
  const previous = state[collection].find(item => item.id === event.id);
  if (previous) assert.equal(learningEventFingerprint(previous), learningEventFingerprint(event), 'An acknowledged event ID changed body');
  else state[collection].push(structuredClone(event));
}
export function verifyLearningEventRecord({ row, event, user, fixture, participation }) {
  assert.equal(row.userId, user.id); assert.equal(row.classroomInstanceId, fixture.instanceId);
  assert.equal(row.participationId, participation.id); assert.equal(row.enrollmentId, participation.enrollmentId);
  assert.equal(row.offeringId, fixture.offeringId); assert.equal(row.researchKey, participation.enrollment.researchKey);
  assert.equal(row.source, 'legacy-classroom'); assert.equal(row.eventType, event.type);
  assert.equal(row.durationMs, event.durationMs ?? null); assert.equal(new Date(row.occurredAt).toISOString(), new Date(event.occurredAt).toISOString());
  assert.equal(row.idempotencyKey, `legacy:${hash([fixture.instanceId, event.idempotencyKey])}`);
  assert.equal(row.metadata.requestFingerprint, learningEventFingerprint(event));
  // The server enriches activityTitle/knowledgePointLabels. Every original field otherwise survives unchanged.
  const stored = row.metadata.legacy;
  for (const [key, value] of Object.entries(event)) {
    if (key === 'content') {
      for (const [name, field] of Object.entries(value ?? {})) if (!['activityTitle', 'knowledgePointLabels'].includes(name)) assert.deepEqual(stored.content?.[name], field);
    } else if (key === 'occurredAt') assert.equal(new Date(stored[key]).toISOString(), new Date(value).toISOString());
    else assert.deepEqual(stored[key], value, `Learning event ${event.id} changed ${key}`);
  }
}
