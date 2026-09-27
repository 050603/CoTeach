// Only run through the disposable database runner; never against a configured deployment.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AuthClaims } from "../src/lib/auth/session";
import type { ActionEnvelope } from "../src/lib/courses/contracts";
import type { ClassroomSubmission } from "../src/lib/session/types";

async function main() {
  const marker = process.env.OPENPBL_VERIFICATION_MARKER;
  assert.match(marker ?? "", /^openpbl-research-check-[0-9a-f-]{36}$/);
  const target = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.username, "postgres"); assert.equal(target.password, ""); assert.equal(target.pathname, "/postgres"); assert.ok(target.port);
  const { prisma } = await import("../src/lib/db/client");
  let uploads: string | undefined;
  try {
    const matching = await prisma.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification" WHERE marker = ${marker}`;
    assert.equal(matching.length, 1, "Disposable database nonce is required");
    uploads = await mkdtemp(path.join(tmpdir(), "openpbl-concurrency-uploads-"));
    process.env.UPLOAD_DIR = uploads;
    process.env.JWT_SECRET = randomUUID() + randomUUID();
    delete process.env.REDIS_URL;
    const { executeCourseAction } = await import("../src/lib/courses/action-service");
    const { POST: finalize } = await import("../src/app/api/project-practice/submissions/finalize/route");
    const { signStudentToken } = await import("../src/lib/auth/session");
    const createUser = (name: string, role = "STUDENT") => prisma.user.create({ data: { username: name, usernameKey: name, displayName: name, role, passwordHash: "test-only-unusable" } });
    const teachers = await Promise.all([createUser("concurrent-teacher-1", "TEACHER"), createUser("concurrent-teacher-2", "TEACHER")]);
    const users = await Promise.all(Array.from({ length: 40 }, (_, index) => createUser(`concurrent-student-${index}`)));
    const offering = await prisma.courseOffering.create({ data: { name: "42 participant concurrency verification", status: "OPEN", teachers: { create: teachers.map(teacher => ({ userId: teacher.id })) } } });
    const chapter = await prisma.chapter.create({ data: { offeringId: offering.id, title: "Verification", position: 0, isOpen: true } });
    const activity = await prisma.activity.create({ data: { chapterId: chapter.id, title: "Concurrent practice", type: "CLASSROOM", position: 0, isOpen: true } });
    const template = await prisma.classroomTemplate.create({ data: { title: "Concurrent practice", ownerId: teachers[0].id } });
    const version = await prisma.classroomTemplateVersion.create({ data: { templateId: template.id, version: 1, status: "PUBLISHED", snapshot: { title: "Concurrent practice", design: { aiLearningClassroomId: "verification-classroom" } } } });
    const instance = await prisma.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: version.id, status: "TEACHING", runtimeConfig: { version: 1, currentStageIndex: 2 } } });
    const students = await Promise.all(users.map(async user => {
      const enrollment = await prisma.enrollment.create({ data: { userId: user.id, offeringId: offering.id } });
      const participation = await prisma.classroomParticipation.create({ data: { instanceId: instance.id, enrollmentId: enrollment.id } });
      const groupViewId = `grp-${user.id}`;
      const group = await prisma.projectGroup.create({ data: { id: `${offering.id}:${groupViewId}`, offeringId: offering.id, name: user.username } });
      await prisma.groupMember.create({ data: { groupId: group.id, userId: user.id, participationId: participation.id } });
      const token = await signStudentToken({ userId: user.id, studentName: user.displayName, sessionVersion: user.sessionVersion });
      const claims: AuthClaims = { sub: user.id, role: "student", studentName: user.displayName, sv: user.sessionVersion };
      const now = new Date().toISOString();
      const draft: ClassroomSubmission = { id: randomUUID(), courseId: instance.id, studentId: user.id, groupId: groupViewId, studentName: user.displayName, type: "document", stageKey: "make", title: user.username, content: `<p>${user.username}-initial</p>`, status: "draft", version: 1, createdAt: now, updatedAt: now };
      return { user, enrollment, participation, group, token, claims, draft };
    }));
    const saveEnvelope = (student: typeof students[number], expected: number, suffix: string): ActionEnvelope => ({ requestId: randomUUID(), action: { type: "UPSERT_SUBMISSION", payload: { courseId: instance.id, expectedSubmissionVersion: expected, submission: { ...student.draft, content: `<p>${student.user.username}-${suffix}</p>` } } } });
    const save = (student: typeof students[number], envelope: ActionEnvelope) => executeCourseAction(instance.id, envelope, student.claims);
    const finalizeRequest = (student: typeof students[number], requestId: string, expectedVersion: number) => new Request("http://localhost/api/project-practice/submissions/finalize", { method: "POST", headers: { origin: "http://localhost", cookie: `${student.token.cookieName}=${student.token.token}`, "content-type": "application/json", "x-openpbl-role": "student" }, body: JSON.stringify({ courseId: instance.id, studentId: student.user.id, submissionId: student.draft.id, stageKey: "make", expectedVersion, requestId }) });
    const summarize = (values: number[]) => { const sorted = values.toSorted((a, b) => a - b); return { count: values.length, p50Ms: Math.round(sorted[Math.ceil(sorted.length * .5) - 1]), p95Ms: Math.round(sorted[Math.ceil(sorted.length * .95) - 1]), maxMs: Math.round(sorted.at(-1)!) }; };
    await Promise.all(students.map(student => save(student, saveEnvelope(student, 0, "initial"))));
    const archiveIds = students.map(() => randomUUID());
    const receipts = await Promise.all(students.map(async (student, index) => {
      const start = performance.now();
      const result = await finalize(finalizeRequest(student, archiveIds[index], 1));
      assert.equal(result.status, 200, await result.clone().text());
      return { receipt: await result.json(), elapsed: performance.now() - start };
    }));
    const cold = summarize(receipts.map(item => item.elapsed));
    console.log(`PASS 40 simultaneous real DOCX archives with cold converter import ${JSON.stringify(cold)}`);
    // Apply the latency gate after checking all integrity behavior, so failures retain full evidence.
    const countVersions = () => prisma.artifactVersion.count({ where: { artifact: { participation: { instanceId: instance.id } } } });
    const countFiles = () => prisma.fileAsset.count({ where: { offeringId: offering.id } });
    assert.equal(await countVersions(), 40); assert.equal(await countFiles(), 40);
    await Promise.all(students.map(async (student, index) => {
      const retry = await finalize(finalizeRequest(student, archiveIds[index], 1));
      assert.equal(retry.status, 200); assert.deepEqual(await retry.json(), receipts[index].receipt);
      const wrong = await finalize(finalizeRequest(student, archiveIds[index], 2));
      assert.equal(wrong.status, 409);
    }));
    assert.equal(await countVersions(), 40);
    console.log("PASS all 40 full receipts replay identically; request ID reuse with another version fails");

    // Continue editing a submitted document, preserving immutable archive 1.
    await Promise.all(students.map(student => save(student, saveEnvelope(student, 2, "after-first-archive"))));
    const warm = await Promise.all(students.map(async student => {
      const start = performance.now(); const result = await finalize(finalizeRequest(student, randomUUID(), 3));
      assert.equal(result.status, 200, await result.clone().text());
      return performance.now() - start;
    }));
    const warmSummary = summarize(warm);
    console.log(`PASS 40 simultaneous real DOCX archives with loaded converter ${JSON.stringify(warmSummary)}`);
    await Promise.all(students.map(student => save(student, saveEnvelope(student, 4, "after-second-archive"))));
    const duplicates = await Promise.all(students.map(async student => {
      const id = randomUUID(); const start = performance.now();
      const results = await Promise.all([finalize(finalizeRequest(student, id, 5)), finalize(finalizeRequest(student, id, 5))]);
      assert.ok(results.every(result => result.status === 200), await Promise.all(results.map(result => result.clone().text())));
      assert.deepEqual(await results[0].json(), await results[1].json());
      return performance.now() - start;
    }));
    assert.equal(await countVersions(), 120); assert.equal(await countFiles(), 120);
    assert.equal((await readdir(uploads)).length, 120);
    console.log(`PASS 80 simultaneous duplicate finalizations commit exactly 40 more archives ${JSON.stringify(summarize(duplicates))}`);

    const interleaved = await Promise.all(students.map(async student => {
      const id = randomUUID(); const start = performance.now();
      const [archive, edit] = await Promise.all([finalize(finalizeRequest(student, id, 6)), save(student, saveEnvelope(student, 6, "racing-edit")).then(ack => ({ ack }), error => ({ error }))]);
      assert.ok(archive.status === 200 || archive.status === 409, await archive.clone().text());
      assert.equal(Number(archive.status === 200) + Number("ack" in edit), 1);
      if ("error" in edit) assert.equal(edit.error.code, "DRAFT_VERSION_CONFLICT");
      if (archive.status !== 200) { const retry = await finalize(finalizeRequest(student, randomUUID(), 7)); assert.equal(retry.status, 200, await retry.clone().text()); }
      return performance.now() - start;
    }));
    assert.equal(await countVersions(), 160); assert.equal(await countFiles(), 160);
    console.log(`PASS 40 archive/save races: exactly one CAS winner, later edits retained ${JSON.stringify(summarize(interleaved))}`);
    const versions = await prisma.artifactVersion.findMany({ where: { artifact: { participation: { instanceId: instance.id } } }, include: { fileAsset: true, artifact: { include: { participation: { include: { enrollment: true } } } } } });
    for (const version of versions) {
      assert.ok(version.fileAsset); assert.equal(version.fileAsset.uploadedById, version.artifact.participation.enrollment.userId);
      assert.equal(version.fileAsset.offeringId, offering.id);
      const bytes = await readFile(path.join(uploads, version.fileAsset.storageKey));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), version.sha256); assert.equal(version.fileAsset.sha256, version.sha256);
      assert.equal(BigInt(bytes.length), version.size); assert.equal(version.fileAsset.size, version.size);
      assert.equal(await prisma.domainEvent.count({ where: { classroomInstanceId: instance.id, eventType: "document_version_submitted", payload: { path: ["versionId"], equals: version.id } } }), 1);
      assert.equal(await prisma.aiInteractionEvent.count({ where: { offeringId: offering.id, eventType: "submit", payload: { path: ["detail", "versionId"], equals: version.id } } }), 1);
    }
    assert.equal((await readdir(uploads)).length, 160);
    console.log("PASS all 160 immutable archives have correct ownership, real file SHA/size and both atomic receipts");

    // A real database rejection in the final audit insert must roll back every CTE.
    const failing = students[0];
    const row = await prisma.classroomSubmission.findUniqueOrThrow({ where: { participationId_stageKey: { participationId: failing.participation.id, stageKey: "make:document" } } });
    const beforeVersion = (row.payload as { view: { version: number } }).view.version;
    await prisma.$executeRawUnsafe(`CREATE FUNCTION reject_archive_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."eventType" = 'submit' THEN RAISE EXCEPTION 'isolated archive rollback injection'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_archive_audit BEFORE INSERT ON "AiInteractionEvent" FOR EACH ROW EXECUTE FUNCTION reject_archive_audit()`);
    const failure = await finalize(finalizeRequest(failing, randomUUID(), beforeVersion));
    assert.equal(failure.status, 503);
    await prisma.$executeRawUnsafe('DROP TRIGGER reject_archive_audit ON "AiInteractionEvent"');
    const unchanged = await prisma.classroomSubmission.findUniqueOrThrow({ where: { id: row.id } });
    assert.deepEqual(unchanged, row); assert.equal(await countVersions(), 160); assert.equal(await countFiles(), 160);
    assert.equal((await readdir(uploads)).length, 160);
    console.log("PASS injected PostgreSQL audit failure rolls back artifact/file/draft/receipt and removes uncommitted bytes");
    await prisma.$executeRaw`UPDATE "ClassroomInstance" SET "runtimeConfig" = 'null'::jsonb WHERE id = ${instance.id}`;
    const nullable = await finalize(finalizeRequest(failing, randomUUID(), beforeVersion)); assert.equal(nullable.status, 200, await nullable.clone().text());
    const nullableReceipt = await nullable.json();
    const nullableInstance = await prisma.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } });
    assert.deepEqual(nullableInstance.runtimeConfig, { version: 2 });
    const nullableFile = await prisma.fileAsset.findUniqueOrThrow({ where: { id: nullableReceipt.docxUploadId } });
    assert.equal(createHash("sha256").update(await readFile(path.join(uploads, nullableFile.storageKey))).digest("hex"), nullableReceipt.sha256);
    console.log("PASS historical JSON-null runtime config upgrades safely without dropping the committed archive");
    await prisma.classroomInstance.update({ where: { id: instance.id }, data: { status: "FINISHED" } });
    const closed = await finalize(finalizeRequest(failing, randomUUID(), beforeVersion + 1)); assert.equal(closed.status, 409);
    const replay = await finalize(finalizeRequest(failing, archiveIds[0], 1)); assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), receipts[0].receipt);
    assert.equal(await countVersions(), 161); assert.equal((await readdir(uploads)).length, 161);
    console.log("PASS closed classroom rejects new archives but replays its confirmed historical receipt");
    console.log(`ARCHIVE_PERFORMANCE ${JSON.stringify({ cold, warm: warmSummary, coldPassed: cold.p95Ms <= 2000, warmPassed: warmSummary.p95Ms <= 2000, runtime: "isolated tsx, no HTTP" })}`);
    assert.ok(warmSummary.p95Ms <= 2000, `warm archive P95 exceeded 2 seconds: ${warmSummary.p95Ms}`);
    assert.ok(cold.p95Ms <= 2000, `cold archive P95 exceeded 2 seconds: ${cold.p95Ms}`);
  } finally { await prisma.$disconnect(); if (uploads) await rm(uploads, { recursive: true, force: true }); }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
