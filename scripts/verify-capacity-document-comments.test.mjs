import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { capacityCommentTarget, verifyCapacityDocumentComments } from './verify-capacity-document-comments.mjs';

function setup(count = 4, noComment = false) {
  const users = Array.from({ length: count }, (_, index) => ({ id: `student-${index}`, role: 'student' }));
  const fixture = { classroomId: 'capacity-test', instanceId: 'instance', offeringId: 'offering', userIds: users.map(user => user.id) };
  const expected = new Map(users.map(user => [user.id, { content: `<p>${capacityCommentTarget}</p>` }]));
  const checks = [], rows = new Map();
  let active = 0, peak = 0;
  const request = async (user, method, endpoint, body) => {
    assert.equal(method, 'POST'); assert.equal(endpoint, '/api/ai-collaboration/document');
    active++; peak = Math.max(peak, active);
    await delay(5); active--;
    const cached = rows.get(user.id);
    if (cached) { assert.equal(cached.requestId, body.requestId); return cached.response; }
    const logical = `logical-${user.id}`, physical = `physical-${user.id}`;
    const anchor = { id: logical, blockId: body.blockId, blockIndex: 2, blockText: capacityCommentTarget, targetText: '所以每小时节省2度电' };
    const comment = { id: `assistant-${user.id}`, role: 'assistant', content: '前后用电量的变化与节省结论一致吗？' };
    const thread = { ...anchor, comments: [comment] };
    const conversation = { id: physical, userId: user.id, offeringId: 'offering', participationId: `participation-${user.id}` };
    const ownership = { userId: user.id, offeringId: 'offering', participationId: conversation.participationId, researchKey: `research-${user.id}` };
    const messages = noComment ? [] : [
      { id: `system-${user.id}`, role: 'system', content: `OPENPBL_DOCUMENT_COMMENT_META:${JSON.stringify(anchor)}`, metadata: { conversationId: logical, legacyRole: 'system-trigger', visibility: 'teacher-only' }, userId: null, conversationId: physical },
      { id: comment.id, role: 'assistant', content: comment.content, metadata: { conversationId: logical, legacyRole: 'agent', visibility: 'student-and-teacher' }, userId: null, conversationId: physical },
    ];
    const fact = { ...ownership, requestId: body.requestId, actor: 'assistant', eventType: 'comment', content: comment.content,
      conversation: { ...conversation, id: `audit-${logical}` },
      payload: { legacy: { source: 'proactive-comment', conversationId: logical }, detail: { commentThreadId: logical, blockId: body.blockId, blockIndex: 2, targetText: capacityCommentTarget, initialComment: true } } };
    const messageFacts = messages.map(message => ({ ...ownership, idempotencyKey: `companion-message:${message.id}`, content: message.content,
      actor: message.role, conversationId: physical, payload: { legacy: { conversationId: logical } } }));
    const modelShouldComment = !noComment || noComment === 'filtered';
    const raw = JSON.stringify({ shouldComment: modelShouldComment, comment: comment.content });
    const rawSha256 = createHash('sha256').update(raw).digest('hex');
    const documentVersion = digest(body.documentHtml);
    const decision = { outcome: noComment ? 'no-comment' : 'comment', reasonCodes: noComment === 'filtered' ? ['EVIDENCE_NOT_INDEPENDENT'] : noComment ? ['MODEL_NO_COMMENT'] : [], modelShouldComment,
      reviewVersion: 4, action: body.action, documentVersion, blockId: body.blockId, blockIndex: body.blockIndex,
      targetText: body.targetText, rawSha256, rawOutputs: [{ attempt: 1, sha256: rawSha256, validation: 'valid' }], commentThreadId: noComment ? null : logical };
    const response = { commentThread: noComment ? null : thread, requestId: body.requestId, status: 'completed', documentVersion, reviewDecision: decision };
    const taskId = `document-ai-${digest([conversation.participationId, body.requestId])}`;
    const token = `token-${user.id}`;
    const task = { id: taskId, status: 'COMPLETED', taskType: 'DOCUMENT_COLLABORATION', createdById: user.id, offeringId: 'offering', conversation, conversationId: physical,
      input: { requestId: body.requestId, participationId: conversation.participationId, stageKey: body.stageKey, workspaceKind: body.workspaceKind,
        conversationId: 'proactive-document-comment', intent: body.action, message: body.targetText, documentVersion, token,
        fingerprint: digest({ action: body.action, courseId: body.courseId, stageKey: body.stageKey, workspaceKind: body.workspaceKind, documentHtml: body.documentHtml,
          targetText: body.targetText, blockId: body.blockId, blockIndex: body.blockIndex }) }, output: { schemaVersion: 1, response } };
    const rawFact = { ...ownership, idempotencyKey: `legacy-ai:${digest([conversation.participationId, user.id, `document-review-model:${token}:1`])}`, requestId: body.requestId, eventType: 'response', actor: 'system', content: raw, conversation,
      payload: { legacy: { source: 'proactive-comment' }, detail: { kind: 'model-output', action: body.action, requestAttemptId: token, modelAttempt: 1, validation: 'valid', rawSha256, rawLength: raw.length, documentVersion, workspaceKind: body.workspaceKind } } };
    const policyFact = { ...ownership, requestId: body.requestId, eventType: 'policy', actor: 'system', taskId, conversation, conversationId: physical,
      idempotencyKey: `document-review-decision:${conversation.participationId}:${body.requestId}`,
      payload: { legacy: { source: 'proactive-comment' }, detail: { kind: 'document-comment-review', ...decision, requestAttemptId: token, workspaceKind: body.workspaceKind } } };
    fact.taskId = taskId; fact.idempotencyKey = `document-review-comment:${conversation.participationId}:${body.requestId}`;
    rows.set(user.id, { thread, messages, conversation, fact, messageFacts, requestId: body.requestId, task, response, requestFacts: [rawFact, policyFact, ...(noComment ? [] : [fact])] });
    return response;
  };
  const db = {
    aiTask: { findUniqueOrThrow: async ({ where }) => [...rows.values()].find(row => row.task.id === where.id).task },
    classroomParticipation: { findFirstOrThrow: async ({ where }) => ({ id: `participation-${where.enrollment.userId}`, enrollment: { researchKey: `research-${where.enrollment.userId}` } }) },
    aiMessage: {
      findUniqueOrThrow: async ({ where }) => {
        const row = [...rows.values()].find(row => row.messages.some(message => message.id === where.id));
        return { ...row.messages.find(message => message.id === where.id), conversation: row.conversation };
      },
      findMany: async ({ where }) => {
        const selected = [...rows.values()].filter(row => where.conversation ? row.conversation.participationId === where.conversation.participationId : row.conversation.id === where.conversationId);
        return selected.flatMap(row => row.messages).filter(message => !where.metadata || message.metadata.conversationId === where.metadata.equals);
      },
    },
    aiInteractionEvent: { findMany: async ({ where }) => where.requestId
      ? [...rows.values()].filter(row => row.requestId === where.requestId).flatMap(row => row.requestFacts)
      : [...rows.values()].flatMap(row => row.messageFacts).filter(fact => where.idempotencyKey.in.includes(fact.idempotencyKey)) },
  };
  return { users, fixture, request, expected, db, record: (...args) => checks.push(args), checks, rows, peak: () => peak };
}

