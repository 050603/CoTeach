// This worker requires the disposable PostgreSQL harness marker. No external model is contacted.
import assert from 'node:assert/strict';
import { MockLanguageModelV3 } from 'ai/test';
import { setTimeout as delay } from 'node:timers/promises';
import type { KnowledgeLectureTutorThread } from '../src/lib/session/types';
import type { ResolvedModel } from '../src/lib/openmaic/server/resolve-model';
import type { ExplanationInput } from '../src/lib/courses/knowledge-explanations';

async function main() {
  const marker = process.env.OPENPBL_VERIFICATION_MARKER;
  assert.match(marker ?? '', /^openpbl-research-check-[0-9a-f-]{36}$/);
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.username, 'postgres');
  assert.equal(url.password, ''); assert.equal(url.pathname, '/postgres'); assert.ok(url.port);
  const { prisma } = await import('../src/lib/db/client');
  try {
    assert.equal((await prisma.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification" WHERE marker = ${marker}`).length, 1);
    const { getSharedExplanation, explanationCacheKey, readPreparedExplanation, parsePreparedExplanation } = await import('../src/lib/courses/knowledge-explanations');
    const { authoredQuestionFingerprint } = await import('../src/lib/courses/knowledge-tutor-evidence');
    const { parseTutorPayload } = await import('../src/lib/courses/knowledge-tutor-payload');
    const input: ExplanationInput = { classroomId: 'verification-classroom', sceneId: 'verification-scene', knowledgePointNames: ['变量关系'], sourceEvidence: { items: [], authoredQuotes: [] },
      question: { id: 'question', type: 'single' as const, question: '以下哪项正确？', options: [{ value: 'A', label: '同向' }, { value: 'B', label: '反向' }], answer: ['A'], analysis: '两者同向变化。' } };
    const preparedOutput = (introduction: string) => JSON.stringify({ introduction,
      items: [{ key: 'A', explanation: '题设描述两者同向变化，符合题目给出的关系。' }, { key: 'B', explanation: '反向表示一个增加而另一个减少，题设没有给出这种关系。' }],
      takeaway: '判断方向时需要依据题设，不能把同向和反向混淆。', boardNotes: [] });
    let calls = 0; let output = preparedOutput('先比较题目中两个变量的变化方向。');
    const fake = new MockLanguageModelV3({ doGenerate: async () => {
      calls++; await delay(100);
      return { content: [{ type: 'text', text: output }], finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
    } });
    const model = { model: fake, modelString: 'isolated/fake' } as unknown as ResolvedModel;
    const answers = await Promise.all(Array.from({ length: 30 }, () => getSharedExplanation(input, model, AbortSignal.timeout(20_000))));
    assert.equal(calls, 1); assert.equal(new Set(answers).size, 1);
    const key = explanationCacheKey(input, model);
    const rows = await prisma.$queryRaw<Array<{ status: string; raw: string; input: ExplanationInput }>>`SELECT status, raw, input FROM "KnowledgeExplanation" WHERE id = ${key}`;
    assert.equal(rows.length, 1); assert.equal(rows[0].status, 'COMPLETED'); assert.equal(rows[0].raw, output);
    console.log('PASS real PostgreSQL: 30 concurrent background preparations produce one complete question lecture with one local mock model call');

    // Default opening and replay only read the lesson resource. They must not
    // fabricate personal AI requests, conversations, messages or learning facts.
    const aiCounts = async () => Promise.all([prisma.aiTask.count(), prisma.aiConversation.count(), prisma.aiMessage.count(), prisma.aiInteractionEvent.count()]);
    const beforeReads = await aiCounts();
    const lookup = { classroomId: input.classroomId, sceneId: input.sceneId,
      questionFingerprint: authoredQuestionFingerprint(input.question, input.sourceEvidence!) };
    // JSONB does not preserve object-property order. Existing resources without
    // a frozen fingerprint must still return the caller's matching content key.
    await prisma.$executeRaw`UPDATE "KnowledgeExplanation" SET input = input - 'questionFingerprint' WHERE id = ${key}`;
    const prepared = await Promise.all(Array.from({ length: 30 }, () => readPreparedExplanation(lookup)));
    const expectedText = parsePreparedExplanation(output, input, new Date().toISOString()).answer;
    assert.ok(prepared.every(resource => resource?.source === 'prepared' && resource.text === expectedText
      && resource.questionFingerprint === lookup.questionFingerprint));
    assert.equal(new Set(prepared.map(resource => resource!.id)).size, 1);
    const replayed = await readPreparedExplanation(lookup);
    assert.equal(replayed?.id, prepared[0]!.id);
    assert.equal(await readPreparedExplanation({ ...lookup, sceneId: 'missing-resource' }), null);
    assert.equal(calls, 1, 'Opening, replay and a missing resource cannot generate model output');
    assert.deepEqual(await aiCounts(), beforeReads, 'Shared lecture reads cannot create personal AI records');
    console.log('PASS 30 default opens, replay and cache miss: same lecture resource, zero new model calls, AI tasks, conversations, messages or AI interaction events');

    const [frozen] = await prisma.$queryRaw<Array<{ input: ExplanationInput }>>`SELECT ${JSON.stringify({ ...input, questionFingerprint: lookup.questionFingerprint })}::jsonb AS input`;
    assert.equal(frozen.input.questionFingerprint, lookup.questionFingerprint);
    assert.equal(await getSharedExplanation(frozen.input, model, AbortSignal.timeout(5_000)), output);
    assert.equal(calls, 1, 'A frozen source fingerprint must reuse its resource after the queue JSONB roundtrip');
    console.log('PASS the frozen question fingerprint survives a queue JSONB roundtrip without another background model call');

    // Only an explicit follow-up creates independent owned receipts and learning facts.
    // Deliberately reuse request/thread/question identifiers across users to exercise scoping.
    const { claimTutorRequest, finishTutorRequest } = await import('../src/lib/courses/knowledge-tutor-requests');
    const teacher = await prisma.user.create({ data: { username: 'tutor-receipt-teacher', usernameKey: 'tutor-receipt-teacher', displayName: 'Teacher', role: 'TEACHER', passwordHash: 'isolated-unusable' } });
    const offering = await prisma.courseOffering.create({ data: { name: 'Isolated tutor receipts', status: 'OPEN' } });
    const chapter = await prisma.chapter.create({ data: { offeringId: offering.id, title: 'Knowledge', position: 0 } });
    const activity = await prisma.activity.create({ data: { chapterId: chapter.id, title: 'Shared explanation', type: 'CLASSROOM', position: 0 } });
    const template = await prisma.classroomTemplate.create({ data: { ownerId: teacher.id, title: 'Tutor receipts' } });
    const version = await prisma.classroomTemplateVersion.create({ data: { templateId: template.id, version: 1, status: 'PUBLISHED', snapshot: { title: 'Tutor receipts' } } });
    const instance = await prisma.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: version.id, status: 'TEACHING', runtimeConfig: { version: 1 } } });
    const learners = await Promise.all(Array.from({ length: 30 }, async (_, index) => {
      const name = `tutor-receipt-student-${index}`;
      const student = await prisma.user.create({ data: { username: name, usernameKey: name, displayName: name, role: 'STUDENT', passwordHash: 'isolated-unusable' } });
      const enrollment = await prisma.enrollment.create({ data: { userId: student.id, offeringId: offering.id } });
      const participation = await prisma.classroomParticipation.create({ data: { instanceId: instance.id, enrollmentId: enrollment.id } });
      const original = `private-state-${index}`;
      await prisma.studentProjectWorkspace.create({ data: { participationId: participation.id, projectState: {
        original, aiLearningProgress: { classroomId: input.classroomId, studentId: student.id, knowledgeLectureTutorThreads: [] },
      } } });
      const request = { courseId: instance.id, classroomId: input.classroomId, studentId: student.id,
        requestId: 'same-request-id', threadId: 'same-thread-id', questionId: input.question.id,
        attemptId: `attempt-${student.id}`, message: `我选择了B，为什么题目中的同向变化不能理解为反向？追问${index}`, initial: false };
      return { student, enrollment, participation, request, original };
    }));
    const claims = await Promise.all(learners.map(learner => claimTutorRequest(learner.request)));
    assert.ok(claims.every(claim => claim.run), 'All 30 explicit follow-ups must independently own an AI receipt');
    // Schema-valid personalized fixtures exercise persistence without contacting a provider.
    const personalRaw = learners.map((_, index) => JSON.stringify({ answer: `针对你的B选项追问${index}：反向变化要求一个变量增加而另一个减少；本题给出的两个变量同向变化，所以B不符合题意。`, boardNotes: [] }));
    const personalPayload = personalRaw.map(raw => parseTutorPayload(raw, new Date().toISOString()));
    const completedThreads = await Promise.all(learners.map(async (learner, index) => {
      const claim = claims[index]; assert.equal(claim.run, true);
      if (!claim.run) throw new Error('Expected new receipt');
      const now = new Date().toISOString();
      const additions: KnowledgeLectureTutorThread = { id: learner.request.threadId, attemptId: learner.request.attemptId,
        questionId: learner.request.questionId, createdAt: now, updatedAt: now, boardNotes: [],
        messages: [{ id: `student-${learner.student.id}`, role: 'user', content: learner.request.message, createdAt: now },
          { id: `assistant-${learner.student.id}`, role: 'assistant', content: personalPayload[index].answer, createdAt: now }] };
      return finishTutorRequest(learner.request, claim.token, additions, personalRaw[index], 'personalized');
    }));
    assert.equal(calls, 1, 'Thirty personalized completion fixtures must not regenerate the shared lecture');
    const tasks = await prisma.aiTask.findMany({ where: { offeringId: offering.id, taskType: 'KNOWLEDGE_LECTURE_TUTOR' },
      include: { conversation: { include: { messages: true } }, interactionEvents: true } });
    assert.equal(tasks.length, 30); assert.equal(new Set(tasks.map(task => task.id)).size, 30);
    assert.equal(new Set(tasks.map(task => task.conversationId)).size, 30);
    const object = (value: unknown) => value as Record<string, unknown>;
    for (const [index, learner] of learners.entries()) {
      const task = tasks.find(candidate => candidate.createdById === learner.student.id)!;
      assert.ok(task); assert.equal(task.status, 'COMPLETED');
      assert.equal(object(task.input).studentId, learner.student.id); assert.equal(object(task.input).message, learner.request.message);
      assert.equal(object(task.input).initial, false);
      assert.equal(task.conversation?.userId, learner.student.id); assert.equal(task.conversation?.participationId, learner.participation.id);
      assert.equal(task.conversation?.messages.length, 2);
      const userMessage = task.conversation!.messages.find(message => message.role === 'user')!;
      const assistantMessage = task.conversation!.messages.find(message => message.role === 'assistant')!;
      assert.equal(userMessage.userId, learner.student.id); assert.equal(userMessage.content, learner.request.message);
      assert.equal(object(userMessage.metadata).initial, false);
      assert.equal(assistantMessage.content, personalPayload[index].answer);
      assert.equal(task.interactionEvents.length, 2);
      for (const event of task.interactionEvents) {
        assert.equal(event.userId, learner.student.id); assert.equal(event.participationId, learner.participation.id);
        assert.equal(event.researchKey, learner.enrollment.researchKey); assert.equal(event.taskId, task.id);
        assert.equal(event.conversationId, task.conversationId);
        assert.equal(object(object(event.payload).detail).attemptId, learner.request.attemptId);
        assert.equal(event.content, event.actor === 'student' ? learner.request.message : assistantMessage.content);
      }
      assert.equal(object(task.output).resultSource, 'personalized');
      assert.equal(object(object(task.output).modelOutput).raw, personalRaw[index]);
      assert.deepEqual(object(task.output).thread, completedThreads[index]);
      const workspace = await prisma.studentProjectWorkspace.findUniqueOrThrow({ where: { participationId: learner.participation.id } });
      assert.equal(object(workspace.projectState).original, learner.original); assert.equal(workspace.version, 2);
      const progress = object(object(workspace.projectState).aiLearningProgress);
      assert.equal(progress.studentId, learner.student.id);
      assert.deepEqual(progress.knowledgeLectureTutorThreads, [completedThreads[index]]);
      assert.equal(completedThreads[index].attemptId, learner.request.attemptId);
      assert.equal(completedThreads[index].messages[0].id, `student-${learner.student.id}`);
      assert.equal(completedThreads[index].messages[1].id, `assistant-${learner.student.id}`);
    }
    const completions = await prisma.domainEvent.findMany({ where: { classroomInstanceId: instance.id, eventType: 'KNOWLEDGE_TUTOR_COMPLETED' } });
    assert.equal(completions.length, 30); assert.equal(new Set(completions.map(event => event.actorId)).size, 30);
    for (const learner of learners) {
      const event = completions.find(candidate => candidate.actorId === learner.student.id)!;
      assert.equal(event.participationId, learner.participation.id); assert.equal(event.researchKey, learner.enrollment.researchKey);
      assert.equal(object(event.payload).studentId, learner.student.id);
    }
    assert.equal(object((await prisma.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } })).runtimeConfig).version, 31);
    const replays = await Promise.all(learners.map(learner => claimTutorRequest(learner.request)));
    for (const [index, replay] of replays.entries()) {
      assert.equal(replay.run, false);
      if (replay.run) throw new Error('Replay must not execute another model call');
      assert.equal(replay.status, 'COMPLETED'); assert.equal(replay.resultSource, 'personalized');
      assert.deepEqual(replay.thread, completedThreads[index]);
    }
    await Promise.all(learners.map((learner, index) => {
      const claim = claims[index]; if (!claim.run) throw new Error('Expected original token');
      return finishTutorRequest(learner.request, claim.token, completedThreads[index], 'must-not-overwrite', 'personalized');
    }));
    assert.equal(await prisma.aiTask.count({ where: { offeringId: offering.id } }), 30);
    assert.equal(await prisma.aiMessage.count({ where: { conversation: { offeringId: offering.id } } }), 60);
    assert.equal(await prisma.aiInteractionEvent.count({ where: { offeringId: offering.id } }), 60);
    assert.equal(await prisma.domainEvent.count({ where: { classroomInstanceId: instance.id, eventType: 'KNOWLEDGE_TUTOR_COMPLETED' } }), 30);
    assert.equal(calls, 1);
    const retainedTasks = await prisma.aiTask.findMany({ where: { offeringId: offering.id } });
    for (const [index, learner] of learners.entries()) {
      const task = retainedTasks.find(candidate => candidate.createdById === learner.student.id)!;
      assert.equal(object(object(task.output).modelOutput).raw, personalRaw[index]);
    }
    console.log('PASS 30 explicit follow-ups: 30 owned personalized receipts, 30 conversations, 60 messages, 60 AI learning events and 30 completion events; isolated student state and idempotent replay preserve original answers');


    await getSharedExplanation({ ...input, question: { ...input.question, answer: ['B'] } }, model, AbortSignal.timeout(5_000));
    assert.equal(calls, 2);
    await getSharedExplanation({ ...input, sourceEvidence: { version: 2, fingerprint: 'new-source', items: [], authoredQuotes: [] } }, model, AbortSignal.timeout(5_000));
    assert.equal(calls, 3);
    console.log('PASS changed correct answer and source revision cannot reuse an obsolete explanation');

    const failureInput = { ...input, sceneId: 'failure-scene' }; const failureKey = explanationCacheKey(failureInput, model);
    output = 'malformed-json';
    await assert.rejects(getSharedExplanation(failureInput, model, AbortSignal.timeout(5_000)), /TUTOR_INVALID_OUTPUT/);
    const [failed] = await prisma.$queryRaw<Array<{ status: string; raw: string }>>`SELECT status, raw FROM "KnowledgeExplanation" WHERE id = ${failureKey}`;
    assert.equal(failed.status, 'FAILED'); assert.equal(failed.raw, 'malformed-json');
    output = preparedOutput('有效重试讲解：先辨析两个变量的变化方向。');
    await prisma.$executeRaw`UPDATE "KnowledgeExplanation" SET "retryAt" = NOW() - INTERVAL '1 second' WHERE id = ${failureKey}`;
    assert.equal(await getSharedExplanation(failureInput, model, AbortSignal.timeout(5_000)), output);
    await prisma.$executeRaw`UPDATE "KnowledgeExplanation" SET status = 'RUNNING', token = 'dead-process', "leaseUntil" = NOW() - INTERVAL '1 second' WHERE id = ${failureKey}`;
    assert.equal(await getSharedExplanation(failureInput, model, AbortSignal.timeout(5_000)), output);
    assert.equal(calls, 5);
    console.log('PASS invalid output retained as failed, bounded retry and abandoned lease recover retained valid output without a new model call');

    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let leaseCalls = 0;
    const leasedModel = { ...model, model: new MockLanguageModelV3({ doGenerate: async () => {
      leaseCalls++; if (leaseCalls === 1) await gate;
      return { content: [{ type: 'text', text: output }], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
    } }) } as unknown as ResolvedModel;
    const leaseInput = { ...input, sceneId: 'fenced-lease' }; const leaseKey = explanationCacheKey(leaseInput, leasedModel);
    const previous = getSharedExplanation(leaseInput, leasedModel, AbortSignal.timeout(5_000));
    const rejected = assert.rejects(previous, /LEASE_EXPIRED/);
    while (leaseCalls === 0) await delay(10);
    await prisma.$executeRaw`UPDATE "KnowledgeExplanation" SET "leaseUntil" = NOW() - INTERVAL '1 second' WHERE id = ${leaseKey}`;
    const replacement = await getSharedExplanation(leaseInput, leasedModel, AbortSignal.timeout(5_000));
    release(); await rejected;
    assert.equal(replacement, output); assert.equal(leaseCalls, 2);
    const [completed] = await prisma.$queryRaw<Array<{ status: string; raw: string }>>`SELECT status, raw FROM "KnowledgeExplanation" WHERE id = ${leaseKey}`;
    assert.equal(completed.status, 'COMPLETED'); assert.equal(completed.raw, output);
    console.log('PASS stale owner cannot overwrite the replacement lease result');
  } finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
