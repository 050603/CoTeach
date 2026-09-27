import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
  process.env.JWT_SECRET = randomUUID() + randomUUID();
  delete process.env.REDIS_URL;
  const { POST } = await import('../src/app/api/uploads/route');
  const { signStudentToken, signTeacherToken } = await import('../src/lib/auth/session');
  await prisma.courseOffering.update({ where: { id: 'fault-offering' }, data: { status: 'OPEN' } });
  await prisma.classroomInstance.update({ where: { id: 'fault-course' }, data: { status: 'TEACHING' } });
  const makeRequest = (cookie: string, key: string, text: string, bind = false, title = 'Work') => {
    const form = new FormData();
    form.set('file', new File([text], 'work.txt', { type: 'text/plain' }));
    form.set('courseId', 'fault-course'); form.set('title', title);
    if (bind) form.set('bindAsCourseResource', 'true');
    return new Request('http://localhost/api/uploads', { method: 'POST', headers: { origin: 'http://localhost', cookie,
      'Idempotency-Key': key, 'x-request-id': randomUUID() }, body: form });
  };
  const students = await Promise.all(Array.from({ length: 40 }, async (_, index) => {
    const userId = `fault-student-${index}`;
    const token = await signStudentToken({ userId, studentName: userId, sessionVersion: 1 });
    return { userId, key: randomUUID(), cookie: `${token.cookieName}=${token.token}`, text: `Student ${index} retained outcome` };
  }));
  const expected = await Promise.all(students.map(async student => {
    const responses = await Promise.all([POST(makeRequest(student.cookie, student.key, student.text)), POST(makeRequest(student.cookie, student.key, student.text))]);
    for (const response of responses) assert.equal(response.status, 201, await response.clone().text());
    const [first, duplicate] = await Promise.all(responses.map(response => response.json()));
    assert.deepEqual(duplicate, first);
    return { student, response: first };
  }));
  assert.equal(await prisma.fileAsset.count(), 40);
  assert.equal(await prisma.domainEvent.count({ where: { eventType: 'UPLOAD_RECEIPT' } }), 40);
  for (const { student, response } of expected) {
    const replay = await POST(makeRequest(student.cookie, student.key, student.text));
    assert.equal(replay.status, 201); assert.deepEqual(await replay.json(), response);
    const row = await prisma.fileAsset.findUniqueOrThrow({ where: { id: response.id } });
    assert.equal(row.uploadedById, student.userId); assert.equal(row.offeringId, 'fault-offering');
    assert.equal(await readFile(path.join(process.env.UPLOAD_DIR!, row.storageKey), 'utf8'), student.text);
    const conflict = await POST(makeRequest(student.cookie, student.key, `${student.text} changed`));
    assert.equal(conflict.status, 409);
  }
  assert.equal((await readdir(process.env.UPLOAD_DIR!)).length, 40);
  console.log('PASS 40 students / 80 concurrent authenticated multipart POSTs: exactly 40 files + receipts; 40 response-loss replays stable; 40 changed-body conflicts; no losing-attempt files remain');

  const teacher = await prisma.user.create({ data: { username: 'fault-teacher', usernameKey: 'fault-teacher', displayName: 'Teacher', passwordHash: 'unusable', role: 'TEACHER' } });
  await prisma.courseTeacher.create({ data: { userId: teacher.id, offeringId: 'fault-offering' } });
  const token = await signTeacherToken({ teacherId: teacher.id, username: teacher.username, displayName: teacher.displayName, sessionVersion: 1 });
  const cookie = `${token.cookieName}=${token.token}`;
  const key = randomUUID();
  const resources = await Promise.all(Array.from({ length: 3 }, () => POST(makeRequest(cookie, key, 'Teacher resource', true))));
  for (const response of resources) assert.equal(response.status, 201, await response.clone().text());
  const payloads = await Promise.all(resources.map(response => response.json()));
  assert.ok(payloads.every(value => value.id === payloads[0].id));
  assert.equal(await prisma.resource.count(), 1);
  assert.equal(await prisma.fileAsset.count(), 41);
  assert.equal((await POST(makeRequest(cookie, key, 'Teacher resource', true, 'Changed metadata'))).status, 409);
  const intentional = await POST(makeRequest(cookie, randomUUID(), 'Teacher resource', true));
  assert.equal(intentional.status, 201);
  assert.notEqual((await intentional.json()).id, payloads[0].id);
  assert.equal(await prisma.resource.count(), 2);
  assert.equal(await prisma.fileAsset.count(), 42);
  assert.equal((await readdir(process.env.UPLOAD_DIR!)).length, 42);
  console.log('PASS 3 concurrent teacher resource uploads: 1 asset/resource; changed metadata rejected; intentional same-content new operation creates a separate asset/resource');
}
main().finally(() => prisma.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