test('uses two workers and reconciles logical thread IDs, physical messages, and separate audit conversation IDs', async () => {
  const args = setup();
  const summary = await verifyCapacityDocumentComments(args);
  assert.equal(args.peak(), 2);
  assert.equal(summary.threads, 4); assert.equal(summary.messages, 8);
  assert.equal(summary.requestAuditFacts, 12); assert.equal(summary.messageAuditFacts, 8);
  for (const state of args.expected.values()) assert.ok(state.commentRequestId && state.commentThreadId && state.commentConversationId);
});

test('collects failures while continuing all students with bounded concurrency', async () => {
  const args = setup(7);
  let active = 0, peak = 0, completed = 0;
  args.request = async () => {
    active++; peak = Math.max(peak, active); await delay(5); active--; completed++;
    throw new Error('injected model failure');
  };
  await assert.rejects(verifyCapacityDocumentComments(args), error => error instanceof AggregateError && error.errors.length === 7);
  assert.equal(completed, 7); assert.equal(peak, 2);
  assert.equal(args.checks.at(-1)[1], '未通过');
});

test('detects a missing durable system anchor instead of accepting only the visible assistant response', async () => {
  const args = setup(1);
  const read = args.db.aiMessage.findMany;
  args.db.aiMessage.findMany = async input => (await read(input)).filter(message => message.role === 'assistant');
  await assert.rejects(verifyCapacityDocumentComments(args), AggregateError);
  assert.ok(args.expected.get('student-0').commentThreadId, 'Retain acknowledged thread identity for failure reconciliation');
});


