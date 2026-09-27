// Real authenticated route calls against disposable PostgreSQL, no production credentials.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { prisma } from '../src/lib/db/client';
import type { AuthClaims } from '../src/lib/auth/session';
import type { LearningEvent } from '../src/lib/session/types';

async function all<T>(tasks: Promise<T>[]): Promise<T[]> {
  const outcomes = await Promise.allSettled(tasks);
  const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  assert.equal(failures.length, 0, failures.map(failure => String(failure.reason)).join('\n'));
  return outcomes.map(outcome => (outcome as PromiseFulfilledResult<T>).value);
}
async function main() {
  const marker = process.env.OPENPBL_VERIFICATION_MARKER ?? '';
  assert.match(marker, /^openpbl-fault-check-[0-9a-f-]{36}$/);
  assert.equal(new URL(process.env.DATABASE_URL!).hostname, '127.0.0.1');
  assert.equal((await prisma.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification"`)[0]?.marker, marker);
  process.env.JWT_SECRET = randomUUID() + randomUUID(); delete process.env.REDIS_URL;
  const { POST } = await import('../src/app/api/learning-events/route');
  const { signStudentToken } = await import('../src/lib/auth/session');
  const { subscribeCourseEvents } = await import('../src/lib/realtime/event-bus');
  const { lockProjectedCourse } = await import('../src/lib/db/session-repository');
  await prisma.courseOffering.update({ where: { id: 'fault-offering' }, data: { status: 'OPEN' } });
  const instance = await prisma.classroomInstance.update({ where: { id: 'fault-course' }, data: { status: 'TEACHING', runtimeConfig: { version: 1, currentStageIndex: 1, sentinel: 'must-survive' } }, include: { activity: true } });
  const students = await all(Array.from({ length: 40 }, async (_, index) => {
    const userId = `fault-student-${index}`;
    const participation = await prisma.classroomParticipation.findFirstOrThrow({ where: { instanceId: instance.id, enrollment: { userId } }, include: { enrollment: true } });
    const token = await signStudentToken({ userId, studentName: userId, sessionVersion: 1 });
    return { userId, participation, cookie: `${token.cookieName}=${token.token}` };
  }));
  const now = Date.now();
  function event(student: typeof students[number], id: string, patch: Partial<LearningEvent> = {}): LearningEvent {
    return { id, idempotencyKey: id, courseId: instance.id, studentId: student.userId, stageKey: 'ai-learning', sceneId: 'scene', type: 'heartbeat', durationMs: 10000, expectedDurationSec: 60, visible: true, occurredAt: new Date(now).toISOString(), metadata: { a: 1, b: 'test' }, ...patch };
  }
  const rawKey = (event: LearningEvent) => `legacy:${createHash('sha256').update(JSON.stringify([instance.id, event.idempotencyKey])).digest('hex')}`;
  const histories = students.flatMap(student => Array.from({ length: 360 }, (_, index) => {
    const item = event(student, `${student.userId}-history-${index}`, { occurredAt: new Date(now - (360 - index) * 10000).toISOString(), type: index === 0 ? 'scene-enter' : 'heartbeat' });
    return { id: randomUUID(), userId: student.userId, idempotencyKey: rawKey(item), researchKey: student.participation.enrollment.researchKey,
      offeringId: 'fault-offering', enrollmentId: student.participation.enrollmentId, chapterId: instance.activity.chapterId,
      activityId: instance.activityId, classroomInstanceId: instance.id, participationId: student.participation.id,
      eventType: item.type, occurredAt: new Date(item.occurredAt), receivedAt: new Date(now - (360 - index) * 10000), source: 'legacy-classroom', metadata: { legacy: item } };
  }));
  for (let index = 0; index < histories.length; index += 1000) await prisma.learningEvent.createMany({ data: histories.slice(index, index + 1000) });
  assert.equal(await prisma.learningEvent.count(), 14400);
  const emitted: unknown[] = []; const unsubscribe = subscribeCourseEvents(instance.id, item => emitted.push(item));
  const version = async () => (await prisma.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } })).runtimeConfig as { version: number; sentinel: string };
  const post = async (student: typeof students[number], events: LearningEvent[]) => {
    const start = performance.now();
    const response = await POST(new Request('http://localhost/api/learning-events', { method: 'POST', headers: { origin: 'http://localhost', cookie: student.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ courseId: instance.id, studentId: student.userId, events }) }));
    const body = await response.json();
    return { status: response.status, body, ms: performance.now() - start };
  };
  try {
    const fresh = students.map(student => event(student, `${student.userId}-fresh`));
    const started = performance.now();
    const first = await all(students.map(async (student, index) => {
      const response = await post(student, [fresh[index]]); assert.equal(response.status, 200, JSON.stringify(response));
      assert.deepEqual(response.body.acceptedIds, [fresh[index].id]); assert.equal(response.body.duplicateCount, 0);
      assert.ok(response.body.signals.some((signal: { kind: string }) => signal.kind === 'dwell-overrun'));
      return response.ms;
    }));
    const sorted = [...first].sort((a, b) => a - b);
    console.log(`MEASURED 40 simultaneous authenticated route requests over 14,400 existing facts (360/student): batch ${Math.round(performance.now() - started)} ms, request p50 ${Math.round(sorted[19])} ms, p95 ${Math.round(sorted[37])} ms, max ${Math.round(sorted[39])} ms; 30 connections / 10s pool timeout`);
    // Acceptance is P95 ≤ 2s; retain max separately, including outliers.
    const latencyFailure = sorted[37] > 2000 ? `Telemetry request P95 exceeded 2s: ${sorted[37]} (max ${sorted[39]})` : undefined;
    const admissionMetrics = await import("../src/lib/observability/course-admission");
    console.log(JSON.stringify({ attempts: (await admissionMetrics.courseAdmissionAttempts.get()).values[0]?.value, busy: (await admissionMetrics.courseAdmissionBusy.get()).values[0]?.value, backoff: (await admissionMetrics.courseAdmissionBackoff.get()).values.filter(row => row.metricName?.endsWith("_sum") || row.metricName?.endsWith("_count")) }));
    assert.equal(await prisma.learningEvent.count(), 14440); assert.equal(await prisma.learningSignal.count(), 40);
    assert.deepEqual(await version(), { version: 41, currentStageIndex: 1, sentinel: 'must-survive' });
    assert.equal(await prisma.domainEvent.count(), 40); assert.equal(emitted.length, 40);
    const notifications = await prisma.domainEvent.findMany({ orderBy: { createdAt: 'asc' } });
    assert.deepEqual(notifications.map(row => (row.payload as { courseVersion: number }).courseVersion).sort((a, b) => a - b), Array.from({ length: 40 }, (_, index) => index + 2));
    for (const row of notifications) { assert.ok(row.participationId && row.researchKey); assert.equal((row.payload as { scope: string }).scope, 'student'); }
    await all(students.map(async (student, index) => {
      const reordered = JSON.parse(JSON.stringify(fresh[index])); reordered.metadata = { b: 'test', a: 1 };
      const response = await post(student, [reordered]); assert.equal(response.status, 200); assert.deepEqual(response.body.acceptedIds, [fresh[index].id]); assert.equal(response.body.duplicateCount, 1);
      for (const patch of [{ durationMs: 17 }, { id: randomUUID() }]) {
        const conflict = await post(student, [{ ...fresh[index], ...patch }]); assert.equal(conflict.status, 409); assert.equal(conflict.body.error, 'LEARNING_EVENT_CONFLICT');
      }
    }));
    assert.equal(await prisma.learningEvent.count(), 14440); assert.equal(await prisma.domainEvent.count(), 40); assert.equal((await version()).version, 41); assert.equal(emitted.length, 40);
    console.log('PASS 40 lost-ack replays acknowledge all original IDs; JSON property order ignored; 80 changed-body/changed-event-ID conflicts; no duplicate facts, version increments or notifications');
    await all(students.map(async (student, index) => {
      const finish = event(student, `${student.userId}-complete`, { type: 'stage-goal-complete', sceneId: undefined, occurredAt: new Date(now + 1000).toISOString() });
      const pair = await all([post(student, [finish]), post(student, [finish])]);
      pair.forEach(response => { assert.equal(response.status, 200); assert.deepEqual(response.body.acceptedIds, [finish.id]); assert.equal(response.body.signals.length, 0); });
      assert.deepEqual(pair.map(response => response.body.duplicateCount).sort(), [0, 1]);
      const rows = await prisma.learningEvent.findMany({ where: { userId: student.userId }, select: { researchKey: true, enrollmentId: true, participationId: true } });
      assert.equal(rows.length, 362, `student ${index} evidence count`);
      rows.forEach(row => { assert.equal(row.researchKey, student.participation.enrollment.researchKey); assert.equal(row.enrollmentId, student.participation.enrollmentId); assert.equal(row.participationId, student.participation.id); });
    }));
    assert.equal(await prisma.learningSignal.count(), 0); assert.equal(await prisma.learningEvent.count(), 14480);
    assert.equal((await version()).version, 81); assert.equal(await prisma.domainEvent.count(), 80);
    console.log('PASS 40 students × 2 concurrent identical completion events: exactly one mutation each; stale per-scene warnings removed after stage completion; all 14,480 raw facts and ownership retained');
    // Fail the final durable-notification write, after raw evidence / signal / version writes.
    await prisma.$executeRawUnsafe(`CREATE FUNCTION verification_reject_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated injected notification failure'; END; $$`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER verification_reject_notice BEFORE INSERT ON "DomainEvent" FOR EACH ROW EXECUTE FUNCTION verification_reject_notice()');
    const failedEvents = students.map(student => event(student, `${student.userId}-rollback`, { type: 'artifact-change', stageKey: 'make', sceneId: undefined }));
    await all(students.map(async (student, index) => { const response = await post(student, [failedEvents[index]]); assert.equal(response.status, 503); }));
    assert.equal(await prisma.learningEvent.count(), 14480); assert.equal((await version()).version, 81); assert.equal(await prisma.domainEvent.count(), 80); assert.equal(emitted.length, 80);
    await prisma.$executeRawUnsafe('DROP TRIGGER verification_reject_notice ON "DomainEvent"'); await prisma.$executeRawUnsafe('DROP FUNCTION verification_reject_notice()');
    await all(students.map(async (student, index) => { const response = await post(student, [failedEvents[index]]); assert.equal(response.status, 200); assert.deepEqual(response.body.acceptedIds, [failedEvents[index].id]); }));
    assert.equal(await prisma.learningEvent.count(), 14520); assert.equal((await version()).version, 121); assert.equal(await prisma.domainEvent.count(), 120);
    console.log('PASS 40 injected mid-transaction failures return 503 and roll back raw facts/signals/version/notification; retry commits exactly once for every student');
    let locked!: () => void; const lockHeld = new Promise<void>(resolve => { locked = resolve; });
    const closure = prisma.$transaction(async tx => { await lockProjectedCourse(tx, instance.id); locked(); await delay(50); await tx.classroomInstance.update({ where: { id: instance.id }, data: { status: 'FINISHED' } }); });
    await lockHeld;
    await all(students.map(async (student, index) => {
      const response = await post(student, [event(student, `${student.userId}-after-close`)]); assert.equal(response.status, 409); assert.equal(response.body.error, 'COURSE_LOCKED');
      const replay = await post(student, [failedEvents[index]]); assert.equal(replay.status, 200); assert.deepEqual(replay.body.acceptedIds, [failedEvents[index].id]);
    })); await closure;
    assert.equal(await prisma.learningEvent.count(), 14520); assert.equal((await version()).version, 121); assert.equal(await prisma.domainEvent.count(), 120);
    console.log('PASS classroom closure wins the shared lock order: all 40 new events rejected, all 40 previously committed retries acknowledged, retained 14,520 facts and exactly 120 durable/live notifications');
    // A durable receipt must not bypass a subsequent identity/enrollment
    // revocation, including when authentication preceded the lock wait.
    const { ingestClassroomLearningEvents } = await import('../src/lib/learning-analytics/ingest');
    const student = students[0];
    const replayInput = { courseId: instance.id, studentId: student.userId, events: [failedEvents[0]] };
    const claims = { sub: student.userId, role: 'student', sv: 1 } as AuthClaims;
    for (const patch of [{ status: 'DISABLED' }, { role: 'TEACHER' }, { sessionVersion: 2 }]) {
      await prisma.user.update({ where: { id: student.userId }, data: patch });
      await assert.rejects(ingestClassroomLearningEvents(claims, replayInput), (error: unknown) => (error as { code: string }).code === 'UNAUTHENTICATED');
      await prisma.user.update({ where: { id: student.userId }, data: { status: 'ACTIVE', role: 'STUDENT', sessionVersion: 1 } });
    }
    await prisma.enrollment.update({ where: { id: student.participation.enrollmentId }, data: { status: 'WITHDRAWN' } });
    await assert.rejects(ingestClassroomLearningEvents(claims, replayInput), (error: unknown) => (error as { code: string }).code === 'STUDENT_SCOPE_MISMATCH');
    assert.equal(await prisma.learningEvent.count(), 14520); assert.equal(await prisma.domainEvent.count(), 120);
    console.log('PASS committed receipts still reject disabled users, changed roles/session versions, and withdrawn enrollment after acquiring locks');
    // Differential regression: the production reader now selects only relevant
    // scene history. Compare its result with the previous full-history algorithm.
    await prisma.enrollment.update({ where: { id: student.participation.enrollmentId }, data: { status: 'ACTIVE' } });
    await prisma.classroomInstance.update({ where: { id: instance.id }, data: { status: 'TEACHING' } });
    const { analyzeStudentLearning } = await import('../src/lib/learning-analytics/analyzer');
    type Signal = import('../src/lib/session/types').LearningSignal;
    const signalScope = (item: { stageKey: string; sceneId?: string }) => JSON.stringify([item.stageKey, item.sceneId ?? '']);
    const batches: LearningEvent[][] = [
      [event(student, 'differential-a-enter', { stageKey: 'differential', sceneId: 'a', type: 'scene-enter', occurredAt: new Date(now - 600000).toISOString(), expectedDurationSec: 10 }), event(student, 'differential-b-enter', { stageKey: 'differential', sceneId: 'b', type: 'scene-enter', occurredAt: new Date(now - 500000).toISOString(), expectedDurationSec: 20 }), event(student, 'differential-other-enter', { stageKey: 'unrelated', type: 'scene-enter', occurredAt: new Date(now - 600000).toISOString() })],
      [event(student, 'differential-a-heartbeat', { stageKey: 'differential', sceneId: 'a', durationMs: 600000, expectedDurationSec: 10 }), event(student, 'differential-b-heartbeat', { stageKey: 'differential', sceneId: 'b', durationMs: 500000, expectedDurationSec: 20 })],
      [event(student, 'differential-finish', { stageKey: 'differential', sceneId: undefined, type: 'stage-goal-complete' })],
      [event(student, 'differential-after-finish', { stageKey: 'differential', sceneId: 'a', durationMs: 700000, expectedDurationSec: 1 })],
      [event(student, 'differential-no-scene', { stageKey: 'no-scene', sceneId: undefined, type: 'artifact-change' }), event(student, 'differential-other-heartbeat', { stageKey: 'unrelated', durationMs: 600000 })],
    ];
    for (const batch of batches) {
      const rows = await prisma.learningEvent.findMany({ where: { userId: student.userId, classroomInstanceId: instance.id, participationId: student.participation.id }, orderBy: { receivedAt: 'asc' } });
      const learningEvents = [...rows.map(row => (row.metadata as { legacy: LearningEvent }).legacy), ...batch];
      const oldSignals = (await prisma.learningSignal.findMany({ where: { participationId: student.participation.id } })).map(row => (row.payload as { view: Signal }).view);
      const affected = new Set(batch.map(signalScope));
      for (const item of batch) if (item.type === 'stage-goal-complete') for (const previous of [...learningEvents, ...oldSignals]) if (previous.stageKey === item.stageKey) affected.add(signalScope(previous));
      const expectedSignals = [...oldSignals.filter(signal => !affected.has(signalScope(signal))), ...[...affected].flatMap(value => {
        const [stageKey, sceneId] = JSON.parse(value);
        const scoped = learningEvents.filter(item => item.stageKey === stageKey && ((item.sceneId ?? '') === sceneId || item.type === 'stage-goal-complete'));
        const last = (field: 'expectedDurationSec' | 'ttsDurationSec' | 'plannedStudentActivitySec') => [...scoped].reverse().find(item => typeof item[field] === 'number')?.[field];
        const attempts = oldSignals.filter(signal => signalScope(signal) === value).reduce((max, signal) => Math.max(max, signal.aiInterventionAttempts), 0);
        return analyzeStudentLearning({ events: scoped, expectedDurationSec: last('expectedDurationSec') ?? 0, ttsDurationSec: last('ttsDurationSec'), plannedStudentActivitySec: last('plannedStudentActivitySec'), aiInterventionAttempts: attempts }).signals;
      })];
      const result = await post(student, batch); assert.equal(result.status, 200);
      const canonical = (signals: Signal[]) => signals.map(signal => { const copy = { ...signal }; Reflect.deleteProperty(copy, 'firstDetectedAt'); Reflect.deleteProperty(copy, 'lastDetectedAt'); return JSON.parse(JSON.stringify(copy)) as Signal; }).sort((a, b) => a.id.localeCompare(b.id));
      assert.deepEqual(canonical(result.body.signals), canonical(expectedSignals), `scoped/full history equivalence: ${batch.map(item => item.id).join(',')}`);
      // Keep mutable teacher intervention state across the next narrow read.
      for (const row of await prisma.learningSignal.findMany({ where: { participationId: student.participation.id } })) {
        const payload = row.payload as { view: Signal };
        await prisma.learningSignal.update({ where: { id: row.id }, data: { payload: { ...payload, view: { ...payload.view, aiInterventionAttempts: 2 } } } });
      }
    }
    assert.equal((await version()).sentinel, 'must-survive');
    console.log('PASS SQL-scoped history equals full-history analysis across five multi-scene/stage batches, stage completion/revisit, absent scene, unrelated signals and mutable intervention attempts; runtime sentinel preserved');
    await prisma.$executeRawUnsafe('ANALYZE "LearningEvent"');
    for (const requestedStage of ['ai-learning', 'make']) {
      const selection = JSON.stringify([{ stageKey: requestedStage, sceneId: requestedStage === 'ai-learning' ? 'scene' : '', wholeStage: false }]);
      const plan = await prisma.$queryRaw`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT jsonb_agg(jsonb_build_object('metadata', le.metadata) ORDER BY le."receivedAt")
        FROM "LearningEvent" le WHERE le."userId" = ${student.userId} AND le."classroomInstanceId" = ${instance.id} AND le."participationId" = ${student.participation.id}
        AND EXISTS (SELECT 1 FROM jsonb_to_recordset(${selection}::jsonb) AS affected("stageKey" text, "sceneId" text, "wholeStage" boolean)
          WHERE le.metadata #>> '{legacy,stageKey}' = affected."stageKey"
          AND (affected."wholeStage" OR COALESCE(le.metadata #>> '{legacy,sceneId}', '') = affected."sceneId" OR le.metadata #>> '{legacy,type}' = 'stage-goal-complete'))`;
      console.log(`EXPLAIN scoped history ${requestedStage}: ${JSON.stringify(plan)}`);
    }
    assert.equal(latencyFailure, undefined, latencyFailure);
    console.log('PASS 40 telemetry request P95 meets the agreed ≤2s gate; max reported above');
  } finally { unsubscribe(); }
}
main().finally(() => prisma.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
