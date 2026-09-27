import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createDocumentSaveCollector, captureDocumentBrowserTraffic } from './verify-capacity-document-browser.mjs';
import { capacityAiRequestManifests, separateCapacityAiDiagnostics, verifyCapacityAiRecords } from './verify-capacity-ai-records.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
test('keeps failed model output distinct and verifies its complete bytes', () => {
  const raw = 'invalid JSON ' + '内容'.repeat(5000);
  const error = { eventType: 'error', actor: 'system', content: raw, payload: { detail: {
    kind: 'invalid-model-response', rawSha256: digest(raw), rawLength: raw.length,
    requestAttemptId: 'attempt', modelAttempt: 1, reason: 'INVALID_JSON',
  } } };
  const result = separateCapacityAiDiagnostics([error, { eventType: 'response', actor: 'assistant' }]);
  assert.equal(result.diagnostics.length, 1); assert.equal(result.successful.length, 1);
  assert.throws(() => separateCapacityAiDiagnostics([{ ...error, content: raw.slice(0, 500) }]), /hash differs/);
  assert.throws(() => separateCapacityAiDiagnostics([{ ...error, actor: 'assistant' }]), /masquerade/);
  const modelOutput = { ...error, eventType: 'response', payload: { detail: { ...error.payload.detail, kind: 'model-output', reason: undefined } } };
  const retained = separateCapacityAiDiagnostics([error, modelOutput, { eventType: 'response', actor: 'assistant' }]);
  assert.equal(retained.modelOutputs.length, 1); assert.equal(retained.successful.length, 1);
  assert.throws(() => separateCapacityAiDiagnostics([{ ...modelOutput, content: 'truncated' }]), /hash differs/);
});
const state = () => ({ submissionId: 'draft', saves: 2, version: 4, content: '<p>previous</p>', receipts: [],
  documentRequestId: 'whole-class-document', tutorRequestId: 'whole-class-tutor' });
const saved = (version, requestId = `save-${version}`, content = `<p>browser ${version}</p>`) => ({
  body: { requestId, action: { type: 'UPSERT_SUBMISSION', payload: { courseId: 'course', expectedSubmissionVersion: version - 1,
    submission: { id: 'draft', courseId: 'course', studentId: 'student', groupId: 'personal-group', type: 'document', stageKey: 'make', content } } } },
  ack: { requestId, courseVersion: 100 + version, submissionVersion: version, eventCursor: `event-${version}` },
});

test('save collector orders late responses, preserves exact HTML/group metadata and counts replay once', () => {
  const expected = state();
  const collector = createDocumentSaveCollector({ state: expected, userId: 'student', courseId: 'course' });
  const earlier = saved(5, 'first', '<p><strong>actual serialized HTML</strong></p>');
  const later = saved(6);
  collector.accept(later.body, later.ack);
  assert.equal(expected.version, 4);
  assert.throws(() => collector.assertComplete(), /gap/);
  collector.accept(earlier.body, earlier.ack);
  collector.accept(earlier.body, earlier.ack);
  collector.assertComplete();
  assert.equal(expected.saves, 4); assert.equal(expected.version, 6);
  assert.deepEqual(expected.receipts.map(item => item.version), [5, 6]);
  assert.equal(expected.receipts[0].contentSha256, digest(earlier.body.action.payload.submission.content));
  assert.equal(expected.content, later.body.action.payload.submission.content);
  assert.deepEqual(expected.lastAction, later.body.action); assert.deepEqual(expected.lastAck, later.ack);
  assert.equal(expected.lastRequestId, later.body.requestId); assert.equal(expected.groupId, 'personal-group');
  assert.equal(expected.documentRequestId, 'whole-class-document');
});

