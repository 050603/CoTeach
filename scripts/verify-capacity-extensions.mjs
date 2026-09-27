/** Additional HTTP checks on the capacity runner's existing fixture only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { verifyCapacityAiRecords } from './verify-capacity-ai-records.mjs';
import { verifyCapacityGradingRecords } from './verify-capacity-grading-records.mjs';

async function allCompleted(work) {
  const results = await Promise.allSettled(work);
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), String(failures[0].reason));
  return results.map(result => result.value);
}

const assessmentQuestion = id => ({ id, type: 'single-choice', prompt: '哪一种证据可以支持节能结论？', options: ['同等条件的测量值', '未经测量的猜测'], correctAnswer: '同等条件的测量值', category: 'knowledge' });
export const capacityExperimentConfig = {
  enabled: true, pretest: [assessmentQuestion('pre-evidence')], posttest: [assessmentQuestion('post-evidence')], sharedQuestions: [], randomizeQuestionOrder: false, randomizeOptionOrder: false,
};
const answers = phase => ({ [`${phase === 'pretest' ? 'pre' : 'post'}-evidence`]: '同等条件的测量值' });

export async function prepareStudentAssessment({ user, fixture, request }) {
  await request(user, 'GET', `/api/platform/activities/${fixture.activityId}`, undefined, { category: 'assessment-prepare' });
  const endpoint = `/api/platform/classroom-instances/${fixture.instanceId}/experiment`;
  const form = await request(user, 'GET', `${endpoint}?phase=pretest`, undefined, { category: 'assessment-prepare' });
  assert.equal(form.enabled, true); assert.equal(form.available, true);
  assert.ok(form.questions.some(question => question.id === 'pre-evidence'));
  const result = await request(user, 'POST', endpoint, { phase: 'pretest', answers: answers('pretest') }, { category: 'pretest' });
  user.pretestSubmissionId = result.submission.id;
}

export async function verifyExtendedClassroom({ users, fixture, db, request, record, expected }) {
  const students = users.filter(user => user.role === 'student');
  const teachers = users.filter(user => user.role === 'teacher');
  assert.equal(students.length, expected.size);
  const act = (teacher, type, payload) => request(teacher, 'POST', `/api/courses/${fixture.instanceId}/actions`, { requestId: randomUUID(), action: { type, payload } }, { category: 'extended-teacher-action' });
  const endpoint = `/api/platform/classroom-instances/${fixture.instanceId}/experiment`;
  const blocked = await request(students[0], 'GET', `${endpoint}?phase=posttest`, undefined, { category: 'assessment-gate' });
  assert.equal(blocked.enabled, true); assert.equal(blocked.available, false, 'Posttest must remain gated before the reflection stage');

  await act(teachers[0], 'SET_STAGE', { id: fixture.instanceId, index: 3 });
  const course = (await request(teachers[0], 'GET', `/api/courses/${fixture.instanceId}/state`, undefined, { category: 'showcase' })).course;
  const presenter = students[0];
  let group = course.groups?.find(candidate => candidate.members.some(member => member.studentId === presenter.id));
  if (!group) {
    // Personal project groups normally arise in the workbench. Create the same
    // fixture-owned group through its teacher action when API-only load did not open that UI.
    const now = new Date().toISOString();
    group = { id: `grp-${presenter.id}`, name: '验收个人项目', topic: '测量证据', members: [{ studentId: presenter.id, name: presenter.username, role: '组长' }], createdAt: now, updatedAt: now };
    await act(teachers[0], 'UPDATE_COURSE', { id: fixture.instanceId, patch: { groups: [...(course.groups ?? []), group] } });
  }
  const showcase = `/api/courses/${fixture.instanceId}/showcase/presentation`;
  await request(teachers[0], 'POST', showcase, { action: 'assign', groupId: group.id, studentId: presenter.id }, { category: 'showcase' });
  const artifactVersionId = expected.get(presenter.id).archives.at(-1)?.versionId;
  assert.ok(artifactVersionId, 'Showcase uses this run\'s already archived document');
  const started = await request(teachers[0], 'POST', showcase, { action: 'start', studentId: presenter.id, artifactKind: 'document', artifactVersionId, displayMode: 'continuous' }, { category: 'showcase' });
  assert.equal(started.status, 'active');
  const views = await allCompleted(users.map(user => request(user, 'GET', showcase, undefined, { category: 'showcase-read' })));
  for (let index = 0; index < users.length; index++) {
    if (users[index].role === 'teacher') assert.equal(views[index].activePresentation?.id, started.id);
    else assert.equal(views[index].activePresentation ?? null, null, 'Private teacher presentation details are not exposed in student DTOs');
  }
  const ended = await request(teachers[0], 'POST', showcase, { action: 'end', presentationId: started.id }, { category: 'showcase' });
  assert.equal(ended.status, 'evaluating');
  const note = '验收点评：结论对应测量证据，继续核对对照条件。';
  const evaluation = { action: 'finish-evaluation', presentationId: started.id, note };
  await request(teachers[1], 'POST', showcase, evaluation, { category: 'showcase' });
  await request(teachers[1], 'POST', showcase, evaluation, { category: 'showcase-replay' });
  const presentation = await db.showcasePresentation.findUniqueOrThrow({ where: { id: started.id } });
  assert.equal(presentation.participationId, presenter.participationId);
  assert.equal(presentation.artifactVersionId, artifactVersionId);
  assert.equal(presentation.status, 'ENDED');
  assert.equal(presentation.content.evaluationNote, note);
  assert.equal(presentation.content.evaluatedBy, teachers[1].id);
  assert.equal(await db.showcasePresentation.count({ where: { id: started.id } }), 1);
  record('showcase-two-teacher-evaluation-and-role-reads', '通过', { readers: users.length, presenters: 1, presentationId: started.id });

  await act(teachers[0], 'SET_STAGE', { id: fixture.instanceId, index: 4 });
  await allCompleted(students.map(async user => {
    const form = await request(user, 'GET', `${endpoint}?phase=posttest`, undefined, { category: 'posttest' });
    assert.equal(form.available, true); assert.equal(form.enabled, true);
    const body = { phase: 'posttest', answers: answers('posttest'), currentPage: 0, version: form.draft?.version ?? 0 };
    const saved = await request(user, 'PUT', endpoint, body, { category: 'posttest-draft' });
    assert.equal(saved.draft.version, body.version + 1);
    const restored = await request(user, 'GET', `${endpoint}?phase=posttest`, undefined, { category: 'posttest' });
    assert.deepEqual(restored.draft.answers, body.answers);
    await request(user, 'PUT', endpoint, body, { expectedStatus: 409, category: 'expected-conflict' });
    const submissionBody = { phase: 'posttest', answers: body.answers };
    const first = await request(user, 'POST', endpoint, submissionBody, { category: 'posttest-submit' });
    const replay = await request(user, 'POST', endpoint, submissionBody, { category: 'posttest-replay' });
    assert.equal(first.submission.id, replay.submission.id);
    await request(user, 'POST', endpoint, { phase: 'posttest', answers: { 'post-evidence': '未经测量的猜测' } }, { expectedStatus: 409, category: 'expected-conflict' });
    expected.get(user.id).posttestSubmissionId = first.submission.id;
    const rows = await db.experimentAssessmentSubmission.findMany({ where: { instanceId: fixture.instanceId, enrollmentId: user.enrollmentId } });
    assert.equal(rows.length, 2);
    assert.ok(rows.some(row => row.id === user.pretestSubmissionId && row.phase === 'pretest'));
    const row = rows.find(item => item.id === first.submission.id);
    assert.equal(row.phase, 'posttest'); assert.equal(row.objectiveScore, 1); assert.equal(row.objectiveTotal, 1);
    assert.deepEqual(row.answers, body.answers);
    const enrollment = await db.enrollment.findUniqueOrThrow({ where: { id: user.enrollmentId } });
    assert.equal(row.researchKey, enrollment.researchKey);
  }));
  record('all-student-posttest-draft-replay-and-research-reconciliation', '通过', { students: students.length });
  if (students.every(user => expected.get(user.id).subjectiveAttemptId)) {
    const grading = await allCompleted(students.map(user => verifyCapacityGradingRecords({ db, fixture, user,
      attemptId: expected.get(user.id).subjectiveAttemptId,
      observedAttempts: expected.get(user.id).subjectiveGradingAttempts, expectedInvocations: expected.get(user.id).subjectiveGradingAttempts.length })));
    record('all-student-subjective-grading-raw-terminal-reconciliation', '通过', {
      students: grading.length, invocations: grading.reduce((sum, item) => sum + item.invocations, 0),
      failedAttempts: grading.reduce((sum, item) => sum + item.failedAttempt, 0),
    });
  }
  if (students.every(user => expected.get(user.id).tutorRequestId && expected.get(user.id).documentRequestId)) {
    const ai = await verifyCapacityAiRecords({ db, fixture, expected, studentCount: students.length });
    record('real-ai-tasks-messages-audit-reconciliation', '通过', { students: ai.students, requests: ai.requests });
  } else record('real-ai-tasks-messages-audit-reconciliation', '未验证', 'No complete real AI request manifest');
}

/** Add these two values to the test template and classroom JSON during seed.
 * Keep them absent when CAPACITY_REAL_AI is off, so a skipped AI check cannot
 * accidentally mark an unattempted scene as completed. */
