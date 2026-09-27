import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySubjectiveGrading } from './verify-capacity-extensions.mjs';

test('failed HTTP-200 grading retries once with the original answer and records both statuses', async () => {
  const user = { id: 'student', index: 1, role: 'student', participationId: 'participation' };
  const fixture = { instanceId: 'course', subjectiveQuizId: 'subjective', subjectiveSectionId: 'section', quizId: 'objective' };
  const expected = new Map([[user.id, {}]]);
  const checks = [];
  let saved;
  let retries = 0;
  const request = async (_user, _method, endpoint, body, options) => {
    if (options?.expectedStatus === 409 || endpoint.includes('/progress')) return {};
    if (body.action === 'retry-grading') {
      retries++;
      saved = { ...saved, gradingStatus: 'graded', score: 6, maxScore: 6, questions: saved.questions.map(q => ({ ...q, gradingStatus: 'graded', earned: 6, feedback: '有依据' })) };
      return { attempt: saved };
    }
    saved ??= { id: 'attempt', quizOutlineId: 'subjective', gradingSource: 'server', gradingStatus: 'failed', questions: [{ questionId: 'subjective-q1', answer: body.answers['subjective-q1'], gradingStatus: 'failed', points: 6, earned: 0, feedback: '稍后重试' }] };
    return { attempt: saved };
  };
  const reconciliationSentinel = new Error('Reached independent grading evidence reconciliation');
  const db = { classroomParticipation: {
    findFirstOrThrow: async () => { throw reconciliationSentinel; },
    findUniqueOrThrow: async () => ({ instanceId: 'course', enrollment: { userId: user.id }, workspace: { projectState: { aiLearningProgress: { knowledgeLectureAttempts: [saved, { quizOutlineId: 'objective' }] } } } }),
  } };
  await assert.rejects(verifySubjectiveGrading({ users: [user], fixture, db, request, record: (...args) => checks.push(args), expected }), error => error.errors?.[0] === reconciliationSentinel);
  assert.equal(retries, 1);
  assert.deepEqual(expected.get(user.id).subjectiveGradingAttempts.map(a => a.status), ['failed', 'graded']);
  assert.equal(checks[0][0], 'subjective-grading-business-failure');
  assert.equal(checks[0][1], '未通过');
  assert.equal(expected.get(user.id).subjectiveAttemptId, 'attempt');
});