test('collector rejects scope changes, conflicting idempotency receipts and concurrent protocol mutations', () => {
  const expected = state();
  const collector = createDocumentSaveCollector({ state: expected, userId: 'student', courseId: 'course' });
  const entry = saved(5);
  const other = structuredClone(entry); other.body.action.payload.submission.studentId = 'other';
  assert.throws(() => collector.accept(other.body, other.ack));
  assert.equal(expected.version, 4);
  collector.accept(entry.body, entry.ack);
  const conflicting = structuredClone(entry); conflicting.body.action.payload.submission.content = 'silently changed';
  assert.throws(() => collector.accept(conflicting.body, conflicting.ack));
  assert.throws(() => collector.accept(saved(5, 'another-request').body, saved(5, 'another-request').ack), /same saved version/);
  expected.version = 6;
  assert.throws(() => collector.accept(saved(7).body, saved(7).ack), /protocol writer/);
});

function fakeRequest(pathname, body, payload, status = 200, method = 'POST') {
  return { method: () => method, url: () => `https://coteach.cn${pathname}`, postDataJSON: () => body,
    response: async () => ({ ok: () => status >= 200 && status < 300, status: () => status, json: async () => payload }),
    failure: () => ({ errorText: 'synthetic connection reset' }) };
}

test('traffic collector records real completed saves and accepts non-UUID AI IDs without replacing burst IDs', async () => {
  const page = new EventEmitter(); const expected = state(); const map = new Map([['student', expected]]);
  const collector = captureDocumentBrowserTraffic(page, { user: { id: 'student' }, fixture: { instanceId: 'course' }, expected: map, question: 'synthetic question' });
  const entry = saved(5); const saveRequest = fakeRequest('/api/courses/course/actions', entry.body, entry.ack);
  page.emit('request', saveRequest); page.emit('requestfinished', saveRequest);
  const requestId = 'document-ai-request-browser-real-format';
  const body = { courseId: 'course', studentId: 'student', stageKey: 'make', workspaceKind: 'document', intent: 'discuss',
    message: 'synthetic question', documentHtml: '<p>saved draft</p>', conversationId: 'legacy', requestId };
  const ai = fakeRequest('/api/ai-collaboration/document', body, { requestId, status: 'processing' }, 202);
  page.emit('request', ai); page.emit('requestfinished', ai);
  const reply = { requestId, status: 'completed', conversationId: 'legacy', result: { message: 'complete browser answer' },
    messages: [{ id: 'student-message', role: 'student' }, { id: 'assistant-message', role: 'agent' }] };
  const poll = fakeRequest(`/api/ai-collaboration/document?requestId=${requestId}`, undefined, reply, 200, 'GET');
  page.emit('requestfinished', poll);
  await collector.drain(); collector.detach();
  assert.equal(expected.version, 5); assert.equal(expected.saves, 3);
  assert.equal(expected.documentRequestId, 'whole-class-document');
  assert.equal(expected.browserDocumentRequests.length, 1);
  assert.equal(expected.browserDocumentRequests[0].responseSha256, digest(reply.result.message));
  assert.equal(expected.browserDocumentRequests[0].documentVersion, digest(JSON.stringify(body.documentHtml)));
  assert.equal(expected.browserDocumentRequests[0].assistantMessageId, 'assistant-message');
});

test('failed browser writes remain failures and never advance the acknowledged manifest', async () => {
  const page = new EventEmitter(); const expected = state();
  const collector = captureDocumentBrowserTraffic(page, { user: { id: 'student' }, fixture: { instanceId: 'course' }, expected: new Map([['student', expected]]), question: 'q' });
  const req = fakeRequest('/api/courses/course/actions', saved(5).body, { code: 'DRAFT_VERSION_CONFLICT' }, 409);
  page.emit('request', req); page.emit('requestfinished', req);
  await assert.rejects(collector.drain(), /409/);
  assert.equal(expected.version, 4); assert.equal(expected.saves, 2); collector.detach();
});