export function seedCapacitySubjectiveQuiz({ runId }) {
  assert.match(runId, /^capacity-[0-9a-f-]{36}$/);
  const quizId = `${runId}-subjective-quiz`;
  const sectionId = `${runId}-subjective-section`;
  return {
    quizId, sectionId,
    section: { id: sectionId, title: '证据条件与推理', quizOutlineId: quizId, knowledgePointIds: ['energy'], sceneOutlineIds: [quizId], order: 1 },
    scene: { id: quizId, outlineId: quizId, lectureSectionId: sectionId, type: 'quiz', title: '节能方案简答批阅', order: 1, stageKey: 'ai-learning', audience: 'student', generationPurpose: 'knowledge-teaching', knowledgePointIds: ['energy'], actions: [],
      content: { type: 'quiz', questions: [{ id: 'subjective-q1', type: 'short_answer', question: '如何公平比较教室改进照明方案前后的节能效果？请说明需要记录的数据和保持相同的条件。', points: 6, commentPrompt: '满分6分：记录改进前后相同时间段的用电量2分；控制使用时长、人数或照明需求等条件2分；使用可核对的数据比较并说明节能结论2分。只按学生明确写出的内容评分。', knowledgePointIds: ['energy'] }] } },
  };
}

export async function verifySubjectiveGrading({ users, fixture, db, request, record, expected }) {
  assert.ok(fixture.subjectiveQuizId && fixture.subjectiveSectionId, 'Seed a test-only subjective scene and section before publication');
  const students = users.filter(user => user.role === 'student');
  await allCompleted(students.map(async user => {
    const answer = `验收学生${user.index}：记录改进前后同一时间段的用电量，保持开灯时长、人数和照明需求相同；比较相同条件下的用电量差值，再据此判断是否节能。`;
    const body = { action: 'record-attempt', courseId: fixture.instanceId, studentId: user.id, sectionId: fixture.subjectiveSectionId, quizOutlineId: fixture.subjectiveQuizId, runtimeSceneId: fixture.subjectiveQuizId, answers: { 'subjective-q1': answer } };
    const gradingStarted = performance.now();
    let first = await request(user, 'POST', '/api/knowledge-lecture', body, { category: 'real-ai-subjective-grading', timeout: 180000 });
    const gradingAttempts = [{ status: first.attempt.gradingStatus, elapsedMs: performance.now() - gradingStarted }];
    if (first.attempt.gradingStatus === 'failed') {
      const original = first.attempt;
      record('subjective-grading-business-failure', '未通过', { studentId: user.id, attemptId: original.id, elapsedMs: gradingAttempts[0].elapsedMs, retrying: true });
      first = await request(user, 'POST', '/api/knowledge-lecture', { action: 'retry-grading', courseId: fixture.instanceId, studentId: user.id, quizOutlineId: fixture.subjectiveQuizId }, { category: 'real-ai-subjective-grading-retry', timeout: 180000 });
      assert.equal(first.attempt.id, original.id, 'A grading retry must reuse the submitted attempt');
      assert.deepEqual(first.attempt.questions.map(item => [item.questionId, item.answer]), original.questions.map(item => [item.questionId, item.answer]), 'A grading retry must preserve submitted answers');
      gradingAttempts.push({ status: first.attempt.gradingStatus, elapsedMs: performance.now() - gradingStarted });
    }
    expected.get(user.id).subjectiveGradingAttempts = gradingAttempts;
    assert.equal(first.attempt.gradingSource, 'server');
    assert.equal(first.attempt.gradingStatus, 'graded', 'HTTP 200 with failed/pending AI grading is not a pass');
    assert.equal(first.attempt.questions.length, 1);
    const question = first.attempt.questions[0];
    assert.equal(question.questionId, 'subjective-q1'); assert.equal(question.answer, answer);
    assert.equal(question.gradingStatus, 'graded'); assert.equal(question.points, 6);
    assert.ok(Number.isFinite(question.earned) && question.earned >= 0 && question.earned <= 6);
    assert.ok(typeof question.feedback === 'string' && question.feedback.trim().length > 0);
    assert.equal(first.attempt.score, question.earned); assert.equal(first.attempt.maxScore, 6);
    const replay = await request(user, 'POST', '/api/knowledge-lecture', body, { category: 'subjective-replay' });
    assert.deepEqual(replay.attempt, first.attempt, 'A retried submission must reuse its verified grade');
    const participation = await db.classroomParticipation.findUniqueOrThrow({ where: { id: user.participationId }, include: { workspace: true, enrollment: true } });
    assert.equal(participation.instanceId, fixture.instanceId); assert.equal(participation.enrollment.userId, user.id);
    const attempts = participation.workspace?.projectState?.aiLearningProgress?.knowledgeLectureAttempts ?? [];
    const saved = attempts.filter(attempt => attempt.quizOutlineId === fixture.subjectiveQuizId);
    assert.equal(saved.length, 1); assert.deepEqual(saved[0], first.attempt);
    assert.ok(attempts.some(attempt => attempt.quizOutlineId === fixture.quizId), 'Subjective grading must preserve the earlier objective quiz');
    const state = expected.get(user.id);
    state.subjectiveAttemptId = first.attempt.id;
    state.subjectiveScore = question.earned;
    state.subjectiveQuizId = fixture.subjectiveQuizId;
    state.subjectiveGradingRecords = await verifyCapacityGradingRecords({ db, fixture, user,
      attemptId: first.attempt.id, observedAttempts: gradingAttempts, expectedInvocations: gradingAttempts.length });
    const completedScenes = [fixture.lectureSceneId, fixture.quizId, fixture.subjectiveQuizId].filter(Boolean);
    await request(user, 'POST', '/api/openmaic/progress', { courseId: fixture.instanceId, studentId: user.id, classroomId: fixture.classroomId, currentSceneIndex: completedScenes.length - 1, totalScenes: completedScenes.length, completedScenes, completionModelVersion: 2 }, { category: 'progress' });
  }));
  const user = students[0];
  await request(user, 'POST', '/api/knowledge-lecture', { action: 'record-attempt', courseId: fixture.instanceId, studentId: user.id, sectionId: fixture.subjectiveSectionId, quizOutlineId: fixture.subjectiveQuizId, runtimeSceneId: fixture.subjectiveQuizId, answers: { 'subjective-q1': '重试时更改原来的答案' } }, { expectedStatus: 409, category: 'expected-conflict' });
  record('real-ai-subjective-grading-and-persisted-replay', '通过', { students: students.length, maxScore: 6, verified: ['graded status', 'bounded score', 'nonempty feedback', 'first answer immutable', 'per-student durable attempt', 'replay stable'] });
}
