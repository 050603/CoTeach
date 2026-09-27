import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import type { Prisma } from '@prisma/client';

type Result = { count: number; p95Ms: number; maxMs: number };
function summarize(times: number[]): Result {
  const sorted = times.toSorted((a, b) => a - b);
  return { count: sorted.length, p95Ms: Math.round(sorted[Math.ceil(sorted.length * .95) - 1]), maxMs: Math.round(sorted.at(-1)!) };
}
async function main() {
  const marker = process.env.OPENPBL_VERIFICATION_MARKER!;
  assert.match(marker, /^openpbl-admission-[0-9a-f-]{36}$/);
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.username, 'postgres'); assert.equal(url.password, ''); assert.equal(url.pathname, '/postgres');
  const { prisma } = await import('../src/lib/db/client');
  const { runMutationTransaction, CourseAdmissionTimeoutError } = await import('../src/lib/db/transaction-retry');
  const { lockProjectedCourse } = await import('../src/lib/db/session-repository');
  const courseId = 'probe';
  assert.equal((await prisma.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification" WHERE marker=${marker}`).length, 1);
  const mutate = async (tx: Prisma.TransactionClient, id: string, projection = false) => {
    await lockProjectedCourse(tx, courseId);
    const [row] = await tx.$queryRaw<Array<{ runtimeConfig: { version: number; projection: string }; status: string }>>`SELECT "runtimeConfig", status FROM "ClassroomInstance" WHERE id=${courseId}`;
    if (row.status !== 'TEACHING') throw new Error('CLASSROOM_READ_ONLY');
    await tx.$queryRaw`SELECT pg_sleep(0.008)::text`;
    const runtime = { ...row.runtimeConfig, version: row.runtimeConfig.version + 1, ...(projection ? { projection: id } : {}) };
    await tx.$executeRaw`UPDATE "ClassroomInstance" SET "runtimeConfig"=${JSON.stringify(runtime)}::jsonb WHERE id=${courseId}`;
    await tx.$executeRaw`INSERT INTO receipt VALUES (${id}, ${runtime.version})`;
  };
  try {
    if (process.argv[2] === 'child') {
      const count = Number(process.argv[3]); const name = process.argv[4];
      console.log('READY'); await once(process.stdin, 'data'); process.stdin.pause();
      const times: number[] = [];
      const results = await Promise.allSettled(Array.from({ length: count }, async (_, index) => {
        const start = performance.now();
        await runMutationTransaction(tx => mutate(tx, `${name}-${index}`), { lowPriorityCourseId: courseId });
        times.push(performance.now() - start);
      }));
      for (const value of results) assert.equal(value.status, 'fulfilled', value.status === 'rejected' ? String(value.reason) : '');
      const { courseAdmissionBusy, courseAdmissionAttempts } = await import('../src/lib/observability/course-admission');
      console.log(`RESULT ${JSON.stringify({ ...summarize(times), busy: (await courseAdmissionBusy.get()).values[0]?.value, attempts: (await courseAdmissionAttempts.get()).values[0]?.value })}`);
      return;
    }
    function child(count: number, name: string) {
      const process = spawn(globalThis.process.execPath, ['--import', 'tsx', path.resolve('scripts/verify-course-admission-worker.ts'), 'child', String(count), name], { env: globalThis.process.env, stdio: ['pipe', 'pipe', 'pipe'] });
      let buffered = '', errors = '', result: Result | undefined;
      let readyResolve!: () => void;
      const ready = new Promise<void>(resolve => { readyResolve = resolve; });
      process.stdout.on('data', value => {
        buffered += value.toString();
        let end;
        while ((end = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
          if (line === 'READY') readyResolve();
          if (line.startsWith('RESULT ')) result = JSON.parse(line.slice(7));
        }
      });
      process.stderr.on('data', value => { errors += value.toString(); });
      const finished = once(process, 'exit').then(([code]) => { assert.equal(code, 0, errors); assert.ok(result); return result; });
      return { ready, start: () => process.stdin.end('go\n'), finished };
    }
    for (const count of [40, 120]) {
      await prisma.$executeRaw`TRUNCATE receipt, "ClassroomInstance"`;
      await prisma.$executeRaw`INSERT INTO "ClassroomInstance" VALUES (${courseId}, '{"version":0,"projection":""}', 'TEACHING')`;
      const children = [child(count / 2, 'first'), child(count / 2, 'second')];
      await Promise.all(children.map(value => value.ready));
      children.forEach(value => value.start());
      const teacher = (async () => {
        const times: number[] = [];
        await delay(90);
        for (let i = 0; i < 10; i++) {
          const start = performance.now();
          await runMutationTransaction(tx => mutate(tx, `projection-${i}`, true));
          times.push(performance.now() - start); await delay(50);
        }
        return summarize(times);
      })();
      const settled = await Promise.allSettled([...children.map(value => value.finished), teacher]);
      for (const value of settled) assert.equal(value.status, 'fulfilled', value.status === 'rejected' ? String(value.reason) : '');
      const [row] = await prisma.$queryRaw<Array<{ runtimeConfig: { version: number; projection: string } }>>`SELECT "runtimeConfig" FROM "ClassroomInstance" WHERE id=${courseId}`;
      const [receipts] = await prisma.$queryRaw<Array<{ count: number; min: number; max: number }>>`SELECT count(*)::int AS count, min(version), max(version) FROM receipt`;
      assert.deepEqual(receipts, { count: count + 10, min: 1, max: count + 10 });
      assert.deepEqual(row.runtimeConfig, { version: count + 10, projection: 'projection-9' });
      for (const name of ['first', 'second']) {
        const ordered = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM receipt WHERE id LIKE ${`${name}-%`} ORDER BY version`;
        assert.deepEqual(ordered.map(row => row.id), Array.from({ length: count / 2 }, (_, index) => `${name}-${index}`));
      }
      console.log(JSON.stringify({ result: 'PASS', writers: count, separateNodeProcesses: 3, students: await Promise.all(children.map(value => value.finished)), teacher: await teacher, invariant: 'no lost versions/receipts/projection; both student processes complete under periodic teachers' }));
    }
    let release!: () => void, locked!: () => void;
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const blocker = prisma.$transaction(async tx => { await lockProjectedCourse(tx, courseId); locked(); await held; }, { timeout: 20000 });
    await acquired;
    const start = performance.now(); let called = false;
    try {
      const attempts = Array.from({ length: 6 }, () => runMutationTransaction(async () => { called = true; }, { lowPriorityCourseId: courseId }).catch(error => error));
      await delay(250);
      const ping = performance.now();
      await prisma.$queryRaw`SELECT 1`;
      assert.ok(performance.now() - ping < 1000, 'Contention must release connections between attempts');
      const failures = await Promise.all(attempts);
      failures.forEach(failure => assert.ok(failure instanceof CourseAdmissionTimeoutError));
      assert.equal(globalThis.__openPblCourseMutationQueues?.size, 0, 'Expired FIFO entries must not retain a course queue');
      assert.equal(called, false);
      assert.ok(performance.now() - start >= 9900 && performance.now() - start < 12000);
    } finally { release(); await blocker; }
    console.log(JSON.stringify({ result: 'PASS', deadlineMs: Math.round(performance.now() - start), starvation: 'six queued writers return explicit timeout without entering business code; local queue removed and connection remains usable' }));
    const slowStart = performance.now();
    const slowFailure = await runMutationTransaction(async tx => {
      await tx.$queryRaw`SELECT pg_sleep(12)::text`;
      await tx.$executeRaw`INSERT INTO receipt VALUES ('expired-query', 99999)`;
    }, { lowPriorityCourseId: courseId }).catch(error => error);
    assert.ok(slowFailure instanceof CourseAdmissionTimeoutError);
    const slowMs = performance.now() - slowStart;
    assert.equal((await prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM receipt WHERE id='expired-query'`).length, 0);
    assert.ok(slowMs < 2000, 'PostgreSQL must cancel the statement at the 1s server-side timeout');
    const activeSleeps = await prisma.$queryRaw<Array<{ pid: number }>>`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query LIKE '%pg_sleep(12)%'`;
    assert.equal(activeSleeps.length, 0, 'No expired statement may remain active after the response');
    const defaults = await Promise.all(Array.from({ length: 8 }, () => prisma.$transaction(async tx => {
      const [setting] = await tx.$queryRaw<Array<{ value: string }>>`SELECT current_setting('statement_timeout') AS value`;
      await tx.$queryRaw`SELECT pg_sleep(0.02)::text`;
      return setting.value;
    })));
    assert.deepEqual(defaults, Array(8).fill('0'), 'SET LOCAL must not pollute any pooled connection');
    console.log(JSON.stringify({ result: 'PASS', slowStatementMs: Math.round(slowMs), rolledBack: true, residualActiveStatements: activeSleeps.length, pooledStatementTimeouts: defaults }));
    await prisma.$executeRaw`UPDATE "ClassroomInstance" SET status='FINISHED' WHERE id=${courseId}`;
    await assert.rejects(runMutationTransaction(tx => mutate(tx, 'closed'), { lowPriorityCourseId: courseId }), /CLASSROOM_READ_ONLY/);
    assert.equal((await prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM receipt WHERE id='closed'`).length, 0);
    console.log('PASS original row lock and post-admission classroom status check reject closed writes');
  } finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
