// Disposable minimal PostgreSQL only; never reads deployment secrets or production data.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
const container = `openpbl-external-spi-${randomUUID()}`;
let db;
const command = args => { const r=spawnSync('docker',args,{encoding:'utf8',timeout:30000});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim(); };
try {
  command(['run','--detach','--rm','--name',container,'--publish','127.0.0.1::5432','--tmpfs','/var/lib/postgresql/data:rw','--env','POSTGRES_HOST_AUTH_METHOD=trust','pgvector/pgvector:0.8.6-pg16']);
  for(let i=0;i<60;i++){if(spawnSync('docker',['exec',container,'pg_isready','-h','127.0.0.1','-U','postgres'],{stdio:'ignore'}).status===0)break;await delay(100);}
  const port=command(['port',container,'5432/tcp']);assert.match(port,/^127\.0\.0\.1:\d+$/);
  db=new PrismaClient({datasourceUrl:`postgresql://postgres@${port}/postgres?connection_limit=6`});
  for(const sql of [
    'CREATE TABLE "ClassroomInstance" (id text PRIMARY KEY,"activityId" text,status text,"runtimeConfig" jsonb,"templateVersionId" text)',
    'CREATE TABLE "ClassroomTemplate" (id text PRIMARY KEY)',
    'CREATE TABLE "ClassroomTemplateVersion" (id text PRIMARY KEY,snapshot jsonb)',
    'CREATE TABLE "User" (id text PRIMARY KEY,status text,role text,"sessionVersion" integer)',
    'CREATE TABLE "Enrollment" (id text PRIMARY KEY,"userId" text,"offeringId" text,status text,"researchKey" text)',
    'CREATE TABLE "ClassroomParticipation" (id text PRIMARY KEY,"enrollmentId" text,"instanceId" text)',
    'CREATE TABLE "Activity" (id text PRIMARY KEY,"chapterId" text,"archivedAt" timestamp(3))',
    'CREATE TABLE "Chapter" (id text PRIMARY KEY,"offeringId" text)',
    'CREATE TABLE "CourseOffering" (id text PRIMARY KEY,status text)',
    'CREATE TABLE "ProjectGroup" (id text PRIMARY KEY,"offeringId" text,status text)',
    'CREATE TABLE "GroupMember" (id text PRIMARY KEY,"userId" text,"groupId" text,"leftAt" timestamp(3),"joinedAt" timestamp(3))',
    'CREATE TABLE "Artifact" (id text PRIMARY KEY,"participationId" text,type text)',
    'CREATE TABLE "ArtifactVersion" ("artifactId" text,sequence integer)',
    'CREATE TABLE "DomainEvent" ("idempotencyKey" text PRIMARY KEY)',
    'CREATE TABLE "ProbeReceipt" (id text PRIMARY KEY)',
    `INSERT INTO "ClassroomInstance" VALUES ('course','activity','TEACHING','{"version":1,"currentStageIndex":2,"stages":[]}','template-version')`,
    `INSERT INTO "ClassroomTemplateVersion" VALUES ('template-version','{"design":{"stages":[{"key":"template"}]}}')`,
    `INSERT INTO "User" VALUES ('student','ACTIVE','STUDENT',1)`,
    `INSERT INTO "Enrollment" VALUES ('enrollment','student','offering','ACTIVE','research')`,
    `INSERT INTO "ClassroomParticipation" VALUES ('person','enrollment','course')`,
    `INSERT INTO "Activity" VALUES ('activity','chapter',null)`,
    `INSERT INTO "Chapter" VALUES ('chapter','offering')`,
    `INSERT INTO "CourseOffering" VALUES ('offering','OPEN')`,
    `INSERT INTO "ProjectGroup" VALUES ('group','offering','ACTIVE')`,
    `INSERT INTO "GroupMember" VALUES ('member','student','group',null,'2026-09-27')`,
    `INSERT INTO "Artifact" VALUES ('artifact','person','FILE_ARCHIVE')`,
  ])await db.$executeRawUnsafe(sql);
  const source=readFileSync(new URL('../src/lib/showcase/artifact-upload.ts',import.meta.url),'utf8');
  const scope=source.match(/scopes = await tx\.\$queryRaw<ArtifactUploadScope\[\]>`(SELECT ci[\s\S]*?)`;/)[1];
  const namespace=source.match(/const readNamespaceAllowed = \(input: ArtifactUploadInput\) => Prisma.sql`([\s\S]*?)`;/)[1];
  const fallback=scope.replace('${readNamespaceAllowed(input)}',namespace).replaceAll('${input.courseId}','$1').replaceAll('${input.studentId}','$2').replaceAll('${receiptKey(input)}','$3');
  assert.ok(!fallback.includes('${'));
  const migration=readFileSync(new URL('../prisma/migrations/20260927120000_external_artifact_scope_v1/migration.sql',import.meta.url),'utf8');
  const normalize=s=>s.replaceAll('public.','').replace(/\s+/g,' ').trim();
  assert.equal(normalize(migration.split('RETURN QUERY')[1].split(';\nEND')[0]),normalize(fallback.replaceAll('$1','p_course').replaceAll('$2','p_student').replaceAll('$3','p_receipt')),'Migration scope must exactly retain application fallback');
  await db.$executeRawUnsafe(migration);
  const [identity]=await db.$queryRawUnsafe(`SELECT p.provolatile,p.prosecdef,p.proparallel,p.proconfig,l.lanname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname='public' AND p.proname='openpbl_external_artifact_scope_v1'`);
  assert.deepEqual(identity,{provolatile:'v',prosecdef:false,proparallel:'u',proconfig:['search_path=pg_catalog, public, pg_temp'],lanname:'plpgsql'});
  const values=['course','student','receipt'];
  const candidate=tx=>tx.$queryRawUnsafe('SELECT * FROM public.openpbl_external_artifact_scope_v1($1,$2,$3) /* external_scope_probe */',...values);
  const oldRead=tx=>tx.$queryRawUnsafe(fallback,...values);
  async function reset(){
    for(const sql of [`UPDATE "User" SET status='ACTIVE',role='STUDENT',"sessionVersion"=1`,`UPDATE "Enrollment" SET status='ACTIVE'`,`UPDATE "ClassroomInstance" SET status='TEACHING',"runtimeConfig"='{"version":1,"currentStageIndex":2,"stages":[]}'`,`DELETE FROM "ClassroomTemplate"`,`DELETE FROM "CourseOffering" WHERE id='course'`,`DELETE FROM "DomainEvent"`,`DELETE FROM "ArtifactVersion"`,`UPDATE "GroupMember" SET "leftAt"=null`])await db.$executeRawUnsafe(sql);
  }
  const changes=[
    ['user-status',`UPDATE "User" SET status='DISABLED'`,'userStatus','DISABLED'],
    ['user-role',`UPDATE "User" SET role='TEACHER'`,'userRole','TEACHER'],
    ['session',`UPDATE "User" SET "sessionVersion"=2`,'sessionVersion',2],
    ['enrollment',`UPDATE "Enrollment" SET status='WITHDRAWN'`,'readAllowed',false],
    ['template-namespace',`INSERT INTO "ClassroomTemplate" VALUES ('course')`,'readAllowed',false],
    ['offering-namespace',`INSERT INTO "CourseOffering" VALUES ('course','OPEN')`,'readAllowed',false],
    ['receipt',`INSERT INTO "DomainEvent" VALUES ('receipt')`,'hasReceipt',true],
    ['sequence',`INSERT INTO "ArtifactVersion" VALUES ('artifact',4)`,'sequence',5],
    ['membership',`UPDATE "GroupMember" SET "leftAt"=now()`,'groupId',null],
  ];
  async function waitBlocked(){const end=performance.now()+2000;while(performance.now()<end){const rows=await db.$queryRawUnsafe(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%external_scope_probe%'`);if(rows.length)return;await delay(5);}throw new Error('No actual row lock wait');}
  for(const [name,mutation,field,expected] of changes){
    for(const mode of ['volatile-two-spi','separate-lock-read','unsafe-cte-negative-control']){
      await reset();const before=(await oldRead(db))[0];const ready=Promise.withResolvers(),release=Promise.withResolvers();
      const writer=db.$transaction(async tx=>{await tx.$queryRawUnsafe(`SELECT id FROM "ClassroomInstance" WHERE id='course' FOR UPDATE`);ready.resolve();await release.promise;await tx.$executeRawUnsafe(mutation);},{timeout:10000});
      await ready.promise;
      const pending=db.$transaction(async tx=>{
        await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended('v2-course:course',0))::text,set_config('statement_timeout','3000',true)`);
        if(mode==='volatile-two-spi')return candidate(tx);
        if(mode==='separate-lock-read'){await tx.$queryRawUnsafe(`SELECT id FROM "ClassroomInstance" WHERE id='course' FOR UPDATE /* external_scope_probe */`);return oldRead(tx);}
        return tx.$queryRawUnsafe(`/* external_scope_probe */ WITH locked AS MATERIALIZED (SELECT id FROM "ClassroomInstance" WHERE id=$1 FOR UPDATE) SELECT s.* FROM locked CROSS JOIN LATERAL (${fallback}) s /* external_scope_probe */`,...values);
      },{timeout:5000});
      try { await waitBlocked(); } finally { release.resolve(); }
      await writer;const [actual]=await pending;
      if(mode==='unsafe-cte-negative-control')assert.deepEqual(actual[field],before[field],`${name}: negative control must retain stale statement snapshot`);
      else {assert.deepEqual(actual[field],expected,`${name}/${mode}`);assert.deepEqual(actual,(await oldRead(db))[0],'All fields must match current fallback scope');}
    }
    console.log(`PASS ${name}: function and separate statements fresh; unsafe one-statement CTE stale`);
  }
  await reset();
  for(const runtime of [null,{}, {version:'2147483648',currentStageIndex:'3'}, {version:false,currentStageIndex:0,stages:[]}, {version:'',stages:null}]){
    await db.$executeRawUnsafe(`UPDATE "ClassroomInstance" SET "runtimeConfig"=$1::jsonb`,JSON.stringify(runtime));
    const original=await oldRead(db);const actual=await db.$transaction(candidate);assert.deepEqual(actual,original);
  }
  console.log('PASS JSON null/missing/numeric-string/boolean/empty-string scope parity; JavaScript retains numeric interpretation');
  for(const kind of ['row','ddl']){
    const ready=Promise.withResolvers(),release=Promise.withResolvers();
    const holder=db.$transaction(async tx=>{await tx.$executeRawUnsafe(kind==='row'?`SELECT id FROM "ClassroomInstance" WHERE id='course' FOR UPDATE`:`LOCK TABLE "User" IN ACCESS EXCLUSIVE MODE`);ready.resolve();await release.promise;},{timeout:10000});await ready.promise;
    const started=performance.now();
    try{await assert.rejects(db.$transaction(async tx=>{await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended('v2-course:course',0))::text,set_config('statement_timeout','100',true)`);await tx.$executeRawUnsafe(`INSERT INTO "ProbeReceipt" VALUES ('rollback')`);await candidate(tx);},{timeout:5000}),e=>String(e.message).includes('57014'));assert.ok(performance.now()-started<1000);}
    finally{release.resolve();await holder;}
    assert.equal(await db.$executeRawUnsafe('DELETE FROM "ProbeReceipt"'),0);
    const [lock]=await db.$transaction(tx=>tx.$queryRawUnsafe(`SELECT pg_try_advisory_xact_lock(hashtextextended('v2-course:course',0)) AS available`));assert.equal(lock.available,true);
    console.log(`PASS ${kind} SPI native timeout rollback/advisory release (${Math.round(performance.now()-started)}ms)`);
  }
  await assert.rejects(db.$transaction(candidate,{isolationLevel:'RepeatableRead'}),e=>String(e.message).includes('EXTERNAL_ARTIFACT_SCOPE_REQUIRES_READ_COMMITTED'));
  assert.equal((await db.$queryRawUnsafe('SHOW statement_timeout'))[0].statement_timeout,'0');
  console.log('PASS exact migration identity, RepeatableRead rejection and LOCAL timeout reset; no production access');
}finally{await db?.$disconnect();spawnSync('docker',['rm','-f',container],{stdio:'ignore',timeout:10000});}
