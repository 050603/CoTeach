import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { verifyCapacityGradingRecords } from './verify-capacity-grading-records.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const hash = value => sha(JSON.stringify(value));
function setup(retry = false) {
  const user = { id: 'student' }, fixture = { instanceId: 'instance', offeringId: 'offering', classroomId: 'lecture' };
  const question = { questionId: 'question', questionType: 'short_answer', prompt: '题目', answer: '原始答案', points: 6, earned: 6, feedback: '完整', gradingStatus: 'graded' };
  const attempt = { id: 'attempt', gradingSource: 'server', gradingStatus: 'graded', questions: [question] };
  const participation = { id: 'participation', enrollment: { researchKey: 'research' }, workspace: { projectState: { aiLearningProgress: { knowledgeLectureAttempts: [attempt] } } } };
  const facts = [];
  for (const failed of retry ? [true, false] : [false]) {
    const id = failed ? 'failed-request' : 'success-request', raw = failed ? '{broken' : '{"score":6,"comment":"完整"}';
    const common = { kind: 'knowledge-quiz-grading', attemptId: attempt.id, questionId: question.questionId, callAttemptId: id, classroomId: fixture.classroomId, visibility: 'teacher-only', answerSha256: sha(question.answer), startedAt: '2026-09-27T02:00:00Z' };
    const outcome = { status: failed ? 'failed' : 'success', ...(failed ? { errorCode: 'INVALID_JSON' } : {}), rawSha256: sha(raw), rawLength: raw.length, elapsedMs: 100 };
    const row = (suffix, eventType, actor, content, detail) => ({ idempotencyKey: `legacy-ai:${hash([participation.id, user.id, `knowledge-grade:${id}:${suffix}`])}`, requestId: id, offeringId: fixture.offeringId, researchKey: participation.enrollment.researchKey, eventType, actor, content,
      payload: { legacy: { source: 'submission', stageKey: 'ai-learning', conversationId: attempt.id }, detail: { ...common, ...detail } } });
    facts.push(row('request', 'request', 'student', question.answer, { status: 'started', prompt: `题目：${question.prompt}答案：${question.answer}`, system: '严格评分', points: 6 }),
      row('raw', 'response', 'system', raw, { ...outcome, kind: 'model-output' }),
      row('terminal', failed ? 'error' : 'policy', 'system', '完成', { ...outcome, gradingStatus: failed ? 'failed' : 'graded', earned: failed ? 0 : 6, feedback: failed ? '失败' : '完整' }));
  }
  const commits = [{ payload: { attempt: structuredClone(attempt) } }];
  const db = { classroomParticipation: { findFirstOrThrow: async () => participation }, aiInteractionEvent: { findMany: async () => facts }, domainEvent: { findMany: async () => commits } };
  return { db, fixture, user, attemptId: attempt.id, expectedInvocations: retry ? 2 : 1, facts, commits, question };
}
test('successful grading has complete raw and terminal fact matching final atomic grade', async () => { const result = await verifyCapacityGradingRecords(setup()); assert.equal(result.raw, 1); assert.equal(result.success, 1); });
test('retry retains initial failure and returns failure count without hiding recovery', async () => { const result = await verifyCapacityGradingRecords(setup(true)); assert.equal(result.invocations, 2); assert.equal(result.failedAttempt, 1); assert.equal(result.raw, 2); assert.equal(result.error, 1); });
for (const [name, mutate] of Object.entries({
  'missing raw': args => args.facts.splice(1, 1),
  'missing terminal': args => args.facts.splice(2, 1),
  'corrupted raw': args => { args.facts[1].content += '!'; },
  'wrong ownership': args => { args.facts[1].researchKey = 'other'; },
  'duplicate request': args => args.facts.push(structuredClone(args.facts[0])),
  'changed original answer': args => { args.question.answer = 'changed'; },
  'missing atomic commit': args => { args.commits.length = 0; },
  'wrong final grade': args => { args.question.earned = 2; },
})) test(`rejects ${name}`, async () => { const args = setup(); mutate(args); await assert.rejects(verifyCapacityGradingRecords(args)); });

test('rejects a raw score that differs from the stored grade even when its hash is correct', async () => {
  const args = setup(); const raw = '{"score":0,"comment":"完整"}'; args.facts[1].content = raw;
  for (const fact of args.facts.slice(1)) { fact.payload.detail.rawSha256 = sha(raw); fact.payload.detail.rawLength = raw.length; }
  await assert.rejects(verifyCapacityGradingRecords(args), /differs from original/);
});
test('uses the production parser feedback trim/limit and default semantics', async () => {
  const args = setup(); const raw = '{"score":6,"comment":"  完整  "}'; args.facts[1].content = raw;
  for (const fact of args.facts.slice(1)) { fact.payload.detail.rawSha256 = sha(raw); fact.payload.detail.rawLength = raw.length; }
  await verifyCapacityGradingRecords(args);
});
test('rejects HTTP retry status history that disagrees with retained terminal facts', async () => {
  const args = setup(true); args.observedAttempts = [{ status: 'graded' }, { status: 'graded' }];
  await assert.rejects(verifyCapacityGradingRecords(args), /HTTP-observed/);
  args.observedAttempts = [{ status: 'failed' }, { status: 'graded' }]; await verifyCapacityGradingRecords(args);
});
