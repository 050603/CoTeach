import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { captureCapacityBrowserEvents } from './verify-capacity-projection-browser.mjs';

test('captures only successful scoped acknowledged IDs once and drains response parsing', async () => {
  const page = new EventEmitter();
  const expected = new Map([['student', {}]]);
  const flush = captureCapacityBrowserEvents(page, { user: { id: 'student', role: 'student' }, fixture: { instanceId: 'course' }, expected });
  const emit = ({ ids = ['first'], ack = ids, ok = true, studentId = 'student' } = {}) => page.emit('requestfinished', {
    method: () => 'POST', url: () => 'https://example.test/api/learning-events',
    postDataJSON: () => ({ courseId: 'course', studentId, events: ids.map(id => ({ id, idempotencyKey: id, courseId: 'course', studentId, stageKey: 'make', type: 'artifact-change', occurredAt: '2026-09-27T00:00:00Z' })) }),
    response: async () => ({ ok: () => ok, json: async () => ({ acceptedIds: ack }) }),
  });
  emit(); emit(); emit({ ids: ['failed'], ok: false }); emit({ ids: ['other'], studentId: 'other' });
  emit({ ids: ['second'], ack: ['second', 'not-in-request'] });
  await flush();
  assert.deepEqual(expected.get('student').browserEvents, ['first', 'second']);
  assert.deepEqual(expected.get('student').browserEventReceipts.map(event => event.id), ['first', 'second']);
  assert.equal(expected.get('student').browserEventReceipts[0].type, 'artifact-change');
});

test('context closure while reading an ACK never becomes an unhandled rejection', async () => {
  const page = new EventEmitter();
  const expected = new Map([['student', {}]]);
  const flush = captureCapacityBrowserEvents(page, { user: { id: 'student', role: 'student' }, fixture: { instanceId: 'course' }, expected });
  page.emit('requestfinished', { method: () => 'POST', url: () => 'https://example.test/api/learning-events',
    postDataJSON: () => ({ courseId: 'course', studentId: 'student', events: [] }),
    response: async () => ({ ok: () => true, json: async () => { throw new Error('Target closed'); } }) });
  await flush();
  assert.equal(expected.get('student').browserEvents, undefined);
});

test('HTTP-success telemetry without an explicit event ACK fails the collector drain', async () => {
  const page = new EventEmitter(); const expected = new Map([['student', {}]]);
  const flush = captureCapacityBrowserEvents(page, { user: { id: 'student', role: 'student' }, fixture: { instanceId: 'course' }, expected });
  page.emit('requestfinished', { method: () => 'POST', url: () => 'https://example.test/api/learning-events',
    postDataJSON: () => ({ courseId: 'course', studentId: 'student', events: [{ id: 'event', courseId: 'course', studentId: 'student' }] }),
    response: async () => ({ ok: () => true, json: async () => ({ acceptedIds: [] }) }) });
  await assert.rejects(flush());
});
