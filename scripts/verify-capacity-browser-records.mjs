/** Read-only reconciliation of browser-owned records; no fixture writes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
const hash = value => sha(JSON.stringify(value));
const metaPrefix = 'OPENPBL_DOCUMENT_COMMENT_META:';
const checkpointPrefix = 'OPENPBL_DOCUMENT_COMMENT_REVIEW:';
export function paragraphFingerprint(value) {
  // Match the runtime paragraph fingerprint exactly, including control normalization.
  const normalized = value.normalize('NFKC').replace(/[\u0000-\u001F]/g, ' ').replace(/\s+/g, ' ').trim();
  let valueHash = 2166136261;
  for (let index = 0; index < normalized.length; index++) { valueHash ^= normalized.charCodeAt(index); valueHash = Math.imul(valueHash, 16777619); }
  return `${normalized.length}:${(valueHash >>> 0).toString(36)}`;
}
function owned(fact, user, fixture, participation) {
  assert.equal(fact.userId, user.id); assert.equal(fact.participationId, participation.id);
  assert.equal(fact.offeringId, fixture.offeringId); assert.equal(fact.researchKey, participation.enrollment.researchKey);
}
async function messageFact(db, message, task, user, fixture, participation) {
  assert.equal(message.conversationId, task.conversationId); assert.equal(message.userId, null);
  const facts = await db.aiInteractionEvent.findMany({ where: { idempotencyKey: `companion-message:${message.id}` } });
  assert.equal(facts.length, 1, 'Every companion message requires exactly one immutable audit fact');
  const fact = facts[0]; owned(fact, user, fixture, participation);
  assert.equal(fact.content, message.content); assert.equal(fact.actor, message.role);
  assert.equal(fact.eventType, message.role === 'assistant' ? 'response' : 'comment');
  assert.equal(fact.payload.detail.messageId, message.id); assert.equal(fact.payload.detail.visibility, message.metadata.visibility);
  assert.equal(fact.conversationId, task.conversationId);
  assert.equal(fact.payload.legacy.conversationId, message.metadata.conversationId);
}
export function verifyProgressReceipt({ row, user, fixture, participation, body, ack }) {
  assert.equal(row.actorId, user.id); assert.equal(row.participationId, participation.id);
  assert.equal(row.offeringId, fixture.offeringId); assert.equal(row.classroomInstanceId, fixture.instanceId);
  assert.equal(row.researchKey, participation.enrollment.researchKey); assert.equal(row.eventType, 'UPDATE_STUDENT_PROGRESS');
  assert.equal(row.idempotencyKey, `ai-progress:${fixture.instanceId}:${user.id}:${body.requestId}`);
  assert.equal(row.payload.requestId, body.requestId); assert.equal(row.payload.studentId, user.id);
  assert.equal(row.payload.stageKey, 'ai-learning'); assert.equal(row.payload.scope, 'student');
  const { courseId, studentId, classroomId, currentSceneIndex, totalScenes, completedScenes, studentName } = body;
  assert.equal(row.payload.fingerprint, hash({ courseId, studentId, classroomId, currentSceneIndex, totalScenes, completedScenes,
    completionModelVersion: body.completionModelVersion, studentName, quizScore: body.quizScore }));
  assert.deepEqual(row.payload.response, ack.data.progress);
}
export async function progressReplaySnapshot({ db, fixture, users }) {
  return {
    domainEvents: await db.domainEvent.count({ where: { classroomInstanceId: fixture.instanceId } }),
    course: await db.classroomInstance.findUniqueOrThrow({ where: { id: fixture.instanceId }, select: { runtimeConfig: true, updatedAt: true } }),
    learners: await Promise.all(users.map(async user => ({
      id: user.id,
      participation: await db.classroomParticipation.findUniqueOrThrow({ where: { id: user.participationId }, select: { stageProgress: true } }),
      workspace: await db.studentProjectWorkspace.findUniqueOrThrow({ where: { participationId: user.participationId }, select: { version: true, updatedAt: true, projectState: true } }),
      events: await db.domainEvent.count({ where: { classroomInstanceId: fixture.instanceId, actorId: user.id, eventType: 'UPDATE_STUDENT_PROGRESS' } }),
    }))),
  };
}
export async function verifyBrowserReviewRecords({ db, user, fixture, review, participation }) {
  const body = review.body;
  const id = `document-ai-${hash([participation.id, review.requestId])}`;
  const tasks = await db.aiTask.findMany({ where: { createdById: user.id, offeringId: fixture.offeringId, taskType: 'DOCUMENT_COLLABORATION', input: { path: ['requestId'], equals: review.requestId } }, include: { conversation: true } });
  assert.equal(tasks.length, 1); const task = tasks[0];
  assert.equal(task.createdById, user.id); assert.equal(task.offeringId, fixture.offeringId); assert.equal(task.taskType, 'DOCUMENT_COLLABORATION');
  assert.equal(task.id, id); assert.equal(task.conversation.userId, user.id); assert.equal(task.conversation.offeringId, fixture.offeringId);
  assert.equal(task.conversation.participationId, participation.id); assert.equal(task.input.participationId, participation.id);
  assert.equal(body.courseId, fixture.instanceId); assert.equal(body.studentId, user.id);
  assert.equal(task.input.requestId, review.requestId); assert.equal(task.input.intent, body.action); assert.equal(body.action, 'proactive-document-comments');
  assert.equal(task.input.conversationId, body.action); assert.equal(task.input.stageKey, body.stageKey); assert.equal(task.input.workspaceKind, body.workspaceKind);
  assert.equal(task.input.documentVersion, hash(body.documentHtml)); assert.ok(task.input.token);
  const candidates = body.paragraphs.map((item, index) => ({ candidateId: item.candidateId?.trim().slice(0, 160) || item.blockId?.trim().slice(0, 160) || `paragraph-${Number(item.blockIndex)}-${index}`,
    ...(item.blockId?.trim() ? { blockId: item.blockId.trim().slice(0, 160) } : {}), blockIndex: Number(item.blockIndex), targetText: item.targetText.trim().slice(0, 3000) }));
  assert.ok(candidates.length > 0 && candidates.length <= 8); assert.equal(new Set(candidates.map(row => row.candidateId)).size, candidates.length);
  assert.equal(task.input.message, JSON.stringify(candidates));
  assert.equal(task.input.fingerprint, hash({ action: body.action, courseId: body.courseId, stageKey: body.stageKey, workspaceKind: body.workspaceKind, documentHtml: body.documentHtml, proactiveParagraphs: candidates }));
  assert.equal(task.status, review.status === 'cancelled' ? 'CANCELLED' : 'COMPLETED');
  const facts = await db.aiInteractionEvent.findMany({ where: { requestId: review.requestId } });
  const raws = facts.filter(fact => fact.payload?.detail?.kind === 'model-output');
  for (const fact of facts) owned(fact, user, fixture, participation);
  for (const fact of raws) {
    const detail = fact.payload.detail;
    assert.equal(fact.actor, 'system'); assert.equal(fact.eventType, 'response'); assert.equal(fact.payload.legacy.source, 'proactive-comment');
    assert.equal(detail.action, body.action); assert.equal(detail.workspaceKind, body.workspaceKind);
    assert.equal(detail.documentVersion, task.input.documentVersion); assert.equal(detail.rawLength, fact.content.length); assert.equal(detail.rawSha256, sha(fact.content));
    assert.equal(fact.idempotencyKey, `legacy-ai:${hash([participation.id, user.id, `document-review-model:${detail.requestAttemptId}:${detail.modelAttempt}`])}`);
  }
  if (review.status === 'cancelled') return;
  assert.deepEqual(task.output.response, review.response); assert.equal(task.output.schemaVersion, 1);
  const decision = review.response.reviewDecision;
  assert.ok(decision && ['comment', 'no-comment', 'incomplete'].includes(decision.outcome));
  assert.equal(decision.reviewVersion, 4); assert.equal(decision.action, body.action); assert.equal(decision.documentVersion, task.input.documentVersion);
  assert.deepEqual(decision.requestedCandidates, candidates); assert.ok(Array.isArray(decision.rawOutputs));
  const policies = facts.filter(fact => fact.payload?.detail?.kind === 'document-comment-review');
  assert.equal(policies.length, 1); const policy = policies[0];
  assert.equal(policy.eventType, 'policy'); assert.equal(policy.actor, 'system'); assert.equal(policy.taskId, task.id); assert.equal(policy.conversationId, task.conversationId);
  assert.equal(policy.idempotencyKey, `document-review-decision:${participation.id}:${review.requestId}`);
  assert.deepEqual(policy.payload.detail, { kind: 'document-comment-review', ...decision, requestAttemptId: task.input.token, workspaceKind: body.workspaceKind });
  assert.equal(policy.payload.legacy.source, 'proactive-comment'); assert.equal(policy.payload.legacy.stageKey, body.stageKey);
  assert.equal(policy.payload.legacy.conversationId, body.action);
  const currentRaws = raws.filter(fact => fact.payload.detail.requestAttemptId === task.input.token);
  assert.equal(currentRaws.length, decision.rawOutputs.length); assert.equal(new Set(currentRaws.map(fact => fact.payload.detail.modelAttempt)).size, currentRaws.length);
  for (const [index, output] of decision.rawOutputs.entries()) {
    assert.equal(output.attempt, index + 1);
    const matches = currentRaws.filter(fact => fact.payload.detail.modelAttempt === output.attempt);
    assert.equal(matches.length, 1); assert.equal(matches[0].payload.detail.rawSha256, output.sha256); assert.equal(matches[0].payload.detail.validation, output.validation);
    assert.ok(['valid', 'invalid-json', 'invalid-schema'].includes(output.validation));
  }
  if (decision.rawOutputs.length) assert.equal(decision.rawOutputs.at(-1).validation, 'valid');
  else { assert.deepEqual(decision.reasonCodes, ['ALL_ALREADY_REVIEWED']); assert.equal(decision.outcome, 'no-comment'); assert.equal(decision.complete, true); }
  const messages = await db.aiMessage.findMany({ where: { conversationId: task.conversationId } });
  const checkpoints = messages.flatMap(message => {
    if (message.role !== 'system') return [];
    if (message.content.startsWith(checkpointPrefix)) return [{ message, checkpoint: true, ...JSON.parse(message.content.slice(checkpointPrefix.length)) }];
    if (message.content.startsWith(metaPrefix)) {
      const meta = JSON.parse(message.content.slice(metaPrefix.length));
      return meta.blockText ? [{ message, reviewVersion: meta.reviewVersion, fingerprint: paragraphFingerprint(meta.blockText) }] : [];
    }
    return [];
  });
  const confirmed = decision.rawOutputs.length ? decision.reviewedCandidateIds : candidates.map(row => row.candidateId);
  assert.ok(Array.isArray(confirmed));
  for (const candidateId of confirmed) {
    const candidate = candidates.find(item => item.candidateId === candidateId); assert.ok(candidate);
    const matches = checkpoints.filter(item => (decision.rawOutputs.length ? item.checkpoint : true) && item.reviewVersion === 4 && item.fingerprint === paragraphFingerprint(candidate.targetText)
      && (decision.rawOutputs.length || new Date(item.message.createdAt) <= new Date(task.startedAt)));
    assert.ok(matches.length, 'A confirmed review needs its durable checkpoint, predating historical reuse');
    assert.equal(matches[0].message.metadata.visibility, 'teacher-only');
    assert.ok(review.response.reviewedParagraphFingerprints.includes(paragraphFingerprint(candidate.targetText)));
    await messageFact(db, matches[0].message, task, user, fixture, participation);
  }
  assert.equal(review.response.requestId, review.requestId); assert.equal(review.response.status, 'completed');
  assert.equal(review.response.documentVersion, task.input.documentVersion);
  assert.equal(review.response.complete, decision.complete); assert.deepEqual(review.response.reviewedCandidateIds, decision.reviewedCandidateIds);
  const threads = review.response.commentThreads; assert.ok(Array.isArray(threads));
  const commentFacts = facts.filter(fact => fact.eventType === 'comment'); assert.equal(commentFacts.length, threads.length);
  if (decision.rawOutputs.length) assert.deepEqual(decision.createdCommentThreadIds, threads.map(thread => thread.id));
  for (const thread of threads) {
    assert.equal(thread.comments.length, 1); const comment = thread.comments[0];
    const pair = messages.filter(message => message.metadata?.conversationId === thread.id
      && (message.id === comment.id || message.role === 'system' && message.content.startsWith(metaPrefix)));
    assert.equal(pair.length, 2, 'A comment must retain its system anchor and assistant message');
    const system = pair.find(message => message.role === 'system'); const assistant = pair.find(message => message.role === 'assistant'); assert.ok(system && assistant);
    assert.equal(system.metadata.legacyRole, 'system-trigger'); assert.equal(system.metadata.visibility, 'teacher-only');
    assert.equal(assistant.metadata.legacyRole, 'agent'); assert.equal(assistant.metadata.visibility, 'student-and-teacher');
    assert.equal(assistant.id, comment.id); assert.equal(assistant.content, comment.content); assert.ok(system.content.startsWith(metaPrefix));
    const anchor = JSON.parse(system.content.slice(metaPrefix.length));
    for (const key of ['id', 'blockId', 'blockIndex', 'blockText', 'targetText', 'reviewVersion']) assert.deepEqual(anchor[key], thread[key]);
    for (const message of pair) await messageFact(db, message, task, user, fixture, participation);
    const matches = commentFacts.filter(fact => fact.payload.detail.commentThreadId === thread.id); assert.equal(matches.length, 1); const fact = matches[0];
    assert.equal(fact.taskId, task.id); assert.equal(fact.actor, 'assistant'); assert.equal(fact.conversationId, task.conversationId); assert.equal(fact.content, comment.content);
    assert.equal(fact.idempotencyKey, `document-review-comment:${participation.id}:${review.requestId}:${thread.id}`);
    assert.equal(fact.payload.legacy.conversationId, thread.id);
    for (const key of ['blockId', 'blockIndex', 'issueType', 'targetText']) assert.deepEqual(fact.payload.detail[key], thread[key]);
  }
}