test('durable no-comment keeps raw+policy, creates no messages, and records a nonfatal quality failure', async () => {
  const args = setup(3, true);
  const summary = await verifyCapacityDocumentComments(args);
  assert.equal(summary.qualityFailures.length, 3); assert.equal(summary.threads, 0); assert.equal(summary.messages, 0);
  assert.equal(summary.requestAuditFacts, 6); assert.equal(summary.messageAuditFacts, 0);
  assert.equal(args.checks.find(row => row[0] === 'real-ai-background-comments-and-persistence')[1], '通过');
  assert.equal(args.checks.find(row => row[0] === 'real-ai-background-comment-quality')[1], '未通过');
});
for (const broken of ['raw-missing', 'raw-changed', 'policy-missing', 'policy-changed', 'task-ownership', 'replay-changed', 'invented-no-comment-message']) {
  test(`treats ${broken} as fatal integrity failure`, async () => {
    const args = setup(1, broken === 'invented-no-comment-message');
    const request = args.request;
    let calls = 0;
    args.request = async (...input) => {
      const response = await request(...input); calls++;
      const row = args.rows.get('student-0');
      if (broken === 'replay-changed' && calls === 2) return { ...response, status: 'different' };
      if (calls === 1) {
        if (broken === 'raw-missing') row.requestFacts = row.requestFacts.filter(fact => fact.eventType !== 'response');
        if (broken === 'raw-changed') row.requestFacts[0].content += 'corruption';
        if (broken === 'policy-missing') row.requestFacts = row.requestFacts.filter(fact => fact.eventType !== 'policy');
        if (broken === 'policy-changed') row.requestFacts[1].payload.detail.outcome = 'different';
        if (broken === 'task-ownership') row.task.createdById = 'other-student';
        if (broken === 'invented-no-comment-message') row.messages.push({ id: 'fabricated', conversationId: row.conversation.id });
      }
      return response;
    };
    await assert.rejects(verifyCapacityDocumentComments(args), AggregateError);
    assert.equal(args.checks.at(-1)[1], '未通过');
  });
}

test('a policy-filtered model proposal is retained as a nonfatal quality failure', async () => {
  const summary = await verifyCapacityDocumentComments(setup(1, 'filtered'));
  assert.deepEqual(summary.qualityFailures[0].reasonCodes, ['EVIDENCE_NOT_INDEPENDENT']);
  assert.equal(summary.qualityFailures[0].modelShouldComment, true);
  assert.equal(summary.messages, 0);
});
test('an unknown policy reason cannot be classified as a legitimate no-comment', async () => {
  const args = setup(1, 'filtered');
  const request = args.request;
  args.request = async (...input) => {
    const response = await request(...input);
    response.reviewDecision.reasonCodes = ['UNKNOWN_POLICY'];
    args.rows.get('student-0').requestFacts[1].payload.detail.reasonCodes = ['UNKNOWN_POLICY'];
    return response;
  };
  await assert.rejects(verifyCapacityDocumentComments(args), AggregateError);
});

