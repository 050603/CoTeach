/** Disposable PG only: verify the exact candidate SQL before enabling the experiment. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
const container = `openpbl-pipeline-proof-${randomUUID()}`;
let started = false; const clients = [];
function command(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
const source = await readFile(new URL('../src/lib/db/transaction-retry.ts', import.meta.url), 'utf8');
const fragment = source.split('await tx.$queryRaw`WITH previous AS MATERIALIZED (')[1]?.split('`;')[0];
assert.ok(fragment, 'Extract the actual production candidate SQL');
const sql = ('WITH previous AS MATERIALIZED (' + fragment)
  .replace('${String(milliseconds)}', '$1').replace('${String(milliseconds)}', '$2')
  .replace('${`v2-course:${courseId}`}', '$3');
assert.ok(!sql.includes('${'), 'Every production template parameter must be explicitly substituted');
const state = async db => {
  const [row] = await db.$queryRawUnsafe("SELECT pg_backend_pid() AS pid, current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout");
  return row;
};
try {
  command(['run', '--detach', '--rm', '--name', container, '--publish', '127.0.0.1::5432',
    '--tmpfs', '/var/lib/postgresql/data:rw', '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', 'pgvector/pgvector:0.8.6-pg16']); started = true;
  let ready = false;
  for (let index = 0; index < 60; index++) {
    if (spawnSync('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], { stdio: 'ignore', timeout: 5000 }).status === 0) { ready = true; break; }
    await delay(250);
  }
  assert.ok(ready); const address = command(['port', container, '5432/tcp']); assert.match(address, /^127\.0\.0\.1:\d+$/);
  console.log(`ISOLATED_PIPELINE_TARGET ${address}/postgres container=${container}`);
  const make = () => { const client = new PrismaClient({ datasourceUrl: `postgresql://postgres@${address}/postgres?schema=public&connection_limit=1&pool_timeout=5` }); clients.push(client); return client; };
  const observer = make(), owner = make(), candidate = make(), teacher = make(), next = make();
  await candidate.$executeRawUnsafe("SET lock_timeout = '2300ms'");
  const original = await state(candidate);
  const waitForLock = async pid => {
    const end = performance.now() + 3000;
    while (performance.now() < end) {
      const [row] = await observer.$queryRawUnsafe("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", pid);
      if (row?.wait_event_type === 'Lock') return;
      await delay(5);
    }
    throw new Error(`No actual database lock wait for pid ${pid}`);
  };
  const hold = async (db, key) => {
    const acquired = Promise.withResolvers(); const release = Promise.withResolvers();
    const task = db.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text', key);
      acquired.resolve(); await release.promise;
    }, { timeout: 15000 });
    await acquired.promise; return { release: release.resolve, task };
  };
  {
    const key = randomUUID(); const holder = await hold(owner, key);
    try {
      const start = performance.now();
      await assert.rejects(candidate.$transaction(tx => tx.$queryRawUnsafe(sql, '100', '100', key), { timeout: 3000 }), error => error.code === 'P2010' && error.meta?.code === '55P03');
      const elapsed = performance.now() - start;
      assert.ok(elapsed >= 70 && elapsed < 1500, `Actual same-statement lock timeout must cancel around 100ms, got ${elapsed}`);
      assert.deepEqual(await state(candidate), original, 'Rollback restores both LOCAL settings on the same physical backend');
      console.log(`PASS MATERIALIZED lock_timeout cancels current advisory statement in ${elapsed.toFixed(1)}ms; same-backend LOCAL reset`);
    } finally { holder.release(); await holder.task; }
    const [free] = await candidate.$queryRawUnsafe('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', key);
    assert.equal(free.acquired, true);
  }
  {
    const key = randomUUID(); const holder = await hold(owner, key);
    const pending = candidate.$transaction(async tx => {
      await tx.$queryRawUnsafe(sql, '1000', '1000', key);
      const after = await state(tx);
      assert.equal(after.lock_timeout, original.lock_timeout);
      assert.equal(after.statement_timeout, '1s');
      return after;
    }, { timeout: 3000 });
    try { await waitForLock(original.pid); holder.release(); await holder.task; await pending; }
    finally { holder.release(); await holder.task; await pending; }
    assert.deepEqual(await state(candidate), original);
    console.log('PASS successful admission restores prior lock_timeout while future business statement_timeout stays bounded; commit resets LOCAL');
  }
  {
    const key = randomUUID(); const holder = await hold(owner, key);
    const pending = candidate.$transaction(tx => tx.$queryRawUnsafe(sql, '1000', '1000', key), { timeout: 3000 }).then(value => ({ value }), error => ({ error }));
    try {
      await waitForLock(original.pid);
      await observer.$queryRawUnsafe('SELECT pg_cancel_backend($1::int)', original.pid);
      const result = await pending; assert.equal(result.error?.meta?.code, '57014');
      assert.deepEqual(await state(candidate), original);
      console.log('PASS externally cancelled candidate terminates actual PG wait and restores LOCAL settings');
    } finally { holder.release(); await holder.task; await pending; }
  }
  {
    const key = randomUUID(); const holder = await hold(owner, key);
    const teacherPid = (await state(teacher)).pid; const nextPid = (await state(next)).pid;
    const order = []; const candidateLocked = Promise.withResolvers(); const releaseCandidate = Promise.withResolvers();
    const candidateTask = candidate.$transaction(async tx => {
      await tx.$queryRawUnsafe(sql, '1000', '1000', key); order.push('candidate'); candidateLocked.resolve(); await releaseCandidate.promise;
    }, { timeout: 5000 });
    let teacherTask, nextTask;
    try {
      await waitForLock(original.pid);
      teacherTask = teacher.$transaction(async tx => { await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text', key); order.push('teacher'); }, { timeout: 5000 });
      // Prisma promises must be consumed to dispatch their actual IO.
      teacherTask = Promise.resolve(teacherTask); await waitForLock(teacherPid);
      holder.release(); await holder.task; await candidateLocked.promise;
      nextTask = next.$transaction(async tx => { await tx.$queryRawUnsafe(sql, '1000', '1000', key); order.push('next'); }, { timeout: 5000 });
      nextTask = Promise.resolve(nextTask); await waitForLock(nextPid);
      releaseCandidate.resolve(); await Promise.all([candidateTask, teacherTask, nextTask]);
      assert.deepEqual(order, ['candidate', 'teacher', 'next']);
      console.log('PASS already-queued teacher runs after the one existing candidate and before its successor in actual PG lock queue');
    } finally { holder.release(); releaseCandidate.resolve(); await Promise.allSettled([holder.task, candidateTask, teacherTask, nextTask]); }
  }
  console.log('PASS candidate SQL proof; no production database accessed and no throughput claim');
} finally {
  await Promise.allSettled(clients.map(client => client.$disconnect()));
  if (started) command(['rm', '--force', container]);
}
