// Run only through verify-research-database.mjs against its nonce-protected disposable database.
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { setTimeout as delay } from "node:timers/promises";
import type { AuthClaims } from "../src/lib/auth/session";

async function main() {
  const marker = process.env.OPENPBL_VERIFICATION_MARKER;
  assert.match(marker ?? "", /^openpbl-research-check-[0-9a-f-]{36}$/);
  const target = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.username, "postgres");
  assert.equal(target.password, ""); assert.equal(target.pathname, "/postgres"); assert.ok(target.port);
  const { prisma } = await import("../src/lib/db/client");
  const observer = new PrismaClient({ datasourceUrl: target.toString() });
  try {
    const matching = await prisma.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification" WHERE marker = ${marker}`;
    assert.equal(matching.length, 1);
    delete process.env.REDIS_URL;
    const { getStudentActivity, enterClassroom } = await import("../src/lib/platform/repository");
    const { ensureExperimentAssignment, getStudentExperimentAssessment, saveExperimentAssessmentDraft, submitExperimentAssessment } = await import("../src/lib/platform/experiment-service");
    const question = { id: "q", type: "single-choice", prompt: "Which is evidence?", options: ["measurement", "guess"], correctAnswer: "measurement" };
    const config = { schemaVersion: 1, experiment: { enabled: true, pretest: [question], posttest: [question], randomizeQuestionOrder: false, randomizeOptionOrder: false } };
    const teacher = await prisma.user.create({ data: { username: "entry-teacher", usernameKey: "entry-teacher", displayName: "Teacher", role: "TEACHER", passwordHash: "unusable" } });
    const offering = await prisma.courseOffering.create({ data: { name: "entry verification", status: "OPEN", teachers: { create: { userId: teacher.id } } } });
    const chapter = await prisma.chapter.create({ data: { offeringId: offering.id, title: "entry", isOpen: true, position: 0 } });
    const activity = await prisma.activity.create({ data: { chapterId: chapter.id, title: "entry", type: "CLASSROOM", position: 0, isOpen: true, config } });
    const template = await prisma.classroomTemplate.create({ data: { title: "entry", ownerId: teacher.id } });
    const version = await prisma.classroomTemplateVersion.create({ data: { templateId: template.id, version: 1, snapshot: { title: "entry" }, status: "PUBLISHED" } });
    const instance = await prisma.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: version.id, status: "TEACHING" } });
    const students = await Promise.all(Array.from({ length: 40 }, async (_, index) => {
      const user = await prisma.user.create({ data: { username: `entry-${index}`, usernameKey: `entry-${index}`, displayName: `Student ${index}`, role: "STUDENT", passwordHash: "unusable" } });
      const enrollment = await prisma.enrollment.create({ data: { userId: user.id, offeringId: offering.id } });
      const claims: AuthClaims = { sub: user.id, role: "student", sv: user.sessionVersion };
      return { user, enrollment, claims };
    }));
    const started = performance.now();
    const entries = await Promise.allSettled(students.map(async student => {
      await getStudentActivity(student.claims, activity.id);
      const assessment = await getStudentExperimentAssessment(student.claims, instance.id, "pretest");
      assert.equal(assessment.available, true);
      await saveExperimentAssessmentDraft(student.claims, instance.id, { phase: "pretest", answers: { q: "measurement" }, currentPage: 0, version: 0 });
      await submitExperimentAssessment(student.claims, instance.id, { phase: "pretest", answers: { q: "measurement" } });
      await enterClassroom(student.claims, instance.id);
    }));
    assert.ok(entries.every(result => result.status === "fulfilled"), JSON.stringify(entries.filter(result => result.status === "rejected")));
    assert.equal(await prisma.experimentAssessmentAssignment.count({ where: { instanceId: instance.id } }), 40);
    assert.equal(await prisma.experimentAssessmentSubmission.count({ where: { instanceId: instance.id } }), 40);
    assert.equal(await prisma.learningEvent.count({ where: { offeringId: offering.id } }), 80);
    assert.equal(await prisma.classroomParticipation.count({ where: { instanceId: instance.id } }), 40);
    console.log(`PASS full 40-student activity entry, assignment, pretest draft/submit, participation and 80 durable events in ${Math.round(performance.now() - started)}ms`);

    // A slow student's assessment row must not block another student's writes.
    const assignment = await prisma.experimentAssessmentAssignment.findUniqueOrThrow({ where: { instanceId_enrollmentId: { instanceId: instance.id, enrollmentId: students[0].enrollment.id } } });
    await prisma.experimentAssessmentSubmission.deleteMany({ where: { instanceId: instance.id } });
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const blocker = observer.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "ExperimentAssessmentAssignment" WHERE "id" = ${assignment.id} FOR UPDATE`;
      entered(); await gate;
    }, { timeout: 10000 });
    await held;
    const slow = saveExperimentAssessmentDraft(students[0].claims, instance.id, { phase: "pretest", answers: { q: "measurement" }, currentPage: 0, version: 0 });
    const settledSlow = slow.then(() => undefined, error => error);
    await delay(100);
    const unrelated = Promise.allSettled(students.slice(1).map(student => saveExperimentAssessmentDraft(student.claims, instance.id, { phase: "pretest", answers: { q: "measurement" }, currentPage: 0, version: 0 })));
    let unrelatedError: unknown;
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([unrelated, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("One blocked student's row blocked the remaining 39 students")), 4500); })]); }
      finally { clearTimeout(timeout); }
    } catch (error) { unrelatedError = error;
    } finally { release(); await blocker; }
    assert.equal(await settledSlow, undefined);
    const unrelatedResults = await unrelated;
    assert.ok(unrelatedResults.every(result => result.status === "fulfilled"));
    if (unrelatedError) throw unrelatedError;
    console.log("PASS one student's locked assignment does not block 39 other student drafts");

    const pairs = await Promise.all(students.map(async student => {
      const results = await Promise.allSettled([0, 1].map(() => saveExperimentAssessmentDraft(student.claims, instance.id, { phase: "pretest", answers: { q: "guess" }, currentPage: 0, version: 1 })));
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      const failed = results.find(result => result.status === "rejected");
      assert.equal(failed?.reason.code, "DRAFT_VERSION_CONFLICT");
      return student;
    }));
    assert.equal(pairs.length, 40);
    console.log("PASS 80 same-student competing draft saves preserve 40 successful CAS writes and 40 conflicts");

    let releaseClosure!: () => void;
    let enteredClosure!: () => void;
    const closed = new Promise<void>(resolve => { enteredClosure = resolve; });
    const closureGate = new Promise<void>(resolve => { releaseClosure = resolve; });
    const closure = observer.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "ClassroomInstance" WHERE "id" = ${instance.id} FOR UPDATE`;
      await tx.classroomInstance.update({ where: { id: instance.id }, data: { status: "FINISHED" } });
      enteredClosure(); await closureGate;
    }, { timeout: 10000 });
    await closed;
    const late = Promise.allSettled(students.map(student => saveExperimentAssessmentDraft(student.claims, instance.id, { phase: "pretest", answers: { q: "measurement" }, currentPage: 0, version: 2 })));
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        const rows = await observer.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
        if (rows[0].count > 0n) { waiting = true; break; }
        await delay(25);
      }
      assert.ok(waiting);
    } finally { releaseClosure(); await closure; }
    const lateResults = await late;
    assert.ok(lateResults.every(result => result.status === "rejected" && result.reason.code === "ASSESSMENT_UNAVAILABLE"));
    assert.equal(await ensureExperimentAssignment(instance.id, students[0].enrollment.id), null);
    console.log("PASS shared classroom guard still rejects all 40 pretest writes queued behind classroom closure");

    const balanced = await prisma.activity.create({ data: { chapterId: chapter.id, title: "balanced", type: "CLASSROOM", position: 1, isOpen: true,
      config: { ...config, experiment: { ...config.experiment, scenarioPair: { a: { id: "a", type: "short-answer", prompt: "A" }, b: { id: "b", type: "short-answer", prompt: "B" } } } } } });
    const balancedInstance = await prisma.classroomInstance.create({ data: { activityId: balanced.id, templateVersionId: version.id, status: "TEACHING" } });
    await Promise.all(students.flatMap(student => [0, 1].map(() => ensureExperimentAssignment(balancedInstance.id, student.enrollment.id))));
    assert.equal(await prisma.experimentAssessmentAssignment.count({ where: { instanceId: balancedInstance.id, variant: "A_PRE_B_POST" } }), 20);
    assert.equal(await prisma.experimentAssessmentAssignment.count({ where: { instanceId: balancedInstance.id, variant: "B_PRE_A_POST" } }), 20);
    console.log("PASS 80 assignment requests for 40 students preserve idempotency and exact 20/20 counterbalance");
  } finally { await observer.$disconnect(); await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
