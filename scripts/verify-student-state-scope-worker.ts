import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { StudentClaims } from "../src/lib/auth/session";

async function main() {
  const marker = process.env.OPENPBL_VERIFICATION_MARKER;
  assert.match(marker ?? "", /^openpbl-research-check-[0-9a-f-]{36}$/);
  const target = new URL(process.env.DATABASE_URL!);
  assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.username, "postgres"); assert.equal(target.password, ""); assert.equal(target.pathname, "/postgres");
  const { prisma: db } = await import("../src/lib/db/client");
  try {
    assert.equal((await db.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification" WHERE marker = ${marker}`).length, 1);
    const { loadCourse } = await import("../src/lib/db/session-repository");
    const { loadAiLearningTiming } = await import("../src/lib/db/ai-learning-timing");
    const { scopeCourseForClaims } = await import("../src/lib/auth/course-scope");
    const { resolveStudentStateScope } = await import("../src/lib/courses/student-state-scope");
    const { canAccessLegacyCourse } = await import("../src/lib/platform/access");
    const createUser = (username: string, role: string) => db.user.create({ data: { username, usernameKey: username, displayName: username, role, passwordHash: "test-only" } });
    const teachers = await Promise.all([0, 1].map(i => createUser(`teacher-${i}`, "TEACHER")));
    const users = await Promise.all(Array.from({ length: 40 }, (_, i) => createUser(`student-${i}`, "STUDENT")));
    const offering = await db.courseOffering.create({ data: { name: "Scoped read verification", status: "OPEN", teachers: { create: teachers.map(t => ({ userId: t.id })) } } });
    const chapter = await db.chapter.create({ data: { offeringId: offering.id, title: "Chapter", position: 0 } });
    const activity = await db.activity.create({ data: { chapterId: chapter.id, title: "Classroom", position: 0, type: "CLASSROOM" } });
    const template = await db.classroomTemplate.create({ data: { title: "Classroom", ownerId: teachers[0].id } });
    const version = await db.classroomTemplateVersion.create({ data: { templateId: template.id, version: 1, status: "PUBLISHED", snapshot: { title: "Classroom" } } });
    const instance = await db.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: version.id, status: "TEACHING" } });
    const sharedGroup = await db.projectGroup.create({ data: { id: `${offering.id}:grp-shared`, offeringId: offering.id, name: "Shared" } });
    const now = new Date().toISOString();
    const longText = "measured evidence ".repeat(5000);
    const students = await Promise.all(users.map(async (user, index) => {
      const enrollment = await db.enrollment.create({ data: { userId: user.id, offeringId: offering.id } });
      const participation = await db.classroomParticipation.create({ data: { instanceId: instance.id, enrollmentId: enrollment.id } });
      const group = index < 2 ? sharedGroup : await db.projectGroup.create({ data: { id: `${offering.id}:grp-${index}`, offeringId: offering.id, name: `Group${index}` } });
      await db.groupMember.create({ data: { groupId: group.id, userId: user.id, participationId: participation.id } });
      const groupId = index < 2 ? "grp-shared" : `grp-${index}`;
      const submission = { id: `submission-${index}`, courseId: instance.id, studentId: user.id, groupId, stageKey: "make", type: "document", title: `Document${index}`, content: longText, createdAt: now, updatedAt: now };
      await db.classroomSubmission.create({ data: { participationId: participation.id, stageKey: "make", payload: { collection: "submissions", view: submission } } });
      await db.studentProjectWorkspace.create({ data: { participationId: participation.id, projectState: { aiLearningProgress: { currentSceneIndex: index, completedScenes: [], totalScenes: 40 }, scratch: longText } } });
      const artifact = await db.artifact.create({ data: { participationId: participation.id, groupId: group.id, type: "DOCUMENT_ARCHIVE", title: `Archive${index}` } });
      const archive = await db.artifactVersion.create({ data: { artifactId: artifact.id, sequence: 1, sourceHtml: longText, status: "SUBMITTED" } });
      await db.showcasePresentation.create({ data: { participationId: participation.id, artifactId: artifact.id, artifactVersionId: archive.id, groupId: group.id, status: index === 2 ? "ACTIVE" : "PENDING", content: { artifactKind: "document", artifactTitle: "Archive" } } });
      const conversation = await db.aiConversation.create({ data: { userId: user.id, participationId: participation.id, offeringId: offering.id, metadata: { legacyStageKey: "make" }, messages: { create: { role: "assistant", content: longText } } } });
      await db.aiTask.create({ data: { createdById: user.id, conversationId: conversation.id, offeringId: offering.id, taskType: "conversation", input: { legacy: { stageKey: "make" } } } });
      await db.aiActionConfirmation.create({ data: { requestedById: user.id, offeringId: offering.id, actionType: "save", payload: { legacy: { instanceId: instance.id, stageKey: "make" } } } });
      await db.aiSupportRecord.create({ data: { createdById: user.id, participationId: participation.id, offeringId: offering.id, type: "COMPANION_PROCESS", summary: longText, structuredPayload: { stageKey: "make" } } });
      return { user, enrollment, participation, groupId };
    }));
    const evidence = { id: "public-evidence", studentId: users[3].id, content: "course evidence" };
    await db.classroomSubmission.create({ data: { participationId: students[3].participation.id, stageKey: "evidence:test", payload: { collection: "learningEvidence", view: evidence } } });
    const events: Prisma.LearningEventCreateManyInput[] = [];
    for (const [index, student] of students.entries()) for (let eventIndex = 0; eventIndex < 350; eventIndex++) {
      const id = randomUUID(); const occurredAt = new Date(1790000000000 + eventIndex * 10000 + index);
      events.push({ id, idempotencyKey: id, userId: student.user.id, enrollmentId: student.enrollment.id, researchKey: student.enrollment.researchKey, offeringId: offering.id, classroomInstanceId: instance.id, participationId: student.participation.id, eventType: "heartbeat", durationMs: 10000, occurredAt, receivedAt: occurredAt,
        metadata: { legacy: { id, studentId: student.user.id, courseId: instance.id, stageKey: "ai-learning", eventType: "heartbeat", durationMs: 10000, visible: true, createdAt: occurredAt.toISOString() } } });
    }
    for (let index = 0; index < events.length; index += 1000) await db.learningEvent.createMany({ data: events.slice(index, index + 1000) });
    const accessClaims = { role: "student", sub: users[0].id } as StudentClaims;
    const checkAccess = async (expected: boolean) => {
      assert.equal((await resolveStudentStateScope(db, instance.id, users[0].id))?.accessible, expected);
      assert.equal(await canAccessLegacyCourse(accessClaims, instance.id, "read", db), expected);
    };
    await checkAccess(true);
    await db.enrollment.update({ where: { id: students[0].enrollment.id }, data: { status: "COMPLETED" } });
    await db.classroomInstance.update({ where: { id: instance.id }, data: { status: "FINISHED" } });
    await checkAccess(true);
    await db.enrollment.update({ where: { id: students[0].enrollment.id }, data: { status: "WITHDRAWN" } });
    await checkAccess(false);
    await db.enrollment.update({ where: { id: students[0].enrollment.id }, data: { status: "ACTIVE" } });
    await db.user.update({ where: { id: users[0].id }, data: { status: "DISABLED" } });
    await checkAccess(false);
    await db.user.update({ where: { id: users[0].id }, data: { status: "ACTIVE" } });
    await db.classroomInstance.update({ where: { id: instance.id }, data: { status: "TEACHING" } });
    assert.equal((await resolveStudentStateScope(db, instance.id, teachers[0].id))?.accessible, false);
    assert.equal(await resolveStudentStateScope(db, template.id, users[0].id), null);
    assert.equal(await resolveStudentStateScope(db, offering.id, users[0].id), null);
    const timingQueries: Array<{ sql: string; studentIds: string[] }> = [];
    const scopedDb = new Proxy(db, { get(target, property) {
      if (property !== "$queryRaw") return Reflect.get(target, property);
      return (...args: unknown[]) => {
        const sql = Array.isArray(args[0]) ? (args[0] as string[]).join("?") : "";
        if (sql.includes("WITH scoped AS MATERIALIZED")) timingQueries.push({ sql, studentIds: (args[2] as { values: string[] }).values });
        return Reflect.apply(target.$queryRaw, target, args);
      };
    } });
    const full = await loadCourse(instance.id, scopedDb); assert.ok(full);
    assert.equal(timingQueries.length, 1);
    assert.deepEqual(new Set(timingQueries[0].studentIds), new Set(users.map(user => user.id)));
    assert.match(timingQueries[0].sql, /e\."userId" IN/);
    assert.equal(Object.keys(full.aiLearningTimingByStudent ?? {}).length, 40);
    for (const user of users) assert.deepEqual(full.aiLearningTimingByStudent?.[user.id], { effectiveDurationMs: 3_500_000, expectedDurationMs: 0, hasEvidence: true });
    const scopedRaw = await loadCourse(instance.id, scopedDb, { studentId: users[0].id }); assert.ok(scopedRaw);
    assert.deepEqual(timingQueries[1].studentIds, [users[0].id]);
    assert.match(timingQueries[1].sql, /e\."userId" IN/);
    assert.deepEqual(Object.keys(scopedRaw.aiLearningTimingByStudent ?? {}), [users[0].id]);
    assert.deepEqual(scopedRaw.aiLearningTimingByStudent?.[users[0].id], full.aiLearningTimingByStudent?.[users[0].id]);
    const otherStudent = scopeCourseForClaims(full, { role: "student", sub: users[1].id } as StudentClaims);
    assert.deepEqual(Object.keys(otherStudent.aiLearningTimingByStudent ?? {}), [users[1].id]);
    assert.deepEqual(otherStudent.aiLearningTimingByStudent?.[users[1].id], full.aiLearningTimingByStudent?.[users[1].id]);
    console.log("PASS 14,000-event timing aggregate: teacher receives all 40 identical totals; student SQL binds only self, returned map excludes every peer; claims scope protects full-course fallback");
    assert.equal(scopedRaw.companionThreads?.length, 1); assert.equal(scopedRaw.companionTasks?.length, 1); assert.equal(scopedRaw.companionConfirmations?.length, 1); assert.equal(scopedRaw.companionProcessRecords?.length, 1);
    assert.equal(scopedRaw.projectDocumentVersions?.length, 1); assert.equal(Object.keys(scopedRaw.aiLearningProgress ?? {}).length, 1);
    assert.equal(scopedRaw.submissions?.length, 2); assert.deepEqual(scopedRaw.learningEvidence, [evidence]);
    assert.equal(scopedRaw.learningEvents?.length, 350); assert.equal(full.learningEvents?.length, 10000);
    assert.equal(full.companionThreads?.length, 40); assert.equal(full.projectDocumentVersions?.length, 40);
    const claims = { role: "student", sub: users[0].id } as StudentClaims;
    const original = scopeCourseForClaims(full, claims), scoped = scopeCourseForClaims(scopedRaw, claims);
    const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sorted(item)])) : value;
    assert.deepEqual(sorted({ ...scoped, learningEvents: [] }), sorted({ ...original, learningEvents: [] }));
    assert.equal(scoped.showcasePresentations?.length, 2, "Own pending presentation and another student's active presentation remain visible");
    const sample = async (scopedRead: boolean) => {
      const start = performance.now();
      const timings: number[] = [];
      const results = await Promise.allSettled([...users, ...teachers].map(async (user, index) => {
        const t = performance.now();
        const course = await loadCourse(instance.id, db, scopedRead && index < 40 ? { studentId: user.id } : undefined);
        assert.ok(course); timings.push(performance.now() - t);
        return Buffer.byteLength(JSON.stringify(course));
      }));
      for (const result of results) assert.equal(result.status, "fulfilled", result.status === "rejected" ? String(result.reason) : undefined);
      timings.sort((a, b) => a - b);
      return { durationMs: Math.round(performance.now() - start), p95Ms: Math.round(timings[Math.ceil(timings.length * .95) - 1]), totalLoadedBytes: results.reduce((sum, result) => sum + (result.status === "fulfilled" ? result.value : 0), 0) };
    };
    const timingSample = async (onlyOwn: boolean) => {
      const timings: number[] = [];
      const allIds = users.map(user => user.id);
      await Promise.all([...users, ...teachers].map(async (user, index) => {
        const ids = onlyOwn && index < users.length ? [user.id] : allIds;
        const start = performance.now();
        const timing = await loadAiLearningTiming(instance.id, ids, db);
        timings.push(performance.now() - start);
        assert.deepEqual(new Set(Object.keys(timing)), new Set(ids));
        for (const id of ids) assert.deepEqual(timing[id], full.aiLearningTimingByStudent?.[id]);
      }));
      timings.sort((a, b) => a - b);
      return { requests: timings.length, p95Ms: Math.round(timings[Math.ceil(timings.length * .95) - 1]), maxMs: Math.round(timings.at(-1)!) };
    };
    const timingOnly = { allClassIds: await timingSample(false), ownStudentIds: await timingSample(true) };
    const baseline = await sample(false), optimized = await sample(true);
    assert.ok(optimized.totalLoadedBytes < baseline.totalLoadedBytes * .2);
    console.log(JSON.stringify({ result: "PASS", users: 42, historicalEvents: events.length, timingOnly, baseline, optimized, semanticParityExceptPerStudentEventWindow: true }));
  } finally { await db.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