function withRepair(args, corrupt) {
  const request = args.request; let changed = false;
  args.request = async (...input) => {
    const response = await request(...input);
    if (!changed) {
      changed = true;
      const row = args.rows.get('student-0'); const final = row.requestFacts[0];
      const prior = structuredClone(final); prior.content = '{"shouldComment":true,"comment":"missing source"}';
      prior.payload.detail.rawSha256 = createHash('sha256').update(prior.content).digest('hex');
      prior.payload.detail.rawLength = prior.content.length; prior.payload.detail.validation = 'invalid-schema';
      final.payload.detail.modelAttempt = 2;
      final.idempotencyKey = `legacy-ai:${digest([final.participationId, final.userId, `document-review-model:${row.task.input.token}:2`])}`;
      const rawOutputs = [{ attempt: 1, sha256: prior.payload.detail.rawSha256, validation: 'invalid-schema' },
        { attempt: 2, sha256: final.payload.detail.rawSha256, validation: 'valid' }];
      response.reviewDecision.rawOutputs = rawOutputs;
      row.requestFacts.find(fact => fact.eventType === 'policy').payload.detail.rawOutputs = rawOutputs;
      row.requestFacts.unshift(prior);
      if (corrupt === 'missing') row.requestFacts.shift();
      if (corrupt === 'overwritten') prior.content = final.content;
      if (corrupt === 'wrong-final') response.reviewDecision.rawSha256 = prior.payload.detail.rawSha256;
    }
    return response;
  };
  return args;
}
test('reconciles both immutable outputs after one structure repair without adding business messages', async () => {
  const summary = await verifyCapacityDocumentComments(withRepair(setup(1)));
  assert.equal(summary.requestAuditFacts, 4); assert.equal(summary.messages, 2);
});
for (const corrupt of ['missing', 'overwritten', 'wrong-final']) test(`rejects repair raw ${corrupt}`, async () => {
  await assert.rejects(verifyCapacityDocumentComments(withRepair(setup(1), corrupt)), AggregateError);
});

function withHttpFailure(args, { twice = false, corrupt, noRaw = false } = {}) {
  const request = args.request; let calls = 0; let successful; const historical = [];
  args.retryDelayMs = 0;
  args.request = async (...input) => {
    calls++;
    if (calls === 1) {
      await request(...input);
      successful = structuredClone(args.rows.get('student-0'));
    }
    const row = args.rows.get('student-0');
    if (calls === 1 || (calls === 2 && twice)) {
      const token = `failed-token-${calls}`;
      const raw = structuredClone(successful.requestFacts[0]);
      raw.content = '{"shouldComment":true,"comment":"missing fields"}';
      const sha256 = createHash('sha256').update(raw.content).digest('hex');
      raw.idempotencyKey = `legacy-ai:${digest([raw.participationId, raw.userId, `document-review-model:${token}:1`])}`;
      Object.assign(raw.payload.detail, { requestAttemptId: token, validation: 'invalid-schema', rawSha256: sha256, rawLength: raw.content.length });
      const terminal = structuredClone(raw);
      terminal.eventType = 'error'; terminal.content = noRaw ? 'AI_REVIEW_FAILED' : 'AI_REVIEW_INVALID_STRUCTURE';
      terminal.idempotencyKey = `legacy-ai:${digest([raw.participationId, raw.userId, `document-review-error:${token}`])}`;
      terminal.payload.detail = { action: 'proactive-document-comment', requestAttemptId: token,
        documentVersion: row.task.input.documentVersion, workspaceKind: 'document',
        rawOutputs: noRaw ? [] : [{ attempt: 1, sha256, validation: 'invalid-schema' }] };
      row.task.status = 'FAILED'; row.task.input.token = token; row.task.error = terminal.content; row.task.output = null;
      row.messages = []; row.messageFacts = [];
      historical.push(...(noRaw ? [] : [raw]), terminal); row.requestFacts = historical;
      if (corrupt === 'missing-terminal') row.requestFacts = row.requestFacts.filter(fact => fact.eventType !== 'error');
      if (corrupt === 'missing-raw') row.requestFacts = row.requestFacts.filter(fact => fact.eventType !== 'response');
      if (corrupt === 'bad-hash') raw.content += 'changed';
      if (corrupt === 'running') row.task.status = 'RUNNING';
      if (corrupt === 'wrong-body') row.task.input.fingerprint = 'changed';
      if (corrupt === 'unknown-error') row.task.error = terminal.content = 'UNKNOWN_ERROR';
      if (corrupt === 'empty-structure') { row.requestFacts = [terminal]; terminal.payload.detail.rawOutputs = []; }
      if (corrupt === 'missing-second-repair') row.task.error = terminal.content = 'AI_RESPONSE_INVALID_STRUCTURE';
      if (corrupt === 'fake-messages') row.messages = successful.messages;
      throw Object.assign(new Error('injected HTTP service failure'), { status: corrupt === 'conflict' ? 409 : 503 });
    }
    if (calls === 2) {
      const restored = structuredClone(successful); restored.task.input.token = 'recovered-token';
      restored.requestFacts[0].payload.detail.requestAttemptId = 'recovered-token';
      restored.requestFacts[0].idempotencyKey = `legacy-ai:${digest([restored.task.input.participationId, 'student-0', 'document-review-model:recovered-token:1'])}`;
      restored.requestFacts[1].payload.detail.requestAttemptId = 'recovered-token';
      if (corrupt === 'old-token-as-success') restored.task.input.token = 'failed-token-1';
      restored.requestFacts = [...historical, ...restored.requestFacts];
      if (corrupt === 'lost-old-raw') restored.requestFacts.shift();
      if (corrupt === 'overwritten-old') restored.requestFacts[0].content += 'replaced';
      if (corrupt === 'duplicate-old') restored.requestFacts.push(structuredClone(historical[0]));
      if (corrupt === 'conversation-updated') for (const fact of restored.requestFacts) fact.conversation.updatedAt = 'later ordinary message';
      args.rows.set('student-0', restored);
      return restored.response;
    }
    return request(...input);
  };
  return { args, calls: () => calls };
}

