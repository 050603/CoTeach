import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AuthClaims } from "../src/lib/auth/session";
import type { ActionEnvelope } from "../src/lib/courses/contracts";

async function main() {
  const marker = process.env.OPENPBL_VERIFICATION_MARKER;
  assert.match(marker ?? "", /^openpbl-research-check-[0-9a-f-]{36}$/);
  const target = new URL(process.env.DATABASE_URL!);
  assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.username, "postgres");
  assert.equal(target.password, ""); assert.equal(target.pathname, "/postgres");
  const { prisma: db } = await import("../src/lib/db/client");
  try {
    assert.equal((await db.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification" WHERE marker = ${marker}`).length, 1);
    const { executeCourseAction } = await import("../src/lib/courses/action-service");
    const { lockProjectedCourse } = await import("../src/lib/db/session-repository");
    const teachers = await Promise.all([0, 1].map(i => db.user.create({ data: { username: `teacher-${i}`, usernameKey: `teacher-${i}`, displayName: `Teacher${i}`, role: "TEACHER", passwordHash: "test-only" } })));
    const offering = await db.courseOffering.create({ data: { name: "Projection authorization", status: "OPEN", teachers: { create: teachers.map(t => ({ userId: t.id })) } } });
    const chapter = await db.chapter.create({ data: { offeringId: offering.id, title: "Chapter", position: 0 } });
    const activity = await db.activity.create({ data: { chapterId: chapter.id, title: "Classroom", position: 0, type: "CLASSROOM" } });
    const template = await db.classroomTemplate.create({ data: { title: "Classroom", ownerId: teachers[0].id } });
    const version = await db.classroomTemplateVersion.create({ data: { templateId: template.id, version: 1, status: "PUBLISHED", snapshot: {} } });
    const instance = await db.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: version.id, status: "TEACHING", runtimeConfig: { version: 1, preserved: "runtime-marker" } } });
    const claims = teachers.map(t => ({ role: "teacher", sub: t.id, username: t.username, displayName: t.displayName, sv: t.sessionVersion }) as AuthClaims);
    const envelope = (takeover = false): ActionEnvelope => ({ requestId: randomUUID(), action: { type: "SET_UI_STATE", payload: { courseId: instance.id, projectionControl: { clientId: "test-tab", takeover }, patch: { resourceProjection: { resourceId: "fixture-resource", stageKey: "make", title: "Projection", startedAt: new Date().toISOString() } } } } });
    const original = envelope();
    const first = await executeCourseAction(instance.id, original, claims[0]);
    assert.equal(first.courseVersion, 2);
    assert.deepEqual(await executeCourseAction(instance.id, original, claims[0]), first);
    const forbidden = async () => {
      await assert.rejects(executeCourseAction(instance.id, original, claims[0]), { code: "FORBIDDEN", status: 403 });
      await assert.rejects(executeCourseAction(instance.id, envelope(), claims[0]), { code: "FORBIDDEN", status: 403 });
      assert.equal(await db.domainEvent.count(), 1);
      assert.equal(((await db.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } })).runtimeConfig as { version: number }).version, 2);
    };
    for (const patch of [{ status: "DISABLED" }, { role: "STUDENT" }, { sessionVersion: teachers[0].sessionVersion + 1 }]) {
      await db.user.update({ where: { id: teachers[0].id }, data: patch });
      await forbidden();
      await db.user.update({ where: { id: teachers[0].id }, data: { status: "ACTIVE", role: "TEACHER", sessionVersion: teachers[0].sessionVersion } });
    }
    await db.courseTeacher.deleteMany({ where: { offeringId: offering.id, userId: teachers[0].id } });
    await forbidden();
    await db.courseTeacher.create({ data: { offeringId: offering.id, userId: teachers[0].id } });
    console.log("PASS fresh and replayed requests reject disabled account, changed role/session and revoked teacher membership");
    const foreignOffering = await db.courseOffering.create({ data: { name: "Foreign", teachers: { create: { userId: teachers[1].id } } } });
    const foreignChapter = await db.chapter.create({ data: { offeringId: foreignOffering.id, title: "Foreign", position: 0 } });
    const foreignActivity = await db.activity.create({ data: { chapterId: foreignChapter.id, title: "Foreign", position: 0, type: "CLASSROOM" } });
    const foreign = await db.classroomInstance.create({ data: { activityId: foreignActivity.id, templateVersionId: version.id } });
    await assert.rejects(executeCourseAction(foreign.id, original, claims[0]), { code: "FORBIDDEN", status: 403 });
    await assert.rejects(executeCourseAction(randomUUID(), original, claims[0]), { code: "FORBIDDEN", status: 403 });
    console.log("PASS foreign/missing classroom rejects existing receipt before disclosing or replaying it");
    let release!: () => void;
    let locked!: () => void;
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.$transaction(async tx => { await lockProjectedCourse(tx, instance.id); locked(); await gate; }, { timeout: 10000 });
    await acquired;
    const waiting = executeCourseAction(instance.id, original, claims[0]);
    const rejected = assert.rejects(waiting, { code: "FORBIDDEN", status: 403 });
    try {
      const deadline = Date.now() + 3000;
      let waiters = 0;
      do {
        const rows = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'`;
        waiters = Number(rows[0].n);
        if (!waiters) await new Promise(resolve => setTimeout(resolve, 10));
      } while (!waiters && Date.now() < deadline);
      assert.ok(waiters, "Projection must actually be waiting for the course lock");
      await db.courseTeacher.deleteMany({ where: { offeringId: offering.id, userId: teachers[0].id } });
    } finally { release(); await blocker; }
    await rejected;
    await db.courseTeacher.create({ data: { offeringId: offering.id, userId: teachers[0].id } });
    console.log("PASS membership revoked during advisory wait is observed by fresh post-lock SQL even for receipt replay");
    await assert.rejects(executeCourseAction(instance.id, envelope(), claims[1]), { code: "PROJECTION_CONTROL_CONFLICT", status: 409 });
    const second = await executeCourseAction(instance.id, envelope(true), claims[1]);
    assert.equal(second.courseVersion, 3); assert.equal(second.projection?.projectionController?.teacherId, teachers[1].id);
    const before = await db.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } });
    const count = await db.domainEvent.count();
    await db.$executeRawUnsafe(`CREATE FUNCTION reject_projection_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'projection-receipt-fault'; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER reject_projection_receipt BEFORE INSERT ON "DomainEvent" FOR EACH ROW EXECUTE FUNCTION reject_projection_receipt()`);
    await assert.rejects(executeCourseAction(instance.id, envelope(true), claims[0]), /projection-receipt-fault/);
    assert.deepEqual((await db.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } })).runtimeConfig, before.runtimeConfig);
    assert.equal(await db.domainEvent.count(), count);
    await db.$executeRawUnsafe(`DROP TRIGGER reject_projection_receipt ON "DomainEvent"`);
    const final = await executeCourseAction(instance.id, envelope(true), claims[0]);
    assert.equal(final.courseVersion, 4);
    assert.equal(((await db.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } })).runtimeConfig as { preserved: string }).preserved, "runtime-marker");
    console.log("PASS explicit takeover, monotonic versions, receipt failure atomic rollback, unrelated runtime retained");
    const { loadCourse } = await import("../src/lib/db/session-repository");
    const beforeStage = await loadCourse(instance.id, db); assert.ok(beforeStage);
    const reflectionIndex = beforeStage.stages.findIndex(stage => stage.key === "reflection");
    assert.ok(reflectionIndex >= 0);
    const stageRequest: ActionEnvelope = { requestId: randomUUID(), expectedVersion: beforeStage.version,
      action: { type: "SET_STAGE", payload: { id: instance.id, index: reflectionIndex } } };
    const stageAck = await executeCourseAction(instance.id, stageRequest, claims[0]);
    const afterStage = await loadCourse(instance.id, db); assert.ok(afterStage);
    assert.equal(stageAck.courseVersion, (beforeStage.version ?? 1) + 1);
    assert.equal(stageAck.courseVersion, afterStage.version);
    assert.equal(afterStage.currentStageIndex, reflectionIndex);
    assert.equal(afterStage.uiState?.resourceProjection, null);
    assert.equal(afterStage.uiState?.projectionController, null);
    const stageRuntime = (await db.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } })).runtimeConfig as Record<string, unknown>;
    assert.equal(typeof stageRuntime.posttestOpenedAt, "string");
    const stageReceiptCount = await db.domainEvent.count();
    assert.deepEqual(await executeCourseAction(instance.id, stageRequest, claims[0]), stageAck);
    assert.equal(await db.domainEvent.count(), stageReceiptCount);
    assert.deepEqual((await db.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } })).runtimeConfig, stageRuntime);
    await assert.rejects(executeCourseAction(instance.id, { ...stageRequest, requestId: randomUUID() }, claims[0]), { code: "VERSION_CONFLICT", status: 409 });
    await db.$executeRawUnsafe(`CREATE TRIGGER reject_projection_receipt BEFORE INSERT ON "DomainEvent" FOR EACH ROW EXECUTE FUNCTION reject_projection_receipt()`);
    await assert.rejects(executeCourseAction(instance.id, { requestId: randomUUID(), action: { type: "SET_STAGE", payload: { id: instance.id, index: 0 } } }, claims[0]), /projection-receipt-fault/);
    assert.deepEqual((await db.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } })).runtimeConfig, stageRuntime);
    assert.equal(await db.domainEvent.count(), stageReceiptCount);
    await db.$executeRawUnsafe(`DROP TRIGGER reject_projection_receipt ON "DomainEvent"`);
    await db.classroomInstance.update({ where: { id: instance.id }, data: { status: "FINISHED", endedAt: new Date() } });
    const closedAck = await executeCourseAction(instance.id, { requestId: randomUUID(), action: { type: "SET_STAGE", payload: { id: instance.id, index: 100 } } }, claims[0]);
    const closed = await db.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } });
    assert.equal(closed.status, "FINISHED");
    assert.equal(closedAck.courseVersion, Number(stageRuntime.version) + 1);
    assert.equal((closed.runtimeConfig as Record<string, unknown>).posttestOpenedAt, stageRuntime.posttestOpenedAt);
    console.log("PASS SET_STAGE receipt version equals persisted/full-read version; reflection gate retained, replay and stale-version semantics unchanged, receipt fault rolls back, ended classroom never reopens");

  } finally { await db.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
