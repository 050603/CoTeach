import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient, type Prisma } from '@prisma/client';
import { setTimeout as delay } from 'node:timers/promises';

// Install the instrumented client before importing the real route. Query text
// and parameters are never logged; counts describe this isolated database only.
const prisma = new PrismaClient({ log: [{ level: 'query', emit: 'event' }] });
globalThis.__openPblPrisma = prisma;
let queryCount = 0;
prisma.$on('query', () => { queryCount++; });
const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p50Ms: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maxMs: sorted.at(-1) };
};

async function main() {
  const marker = process.env.OPENPBL_VERIFICATION_MARKER ?? '';
  assert.match(marker, /^openpbl-fault-check-[0-9a-f-]{36}$/);
  assert.equal(new URL(process.env.DATABASE_URL!).hostname, '127.0.0.1');
  assert.ok(process.env.UPLOAD_DIR?.startsWith('/tmp/openpbl-fault-check-'));
  const markers = await prisma.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification"`;
  assert.equal(markers[0]?.marker, marker);
  // The isolated harness derives tables from Prisma schema rather than running
  // migrations; install this versioned helper only after the private marker check.
  await prisma.$executeRawUnsafe(await readFile(new URL('../prisma/migrations/20260927120000_external_artifact_scope_v1/migration.sql', import.meta.url), 'utf8'));
  process.env.JWT_SECRET = randomUUID() + randomUUID(); delete process.env.REDIS_URL;
  const { POST } = await import('../src/app/api/courses/[courseId]/showcase/artifacts/pdf/route');
  const { signStudentToken } = await import('../src/lib/auth/session');
  await prisma.courseOffering.update({ where: { id: 'fault-offering' }, data: { status: 'OPEN' } });
  const initialRuntime = { version: 1, currentStageIndex: 2, stages: ['launch', 'ai-learning', 'make', 'showcase', 'reflection'].map(key => ({ key })),
    teacherResourceProjection: { title: 'retained projection', version: 19 }, nested: { arbitrary: ['retained', 4, false] } };
  await prisma.classroomInstance.update({ where: { id: 'fault-course' }, data: { status: 'TEACHING', runtimeConfig: initialRuntime } });
  const students = await Promise.all(Array.from({ length: 40 }, async (_, index) => {
    const userId = `fault-student-${index}`;
    const participation = await prisma.classroomParticipation.findFirstOrThrow({ where: { instanceId: 'fault-course', enrollment: { userId } } });
    const group = await prisma.projectGroup.create({ data: { offeringId: 'fault-offering', name: userId } });
    await prisma.groupMember.create({ data: { userId, groupId: group.id, participationId: participation.id } });
    const token = await signStudentToken({ userId, studentName: userId, sessionVersion: 1 });
    return { userId, participationId: participation.id, cookie: `${token.cookieName}=${token.token}` };
  }));
  const post = (student: typeof students[number], key: string, text: string, title = 'Local project') => {
    const body = new FormData(); body.set('file', new File([text], 'project.txt', { type: 'text/plain' })); body.set('title', title); body.set('requestId', key);
    return POST(new Request('http://localhost/api/courses/fault-course/showcase/artifacts/pdf', { method: 'POST', headers: {
      origin: 'http://localhost', cookie: student.cookie, 'Idempotency-Key': key, 'x-request-id': randomUUID(),
    }, body }), { params: Promise.resolve({ courseId: 'fault-course' }) });
  };
  const evidence: Array<{ student: typeof students[number]; key: string; text: string; versionId: string; uploadId: string }> = [];
  for (let round = 1; round <= 2; round += 1) {
    const sharedKey = randomUUID(); // Scope must include the student, not just request ID.
    const copies = process.env.OPENPBL_ARTIFACT_PERFORMANCE_ONLY === '1' ? 1 : 2;
    queryCount = 0;
    const burst = await Promise.all(students.map(async student => {
      const text = `${student.userId} local project round ${round}\n` + 'Sample project evidence.\n'.repeat(44_000);
      const pair = await Promise.all(Array.from({ length: copies }, async () => {
        const started = performance.now();
        const response = await post(student, sharedKey, text);
        return { response, milliseconds: performance.now() - started };
      }));
      return { student, text, pair };
    }));
    await new Promise(resolve => setTimeout(resolve, 50)); // Flush Prisma query events before the audit reads.
    console.log(`MEASURE ${JSON.stringify({ round, concurrentRequests: copies * students.length, queryCount,
      created: summary(burst.flatMap(result => result.pair.filter(value => value.response.status === 201).map(value => value.milliseconds))),
      replays: copies === 1 ? undefined : summary(burst.flatMap(result => result.pair.filter(value => value.response.status === 200).map(value => value.milliseconds))) })}`);
    const results = await Promise.allSettled(burst.map(async ({ student, text, pair: measured }) => {
      const pair = measured.map(value => value.response);
      assert.deepEqual(pair.map(value => value.status).sort(), copies === 1 ? [201] : [200, 201]);
      const [first, duplicate] = await Promise.all(pair.map(value => value.json()));
      if (copies === 2) assert.deepEqual(first, duplicate);
      assert.equal(first.sequence, round);
      const retry = await post(student, sharedKey, text);
      assert.equal(retry.status, 200); assert.deepEqual(await retry.json(), first);
      assert.equal((await post(student, sharedKey, `${text} changed`)).status, 409);
      const asset = await prisma.fileAsset.findUniqueOrThrow({ where: { id: first.uploadId } });
      assert.equal(asset.uploadedById, student.userId); assert.equal(asset.offeringId, 'fault-offering');
      const bytes = await readFile(path.join(process.env.UPLOAD_DIR!, asset.storageKey));
      assert.equal(bytes.toString(), text); assert.equal(asset.sha256, createHash('sha256').update(bytes).digest('hex'));
      const receipt = await prisma.domainEvent.findUniqueOrThrow({ where: { idempotencyKey: `file-artifact:fault-course:${student.userId}:${sharedKey}` } });
      assert.equal(receipt.participationId, student.participationId); assert.ok(receipt.researchKey);
      evidence.push({ student, key: sharedKey, text, versionId: first.versionId, uploadId: first.uploadId });
    }));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.equal(failures.length, 0, failures.map(result => String(result.reason)).join('\n'));
    assert.equal(await prisma.artifactVersion.count(), round * 40);
    assert.equal(await prisma.fileAsset.count(), round * 40);
    assert.equal(await prisma.domainEvent.count({ where: { eventType: 'file_artifact_submitted' } }), round * 40);
    assert.equal((await readdir(process.env.UPLOAD_DIR!)).length, round * 40);
    console.log(`PASS round ${round}: 40 students × ${copies} concurrent ~1 MiB local artifacts; one 201 per student${copies === 2 ? ' and one 200' : ''}, stable retry, changed body 409, sequence ${round}, no extra files`);
  }
  const instance = await prisma.classroomInstance.findUniqueOrThrow({ where: { id: 'fault-course' } });
  assert.equal((instance.runtimeConfig as { version: number }).version, 81);
  assert.deepEqual(instance.runtimeConfig, { ...initialRuntime, version: 81 });
  const original = evidence[0];
  const idempotencyKey = `file-artifact:fault-course:${original.student.userId}:${original.key}`;
  const receipt = await prisma.domainEvent.findUniqueOrThrow({ where: { idempotencyKey } });
  const detail = { ...(receipt.payload as Record<string, unknown>) }; delete detail.fingerprint;
  await prisma.domainEvent.update({ where: { id: receipt.id }, data: { payload: JSON.parse(JSON.stringify(detail)) } });
  assert.equal((await post(original.student, original.key, original.text)).status, 200);
  assert.equal((await post(original.student, original.key, original.text, 'Changed title')).status, 409);
  await prisma.classroomInstance.update({ where: { id: 'fault-course' }, data: { status: 'FINISHED' } });
  assert.equal((await post(original.student, original.key, original.text)).status, 200);
  assert.equal((await post(original.student, randomUUID(), original.text)).status, 409);
  assert.equal(await prisma.artifactVersion.count(), 80);
  assert.equal((await readdir(process.env.UPLOAD_DIR!)).length, 80);
  console.log('PASS historical receipt without fingerprint: same bytes verified and replayed, changed title rejected; closed classroom replays accepted version but rejects new upload; course version increments exactly once per new artifact');

  const { persistArtifactUpload, canReadArtifactCourse, readArtifactUploadReceipt } = await import('../src/lib/showcase/artifact-upload');
  const { canAccessLegacyCourse } = await import('../src/lib/platform/access');
  const claims = { sub: original.student.userId, role: 'student' as const, studentName: original.student.userId, sv: 1 };
  const parity = async (courseId: string, allowed: boolean) => {
    assert.equal(await canReadArtifactCourse(claims.sub, courseId), allowed);
    assert.equal(await canAccessLegacyCourse(claims, courseId, 'read'), allowed);
  };
  const enrollment = await prisma.enrollment.findFirstOrThrow({ where: { userId: original.student.userId, offeringId: 'fault-offering' } });
  for (const status of ['ACTIVE', 'active', 'COMPLETED', 'completed', 'WITHDRAWN', 'Active']) {
    await prisma.enrollment.update({ where: { id: enrollment.id }, data: { status } });
    await parity('fault-course', ['ACTIVE', 'active', 'COMPLETED', 'completed'].includes(status));
  }
  await prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: 'ACTIVE' } });
  await parity('fault-offering', true); await parity('missing-course', false);
  for (const data of [{ status: 'DISABLED', role: 'STUDENT' }, { status: 'Active', role: 'Student' }, { status: 'ACTIVE', role: 'TEACHER' }]) {
    await prisma.user.update({ where: { id: claims.sub }, data });
    await parity('fault-course', data.role === 'Student');
  }
  await prisma.user.update({ where: { id: claims.sub }, data: { status: 'ACTIVE', role: 'STUDENT' } });
  // IDs from the template/offering namespaces have precedence in the original
  // guard, even if a historical/manual seed reused an instance ID.
  await prisma.courseOffering.create({ data: { id: 'fault-course', name: 'Namespace collision' } });
  await parity('fault-course', false);
  const collisionEnrollment = await prisma.enrollment.create({ data: { userId: claims.sub, offeringId: 'fault-course' } });
  await parity('fault-course', true);
  await prisma.classroomTemplate.create({ data: { id: 'fault-course', title: 'Template precedence', ownerId: claims.sub } });
  await parity('fault-course', false);
  await prisma.classroomTemplate.delete({ where: { id: 'fault-course' } });
  await prisma.enrollment.delete({ where: { id: collisionEnrollment.id } });
  await prisma.courseOffering.delete({ where: { id: 'fault-course' } });
  console.log('PASS narrow read authorization equals legacy guard for closed classes, completed/mixed-case/revoked membership, inactive/wrong-role users, missing IDs and template/offering namespace precedence');

  const directInput = () => ({ courseId: 'fault-course', studentId: original.student.userId, sessionVersion: 1, requestId: randomUUID(), title: 'Scope regression',
    originalName: 'scope.txt', mimeType: 'text/plain', size: 3, sha256: createHash('sha256').update('abc').digest('hex'), kind: 'file' as 'file' | 'pdf',
    uploadId: randomUUID(), versionId: randomUUID(), storageKey: `${randomUUID()}.txt` });
  await prisma.classroomInstance.update({ where: { id: 'fault-course' }, data: { status: 'TEACHING' } });
  const noWrite = async (expectedCode: string) => {
    await assert.rejects(() => persistArtifactUpload(directInput()), (error: { code: string }) => error.code === expectedCode);
  };
  await assert.rejects(() => persistArtifactUpload({ ...directInput(), studentId: 'not-enrolled' }), (error: { code: string }) => error.code === 'FORBIDDEN');
  await prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: 'COMPLETED' } });
  await noWrite('STUDENT_NOT_FOUND');
  await prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: 'ACTIVE' } });
  await prisma.courseOffering.update({ where: { id: 'fault-offering' }, data: { status: 'CLOSED' } });
  await noWrite('ARTIFACT_SUBMISSION_INACTIVE');
  await prisma.courseOffering.update({ where: { id: 'fault-offering' }, data: { status: 'OPEN' } });
  await prisma.activity.update({ where: { id: instance.activityId }, data: { archivedAt: new Date() } });
  await noWrite('ARTIFACT_SUBMISSION_INACTIVE');
  await prisma.activity.update({ where: { id: instance.activityId }, data: { archivedAt: null } });
  const membership = await prisma.groupMember.findFirstOrThrow({ where: { userId: original.student.userId } });
  const foreignOffering = await prisma.courseOffering.create({ data: { name: `${marker}-foreign` } });
  await prisma.enrollment.update({ where: { id: enrollment.id }, data: { offeringId: foreignOffering.id } });
  await parity('fault-course', false); await noWrite('FORBIDDEN');
  await prisma.enrollment.update({ where: { id: enrollment.id }, data: { offeringId: 'fault-offering' } });
  const foreignGroup = await prisma.projectGroup.create({ data: { offeringId: foreignOffering.id, name: 'foreign' } });
  await prisma.groupMember.create({ data: { groupId: foreignGroup.id, userId: original.student.userId, joinedAt: new Date(Date.now() + 60_000) } });
  await prisma.groupMember.update({ where: { id: membership.id }, data: { leftAt: new Date() } });
  await noWrite('GROUP_NOT_FOUND'); // A membership in another offering cannot authorize this upload.
  await prisma.groupMember.update({ where: { id: membership.id }, data: { leftAt: null } });
  await prisma.projectGroup.update({ where: { id: membership.groupId }, data: { status: 'ARCHIVED' } });
  await noWrite('GROUP_NOT_FOUND');
  await prisma.projectGroup.update({ where: { id: membership.groupId }, data: { status: 'ACTIVE' } });
  console.log('PASS missing/revoked enrollment, closed offering, archived activity, departed/inactive/wrong-offering group reject before writes');

  // Force the final audit INSERT to fail, after the dependent file, artifact,
  // version and course updates. PostgreSQL must roll all of them back.
  await prisma.$executeRaw`ALTER TABLE "DomainEvent" ADD CONSTRAINT "_OpenpblArtifactAuditFailure"
    CHECK (payload->>'requestId' <> 'injected-artifact-audit-failure')`;
  await assert.rejects(() => persistArtifactUpload({ ...directInput(), requestId: 'injected-artifact-audit-failure' }),
    (error: Error) => error.message.includes('_OpenpblArtifactAuditFailure'));
  await prisma.$executeRaw`ALTER TABLE "DomainEvent" DROP CONSTRAINT "_OpenpblArtifactAuditFailure"`;
  assert.equal(await prisma.fileAsset.count(), 80);
  assert.equal(await prisma.artifact.count(), 80);
  assert.equal(await prisma.artifactVersion.count(), 80);
  assert.equal(await prisma.domainEvent.count({ where: { eventType: 'file_artifact_submitted' } }), 80);
  assert.equal(((await prisma.classroomInstance.findUniqueOrThrow({ where: { id: 'fault-course' } })).runtimeConfig as { version: number }).version, 81);
  console.log('PASS injected final audit constraint failure rolls back asset, artifact, version, course version and receipt atomically');

  // The newest active membership wins; equal joinedAt uses the original id ASC
  // tie-breaker, and a newer membership from another offering remains ignored.
  const joinedAt = new Date(Date.now() + 30_000);
  const groupIds = await Promise.all(['a', 'b'].map(async suffix => {
    const group = await prisma.projectGroup.create({ data: { offeringId: 'fault-offering', name: suffix } });
    await prisma.groupMember.create({ data: { id: `${suffix}-${randomUUID()}`, groupId: group.id, userId: original.student.userId,
      participationId: original.student.participationId, joinedAt } });
    return group.id;
  }));
  const document = await prisma.artifact.create({ data: { participationId: original.student.participationId, title: 'Independent document sequence', type: 'DOCUMENT_ARCHIVE' } });
  await prisma.artifactVersion.create({ data: { artifactId: document.id, sequence: 99 } });
  const inputs = [directInput(), { ...directInput(), kind: 'pdf' as const, mimeType: 'application/pdf', originalName: 'scope.pdf' }];
  await Promise.all(inputs.map(input => writeFile(path.join(process.env.UPLOAD_DIR!, input.storageKey), 'abc', { flag: 'wx' })));
  const mixed = await Promise.all(inputs.map(input => persistArtifactUpload(input)));
  assert.deepEqual(mixed.map(result => result.response.sequence).sort(), [3, 4]);
  assert.deepEqual(new Set(mixed.map(result => result.response.kind)), new Set(['file', 'pdf']));
  for (const input of inputs) {
    const version = await prisma.artifactVersion.findUniqueOrThrow({ where: { id: input.versionId }, include: { artifact: true, fileAsset: true } });
    assert.equal(version.artifact.groupId, groupIds[0]);
    assert.equal(version.artifact.participationId, original.student.participationId);
    assert.ok(version.fileAsset);
    assert.equal(version.fileAsset.assetRole, 'SOURCE'); assert.equal(version.fileAsset.backupPolicy, 'REQUIRED');
    assert.equal(version.fileAsset.sha256, createHash('sha256').update(await readFile(path.join(process.env.UPLOAD_DIR!, input.storageKey))).digest('hex'));
  }
  assert.equal(((await prisma.classroomInstance.findUniqueOrThrow({ where: { id: 'fault-course' } })).runtimeConfig as { version: number }).version, 83);
  console.log('PASS same-student concurrent PDF/FILE share monotonic sequence, exclude DOCUMENT_ARCHIVE, preserve newest-group tie-break/ownership and required source-file backup policy');

  const replayInput = () => ({ ...directInput(), requestId: original.key, title: 'Local project', originalName: 'project.txt',
    size: Buffer.byteLength(original.text), sha256: createHash('sha256').update(original.text).digest('hex') });
  const durableState = async () => ({ assets: await prisma.fileAsset.count(), artifacts: await prisma.artifact.count(),
    versions: await prisma.artifactVersion.count(), events: await prisma.domainEvent.count(),
    runtime: (await prisma.classroomInstance.findUniqueOrThrow({ where: { id: 'fault-course' } })).runtimeConfig });
  const baseline = await durableState();
  assert.deepEqual(baseline.runtime, { ...initialRuntime, version: 83 });
  const restoreAuthorization = async () => {
    await prisma.user.update({ where: { id: original.student.userId }, data: { role: 'STUDENT', status: 'ACTIVE', sessionVersion: 1 } });
    await prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: 'ACTIVE' } });
  };
  // A separate row-only transaction commits the authorization change only once
  // PostgreSQL confirms the upload statement is blocked on its course row.
  // No sleeps masquerade as evidence that the competing query reached the lock.
  const whileCourseRowBlocked = async <T,>(change: (tx: Prisma.TransactionClient) => Promise<unknown>, operation: () => Promise<T>) => {
    let release!: () => void; let locked!: (pid: number) => void;
    const proceed = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<number>(resolve => { locked = resolve; });
    const writer = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "ClassroomInstance" WHERE id = 'fault-course' FOR UPDATE`;
      const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      locked(backend.pid);
      await proceed;
      await change(tx);
    }, { timeout: 5_000 });
    const pid = await Promise.race([ready, writer.then(() => { throw new Error('Row holder ended before readiness'); })]);
    const work = operation().then(value => ({ value }), error => ({ error }));
    let blocked = false;
    try {
      const deadline = performance.now() + 700;
      while (performance.now() < deadline) {
        const [state] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity a WHERE ${pid} = ANY(pg_blocking_pids(a.pid))
        ) AS blocked`;
        if (state.blocked) { blocked = true; break; }
        await delay(5);
      }
    } finally { release(); }
    await writer;
    const result = await work;
    assert.ok(blocked, 'Competing statement must actually wait for the row-only writer');
    return result;
  };
  // Independent reproduction of the rejected single-statement approach: the
  // materialized row lock does not refresh other relations' MVCC snapshot.
  const oldSnapshot = await whileCourseRowBlocked(
    tx => tx.user.update({ where: { id: original.student.userId }, data: { sessionVersion: 2 } }),
    () => prisma.$queryRaw<Array<{ sessionVersion: number }>>`WITH locked AS MATERIALIZED (
      SELECT id FROM "ClassroomInstance" WHERE id = 'fault-course' FOR UPDATE
    ) SELECT u."sessionVersion" FROM locked JOIN "User" u ON u.id = ${original.student.userId}`,
  );
  assert.ok('value' in oldSnapshot);
  assert.equal(oldSnapshot.value![0].sessionVersion, 1);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: original.student.userId } })).sessionVersion, 2);
  await restoreAuthorization();
  console.log('PASS negative control: MATERIALIZED row-lock CTE observed stale sessionVersion=1 after row holder committed version=2');

  const revocations: Array<{ name: string; apply: (tx: Prisma.TransactionClient) => Promise<unknown> }> = [
    { name: 'disabled user', apply: tx => tx.user.update({ where: { id: original.student.userId }, data: { status: 'DISABLED' } }) },
    { name: 'changed role', apply: tx => tx.user.update({ where: { id: original.student.userId }, data: { role: 'TEACHER' } }) },
    { name: 'revoked session', apply: tx => tx.user.update({ where: { id: original.student.userId }, data: { sessionVersion: 2 } }) },
    { name: 'withdrawn enrollment', apply: tx => tx.enrollment.update({ where: { id: enrollment.id }, data: { status: 'WITHDRAWN' } }) },
  ];
  for (const revocation of revocations) {
    for (const existing of [false, true]) {
      const result = await whileCourseRowBlocked(revocation.apply, () => persistArtifactUpload(existing ? replayInput() : directInput()));
      assert.ok('error' in result, `${revocation.name} must reject ${existing ? 'existing receipt' : 'new upload'}`);
      assert.equal(result.error.code, 'FORBIDDEN');
      await assert.rejects(readArtifactUploadReceipt(replayInput()), { code: 'FORBIDDEN' });
      await restoreAuthorization();
      assert.deepEqual(await durableState(), baseline, 'Authorization rejection must leave every durable fact and runtime key unchanged');
    }
  }
  for (const existing of [false, true]) {
    const result = await whileCourseRowBlocked(
      tx => tx.enrollment.update({ where: { id: enrollment.id }, data: { status: 'COMPLETED' } }),
      () => persistArtifactUpload(existing ? replayInput() : directInput()),
    );
    if (existing) { assert.ok('value' in result); assert.equal(result.value!.duplicate, true); assert.equal(result.value!.response.versionId, original.versionId); }
    else { assert.ok('error' in result); assert.equal(result.error.code, 'STUDENT_NOT_FOUND'); }
    assert.equal((await readArtifactUploadReceipt(replayInput()))?.versionId, original.versionId);
    await restoreAuthorization();
    assert.deepEqual(await durableState(), baseline);
  }
  for (const existing of [false, true]) {
    const result = await whileCourseRowBlocked(
      tx => tx.classroomTemplate.create({ data: { id: 'fault-course', title: 'Namespace revoked while waiting', ownerId: original.student.userId } }),
      () => persistArtifactUpload(existing ? replayInput() : directInput()),
    );
    assert.ok('error' in result); assert.equal(result.error.code, 'FORBIDDEN');
    await assert.rejects(readArtifactUploadReceipt(replayInput()), { code: 'FORBIDDEN' });
    await prisma.classroomTemplate.delete({ where: { id: 'fault-course' } });
    assert.deepEqual(await durableState(), baseline);
  }
  console.log('PASS real blocked-row matrix: disabled user/changed role/revoked session/withdrawn enrollment reject new and existing requests; fast receipts reauthorize; COMPLETED remains replayable; zero new files, versions, events or runtime changes');
  console.log('PASS namespace permission changes during row-lock wait reject both new submissions and receipt replay');
}
main().finally(() => prisma.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
