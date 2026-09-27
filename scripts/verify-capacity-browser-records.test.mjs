import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { paragraphFingerprint, progressReplaySnapshot, verifyBrowserReviewRecords, verifyProgressReceipt } from './verify-capacity-browser-records.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const hash = value => sha(JSON.stringify(value));
function setup({ noComment = false, historical = false } = {}) {
  const user = { id: 'student', participationId: 'participation' }, fixture = { instanceId: 'instance', offeringId: 'offering' };
  const participation = { id: user.participationId, enrollment: { researchKey: 'research' } };
  const candidate = { candidateId: 'candidate', blockId: 'block', blockIndex: 1, targetText: '我们节省的电量其实没有相关依据。' };
  const body = { requestId: 'request', action: 'proactive-document-comments', courseId: fixture.instanceId, studentId: user.id, stageKey: 'make', workspaceKind: 'document', documentHtml: `<p>${candidate.targetText}</p>`, paragraphs: [candidate] };
  const ownership = { userId: user.id, participationId: participation.id, offeringId: fixture.offeringId, researchKey: participation.enrollment.researchKey };
  const physical = 'physical', token = 'token', raw = '{"comments":[],"reviewedCandidateIds":["candidate"]}';
  const task = { createdById: user.id, offeringId: fixture.offeringId, taskType: 'DOCUMENT_COLLABORATION', id: `document-ai-${hash([participation.id, body.requestId])}`, conversationId: physical, conversation: ownership, startedAt: new Date('2026-09-27T02:00:00Z'), status: 'COMPLETED',
    input: { requestId: body.requestId, participationId: participation.id, intent: body.action, conversationId: body.action, stageKey: body.stageKey, workspaceKind: body.workspaceKind, token, documentVersion: hash(body.documentHtml), message: JSON.stringify([candidate]), fingerprint: hash({ action: body.action, courseId: body.courseId, stageKey: body.stageKey, workspaceKind: body.workspaceKind, documentHtml: body.documentHtml, proactiveParagraphs: [candidate] }) } };
  const anchor = { id: 'thread', blockId: candidate.blockId, blockIndex: candidate.blockIndex, blockText: candidate.targetText, targetText: '节省的电量', reviewVersion: 4, issueType: 'unsupported-claim' };
  const comment = { id: 'assistant', content: '请补充具体测量依据。' };
  const thread = { ...anchor, comments: [comment] };
  const positive = !noComment && !historical;
  const decision = { action: body.action, reviewVersion: 4, documentVersion: task.input.documentVersion, requestedCandidates: [candidate],
    outcome: positive ? 'comment' : 'no-comment', complete: true, reasonCodes: historical ? ['ALL_ALREADY_REVIEWED'] : noComment ? ['MODEL_NO_COMMENT'] : [],
    reviewedCandidateIds: historical ? [] : [candidate.candidateId],
    ...(historical ? {} : { createdCommentThreadIds: positive ? [thread.id] : [] }),
    rawOutputs: historical ? [] : [{ attempt: 1, sha256: sha(raw), validation: 'valid' }] };
  const response = { reviewedParagraphFingerprints: [paragraphFingerprint(candidate.targetText)], requestId: body.requestId, status: 'completed', documentVersion: task.input.documentVersion, reviewDecision: decision, commentThreads: positive ? [thread] : [], complete: true, reviewedCandidateIds: decision.reviewedCandidateIds };
  task.output = { schemaVersion: 1, response };
  const review = { requestId: body.requestId, body, response, status: 'completed' };
  const facts = [];
  const rawFact = { ...ownership, requestId: body.requestId, actor: 'system', eventType: 'response', content: raw,
    idempotencyKey: `legacy-ai:${hash([participation.id, user.id, `document-review-model:${token}:1`])}`,
    payload: { legacy: { source: 'proactive-comment' }, detail: { kind: 'model-output', action: body.action, requestAttemptId: token, modelAttempt: 1, rawSha256: sha(raw), rawLength: raw.length, documentVersion: task.input.documentVersion, workspaceKind: body.workspaceKind, validation: 'valid' } } };
  if (!historical) facts.push(rawFact);
  const policy = { ...ownership, requestId: body.requestId, eventType: 'policy', actor: 'system', taskId: task.id, conversationId: physical,
    idempotencyKey: `document-review-decision:${participation.id}:${body.requestId}`,
    payload: { legacy: { source: 'proactive-comment', stageKey: body.stageKey, conversationId: body.action }, detail: { kind: 'document-comment-review', ...decision, requestAttemptId: token, workspaceKind: body.workspaceKind } } };
  facts.push(policy);
  const checkpoint = { id: 'checkpoint', conversationId: physical, userId: null, role: 'system', createdAt: new Date(historical ? '2026-09-26T02:00:00Z' : '2026-09-27T02:00:01Z'),
    content: `OPENPBL_DOCUMENT_COMMENT_REVIEW:${JSON.stringify({ fingerprint: paragraphFingerprint(candidate.targetText), reviewVersion: 4 })}`,
    metadata: { conversationId: 'review-fingerprint', legacyRole: 'system-trigger', visibility: 'teacher-only' } };
  const messages = [checkpoint];
  if (positive) {
    messages.push({ id: 'anchor', conversationId: physical, userId: null, role: 'system', createdAt: new Date('2026-09-27T02:00:01Z'), content: `OPENPBL_DOCUMENT_COMMENT_META:${JSON.stringify(anchor)}`, metadata: { conversationId: thread.id, legacyRole: 'system-trigger', visibility: 'teacher-only' } },
      { id: comment.id, conversationId: physical, userId: null, role: 'assistant', content: comment.content, metadata: { conversationId: thread.id, legacyRole: 'agent', visibility: 'student-and-teacher' } });
    facts.push({ ...ownership, requestId: body.requestId, actor: 'assistant', eventType: 'comment', taskId: task.id, conversationId: physical, content: comment.content,
      idempotencyKey: `document-review-comment:${participation.id}:${body.requestId}:${thread.id}`,
      payload: { legacy: { conversationId: thread.id }, detail: { commentThreadId: thread.id, blockId: thread.blockId, blockIndex: thread.blockIndex, issueType: thread.issueType, targetText: thread.targetText } } });
  }
  const messageFacts = messages.map(message => ({ ...ownership, idempotencyKey: `companion-message:${message.id}`, actor: message.role, eventType: message.role === 'assistant' ? 'response' : 'comment', content: message.content, conversationId: physical, payload: { legacy: { conversationId: message.metadata.conversationId }, detail: { messageId: message.id, visibility: message.metadata.visibility } } }));
  const db = { aiTask: { findMany: async () => [task] }, aiMessage: { findMany: async () => messages }, aiInteractionEvent: { findMany: async ({ where }) => where.requestId ? facts : messageFacts.filter(fact => fact.idempotencyKey === where.idempotencyKey) } };
  return { db, user, fixture, participation, review, task, facts, rawFact, policy, messages, messageFacts, checkpoint };
}
test('complete fresh batch reconciles raw, policy, checkpoint, initial anchor and both message facts', async () => {
  const args = setup();
  // Normal later replies/read markers must not invalidate the immutable initial pair.
  args.messages.push({ id: 'later-read', role: 'system', content: 'OPENPBL_DOCUMENT_COMMENT_READ:{}', metadata: { conversationId: 'thread' } });
  await verifyBrowserReviewRecords(args);
});
test('fresh no-comment needs durable raw, decision and checkpoint but no invented comment', async () => { await verifyBrowserReviewRecords(setup({ noComment: true })); });
test('zero model calls accepted only for already reviewed content with historical checkpoint', async () => { await verifyBrowserReviewRecords(setup({ historical: true })); });
const corruptions = {
  'missing raw': args => args.facts.splice(0, 1),
  'duplicate raw attempt': args => args.facts.push(structuredClone(args.rawFact)),
  'altered raw': args => { args.rawFact.content += 'corruption'; },
  'wrong raw attempt token': args => { args.rawFact.payload.detail.requestAttemptId = 'wrong'; },
  'missing decision': args => args.facts.splice(args.facts.indexOf(args.policy), 1),
  'wrong task fingerprint': args => { args.task.input.fingerprint = 'wrong'; },
  'wrong task identity': args => { args.task.id = 'wrong'; },
  'wrong policy ownership': args => { args.policy.researchKey = 'another-student'; },
  'wrong decision task link': args => { args.policy.taskId = 'another-task'; },
  'missing fresh checkpoint even with valid comment anchor': args => args.messages.splice(args.messages.findIndex(message => message.id === 'checkpoint'), 1),
  'missing system anchor': args => args.messages.splice(args.messages.findIndex(message => message.id === 'anchor'), 1),
  'missing companion fact': args => args.messageFacts.splice(args.messageFacts.findIndex(fact => fact.idempotencyKey === 'companion-message:assistant'), 1),
  'missing comment fact': args => args.facts.splice(args.facts.findIndex(fact => fact.eventType === 'comment'), 1),
};
for (const [name, mutate] of Object.entries(corruptions)) test(`rejects ${name}`, async () => { const args = setup(); mutate(args); await assert.rejects(verifyBrowserReviewRecords(args)); });
test('no-comment without raw cannot masquerade as valid fresh model evidence', async () => {
  const args = setup({ noComment: true }); args.review.response.reviewDecision.rawOutputs.length = 0; args.facts.splice(0, 1);
  await assert.rejects(verifyBrowserReviewRecords(args));
});
test('historical reuse rejects newly created or absent checkpoints', async () => {
  const args = setup({ historical: true }); args.checkpoint.createdAt = new Date('2026-09-27T02:01:00Z');
  await assert.rejects(verifyBrowserReviewRecords(args)); args.messages.length = 0; await assert.rejects(verifyBrowserReviewRecords(args));
});
test('retained earlier failed request attempts do not count as current raw attempts', async () => {
  const args = setup(); const old = structuredClone(args.rawFact); old.payload.detail.requestAttemptId = 'old';
  old.idempotencyKey = `legacy-ai:${hash([args.participation.id, args.user.id, 'document-review-model:old:1'])}`;
  args.facts.push(old); await verifyBrowserReviewRecords(args);
});
test('progress receipt verifies ownership, stable identity, original body hash and exact ACK', () => {
  const { user, fixture, participation } = setup();
  const body = { courseId: fixture.instanceId, studentId: user.id, classroomId: 'lecture', currentSceneIndex: 1, totalScenes: 2, completedScenes: ['scene'], completionModelVersion: 2, studentName: '学生', requestId: 'progress-request' };
  const { requestId, ...input } = body; const ack = { data: { progress: { lastActiveAt: 'original', currentSceneIndex: 1 } } };
  const row = { actorId: user.id, participationId: participation.id, offeringId: fixture.offeringId, classroomInstanceId: fixture.instanceId, researchKey: participation.enrollment.researchKey, eventType: 'UPDATE_STUDENT_PROGRESS', idempotencyKey: `ai-progress:${fixture.instanceId}:${user.id}:${requestId}`,
    payload: { requestId, studentId: user.id, stageKey: 'ai-learning', scope: 'student', fingerprint: hash(input), response: ack.data.progress } };
  const args = { row, user, fixture, participation, body, ack }; verifyProgressReceipt(args);
  for (const key of ['actorId', 'participationId', 'researchKey', 'idempotencyKey']) assert.throws(() => verifyProgressReceipt({ ...args, row: { ...row, [key]: 'wrong' } }));
  assert.throws(() => verifyProgressReceipt({ ...args, body: { ...body, currentSceneIndex: 0 } }));
  assert.throws(() => verifyProgressReceipt({ ...args, ack: { data: { progress: {} } } }));
});
test('replay snapshots detect silent state, lastActiveAt, version and event count mutations', async () => {
  const { user, fixture } = setup(); let workspace = { version: 1, updatedAt: new Date(), projectState: { aiLearningProgress: { lastActiveAt: 'original' } } }, count = 1;
  const db = { classroomParticipation: { findUniqueOrThrow: async () => ({ stageProgress: { progress: { 'ai-learning': 100 } } }) }, classroomInstance: { findUniqueOrThrow: async () => ({ runtimeConfig: { version: 1 }, updatedAt: new Date('2026-09-27') }) }, studentProjectWorkspace: { findUniqueOrThrow: async () => structuredClone(workspace) }, domainEvent: { count: async () => count } };
  const args = { db, fixture, users: [user] }; const before = await progressReplaySnapshot(args);
  assert.deepEqual(await progressReplaySnapshot(args), before);
  workspace.projectState.aiLearningProgress.lastActiveAt = 'changed'; assert.notDeepEqual(await progressReplaySnapshot(args), before);
  workspace = structuredClone(before.learners[0].workspace); count++; assert.notDeepEqual(await progressReplaySnapshot(args), before);
});

test('two model attempts retain invalid raw independently and bind the final valid attempt', async () => {
  const args = setup(); const first = structuredClone(args.rawFact);
  first.content = '{invalid'; first.payload.detail.rawLength = first.content.length;
  first.payload.detail.rawSha256 = sha(first.content); first.payload.detail.validation = 'invalid-json';
  args.rawFact.payload.detail.modelAttempt = 2;
  args.rawFact.idempotencyKey = `legacy-ai:${hash([args.participation.id, args.user.id, 'document-review-model:token:2'])}`;
  args.review.response.reviewDecision.rawOutputs[0].attempt = 2;
  args.review.response.reviewDecision.rawOutputs.unshift({ attempt: 1, sha256: sha(first.content), validation: 'invalid-json' });
  args.facts.push(first); await verifyBrowserReviewRecords(args);
});
test('historical version-four comment anchor can prove prior review without another model call', async () => {
  const args = setup({ historical: true });
  args.checkpoint.content = `OPENPBL_DOCUMENT_COMMENT_META:${JSON.stringify({ reviewVersion: 4, blockText: args.review.body.paragraphs[0].targetText })}`;
  args.messageFacts[0].content = args.checkpoint.content; await verifyBrowserReviewRecords(args);
});
