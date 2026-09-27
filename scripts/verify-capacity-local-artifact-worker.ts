import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../src/lib/db/client';

async function main() {
  const marker = process.env.OPENPBL_VERIFICATION_MARKER ?? '';
  assert.match(marker, /^openpbl-fault-check-[0-9a-f-]{36}$/);
  assert.equal(new URL(process.env.DATABASE_URL!).hostname, '127.0.0.1');
  assert.ok(process.env.UPLOAD_DIR?.startsWith('/tmp/openpbl-fault-check-'));
  const markers = await prisma.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification"`;
  assert.equal(markers[0]?.marker, marker);
  process.env.JWT_SECRET = randomUUID() + randomUUID(); delete process.env.REDIS_URL;
  const { POST } = await import('../src/app/api/courses/[courseId]/showcase/artifacts/pdf/route');
  const { signStudentToken } = await import('../src/lib/auth/session');
  await prisma.courseOffering.update({ where: { id: 'fault-offering' }, data: { status: 'OPEN' } });
  await prisma.classroomInstance.update({ where: { id: 'fault-course' }, data: { status: 'TEACHING', runtimeConfig: { version: 1, currentStageIndex: 2,
    stages: ['launch', 'ai-learning', 'make', 'showcase', 'reflection'].map(key => ({ key })) } } });
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
    const results = await Promise.allSettled(students.map(async student => {
      const text = `${student.userId} local project round ${round}\n` + 'Sample project evidence.\n'.repeat(44_000);
      const requests = await Promise.allSettled([post(student, sharedKey, text), post(student, sharedKey, text)]);
      const pair = requests.map(result => { if (result.status === 'rejected') throw result.reason; return result.value; });
      assert.deepEqual(pair.map(value => value.status).sort(), [200, 201]);
      const [first, duplicate] = await Promise.all(pair.map(value => value.json()));
      assert.deepEqual(first, duplicate); assert.equal(first.sequence, round);
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
    console.log(`PASS round ${round}: 40 students × 2 concurrent ~1 MiB local artifacts; exactly one 201 and one 200 per student, stable retry, changed body 409, sequence ${round}, no extra files`);
  }
  const instance = await prisma.classroomInstance.findUniqueOrThrow({ where: { id: 'fault-course' } });
  assert.equal((instance.runtimeConfig as { version: number }).version, 81);
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
}
main().finally(() => prisma.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