test('retries one fully audited FAILED task with stable body/ID, preserving first failure despite recovery', async () => {
  const testCase = withHttpFailure(setup(1));
  const original = testCase.args.request; const bodies = [];
  testCase.args.request = async (...input) => { bodies.push(structuredClone(input[3])); return original(...input); };
  const summary = await verifyCapacityDocumentComments(testCase.args);
  assert.equal(testCase.calls(), 3); // failure, explicit retry, completed receipt replay
  assert.deepEqual(bodies[0], bodies[1]); assert.deepEqual(bodies[1], bodies[2]);
  assert.equal(summary.threads, 1); assert.equal(summary.messages, 2); assert.equal(summary.requestAuditFacts, 5);
  assert.equal(summary.firstAttemptFailureRate, 1); assert.equal(summary.unrecoveredServiceFailures, 0);
  assert.equal(summary.qualityFailures.length, 1); assert.equal(summary.qualityFailures[0].recovered, true);
  assert.equal(testCase.args.checks.find(row => row[0] === 'real-ai-background-comment-reliability')[1], '未通过');
});
test('two fully retained service failures allow later soak but remain explicit failed reliability/quality', async () => {
  const { args, calls } = withHttpFailure(setup(1), { twice: true });
  const summary = await verifyCapacityDocumentComments(args);
  assert.equal(calls(), 2); assert.equal(summary.threads, 0); assert.equal(summary.messages, 0);
  assert.equal(summary.qualityFailures.length, 2); assert.equal(summary.unrecoveredServiceFailures, 1);
  assert.equal(summary.requestAuditFacts, 4); assert.equal(summary.firstAttemptFailureRate, 1);
});
test('provider failure before a raw output is accepted only with an explicit empty manifest and durable error', async () => {
  const { args } = withHttpFailure(setup(1), { noRaw: true });
  const summary = await verifyCapacityDocumentComments(args);
  assert.equal(summary.requestAuditFacts, 4); assert.equal(summary.qualityFailures[0].errorCode, 'AI_REVIEW_FAILED');
});
test('does not begin a retry when its delay would exhaust the 60 second total budget', async () => {
  const { args, calls } = withHttpFailure(setup(1)); args.retryDelayMs = 60000;
  const summary = await verifyCapacityDocumentComments(args);
  assert.equal(calls(), 1); assert.equal(summary.unrecoveredServiceFailures, 1); assert.equal(summary.qualityFailures.length, 1);
});
for (const corrupt of ['missing-terminal', 'missing-raw', 'bad-hash', 'running', 'wrong-body', 'unknown-error', 'empty-structure', 'missing-second-repair', 'fake-messages', 'conflict', 'lost-old-raw', 'overwritten-old', 'duplicate-old', 'old-token-as-success']) {
  test(`does not downgrade ${corrupt} into a recoverable AI quality failure`, async () => {
    const { args } = withHttpFailure(setup(1), { corrupt });
    await assert.rejects(verifyCapacityDocumentComments(args), AggregateError);
    assert.equal(args.checks.at(-1)[0], 'real-ai-background-comments-and-persistence');
    assert.equal(args.checks.at(-1)[1], '未通过');
  });
}

test('ordinary conversation timestamp changes do not mutate immutable failure facts', async () => {
  const { args } = withHttpFailure(setup(1), { corrupt: 'conversation-updated' });
  const summary = await verifyCapacityDocumentComments(args);
  assert.equal(summary.qualityFailures[0].recovered, true);
});
