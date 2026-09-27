/** Real background AI comment acceptance. No API/model mocks or credential files.
 * Uses two workers to respect the background-review capacity independently of
 * the foreground AI burst. Database access below is read-only reconciliation.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const capacityCommentTarget = '改造前照明每小时耗电10度，改造后每小时耗电12度，所以每小时节省2度电。';
const metaPrefix = 'OPENPBL_DOCUMENT_COMMENT_META:';
const filteredReasons = new Set(['NOT_CRITICAL', 'INTERVENTION_NOT_REQUIRED', 'UNSUPPORTED_ISSUE_TYPE',
  'INVALID_TARGET_QUOTE', 'INVALID_EVIDENCE_SOURCE', 'MISSING_EVIDENCE', 'EVIDENCE_NOT_INDEPENDENT',
  'EVIDENCE_NOT_IN_DOCUMENT_CONTEXT', 'EVIDENCE_NOT_IN_COURSE', 'MISSING_IMPACT', 'EMPTY_COMMENT']);

function assertOwnership(row, userId, fixture, participation) {
  assert.equal(row.userId, userId);
  assert.equal(row.offeringId, fixture.offeringId);
  assert.equal(row.participationId, participation.id);
  assert.equal(row.researchKey, participation.enrollment.researchKey);
}

function assertTaskIdentity(task, { user, fixture, participation, body }) {
  assert.equal(task.taskType, 'DOCUMENT_COLLABORATION');
  assert.equal(task.createdById, user.id); assert.equal(task.offeringId, fixture.offeringId);
  assert.equal(task.conversation.userId, user.id); assert.equal(task.conversation.participationId, participation.id);
  assert.equal(task.conversation.offeringId, fixture.offeringId);
  assert.equal(task.input.requestId, body.requestId); assert.equal(task.input.participationId, participation.id);
  assert.equal(task.input.stageKey, body.stageKey); assert.equal(task.input.workspaceKind, body.workspaceKind);
  assert.equal(task.input.conversationId, 'proactive-document-comment'); assert.equal(task.input.intent, body.action);
  assert.equal(task.input.message, body.targetText); assert.equal(task.input.documentVersion, digest(body.documentHtml));
  assert.equal(task.input.fingerprint, digest({ action: body.action, courseId: body.courseId, stageKey: body.stageKey, workspaceKind: body.workspaceKind,
    documentHtml: body.documentHtml, targetText: body.targetText, blockId: body.blockId, blockIndex: body.blockIndex }));
  assert.ok(typeof task.input.token === 'string' && task.input.token.length > 0);
}
function assertFactOwnership(facts, { user, fixture, participation }) {
  for (const fact of facts) {
    assertOwnership(fact, user.id, fixture, participation);
    assert.equal(fact.conversation?.userId, user.id); assert.equal(fact.conversation?.participationId, participation.id);
    assert.equal(fact.conversation?.offeringId, fixture.offeringId);
    assert.equal(fact.payload.legacy.source, 'proactive-comment');
  }
}
function assertRawAttempts(rawFacts, outputs, token, context, completed) {
  const { participation, user, body } = context;
  assert.ok(Array.isArray(outputs) && outputs.length <= 2 && (!completed || outputs.length >= 1));
  assert.equal(rawFacts.length, outputs.length, 'Every failed and successful raw result must survive replay');
  for (const [index, output] of outputs.entries()) {
    assert.equal(output.attempt, index + 1);
    assert.ok(['valid', 'invalid-json', 'invalid-schema'].includes(output.validation));
    if (completed && index === outputs.length - 1) assert.equal(output.validation, 'valid');
    if (output.validation === 'valid') {
      assert.ok(Array.isArray(output.policyReasonCodes), 'Every complete proposal must retain its strict policy reasons');
      if (index < outputs.length - 1) assert.deepEqual(output.policyReasonCodes, ['EVIDENCE_NOT_INDEPENDENT'], 'Only overlapping evidence can trigger a semantic repair');
    }
    const matches = rawFacts.filter(fact => fact.payload.detail.modelAttempt === output.attempt);
    assert.equal(matches.length, 1, 'Each model attempt requires one immutable raw fact');
    const raw = matches[0];
    assert.equal(raw.idempotencyKey, `legacy-ai:${digest([participation.id, user.id, `document-review-model:${token}:${output.attempt}`])}`);
    assert.equal(raw.actor, 'system'); assert.ok(typeof raw.content === 'string');
    assert.equal(createHash('sha256').update(raw.content).digest('hex'), output.sha256);
    assert.equal(raw.payload.detail.rawSha256, output.sha256); assert.equal(raw.payload.detail.rawLength, raw.content.length);
    assert.deepEqual(raw.payload.detail.policyReasonCodes, output.policyReasonCodes, 'Policy reason manifest differs from the immutable raw fact');
    assert.equal(raw.payload.detail.validation, output.validation); assert.equal(raw.payload.detail.requestAttemptId, token);
    assert.equal(raw.payload.detail.documentVersion, digest(body.documentHtml)); assert.equal(raw.payload.detail.action, body.action);
    assert.equal(raw.payload.detail.workspaceKind, body.workspaceKind);
  }
}
function assertPriorFailures(facts, snapshots) {
  for (const snapshot of snapshots) for (const original of snapshot.facts) {
    const rows = facts.filter(fact => fact.idempotencyKey === original.idempotencyKey);
    assert.equal(rows.length, 1, 'Previously failed attempt must remain exactly once');
    const factOnly = row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'conversation'));
    assert.deepEqual(factOnly(rows[0]), factOnly(original), 'A failed attempt was modified or replaced during recovery');
  }
}

export async function verifyCapacityDocumentComments({ users, fixture, request, record, expected, db, retryDelayMs = 2500 }) {
  assert.ok(fixture.classroomId?.startsWith('capacity-'), 'Only capacity-owned fixtures may be used');
  const students = users.filter(user => user.role === 'student');
  assert.ok(students.length > 0 && students.every(user => fixture.userIds.includes(user.id)));
  assert.ok(students.every(user => expected.has(user.id)));
  const results = new Array(students.length);
  const failures = [];
  const qualityFailures = [];
  let next = 0;
  const started = performance.now();
  async function verifyStudent(user) {
    const state = expected.get(user.id);
    assert.ok(state.content?.includes(capacityCommentTarget), 'The stored draft must include the exact contradictory paragraph');
    state.commentRequestId ??= randomUUID();
    state.commentBlockId ??= `capacity-comment-block:${user.id}`;
    const body = { action: 'proactive-document-comment', courseId: fixture.instanceId, studentId: user.id,
      stageKey: 'make', workspaceKind: 'document', requestId: state.commentRequestId,
      blockId: state.commentBlockId, blockIndex: 2, targetText: capacityCommentTarget, documentHtml: state.content };
    const participation = await db.classroomParticipation.findFirstOrThrow({
      where: { instanceId: fixture.instanceId, enrollment: { userId: user.id, offeringId: fixture.offeringId } }, include: { enrollment: true },
    });
    const messagesBefore = await db.aiMessage.findMany({ where: { conversation: { participationId: participation.id } }, select: { id: true, conversationId: true } });
    const taskId = `document-ai-${digest([participation.id, body.requestId])}`;
    const context = { user, fixture, participation, body };
    const failedSnapshots = [];
    const requestStarted = performance.now();
    let response;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        response = await request(user, 'POST', '/api/ai-collaboration/document', body, {
          category: attempt === 1 ? 'real-ai-background-comments' : 'real-ai-background-comment-explicit-retry',
          timeout: Math.max(1, Math.ceil(60000 - (performance.now() - requestStarted))),
        });
        break;
      } catch (error) {
        assert.ok([500, 502, 503, 504].includes(error?.status), 'Only explicit HTTP service failures can enter audited review recovery');
        const task = await db.aiTask.findUniqueOrThrow({ where: { id: taskId }, include: { conversation: true } });
        assertTaskIdentity(task, context);
        assert.equal(task.status, 'FAILED', 'Unknown/running/completed task after HTTP failure must stop acceptance');
        assert.ok(['AI_RESPONSE_INVALID_STRUCTURE', 'AI_REVIEW_INVALID_STRUCTURE', 'AI_REVIEW_FAILED', 'AI_PROACTIVE_REVIEW_BUSY', 'AI_COLLABORATION_TIMEOUT'].includes(task.error));
        assert.equal(task.output, null);
        assert.ok(!failedSnapshots.some(item => item.token === task.input.token), 'A retry must have its own attempt token');
        const facts = await db.aiInteractionEvent.findMany({ where: { requestId: body.requestId }, include: { conversation: true } });
        assertFactOwnership(facts, context); assertPriorFailures(facts, failedSnapshots);
        const current = facts.filter(fact => fact.payload?.detail?.requestAttemptId === task.input.token);
        const terminals = current.filter(fact => fact.eventType === 'error');
        assert.equal(terminals.length, 1, 'Failed task needs exactly one durable failure terminal');
        const terminal = terminals[0]; const detail = terminal.payload.detail;
        assert.equal(terminal.idempotencyKey, `legacy-ai:${digest([participation.id, user.id, `document-review-error:${task.input.token}`])}`);
        assert.equal(terminal.actor, 'system'); assert.equal(terminal.content, task.error);
        assert.equal(detail.action, body.action); assert.equal(detail.workspaceKind, body.workspaceKind);
        assert.equal(detail.documentVersion, digest(body.documentHtml));
        if (task.error === 'AI_COLLABORATION_TIMEOUT') {
          assert.equal(error.status, 504);
          assert.equal(detail.failureKind, 'timeout');
          assert.equal(detail.deadlineMs, 40000);
          assert.ok(Number.isFinite(detail.elapsedMs) && detail.elapsedMs >= 0);
        }
        const raws = current.filter(fact => fact.eventType === 'response' && fact.payload?.detail?.kind === 'model-output');
        assertRawAttempts(raws, detail.rawOutputs, task.input.token, context, false);
        if (['AI_RESPONSE_INVALID_STRUCTURE', 'AI_REVIEW_INVALID_STRUCTURE'].includes(task.error)) {
          assert.ok(raws.length >= 1 && detail.rawOutputs.at(-1).validation !== 'valid', 'A structure failure must retain its invalid model output');
          if (task.error === 'AI_RESPONSE_INVALID_STRUCTURE') assert.equal(raws.length, 2, 'Exhausted structure repair requires both outputs');
        }
        assert.equal(current.length, raws.length + 1);
        assert.equal(facts.length, current.length + failedSnapshots.reduce((sum, item) => sum + item.facts.length, 0), 'Unknown extra facts cannot be ignored');
        const after = await db.aiMessage.findMany({ where: { conversationId: task.conversationId }, select: { id: true } });
        assert.deepEqual(after.map(row => row.id).sort(), messagesBefore.filter(row => row.conversationId === task.conversationId).map(row => row.id).sort(), 'Failed review cannot fabricate messages');
        failedSnapshots.push({ token: task.input.token, facts: structuredClone(current) });
        const failure = { userId: user.id, requestId: body.requestId, taskId, outcome: 'request-failed',
          attempt, status: error.status, errorCode: task.error, requestAttemptId: task.input.token,
          rawOutputs: structuredClone(detail.rawOutputs), elapsedMs: Math.round(performance.now() - requestStarted), recovered: false };
        qualityFailures.push(failure);
        state.commentRequestFailures ??= []; state.commentRequestFailures.push(failure); state.commentTaskId = taskId;
        record('real-ai-background-comment-request-failed', '未通过', failure);
        if (attempt === 2 || performance.now() - requestStarted + retryDelayMs >= 60000) {
          return { userId: user.id, requestId: body.requestId, taskId, requestMs: Math.round(performance.now() - requestStarted),
            serviceFailed: true, messageCount: 0, requestAuditCount: facts.length, messageAuditCount: 0 };
        }
        await delay(retryDelayMs);
      }
    }
    const requestMs = Math.round(performance.now() - requestStarted);
    if (requestMs > 60000) qualityFailures.push({ userId: user.id, requestId: body.requestId, taskId, outcome: 'completion-timeout', elapsedMs: requestMs });
    assert.equal(response.requestId, body.requestId); assert.equal(response.status, 'completed');
    assert.equal(response.documentVersion, digest(body.documentHtml));
    const decision = response.reviewDecision;
    assert.ok(decision && ['comment', 'no-comment'].includes(decision.outcome), 'A completed review must return its explicit decision');
    assert.equal(decision.reviewVersion, 4); assert.equal(decision.action, body.action);
    assert.equal(decision.documentVersion, response.documentVersion); assert.equal(decision.blockId, body.blockId);
    assert.equal(decision.blockIndex, body.blockIndex); assert.equal(decision.targetText, body.targetText);
    assert.ok(Array.isArray(decision.reasonCodes) && decision.reasonCodes.every(reason => typeof reason === 'string'));
    assert.match(decision.rawSha256 ?? '', /^[0-9a-f]{64}$/, 'Fresh capacity reviews require real model output, not EXISTING_COMMENT reuse');
    const task = await db.aiTask.findUniqueOrThrow({ where: { id: taskId }, include: { conversation: true } });
    assert.equal(task.status, 'COMPLETED'); assertTaskIdentity(task, context);
    assert.ok(!failedSnapshots.some(item => item.token === task.input.token), 'Success must belong to its own request attempt');
    assert.equal(task.output.schemaVersion, 1); assert.deepEqual(task.output.response, response);
    state.commentTaskId = taskId; state.commentReviewDecision = decision; state.commentRawSha256 = decision.rawSha256;
    const replay = await request(user, 'POST', '/api/ai-collaboration/document', body, { category: 'real-ai-background-comment-replay', timeout: 90000 });
    assert.deepEqual(replay, response, 'Same-ID replay must return the entire committed receipt unchanged');
    const replayTask = await db.aiTask.findUniqueOrThrow({ where: { id: taskId }, include: { conversation: true } });
    assert.deepEqual(replayTask.input, task.input); assert.deepEqual(replayTask.output, task.output);
    assert.equal(replayTask.status, 'COMPLETED');
    const requestFacts = await db.aiInteractionEvent.findMany({ where: { requestId: body.requestId }, include: { conversation: true } });
    assertFactOwnership(requestFacts, context); assertPriorFailures(requestFacts, failedSnapshots);
    const priorFactCount = failedSnapshots.reduce((sum, item) => sum + item.facts.length, 0);
    const rawFacts = requestFacts.filter(fact => fact.eventType === 'response' && fact.payload?.detail?.kind === 'model-output' && fact.payload.detail.requestAttemptId === task.input.token);
    const policyFacts = requestFacts.filter(fact => fact.eventType === 'policy');
    assert.equal(policyFacts.length, 1, 'One durable policy decision must survive the replay');
    const policy = policyFacts[0];
    assertRawAttempts(rawFacts, decision.rawOutputs, task.input.token, context, true);
    assert.equal(decision.rawSha256, decision.rawOutputs.at(-1).sha256, 'Decision must use the final recorded output');
    assert.deepEqual(decision.reasonCodes, decision.rawOutputs.at(-1).policyReasonCodes, 'Final decision must match the final raw policy assessment');
    assert.equal(policy.actor, 'system'); assert.equal(policy.taskId, taskId);
    assert.equal(policy.conversationId, task.conversationId);
    assert.equal(policy.idempotencyKey, `document-review-decision:${participation.id}:${body.requestId}`);
    assert.deepEqual(policy.payload.detail, { kind: 'document-comment-review', ...decision, requestAttemptId: task.input.token, workspaceKind: body.workspaceKind });
    for (const failure of state.commentRequestFailures ?? []) failure.recovered = true;
    if (decision.outcome === 'no-comment') {
      assert.equal(response.commentThread, null); assert.equal(decision.commentThreadId, null);
      assert.ok(decision.reasonCodes.length > 0); assert.equal(typeof decision.modelShouldComment, 'boolean');
      if (decision.modelShouldComment === false) assert.deepEqual(decision.reasonCodes, ['MODEL_NO_COMMENT']);
      else assert.ok(decision.reasonCodes.every(reason => filteredReasons.has(reason)), 'Filtered positive proposals require recognized policy reasons');
      assert.equal(requestFacts.length, priorFactCount + rawFacts.length + 1, 'No-comment retains every raw plus policy only');
      const after = await db.aiMessage.findMany({ where: { conversationId: task.conversationId }, select: { id: true } });
      assert.deepEqual(after.map(row => row.id).sort(), messagesBefore.filter(row => row.conversationId === task.conversationId).map(row => row.id).sort(), 'A no-comment decision cannot fabricate messages');
      const qualityFailure = { userId: user.id, requestId: body.requestId, outcome: decision.outcome, reasonCodes: decision.reasonCodes, modelShouldComment: decision.modelShouldComment, taskId, rawSha256: decision.rawSha256 };
      qualityFailures.push(qualityFailure);
      return { userId: user.id, requestId: body.requestId, taskId, requestMs, messageCount: 0, requestAuditCount: requestFacts.length, messageAuditCount: 0, qualityFailure };
    }
    assert.equal(decision.modelShouldComment, true); assert.deepEqual(decision.reasonCodes, []);
    const thread = response.commentThread;
    assert.ok(thread?.id && thread.comments?.length === 1, 'A positive decision must have one initial assistant comment');
    assert.equal(decision.commentThreadId, thread.id);
    assert.equal(thread.blockId, state.commentBlockId); assert.equal(thread.blockIndex, 2); assert.equal(thread.blockText, capacityCommentTarget);
    const comment = thread.comments[0];
    assert.equal(comment.role, 'assistant'); assert.ok(comment.id && comment.content?.trim());
    state.commentThreadId = thread.id; state.commentMessageId = comment.id;
    const initial = await db.aiMessage.findUniqueOrThrow({ where: { id: comment.id }, include: { conversation: true } });
    assert.equal(initial.conversation.userId, user.id);
    assert.equal(initial.conversation.offeringId, fixture.offeringId);
    assert.equal(initial.conversation.participationId, participation.id);
    // The physical companion conversation contains logical document threads.
    // Never compare the response's logical ID directly with the DB foreign key.
    const messages = await db.aiMessage.findMany({ where: {
      conversationId: initial.conversationId, metadata: { path: ['conversationId'], equals: thread.id },
    } });
    assert.equal(messages.length, 2, 'Each initial comment retains exactly a system anchor and an assistant message');
    const system = messages.find(message => message.role === 'system');
    const assistant = messages.find(message => message.role === 'assistant');
    assert.ok(system && assistant);
    assert.equal(system.metadata.legacyRole, 'system-trigger');
    assert.equal(system.metadata.visibility, 'teacher-only');
    assert.equal(assistant.metadata.legacyRole, 'agent');
    assert.equal(assistant.metadata.visibility, 'student-and-teacher');
    assert.equal(assistant.id, comment.id); assert.equal(assistant.content, comment.content);
    assert.ok(system.content.startsWith(metaPrefix));
    const anchor = JSON.parse(system.content.slice(metaPrefix.length));
    assert.equal(anchor.id, thread.id); assert.equal(anchor.blockId, body.blockId);
    assert.equal(anchor.blockIndex, 2); assert.equal(anchor.blockText, capacityCommentTarget);
    assert.equal(anchor.targetText, thread.targetText);
    for (const message of messages) {
      assert.equal(message.conversationId, initial.conversationId);
      assert.equal(message.metadata.conversationId, thread.id);
      assert.equal(message.userId, null, 'Generated system/assistant messages are attributed through their conversation');
    }

    assert.equal(requestFacts.length, priorFactCount + rawFacts.length + 2, 'A positive review retains every raw plus policy and comment after replay');
    const commentFacts = requestFacts.filter(event => event.eventType === 'comment');
    assert.equal(commentFacts.length, 1);
    const fact = commentFacts[0];
    assert.equal(fact.taskId, taskId);
    assert.equal(fact.idempotencyKey, `document-review-comment:${participation.id}:${body.requestId}`);
    assertOwnership(fact, user.id, fixture, participation);
    assert.equal(fact.requestId, body.requestId); assert.equal(fact.actor, 'assistant'); assert.equal(fact.eventType, 'comment');
    assert.equal(fact.content, comment.content);
    assert.equal(fact.payload.legacy.source, 'proactive-comment');
    assert.equal(fact.payload.legacy.conversationId, thread.id);
    assert.equal(fact.payload.detail.commentThreadId, thread.id);
    assert.equal(fact.payload.detail.blockId, body.blockId); assert.equal(fact.payload.detail.blockIndex, 2);
    assert.equal(fact.payload.detail.targetText, capacityCommentTarget); assert.equal(fact.payload.detail.initialComment, true);
    assert.equal(fact.conversation?.userId, user.id); assert.equal(fact.conversation?.participationId, participation.id);
    assert.equal(fact.conversation?.offeringId, fixture.offeringId);
    const messageFacts = await db.aiInteractionEvent.findMany({ where: { idempotencyKey: { in: messages.map(message => `companion-message:${message.id}`) } } });
    assert.equal(messageFacts.length, 2, 'Both messages must have atomic audit facts');
    for (const message of messages) {
      const messageFact = messageFacts.find(event => event.idempotencyKey === `companion-message:${message.id}`);
      assert.ok(messageFact);
      assertOwnership(messageFact, user.id, fixture, participation);
      assert.equal(messageFact.content, message.content);
      assert.equal(messageFact.actor, message.role);
      assert.equal(messageFact.conversationId, initial.conversationId);
      assert.equal(messageFact.payload.legacy.conversationId, thread.id);
    }
    state.commentConversationId = initial.conversationId;
    return { userId: user.id, requestId: body.requestId, commentThreadId: thread.id, requestMs,
      messageCount: messages.length, requestAuditCount: requestFacts.length, messageAuditCount: messageFacts.length };
  }
  async function worker() {
    while (next < students.length) {
      const index = next++;
      try { results[index] = await verifyStudent(students[index]); }
      catch (error) { failures.push({ userId: students[index].id, error }); }
    }
  }
  // Each worker also finishes replay and reconciliation before starting another
  // student. Failures are collected; they never abandon the remaining students.
  await Promise.allSettled(Array.from({ length: Math.min(2, students.length) }, () => worker()));
  if (failures.length) {
    record('real-ai-background-comments-and-persistence', '未通过', { students: students.length, concurrency: 2,
      completed: results.filter(Boolean).length, failures: failures.map(({ userId, error }) => ({ userId, message: String(error) })) });
    throw new AggregateError(failures.map(item => item.error), `${failures.length} document comment checks failed after all students finished`);
  }
  assert.equal(results.filter(Boolean).length, students.length);
  const times = results.map(result => result.requestMs).sort((a, b) => a - b);
  const summary = { students: students.length, concurrency: 2, threads: results.filter(result => result.commentThreadId).length,
    qualityFailures,
    firstAttemptFailures: students.filter(user => expected.get(user.id).commentRequestFailures?.some(item => item.attempt === 1)).length,
    unrecoveredServiceFailures: results.filter(result => result.serviceFailed).length,
    messages: results.reduce((count, result) => count + result.messageCount, 0),
    requestAuditFacts: results.reduce((count, result) => count + result.requestAuditCount, 0),
    messageAuditFacts: results.reduce((count, result) => count + result.messageAuditCount, 0),
    requestP95Ms: times[Math.ceil(times.length * 0.95) - 1], durationMs: Math.round(performance.now() - started) };
  summary.firstAttemptFailureRate = summary.firstAttemptFailures / students.length;
  record('real-ai-background-comment-reliability', summary.firstAttemptFailureRate < .005 && !summary.unrecoveredServiceFailures ? '通过' : '未通过', { firstAttemptFailures: summary.firstAttemptFailures, firstAttemptFailureRate: summary.firstAttemptFailureRate, unrecoveredServiceFailures: summary.unrecoveredServiceFailures });
  record('real-ai-background-comments-and-persistence', '通过', summary);
  record('real-ai-background-comment-quality', qualityFailures.length ? '未通过' : '通过', { students: students.length, qualityFailures });
  return summary;
}
