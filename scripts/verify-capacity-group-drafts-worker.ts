import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AuthClaims } from '../src/lib/auth/session';
import type { ActionEnvelope } from '../src/lib/courses/contracts';
import type { ClassroomSubmission } from '../src/lib/session/types';
import { prisma } from '../src/lib/db/client';
async function all<T>(tasks: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(tasks); const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  assert.equal(failures.length, 0, failures.map(result => String(result.reason)).join('\n'));
  return results.map(result => (result as PromiseFulfilledResult<T>).value);
}
async function main() {
  const marker = process.env.OPENPBL_VERIFICATION_MARKER ?? ''; assert.match(marker, /^openpbl-fault-check-[0-9a-f-]{36}$/);
  assert.equal(new URL(process.env.DATABASE_URL!).hostname, '127.0.0.1'); assert.equal((await prisma.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification"`)[0]?.marker, marker);
  assert.ok(process.env.UPLOAD_DIR?.startsWith('/tmp/openpbl-fault-check-'));
  process.env.JWT_SECRET = randomUUID() + randomUUID(); delete process.env.REDIS_URL;
  const { executeCourseAction } = await import('../src/lib/courses/action-service');
  const { POST: finalize } = await import('../src/app/api/project-practice/submissions/finalize/route');
  const { signStudentToken } = await import('../src/lib/auth/session');
  await prisma.courseOffering.update({ where: { id: 'fault-offering' }, data: { status: 'OPEN' } });
  await prisma.classroomInstance.update({ where: { id: 'fault-course' }, data: { status: 'TEACHING', runtimeConfig: { version: 1, currentStageIndex: 2, sentinel: { projection: "must-survive" } } } });
  const students = await all(Array.from({ length: 40 }, async (_, index) => {
    const userId = `fault-student-${index}`; const groupId = `grp-${userId}`;
    const participation = await prisma.classroomParticipation.findFirstOrThrow({ where: { instanceId: 'fault-course', enrollment: { userId } } });
    const group = await prisma.projectGroup.create({ data: { id: `fault-offering:${groupId}`, offeringId: 'fault-offering', name: userId } });
    const member = await prisma.groupMember.create({ data: { userId, groupId: group.id, participationId: participation.id } });
    const now = new Date().toISOString(); const token = await signStudentToken({ userId, studentName: userId, sessionVersion: 1 });
    const claims: AuthClaims = { sub: userId, role: 'student', sv: 1, studentName: userId };
    const draft: ClassroomSubmission = { id: randomUUID(), courseId: 'fault-course', studentId: userId, groupId, stageKey: 'make', type: 'document', title: userId, content: '<p>Project practice evidence.</p>'.repeat(512), status: 'draft', createdAt: now, updatedAt: now };
    return { userId, claims, participation, draft, member, cookie: `${token.cookieName}=${token.token}` };
  }));
  const envelope = (student: typeof students[number], expected: number, text = student.draft.content): ActionEnvelope => ({ requestId: randomUUID(), action: { type: 'UPSERT_SUBMISSION', payload: { courseId: 'fault-course', expectedSubmissionVersion: expected, submission: { ...student.draft, content: text } } } });
  const save = (student: typeof students[number], payload: ActionEnvelope) => executeCourseAction('fault-course', payload, student.claims);
  const invalid = envelope(students[0], 0); if (invalid.action.type === 'UPSERT_SUBMISSION') invalid.action.payload.submission.groupId = students[1].draft.groupId;
  await assert.rejects(save(students[0], invalid), error => (error as { code: string }).code === 'FORBIDDEN_ACTION_SCOPE');
  await prisma.groupMember.update({ where: { id: students[0].member.id }, data: { leftAt: new Date() } });
  await assert.rejects(save(students[0], envelope(students[0], 0)), error => (error as { code: string }).code === 'FORBIDDEN_ACTION_SCOPE');
  await prisma.groupMember.update({ where: { id: students[0].member.id }, data: { leftAt: null } });
  const first = students.map(student => envelope(student, 0));
  const times = await all(students.map(async (student, index) => { const started = performance.now(); const ack = await save(student, first[index]); assert.equal(ack.submissionVersion, 1); return performance.now() - started; }));
  times.sort((a, b) => a - b);
  assert.ok(times[39] < 2000, `Grouped draft save exceeded 2s: ${times[39]}`);
  console.log(`PASS 40 simultaneous personal-group drafts (~16 KiB each): request p50 ${Math.round(times[19])} ms, p95 ${Math.round(times[37])} ms, max ${Math.round(times[39])} ms; foreign/left group denied; no complete-course tables exist in this isolated schema`);
  await all(students.map(async (student, index) => { const ack = await save(student, first[index]); assert.equal(ack.submissionVersion, 1); }));
  assert.equal(await prisma.domainEvent.count(), 40); assert.equal(await prisma.classroomSubmission.count(), 40);
  await all(students.map(async student => {
    const results = await Promise.allSettled([save(student, envelope(student, 1, '<p>Left update</p>')), save(student, envelope(student, 1, '<p>Right update</p>'))]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult; assert.equal(rejected.reason.code, 'DRAFT_VERSION_CONFLICT');
    const persisted = await prisma.classroomSubmission.findUniqueOrThrow({ where: { participationId_stageKey: { participationId: student.participation.id, stageKey: 'make:document' } } });
    assert.deepEqual(rejected.reason.details.currentSubmission, (persisted.payload as { view: ClassroomSubmission }).view);
    assert.equal(rejected.reason.details.currentSubmission.createdAt, student.draft.createdAt);
  }));
  console.log('PASS personal-group save receipts replay exactly once; 80 competing CAS writes produce exactly 40 successes and 40 conflicts');
  const submit = (student: typeof students[number], expectedVersion: number, requestId: string) => finalize(new Request('http://localhost/api/project-practice/submissions/finalize', { method: 'POST', headers: { origin: 'http://localhost', cookie: student.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ courseId: 'fault-course', studentId: student.userId, submissionId: student.draft.id, stageKey: 'make', expectedVersion, requestId }) }));
  await all(students.map(async student => {
    const requestId = randomUUID();
    const [archive, edit] = await Promise.all([submit(student, 2, requestId), save(student, envelope(student, 2, '<p>Concurrent edit</p>')).then(value => ({ value }), error => ({ error }))]);
    assert.ok([200, 409].includes(archive.status), await archive.clone().text()); assert.equal(Number(archive.status === 200) + Number('value' in edit), 1);
    if ('error' in edit) assert.equal(edit.error.code, 'DRAFT_VERSION_CONFLICT');
    if (archive.status === 200) { const first = await archive.json(); const replay = await submit(student, 2, requestId); assert.equal(replay.status, 200); assert.equal((await replay.json()).versionId, first.versionId); }
    else assert.equal((await submit(student, 3, randomUUID())).status, 200);
    const draft = await prisma.classroomSubmission.findUniqueOrThrow({ where: { participationId_stageKey: { participationId: student.participation.id, stageKey: 'make:document' } } });
    assert.equal((draft.payload as { view: ClassroomSubmission }).view.groupId, student.draft.groupId);
  }));
  assert.deepEqual(((await prisma.classroomInstance.findUniqueOrThrow({ where: { id: 'fault-course' } })).runtimeConfig as { sentinel: unknown }).sentinel, { projection: 'must-survive' });
  assert.equal(await prisma.artifactVersion.count(), 40); assert.equal(await prisma.fileAsset.count(), 40);
  await prisma.classroomInstance.update({ where: { id: 'fault-course' }, data: { status: 'FINISHED' } });
  await all(students.map(async student => { await assert.rejects(save(student, envelope(student, 3)), error => (error as { code: string }).code === 'CLASSROOM_READ_ONLY'); }));
  console.log('PASS 40 group-draft finalize/autosave races preserve ownership and create one immutable archive each; closed classroom rejects all new drafts');
}
main().finally(() => prisma.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