test('an explicitly injected offline failure is evidence, never a saved receipt, and later faults still fail', async () => {
  const page = new EventEmitter(); const expected = state(); let offline = true;
  const collector = captureDocumentBrowserTraffic(page, { user: { id: 'student' }, fixture: { instanceId: 'course' },
    expected: new Map([['student', expected]]), question: 'q', expectedNetworkFailure: () => offline });
  const req = fakeRequest('/api/courses/course/actions', saved(5).body, saved(5).ack);
  page.emit('request', req); page.emit('requestfailed', req);
  await collector.drain(); assert.equal(expected.version, 4);
  assert.equal(collector.traffic[0].fault, 'injected-offline');
  page.emit('request', req); page.emit('requestfinished', req);
  await collector.drain(); assert.equal(expected.version, 5);
  offline = false; page.emit('request', req); page.emit('requestfailed', req);
  await assert.rejects(collector.drain(), /connection reset/); collector.detach();
});

test('browser process-event acknowledgements survive replay and remain available for database reconciliation', async () => {
  const page = new EventEmitter(); const expected = state();
  const collector = captureDocumentBrowserTraffic(page, { user: { id: 'student' }, fixture: { instanceId: 'course' },
    expected: new Map([['student', expected]]), question: 'q' });
  const body = { courseId: 'course', studentId: 'student', requestId: 'interaction-request', eventType: 'decision', content: 'original student decision' };
  const event = { id: 'interaction-event', requestId: body.requestId, studentId: 'student', content: body.content };
  const req = fakeRequest('/api/ai-collaboration/events', body, { ok: true, event });
  page.emit('request', req); page.emit('requestfinished', req); await collector.drain();
  page.emit('request', req); page.emit('requestfinished', req); await collector.drain();
  assert.deepEqual(expected.browserInteractionEvents, [{ eventId: event.id, requestId: body.requestId, body, ack: event }]);
  const bad = fakeRequest('/api/ai-collaboration/events', body, { ok: true, event: { ...event, studentId: 'other' } });
  page.emit('request', bad); page.emit('requestfinished', bad);
  await assert.rejects(collector.drain()); collector.detach();
});

test('automatic review retries keep the original body and full final decision', async () => {
  const page = new EventEmitter(); const expected = state();
  const collector = captureDocumentBrowserTraffic(page, { user: { id: 'student' }, fixture: { instanceId: 'course' },
    expected: new Map([['student', expected]]), question: 'q' });
  const body = { action: 'proactive-document-comments', courseId: 'course', studentId: 'student', requestId: 'review-request', documentHtml: '<p>draft</p>' };
  const processing = fakeRequest('/api/ai-collaboration/document', body, { requestId: body.requestId, status: 'processing' }, 202);
  page.emit('request', processing); page.emit('requestfinished', processing); await collector.drain();
  const response = { requestId: body.requestId, status: 'completed', documentVersion: digest(JSON.stringify(body.documentHtml)),
    reviewDecision: { action: body.action, outcome: 'no-comment', rawOutputs: [] }, commentThreads: [] };
  const completed = fakeRequest('/api/ai-collaboration/document', body, response);
  page.emit('request', completed); page.emit('requestfinished', completed); await collector.drain();
  assert.equal(expected.browserReviewRequests.length, 1);
  assert.deepEqual(expected.browserReviewRequests[0].response, response);
  const changed = fakeRequest('/api/ai-collaboration/document', { ...body, documentHtml: 'changed' }, response);
  page.emit('request', changed); page.emit('requestfinished', changed);
  await assert.rejects(collector.drain()); collector.detach();
});

test('additional AI manifests cannot duplicate or replace baseline requests, or hide unfinished browser requests', () => {
  const expected = state();
  assert.equal(capacityAiRequestManifests(expected).length, 2);
  expected.browserDocumentRequests = [{ requestId: 'document-ai-request-extra', status: 'completed' }];
  assert.deepEqual(capacityAiRequestManifests(expected).map(item => item.kind), ['tutor', 'document', 'browser-document']);
  expected.browserDocumentRequests[0].requestId = expected.documentRequestId;
  assert.throws(() => capacityAiRequestManifests(expected), /duplicate/);
  expected.browserDocumentRequests = [{ requestId: 'extra', status: 'processing' }];
  assert.throws(() => capacityAiRequestManifests(expected), /completion/);
});

