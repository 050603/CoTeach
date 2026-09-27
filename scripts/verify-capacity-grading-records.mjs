/** Read-only subjective grading evidence reconciliation, scoped independently of tutor/document facts. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as gradingParserModule from '../src/lib/openmaic/quiz/grade-response.ts';
const { parseQuizGradeResponse } = gradingParserModule.default ?? gradingParserModule;
const sha = value => createHash('sha256').update(value).digest('hex');
const hash = value => sha(JSON.stringify(value));
const safeErrors = new Set(['CANCELLED', 'MODEL_RESOLUTION_FAILED', 'INVALID_SCORE', 'INVALID_JSON', 'PROVIDER_TIMEOUT', 'CAPACITY_OR_RATE_LIMIT', 'PROVIDER_REQUEST_FAILED']);
export async function verifyCapacityGradingRecords({ db, fixture, user, attemptId, expectedInvocations, observedAttempts }) {
  const participation = await db.classroomParticipation.findFirstOrThrow({ where: { instanceId: fixture.instanceId, enrollment: { userId: user.id } }, include: { enrollment: true, workspace: true } });
  const attempt = participation.workspace.projectState.aiLearningProgress.knowledgeLectureAttempts.find(item => item.id === attemptId);
  assert.ok(attempt); assert.equal(attempt.gradingSource, 'server'); assert.equal(attempt.gradingStatus, 'graded');
  const facts = await db.aiInteractionEvent.findMany({ where: { participationId: participation.id, userId: user.id, payload: { path: ['detail', 'attemptId'], equals: attemptId } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  assert.ok(facts.length, 'Subjective grading must retain request/raw/terminal evidence');
  const grouped = new Map();
  for (const fact of facts) {
    assert.equal(fact.offeringId, fixture.offeringId); assert.equal(fact.researchKey, participation.enrollment.researchKey);
    assert.equal(fact.payload.legacy.source, 'submission'); assert.equal(fact.payload.legacy.stageKey, 'ai-learning');
    assert.equal(fact.payload.legacy.conversationId, attemptId);
    assert.equal(fact.payload.detail.callAttemptId, fact.requestId); assert.equal(fact.payload.detail.classroomId, fixture.classroomId);
    assert.equal(fact.payload.detail.visibility, 'teacher-only'); assert.ok(fact.requestId);
    const group = grouped.get(fact.requestId) ?? []; group.push(fact); grouped.set(fact.requestId, group);
  }
  if (expectedInvocations !== undefined) assert.equal(grouped.size, expectedInvocations);
  const summary = { userId: user.id, attemptId, invocations: grouped.size, raw: 0, success: 0, failedAttempt: 0, cancelled: 0, error: 0, failures: [] };
  const successful = new Map();
  const observedTerminals = [];
  for (const [requestId, rows] of grouped) {
    const requests = rows.filter(row => row.eventType === 'request');
    const outputs = rows.filter(row => row.payload.detail.kind === 'model-output');
    const terminals = rows.filter(row => ['policy', 'error'].includes(row.eventType));
    assert.equal(requests.length, 1); assert.equal(terminals.length, 1);
    const request = requests[0], terminal = terminals[0], detail = terminal.payload.detail;
    assert.ok(['success', 'failed', 'cancelled'].includes(detail.status));
    assert.equal(request.payload.detail.status, 'started'); assert.equal(request.actor, 'student'); assert.equal(terminal.actor, 'system');
    const question = attempt.questions.find(item => item.questionId === detail.questionId); assert.ok(question);
    assert.equal(request.content, question.answer); assert.equal(request.payload.detail.points, question.points);
    assert.equal(detail.answerSha256, sha(question.answer)); assert.equal(request.payload.detail.answerSha256, detail.answerSha256);
    assert.ok(request.payload.detail.prompt.includes(question.prompt) && request.payload.detail.prompt.includes(question.answer));
    assert.ok(typeof request.payload.detail.system === 'string' && request.payload.detail.system.length > 0);
    assert.equal(detail.startedAt, request.payload.detail.startedAt); assert.ok(Number.isFinite(detail.elapsedMs) && detail.elapsedMs >= 0);
    assert.equal(outputs.length, detail.rawSha256 ? 1 : 0); assert.equal(rows.length, 2 + outputs.length);
    for (const [suffix, row] of [['request', request], ['terminal', terminal], ...outputs.map(row => ['raw', row])]) {
      assert.equal(row.idempotencyKey, `legacy-ai:${hash([participation.id, user.id, `knowledge-grade:${requestId}:${suffix}`])}`);
    }
    if (outputs.length) {
      const output = outputs[0]; assert.equal(output.actor, 'system'); assert.equal(output.eventType, 'response');
      assert.equal(output.payload.detail.status, detail.status); assert.equal(output.payload.detail.questionId, question.questionId);
      assert.equal(output.payload.detail.rawLength, output.content.length); assert.equal(detail.rawLength, output.content.length);
      assert.equal(output.payload.detail.rawSha256, sha(output.content)); assert.equal(detail.rawSha256, sha(output.content));
      summary.raw++;
    }
    observedTerminals.push({ startedAt: detail.startedAt, status: detail.status === 'success' ? 'graded' : 'failed' });
    if (detail.status === 'success') {
      assert.equal(terminal.eventType, 'policy'); assert.equal(outputs.length, 1); assert.equal(detail.gradingStatus, 'graded'); assert.equal(detail.errorCode, undefined);
      const parsed = parseQuizGradeResponse(outputs[0].content.trim(), question.points);
      assert.equal(detail.earned, parsed.score, 'Final grade differs from original model output');
      assert.equal(detail.feedback, parsed.comment || 'AI 已完成批阅。');
      assert.ok(Number.isFinite(detail.earned) && detail.earned >= 0 && detail.earned <= question.points);
      const matches = successful.get(question.questionId) ?? []; matches.push(detail); successful.set(question.questionId, matches); summary.success++;
    } else {
      assert.equal(terminal.eventType, 'error'); assert.equal(detail.gradingStatus, 'failed'); assert.ok(safeErrors.has(detail.errorCode));
      assert.equal(detail.status === 'cancelled', detail.errorCode === 'CANCELLED');
      if (detail.status === 'failed') summary.failedAttempt++; else summary.cancelled++;
      summary.error++; summary.failures.push({ requestId, questionId: question.questionId, errorCode: detail.errorCode, elapsedMs: detail.elapsedMs });
    }
  }
  if (observedAttempts) {
    observedTerminals.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    assert.deepEqual(observedTerminals.map(item => item.status), observedAttempts.map(item => item.status), 'HTTP-observed failures and retries must match durable grading terminals');
  }
  for (const question of attempt.questions.filter(item => item.questionType === 'short_answer' && item.answer.trim())) {
    assert.ok(successful.get(question.questionId)?.some(detail => detail.earned === question.earned && detail.feedback === question.feedback), 'Final grade must match a durable successful model decision');
  }
  const commits = await db.domainEvent.findMany({ where: { classroomInstanceId: fixture.instanceId, actorId: user.id, eventType: 'KNOWLEDGE_QUIZ_GRADED', payload: { path: ['attempt', 'id'], equals: attemptId } } });
  assert.ok(commits.some(row => { try { assert.deepEqual(row.payload.attempt, attempt); return true; } catch { return false; } }), 'Final workspace grade must have its atomically committed domain event');
  return summary;
}
