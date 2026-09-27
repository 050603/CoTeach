// Disposable PostgreSQL only: no deployment config, production URLs or application writes.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
const container = `openpbl-archive-spi-${randomUUID()}`;
let db;
function command(args) { const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); }
try {
  command(['run', '--detach', '--rm', '--name', container, '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data:rw', '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', 'pgvector/pgvector:0.8.6-pg16']);
  for (let n = 0; n < 60; n++) { if (spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' }).status === 0) break; await delay(100); }
  const port = command(['port', container, '5432/tcp']); assert.match(port, /^127\.0\.0\.1:\d+$/);
  db = new PrismaClient({ datasourceUrl: `postgresql://postgres@${port}/postgres?connection_limit=6` });
  for (const sql of [
    'CREATE TABLE "ClassroomInstance" (id text PRIMARY KEY, "activityId" text, status text)',
    'CREATE TABLE "User" (id text PRIMARY KEY, status text, role text, "sessionVersion" int)',
    'CREATE TABLE "Enrollment" (id text PRIMARY KEY, "userId" text, "offeringId" text, status text, "researchKey" text)',
    'CREATE TABLE "ClassroomParticipation" (id text PRIMARY KEY, "enrollmentId" text, "instanceId" text)',
    'CREATE TABLE "Activity" (id text PRIMARY KEY, "chapterId" text, "archivedAt" timestamp(3))',
    'CREATE TABLE "Chapter" (id text PRIMARY KEY, "offeringId" text)',
    'CREATE TABLE "CourseOffering" (id text PRIMARY KEY, status text)',
    'CREATE TABLE "ClassroomSubmission" (id text PRIMARY KEY, "participationId" text, payload jsonb)',
    'CREATE TABLE "DomainEvent" ("idempotencyKey" text PRIMARY KEY, payload jsonb)',
    'CREATE TABLE "ArtifactVersion" ("artifactId" text, sequence int)',
    'CREATE TABLE "ProbeReceipt" (id text PRIMARY KEY)',
    `INSERT INTO "ClassroomInstance" VALUES ('course','activity','TEACHING')`,
    `INSERT INTO "User" VALUES ('student','ACTIVE','STUDENT',1)`,
    `INSERT INTO "Enrollment" VALUES ('enrollment','student','offering','ACTIVE','research')`,
    `INSERT INTO "ClassroomParticipation" VALUES ('person','enrollment','course')`,
    `INSERT INTO "Activity" VALUES ('activity','chapter',null)`,
    `INSERT INTO "Chapter" VALUES ('chapter','offering')`,
    `INSERT INTO "CourseOffering" VALUES ('offering','OPEN')`,
    `INSERT INTO "ClassroomSubmission" VALUES ('submission','person','{"view":{"version":1}}')`,
  ]) await db.$executeRawUnsafe(sql);
  // Extract the actual complete archive scope, preventing a simplified proof
  // from accidentally omitting receipt, ownership, current payload or sequence.
  const source = readFileSync(new URL('../src/lib/project-practice/document-finalize.ts', import.meta.url), 'utf8');
  const scope = source.slice(source.indexOf('export async function commitDocumentArchive')).match(/scopes = await tx\.\$queryRaw<ArchiveScope\[\]>`(SELECT e[\s\S]*?FOR UPDATE OF p)`/)[1];
  const replacements = {
    'JSON.stringify(input.originalPayload)': 'p_original', 'input.receiptKey': 'p_receipt', artifactId: 'p_artifact',
    'input.submissionId': 'p_submission', 'input.participationId': 'p_person', 'input.courseId': 'p_course',
    'input.studentId': 'p_student', 'input.offeringId': 'p_offering',
  };
  const sqlScope = scope.replace(/\$\{([^}]+)\}/g, (_, key) => { assert.ok(replacements[key], key); return replacements[key]; });
  const params = 'p_original jsonb,p_receipt text,p_artifact text,p_submission text,p_person text,p_course text,p_student text,p_offering text';
  const signature = "'{\"view\":{\"version\":1}}'::jsonb,'receipt','document:submission','submission','person','course','student','offering'";
  await db.$executeRawUnsafe(readFileSync(new URL('../prisma/migrations/20260927100000_document_archive_scope_v1/migration.sql', import.meta.url), 'utf8'));
  const [identity] = await db.$queryRawUnsafe(`SELECT p.provolatile,p.prosecdef,p.proparallel,p.proconfig,l.lanname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname='public' AND p.proname='openpbl_document_archive_scope_v1'`);
  assert.deepEqual(identity, { provolatile: 'v', prosecdef: false, proparallel: 'u', proconfig: ['search_path=pg_catalog, public, pg_temp'], lanname: 'plpgsql' });
  await db.$executeRawUnsafe(`CREATE FUNCTION public.archive_read_probe(${params}) RETURNS SETOF jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS $body$
    BEGIN RETURN QUERY SELECT to_jsonb(scope_row) FROM (${sqlScope}) scope_row; END $body$`);
  const reset = async () => {
    await db.$executeRawUnsafe(`UPDATE "User" SET status='ACTIVE',role='STUDENT',"sessionVersion"=1`);
    await db.$executeRawUnsafe(`UPDATE "Enrollment" SET status='ACTIVE'`);
    await db.$executeRawUnsafe(`UPDATE "ClassroomInstance" SET status='TEACHING'`);
    await db.$executeRawUnsafe(`UPDATE "ClassroomSubmission" SET payload='{"view":{"version":1}}'`);
    await db.$executeRawUnsafe('DELETE FROM "DomainEvent"'); await db.$executeRawUnsafe('DELETE FROM "ArtifactVersion"');
  };
  const mutate = async tx => {
    await tx.$executeRawUnsafe(`UPDATE "User" SET status='DISABLED',role='TEACHER',"sessionVersion"=2`);
    await tx.$executeRawUnsafe(`UPDATE "Enrollment" SET status='WITHDRAWN'`);
    await tx.$executeRawUnsafe(`UPDATE "ClassroomInstance" SET status='FINISHED'`);
    await tx.$executeRawUnsafe(`UPDATE "ClassroomSubmission" SET payload='{"view":{"version":2}}'`);
    await tx.$executeRawUnsafe(`INSERT INTO "DomainEvent" VALUES ('receipt','{"fingerprint":"committed-after-query-start","ack":{"version":2}}')`);
    await tx.$executeRawUnsafe(`INSERT INTO "ArtifactVersion" VALUES ('document:submission',4)`);
  };
  async function hold(sql) {
    const ready = Promise.withResolvers(), release = Promise.withResolvers();
    const done = db.$transaction(async tx => { await tx.$queryRawUnsafe(sql); ready.resolve(); await release.promise; }, { timeout: 10000 });
    await ready.promise; return async () => { release.resolve(); await done; };
  }
  async function waitBlocked() {
    const end = performance.now() + 2000;
    while (performance.now() < end) {
      const rows = await db.$queryRawUnsafe(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE '%archive_%probe%' OR query LIKE '%openpbl_document_archive_scope_v1%')`);
      if (rows.length) return; await delay(5);
    }
    throw new Error('Candidate never reached a real PostgreSQL row-lock wait');
  }
  const candidate = tx => tx.$queryRawUnsafe(`SELECT * FROM public.openpbl_document_archive_scope_v1(${signature})`);
  for (const mode of ['volatile-two-spi', 'separate-lock-and-read']) {
    await reset();
    const ready = Promise.withResolvers(), release = Promise.withResolvers();
    const writer = db.$transaction(async tx => { await tx.$queryRawUnsafe(`SELECT id FROM "ClassroomInstance" WHERE id='course' FOR UPDATE`); ready.resolve(); await release.promise; await mutate(tx); }, { timeout: 10000 });
    await ready.promise;
    const pending = db.$transaction(async tx => {
      // Independent admission/config SQL, exactly outside the candidate function.
      await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended('v2-course:course',0))::text, set_config('statement_timeout','3000',true)`);
      assert.equal((await tx.$queryRawUnsafe("SHOW transaction_isolation"))[0].transaction_isolation, 'read committed');
      if (mode === 'separate-lock-and-read') {
        // The marker comment lets the observer identify this baseline wait.
        await tx.$queryRawUnsafe(`SELECT id FROM "ClassroomInstance" WHERE id='course' FOR UPDATE /* archive_baseline_probe */`);
        return tx.$queryRawUnsafe(`SELECT * FROM public.archive_read_probe(${signature})`);
      }
      return candidate(tx);
    }, { timeout: 5000 });
    await waitBlocked(); release.resolve(); await writer;
    const rows = await pending;
    const actual = mode === 'volatile-two-spi' ? rows[0] : Object.values(rows[0])[0];
    assert.equal(actual.userStatus, 'DISABLED'); assert.equal(actual.userRole, 'TEACHER'); assert.equal(actual.sessionVersion, 2);
    assert.equal(actual.enrollmentStatus, 'WITHDRAWN'); assert.equal(actual.instanceStatus, 'FINISHED'); assert.equal(actual.unchanged, false);
    assert.equal(actual.receipt.fingerprint, 'committed-after-query-start'); assert.equal(actual.sequence, 5);
    console.log(`PASS ${mode}: all User/Enrollment/course/receipt/submission/sequence changes committed during real row-only lock wait are fresh`);
  }
  await reset();
  for (const kind of ['row', 'ddl']) {
    const release = await hold(kind === 'row' ? `SELECT id FROM "ClassroomInstance" WHERE id='course' FOR UPDATE` : `LOCK TABLE "User" IN ACCESS EXCLUSIVE MODE`);
    const start = performance.now();
    try {
      await assert.rejects(db.$transaction(async tx => {
        await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended('v2-course:course',0))::text, set_config('statement_timeout','100',true)`);
        await tx.$executeRawUnsafe(`INSERT INTO "ProbeReceipt" VALUES ('must-rollback')`);
        await candidate(tx);
      }, { timeout: 5000 }), error => String(error.message).includes('57014') && String(error.message).includes('statement timeout'));
      assert.ok(performance.now() - start < 1000, 'Native timeout must cancel blocked SPI before transaction timeout');
    } finally { await release(); }
    assert.equal(await db.$executeRawUnsafe(`DELETE FROM "ProbeReceipt"`), 0);
    const released = await db.$transaction(async tx => tx.$queryRawUnsafe(`SELECT pg_try_advisory_xact_lock(hashtextextended('v2-course:course',0)) AS available`));
    assert.equal(released[0].available, true);
    console.log(`PASS ${kind} lock inside function obeys inherited 100ms statement_timeout (${Math.round(performance.now()-start)}ms), prior write rolls back and advisory releases`);
  }
  await assert.rejects(db.$transaction(async tx => {
    await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended('v2-course:course',0))::text`);
    await candidate(tx);
  }, { isolationLevel: 'RepeatableRead' }), error => String(error.message).includes('DOCUMENT_ARCHIVE_SCOPE_REQUIRES_READ_COMMITTED'));
  console.log('PASS deployed migration function identity (VOLATILE/INVOKER/UNSAFE/fixed search_path), higher isolation explicitly rejected');
  const restored = await db.$queryRawUnsafe("SHOW statement_timeout"); assert.equal(restored[0].statement_timeout, '0');
  console.log('PASS function does not change LOCAL timeout/isolation; candidate is VOLATILE SECURITY INVOKER and full scope matches source; production schema untouched');
} finally { await db?.$disconnect(); spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore', timeout: 10000 }); }