test('AI reconciliation reads every extra browser task and rejects a different saved answer', async () => {
  const expected = state();
  const browser = { requestId: 'document-ai-request-extra', status: 'completed', messageSha256: digest('question'),
    documentVersion: digest(JSON.stringify('<p>source</p>')), responseSha256: digest('answer'), conversationId: 'logical',
    studentMessageId: 'browser-document-user', assistantMessageId: 'browser-document-assistant' };
  expected.browserDocumentRequests = [browser];
  const owners = { userId: 'student', participationId: 'participation', offeringId: 'offering', researchKey: 'research' };
  const tasks = capacityAiRequestManifests(expected).map(({ kind, requestId, taskType }) => {
    const messages = [{ id: `${kind}-user`, role: 'student', content: 'question' }, { id: `${kind}-assistant`, role: 'agent', content: 'answer' }];
    return { id: kind, taskType, status: 'COMPLETED', completedAt: new Date(), offeringId: 'offering',
      conversationId: 'conversation', conversation: { participationId: 'participation', userId: 'student' },
      input: { requestId, message: 'question', documentVersion: browser.documentVersion },
      output: kind === 'tutor' ? { thread: { messages: [{ role: 'assistant', content: 'answer' }] } }
        : { response: { status: 'completed', requestId, conversationId: 'logical', result: { message: 'answer' }, messages } } };
  });
  const messages = tasks.flatMap(task => [
    { id: task.id === 'tutor' ? 'tutor:student' : `${task.id}-user`, conversationId: 'conversation', role: 'user', userId: 'student', content: 'question' },
    { id: task.id === 'tutor' ? 'tutor:assistant' : `${task.id}-assistant`, conversationId: 'conversation', role: 'assistant', content: 'answer' },
  ]);
  const db = {
    classroomInstance: { findUniqueOrThrow: async () => ({ activity: { chapter: { offeringId: 'offering' } } }) },
    classroomParticipation: { findFirstOrThrow: async () => ({ id: 'participation', enrollment: { researchKey: 'research' } }) },
    aiTask: { findMany: async ({ where }) => tasks.filter(task => task.input.requestId === where.input.equals && task.taskType === where.taskType) },
    aiMessage: { findMany: async ({ where }) => messages.filter(message => where.id.in.includes(message.id)) },
    aiInteractionEvent: { findMany: async ({ where }) => {
      if (where.idempotencyKey) return [{ ...owners }, { ...owners }];
      const task = tasks.find(item => item.input.requestId === where.requestId);
      return [{ ...owners, actor: 'student', content: 'question', taskId: task.id },
        { ...owners, actor: 'assistant', content: 'answer', taskId: task.id }, ...(task.id === 'tutor' ? [] : [{ ...owners, actor: 'system' }])];
    } },
  };
  const input = { db, fixture: { userIds: ['student'], instanceId: 'course', offeringId: 'offering' }, expected: new Map([['student', expected]]), studentCount: 1 };
  const result = await verifyCapacityAiRecords(input);
  assert.equal(result.requests, 3); assert.equal(result.results.at(-1).kind, 'browser-document');
  tasks.at(-1).output.response.result.message = 'wrong saved answer';
  await assert.rejects(verifyCapacityAiRecords(input), /Browser answer differs/);
});

test('includes the post-teaching whole-class document burst without replacing initial requests', () => {
  const requests = capacityAiRequestManifests({ tutorRequestId: 'tutor', documentRequestId: 'initial', followupDocumentRequests: ['after-teaching'] });
  assert.deepEqual(requests.map(item => item.requestId), ['tutor', 'initial', 'after-teaching']);
  assert.equal(requests.at(-1).kind, 'after-learning-document');
  assert.throws(() => capacityAiRequestManifests({ tutorRequestId: 'tutor', documentRequestId: 'initial', followupDocumentRequests: ['initial'] }), /duplicate/);
});
