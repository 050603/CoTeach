import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import type { AuthClaims } from '../src/lib/auth/session';
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function main() {
  const marker = process.env.OPENPBL_VERIFICATION_MARKER;
  assert.match(marker ?? '', /^openpbl-research-check-[0-9a-f-]{36}$/);
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.username, 'postgres'); assert.equal(url.password, '');
  const db = new PrismaClient();
  globalThis.__openPblPrisma = db;
  try {
    assert.equal((await db.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification" WHERE marker = ${marker}`).length, 1);
    const student = await db.user.create({ data: { username: 's', usernameKey: 's', displayName: 's', role: 'STUDENT', passwordHash: 'test-only' } });
    const teacher = await db.user.create({ data: { username: 't', usernameKey: 't', displayName: 't', role: 'TEACHER', passwordHash: 'test-only' } });
    const offering = await db.courseOffering.create({ data: { name: 'lock probe', status: 'OPEN', teachers: { create: { userId: teacher.id } } } });
    const chapter = await db.chapter.create({ data: { offeringId: offering.id, title: 'c', position: 0 } });
    const activity = await db.activity.create({ data: { chapterId: chapter.id, title: 'a', position: 0, type: 'CLASSROOM' } });
    const template = await db.classroomTemplate.create({ data: { title: 't', ownerId: teacher.id } });
    const version = await db.classroomTemplateVersion.create({ data: { templateId: template.id, version: 1, status: 'PUBLISHED', snapshot: {} } });
    const instance = await db.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: version.id, status: 'TEACHING' } });
    const enrollment = await db.enrollment.create({ data: { userId: student.id, offeringId: offering.id } });
    const participation = await db.classroomParticipation.create({ data: { instanceId: instance.id, enrollmentId: enrollment.id } });
    const pHeld = gate(), ciHeld = gate();
    const oldSave = db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "ClassroomParticipation" WHERE id=${participation.id} FOR UPDATE`;
      pHeld.resolve(); await ciHeld.promise;
      await tx.domainEvent.create({ data: { idempotencyKey: randomUUID(), eventType: 'workspace_saved', classroomInstanceId: instance.id, participationId: participation.id, payload: {} } });
    }, { timeout: 10000 });
    const oldFinish = db.$transaction(async tx => {
      await pHeld.promise;
      await tx.$queryRaw`SELECT id FROM "ClassroomInstance" WHERE id=${instance.id} FOR UPDATE`;
      ciHeld.resolve();
      await tx.classroomParticipation.update({ where: { id: participation.id }, data: { completedAt: new Date() } });
    }, { timeout: 10000 });
    const original = await Promise.allSettled([oldSave, oldFinish]);
    const failures = original.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    assert.equal(failures.length, 1);
    console.log('Original error classification', failures.map(error => ({ name: error.name, code: error.code, meta: error.meta, message: error.message }))); 
    assert.ok(failures.some(error => error.code === 'P2034' || error.meta?.code === '40P01' || /code: \"40P01\"/.test(error.message)), 'Original lock sequence must reproduce a database deadlock');
    const { isRetryableTransactionError } = await import('../src/lib/db/transaction-retry');
    assert.ok(failures.every(error => isRetryableTransactionError(error)), 'Real PostgreSQL deadlock object must be recognized by the deployed Prisma compatibility classifier');
    console.log('PASS original p -> FK classroom / classroom -> p ordering reproduced PostgreSQL deadlock (isolated only); real error classified retryable');
    if (process.env.WORKSPACE_LOCK_REPRO_ONLY === '1') return;
    const { saveWorkspace, changeClassroomState } = await import('../src/lib/platform/classroom');
    const originalTransaction = db.$transaction.bind(db);
    let hook: (() => Promise<void>) | undefined;
    const databaseErrors: unknown[] = [];
    Object.assign(db, { $transaction: async (operation: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) => {
      try {
        return await originalTransaction(async tx => operation(new Proxy(tx, { get(target, key) {
          if (key !== '$queryRaw') return Reflect.get(target, key);
          return async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const result = await target.$queryRaw(strings, ...values);
            if (hook && strings.join('').includes('"ClassroomInstance"') && strings.join('').includes('FOR UPDATE')) {
              const selected = hook; hook = undefined; await selected();
            }
            return result;
          };
        } })), options);
      } catch (error) { databaseErrors.push(error); throw error; }
    } });
    const s = { role: 'student', sub: student.id, sv: student.sessionVersion } as AuthClaims;
    const t = { role: 'teacher', sub: teacher.id, sv: teacher.sessionVersion } as AuthClaims;
    for (const first of ['save', 'finish']) {
      await db.classroomInstance.update({ where: { id: instance.id }, data: { status: 'TEACHING' } });
      await db.classroomParticipation.update({ where: { id: participation.id }, data: { completedAt: null } });
      await db.domainEvent.deleteMany({ where: { classroomInstanceId: instance.id } });
      const workspace = await db.studentProjectWorkspace.findUnique({ where: { participationId: participation.id } });
      const held = gate(), release = gate();
      hook = async () => { held.resolve(); await release.promise; };
      const save = () => saveWorkspace(s, participation.id, { version: workspace?.version ?? 0, idempotencyKey: randomUUID(), document: 'owned document' });
      const finish = () => changeClassroomState(t, instance.id, 'finish');
      const firstPromise = first === 'save' ? save() : finish();
      await held.promise;
      const secondPromise = first === 'save' ? finish() : save();
      let secondSettled = false;
      void secondPromise.then(() => { secondSettled = true; }, () => { secondSettled = true; });
      const resultsPromise = Promise.allSettled([firstPromise, secondPromise]);
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(secondSettled, false, 'Competing operation must wait while the classroom lock is held');
      release.resolve();
      const results = await resultsPromise;
      assert.equal(results[0].status, 'fulfilled');
      if (first === 'save') assert.equal(results[1].status, 'fulfilled');
      else assert.equal(results[1].status === 'rejected' && results[1].reason.code, 'CLASSROOM_READ_ONLY');
      assert.equal(await db.domainEvent.count({ where: { classroomInstanceId: instance.id, eventType: 'workspace_saved' } }), first === 'save' ? 1 : 0);
      console.log(`PASS actual application ${first}-first: valid save-before-close or fresh closed 409; no duplicate receipt`);
    }
    assert.ok(!databaseErrors.some(error => error instanceof Error && (/40P01|deadlock detected/.test(error.message) || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034'))), 'Fixed paths must not rely on deadlock retries');
  } finally { await db.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
