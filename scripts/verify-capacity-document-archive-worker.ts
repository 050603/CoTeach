// Only run through the disposable database runner; never against a configured deployment.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
    const engineStart = performance.now();
    const { initializeProjectDocumentArchive } = await import("../src/lib/project-practice/document-archive");
    await initializeProjectDocumentArchive();
    console.log(`ARCHIVE production startup initialization ${Math.round(performance.now() - engineStart)}ms`);
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
    const phases: Record<string, number[]> = {};
    const collectTiming = (response: Response) => { for (const item of (response.headers.get("server-timing") ?? "").split(", ")) { const [name, duration] = item.split(";dur="); if (duration) (phases[name] ??= []).push(Number(duration)); } };
    const receipts = await Promise.all(students.map(async (student, index) => {
      const start = performance.now();
      const result = await finalize(finalizeRequest(student, archiveIds[index], 1));
      assert.equal(result.status, 200, await result.clone().text());
      collectTiming(result);
      return { receipt: await result.json(), elapsed: performance.now() - start };
    }));
    const cold = summarize(receipts.map(item => item.elapsed));
    console.log(`PASS 40 simultaneous real DOCX archives after production startup initialization ${JSON.stringify(cold)}`);
    console.log("ARCHIVE cold phases", JSON.stringify(Object.fromEntries(Object.entries(phases).map(([name, values]) => [name, summarize(values)]))));
    for (const key of Object.keys(phases)) delete phases[key];
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
      collectTiming(result);
      return performance.now() - start;
    }));
    const warmSummary = summarize(warm);
    console.log(`PASS 40 simultaneous real DOCX archives with loaded converter ${JSON.stringify(warmSummary)}`);
    console.log("ARCHIVE warm phases", JSON.stringify(Object.fromEntries(Object.entries(phases).map(([name, values]) => [name, summarize(values)]))));
    await Promise.all(students.map(student => save(student, saveEnvelope(student, 4, "after-second-archive"))));
    const duplicateFirstPass = await Promise.all(students.map(async student => {
      const id = randomUUID(); const start = performance.now();
      const results = await Promise.all([finalize(finalizeRequest(student, id, 5)), finalize(finalizeRequest(student, id, 5))]);
      return { student, id, start, results };
    }));
    let busyResponses = 0;
    // 80 requests exceed the deliberate 2-running + 64-waiting converter bound.
    // Await all first responses before asserting/retrying, never disconnect while
    // other archives still commit. Preserve overload evidence and the same ID.
    const duplicates = await Promise.all(duplicateFirstPass.map(async ({ student, id, start, results }) => {
      for (let index = 0; index < results.length; index++) {
        if (results[index].status === 503) {
          assert.equal((await results[index].clone().json()).code, "DOCUMENT_CONVERSION_BUSY");
          assert.equal(results[index].headers.get("retry-after"), "1"); busyResponses++;
          results[index] = await finalize(finalizeRequest(student, id, 5));
        }
      }
      assert.ok(results.every(result => result.status === 200), await Promise.all(results.map(result => result.clone().text())));
      assert.deepEqual(await results[0].json(), await results[1].json());
      return performance.now() - start;
    }));
    console.log(`ARCHIVE bounded overload first503=${busyResponses}; explicit same-ID retries only after all first responses`);
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
    // Hold the same course advisory lock before starting the real commit helper,
    // then revoke the actor while it waits. This proves the helper uses post-lock
    // identity for new commits and raced receipts, independently of JWT preflight.
    const { tryCourseMutationAdmission } = await import("../src/lib/db/transaction-retry");
    const { commitDocumentArchive } = await import("../src/lib/project-practice/document-finalize");
    const firstReceiptKey = `document-finalize:${createHash("sha256").update(JSON.stringify([failing.participation.id, failing.user.id, archiveIds[0]])).digest("hex")}`;
    const firstReceipt = await prisma.domainEvent.findUniqueOrThrow({ where: { idempotencyKey: firstReceiptKey } });
    const stateBefore = async () => ({ draft: await prisma.classroomSubmission.findUniqueOrThrow({ where: { id: row.id } }),
      course: await prisma.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } }), files: await countFiles(), versions: await countVersions(),
      receipts: await prisma.domainEvent.count({ where: { classroomInstanceId: instance.id } }),
      audits: await prisma.aiInteractionEvent.count({ where: { offeringId: offering.id } }) });
    const [functionIdentity] = await prisma.$queryRaw<Array<{ provolatile: string; prosecdef: boolean; proparallel: string; proconfig: string[] }>>`
      SELECT provolatile::text, prosecdef, proparallel::text, proconfig FROM pg_proc
      WHERE oid = 'public.openpbl_document_archive_commit_v1(jsonb,jsonb,jsonb,jsonb)'::regprocedure`;
    assert.equal(functionIdentity.provolatile, "v"); assert.equal(functionIdentity.prosecdef, false);
    assert.equal(functionIdentity.proparallel, "u"); assert.ok(functionIdentity.proconfig.includes("search_path=pg_catalog, public, pg_temp"));
    await assert.rejects(prisma.$transaction(tx => tx.$queryRaw`SELECT * FROM public.openpbl_document_archive_commit_v1('{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`, { isolationLevel: "RepeatableRead" }), error => String(error).includes("DOCUMENT_ARCHIVE_COMMIT_REQUIRES_READ_COMMITTED"));

    // Same real rows/input, rolled back after each variant: compare the complete
    // durable result, normalizing only independently generated UUIDs and dates.
    const rollback = new Error("isolated equivalence rollback");
    const originalShapes = [row.payload, (row.payload as { view: object }).view, { view: null, legacy: "kept" }, { view: false, legacy: "kept" }, { view: [], legacy: "kept" }];
    for (const shape of originalShapes) {
      const sameInput = { courseId: instance.id, studentId: failing.user.id, participationId: failing.participation.id,
        offeringId: offering.id, sessionVersion: failing.claims.sv, submissionId: row.id, submissionViewId: failing.draft.id,
        originalPayload: shape, expectedVersion: beforeVersion, receiptKey: `equivalence:${randomUUID()}`,
        fingerprint: "same-fingerprint", requestId: randomUUID(), title: "等价/文稿", uploadId: randomUUID(),
        storageKey: "isolated-equivalence.docx", size: 123, sha256: "a".repeat(64), sourceHtml: "<p>等价保留</p>" };
      const snapshots: unknown[] = [];
      for (const admitted of [false, true]) {
        await assert.rejects(prisma.$transaction(async tx => {
          await tx.$executeRaw`UPDATE "ClassroomSubmission" SET payload = ${JSON.stringify(shape)}::jsonb WHERE id = ${row.id}`;
          await tx.$executeRaw`UPDATE "ClassroomInstance" SET "runtimeConfig" = '{"version":"2147483648","retained":{"value":true}}'::jsonb WHERE id = ${instance.id}`;
          if (admitted) await tryCourseMutationAdmission(tx, instance.id);
          const result = await commitDocumentArchive(tx, sameInput);
          const payload = result.payload as { versionId: string; submittedAt: string };
          const stored = {
            result, artifact: await tx.artifact.findUniqueOrThrow({ where: { id: `document:${row.id}` } }),
            version: await tx.artifactVersion.findUniqueOrThrow({ where: { id: payload.versionId } }),
            file: await tx.fileAsset.findUniqueOrThrow({ where: { id: sameInput.uploadId } }),
            submission: await tx.classroomSubmission.findUniqueOrThrow({ where: { id: row.id } }),
            course: await tx.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } }),
            receipt: await tx.domainEvent.findUniqueOrThrow({ where: { idempotencyKey: sameInput.receiptKey } }),
            audit: await tx.aiInteractionEvent.findUniqueOrThrow({ where: { idempotencyKey: `ai:${sameInput.receiptKey}` } }),
          };
          assert.equal(stored.version.submittedAt!.toISOString(), payload.submittedAt);
          assert.equal(stored.submission.submittedAt!.toISOString(), payload.submittedAt);
          assert.deepEqual(stored.course.runtimeConfig, { version: 2147483649, retained: { value: true } });
          assert.deepEqual(stored.receipt.payload, result.payload);
          assert.deepEqual((stored.audit.payload as { detail: unknown }).detail, result.payload);
          const normalized = JSON.stringify(stored, (_key, value) => typeof value === "bigint" ? value.toString() : value)
            .replaceAll(payload.versionId, "<version-id>").replaceAll(stored.receipt.id, "<receipt-id>").replaceAll(stored.audit.id, "<audit-id>")
            .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<timestamp>");
          snapshots.push(JSON.parse(normalized));
          throw rollback;
        }, { timeout: 15000 }), error => error === rollback);
      }
      assert.deepEqual(snapshots[1], snapshots[0], "Single-call function and safe fallback must produce equivalent full receipts, draft, artifact, file, version, event, audit and course metadata");
    }
    console.log("PASS fallback/function full durable equality for wrapped, flat, null/false/array view shapes; exact receipt/audit detail; high numeric runtime and extra keys retained");

    // Negative control: a lock and authorization in one ordinary SQL snapshot
    // really can see pre-revocation identity. The function matrix below must not.
    {
      const acquired = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
      const blocker = prisma.$transaction(async tx => { await tx.$queryRaw`SELECT id FROM "ClassroomInstance" WHERE id = ${instance.id} FOR UPDATE`; acquired.resolve(); await release.promise; }, { timeout: 15000 });
      let pending: Promise<Array<{ sessionVersion: number }>> | undefined;
      try {
        await acquired.promise;
        pending = prisma.$queryRaw<Array<{ sessionVersion: number }>>`WITH locked AS MATERIALIZED (
          SELECT id FROM "ClassroomInstance" WHERE id = ${instance.id} FOR UPDATE
        ) SELECT u."sessionVersion" FROM locked JOIN "User" u ON u.id = ${failing.user.id} /* archive_commit_negative_control */`;
        const running = Promise.resolve(pending); pending = running;
        const deadline = performance.now() + 5000; let waiting = false;
        while (performance.now() < deadline) {
          const [probe] = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%archive_commit_negative_control%'`;
          if (Number(probe.count)) { waiting = true; break; } await delay(5);
        }
        assert.ok(waiting, "Negative control must actually wait before changing identity");
        await prisma.user.update({ where: { id: failing.user.id }, data: { sessionVersion: failing.claims.sv + 1 } });
        release.resolve(); await blocker;
        assert.equal((await pending)[0].sessionVersion, failing.claims.sv, "Negative control should expose the stale outer statement snapshot");
      } finally {
        release.resolve(); await blocker; await pending;
        await prisma.user.update({ where: { id: failing.user.id }, data: { sessionVersion: failing.claims.sv } });
      }
    }
    console.log("PASS negative control confirms ordinary combined SQL can read stale identity after a row wait");
    for (const admitted of [false, true]) for (const replay of [false, true]) for (const revocation of ["DISABLED", "ROLE", "SESSION", "WITHDRAWN"]) {
      const baseline = await stateBefore();
      const acquired = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
      const blocker = prisma.$transaction(async tx => {
        if (admitted) await tx.$queryRaw`SELECT id FROM "ClassroomInstance" WHERE id = ${instance.id} FOR UPDATE`;
        else await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`v2-course:${instance.id}`}, 0))::text`;
        acquired.resolve(); await release.promise;
      }, { timeout: 15000 });
      let pending: Promise<unknown> | undefined;
      try {
        await acquired.promise;
        pending = prisma.$transaction(async tx => {
          if (admitted) await tryCourseMutationAdmission(tx, instance.id);
          return commitDocumentArchive(tx, {
          courseId: instance.id, studentId: failing.user.id, participationId: failing.participation.id, offeringId: offering.id,
          sessionVersion: failing.claims.sv, submissionId: row.id, submissionViewId: failing.draft.id, originalPayload: row.payload,
          expectedVersion: beforeVersion, receiptKey: replay ? firstReceiptKey : `isolated:${randomUUID()}`,
          fingerprint: replay ? (firstReceipt.payload as { fingerprint: string }).fingerprint : "uncommitted-test",
          requestId: randomUUID(), title: "Revocation must not commit", uploadId: randomUUID(), storageKey: "never-written.docx",
          size: 1, sha256: "unused", sourceHtml: "<p>must not commit</p>",
        }); }, { timeout: 15000 }).then(value => value, error => error);
        const deadline = performance.now() + 5000;
        let waiting = false;
        while (performance.now() < deadline) {
          const blocked = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid() AND (wait_event = 'advisory' OR query LIKE '%openpbl_document_archive_scope_v1%' OR query LIKE '%openpbl_document_archive_commit_v1%')`;
          if (Number(blocked[0].count) > 0) { waiting = true; break; }
          await delay(5);
        }
        assert.ok(waiting, "The target must reach a real PostgreSQL course-lock wait before revocation");
        if (revocation === "WITHDRAWN") await prisma.enrollment.update({ where: { id: failing.enrollment.id }, data: { status: "WITHDRAWN" } });
        else await prisma.user.update({ where: { id: failing.user.id }, data: revocation === "ROLE" ? { role: "TEACHER" } : revocation === "SESSION" ? { sessionVersion: failing.claims.sv + 1 } : { status: "DISABLED" } });
        release.resolve(); await blocker;
        const result = await pending as { code?: string; status?: number };
        assert.equal(result.code, revocation === "WITHDRAWN" ? "STUDENT_SCOPE_MISMATCH" : "UNAUTHENTICATED");
        assert.equal(result.status, revocation === "WITHDRAWN" ? 403 : 401);
        assert.deepEqual(await stateBefore(), baseline, "Rejected revocation must not change draft/course/file/version/receipt/audit");
      } finally {
        release.resolve(); await blocker; await pending;
        await prisma.user.update({ where: { id: failing.user.id }, data: { status: "ACTIVE", role: "STUDENT", sessionVersion: failing.claims.sv } });
        await prisma.enrollment.update({ where: { id: failing.enrollment.id }, data: { status: "ACTIVE" } });
      }
    }
    console.log("PASS real advisory/row-only waits in fallback/function paths then disabled/role/session/enrollment revocation rejects new commits and raced receipts; all six durable state categories unchanged");
    for (const lockKind of ["course-row", "version-table-ddl"]) {
      const baseline = await stateBefore();
      const acquired = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
      const blocker = prisma.$transaction(async tx => {
        if (lockKind === "course-row") await tx.$queryRaw`SELECT id FROM "ClassroomInstance" WHERE id = ${instance.id} FOR UPDATE`;
        else await tx.$executeRawUnsafe('LOCK TABLE "ArtifactVersion" IN ACCESS EXCLUSIVE MODE');
        acquired.resolve(); await release.promise;
      }, { timeout: 15000 });
      try {
        await acquired.promise;
        const started = performance.now();
        await assert.rejects(prisma.$transaction(async tx => {
          await tryCourseMutationAdmission(tx, instance.id);
          await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '100ms'");
          return commitDocumentArchive(tx, { courseId: instance.id, studentId: failing.user.id,
            participationId: failing.participation.id, offeringId: offering.id, sessionVersion: failing.claims.sv,
            submissionId: row.id, submissionViewId: failing.draft.id, originalPayload: row.payload,
            expectedVersion: beforeVersion, receiptKey: `timeout:${randomUUID()}`, fingerprint: "timeout",
            requestId: randomUUID(), title: "Timeout cannot commit", uploadId: randomUUID(), storageKey: "timeout.docx",
            size: 1, sha256: "a".repeat(64), sourceHtml: "<p>not committed</p>" });
        }, { timeout: 5000 }), error => String(error).includes("57014") || String(error).includes("statement timeout"));
        assert.ok(performance.now() - started < 2000, "Function must respect the existing actual database statement deadline");
      } finally { release.resolve(); await blocker; }
      assert.deepEqual(await stateBefore(), baseline, "Canceled function must leave all durable facts untouched");
      const [available] = await prisma.$transaction(async tx => {
        const result = await tx.$queryRaw<Array<{ acquired: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${`v2-course:${instance.id}`}, 0)) AS acquired`;
        await tx.$queryRaw`SELECT id FROM "ClassroomInstance" WHERE id = ${instance.id} FOR UPDATE NOWAIT`;
        return result;
      });
      assert.equal(available.acquired, true, "Canceled transaction must release advisory and row locks");
    }
    console.log("PASS single-call function honors 100ms row/DDL deadlines, rolls back every fact and releases advisory/row locks");
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
    await prisma.enrollment.update({ where: { id: failing.enrollment.id }, data: { status: "COMPLETED" } });
    for (const admitted of [false, true]) {
      const historical = await prisma.$transaction(async tx => {
        if (admitted) await tryCourseMutationAdmission(tx, instance.id);
        return commitDocumentArchive(tx, { courseId: instance.id, studentId: failing.user.id,
          participationId: failing.participation.id, offeringId: offering.id, sessionVersion: failing.claims.sv,
          submissionId: row.id, submissionViewId: failing.draft.id, originalPayload: row.payload,
          expectedVersion: beforeVersion, receiptKey: firstReceiptKey,
          fingerprint: (firstReceipt.payload as { fingerprint: string }).fingerprint,
          requestId: randomUUID(), title: "Replay keeps original", uploadId: randomUUID(), storageKey: "unused.docx",
          size: 1, sha256: "a".repeat(64), sourceHtml: "<p>must not overwrite</p>" });
      });
      assert.equal(historical.reused, true); assert.deepEqual(historical.payload, firstReceipt.payload);
    }
    console.log("PASS FINISHED classroom and COMPLETED enrollment return identical historical receipt in function and fallback without new writes");
    assert.equal(await countVersions(), 161); assert.equal((await readdir(uploads)).length, 161);
    console.log("PASS closed classroom rejects new archives but replays its confirmed historical receipt");
    console.log(`ARCHIVE_PERFORMANCE ${JSON.stringify({ cold, warm: warmSummary, coldPassed: cold.p95Ms <= 2000, warmPassed: warmSummary.p95Ms <= 2000, runtime: "isolated tsx, no HTTP" })}`);
    assert.ok(warmSummary.p95Ms <= 2000, `warm archive P95 exceeded 2 seconds: ${warmSummary.p95Ms}`);
    assert.ok(cold.p95Ms <= 2000, `first request archive P95 exceeded 2 seconds: ${cold.p95Ms}`);
  } finally { await prisma.$disconnect(); if (uploads) await rm(uploads, { recursive: true, force: true }); }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
