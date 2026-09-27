import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import type { KnowledgeLectureAttempt } from "../src/lib/session/types";
async function main() {
  const marker = process.env.OPENPBL_VERIFICATION_MARKER!;
  assert.match(marker, /^openpbl-grade-check-[0-9a-f-]{36}$/);
  const target = new URL(process.env.DATABASE_URL!); assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.username, "postgres"); assert.equal(target.password, "");
  assert.ok(process.env.AI_AUDIT_OUTBOX_DIR?.startsWith("/tmp/openpbl-grade-check-"));
  const { prisma } = await import("../src/lib/db/client");
  try {
    const nonce = await prisma.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification"`; assert.equal(nonce[0].marker, marker);
    const { gradeKnowledgeLectureQuestion } = await import("../src/lib/courses/knowledge-lecture-grading");
    const { persistKnowledgeLectureAttempt } = await import("../src/lib/courses/knowledge-lecture-attempts");
    const { drainAiAuditOutbox } = await import("../src/lib/ai-collaboration/audit-outbox");
    const teacher = await prisma.user.create({ data: { username: "teacher", usernameKey: "teacher", displayName: "Test teacher", role: "TEACHER", passwordHash: "unusable" } });
    const offering = await prisma.courseOffering.create({ data: { name: marker, status: "OPEN" } });
    const chapter = await prisma.chapter.create({ data: { offeringId: offering.id, title: marker, position: 0 } });
    const activity = await prisma.activity.create({ data: { chapterId: chapter.id, title: marker, position: 0, type: "CLASSROOM" } });
    const template = await prisma.classroomTemplate.create({ data: { ownerId: teacher.id, title: marker } });
    const version = await prisma.classroomTemplateVersion.create({ data: { templateId: template.id, version: 1, status: "PUBLISHED", snapshot: { design: { aiLearningClassroomId: "lecture" } } } });
    const instance = await prisma.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: version.id, status: "TEACHING", runtimeConfig: { version: 1 } } });
    const students = await Promise.all(Array.from({ length: 40 }, async (_, index) => {
      const user = await prisma.user.create({ data: { username: `student-${index}`, usernameKey: `student-${index}`, displayName: `student-${index}`, passwordHash: "unusable" } });
      const enrollment = await prisma.enrollment.create({ data: { userId: user.id, offeringId: offering.id } });
      const participation = await prisma.classroomParticipation.create({ data: { instanceId: instance.id, enrollmentId: enrollment.id } });
      const attempt: KnowledgeLectureAttempt = { id: `attempt-${index}`, sectionId: "section", quizOutlineId: "quiz", runtimeSceneId: "scene", submittedAt: new Date().toISOString(), gradingSource: "server", gradingStatus: "pending", score: 0, maxScore: 0, knowledgePointIds: [],
        questions: [{ questionId: "question", questionType: "short_answer", prompt: "公平比较节能效果", answer: `学生${index}的完整原始答案`, rawAnswer: `学生${index}的完整原始答案`, gradingStatus: "pending", points: 6, earned: 0, correct: null, feedback: "待批阅", knowledgePointIds: [] }] };
      const input = { courseId: instance.id, studentId: user.id, classroomId: "lecture", attempt };
      await persistKnowledgeLectureAttempt(input);
      return { user, enrollment, participation, input };
    }));
    const raw = JSON.stringify({ score: 6, comment: "完整长评语".repeat(700), extra: "原始附加字段" });
    const model = (text: string) => new MockLanguageModelV3({ doGenerate: async () => ({ content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] }) });
    const args = (student: typeof students[number], text: string) => ({ ...student.input, attemptId: student.input.attempt.id, question: student.input.attempt.questions[0], signal: new AbortController().signal, resolveModel: async () => ({ model: model(text), thinkingConfig: undefined }) as never });
    const results = await Promise.all(students.map((student, index) => gradeKnowledgeLectureQuestion(args(student, index === 0 ? "{invalid-model-output}" : raw))));
    await Promise.all(students.map((student, index) => persistKnowledgeLectureAttempt(student.input, new Map([["question", results[index]]]))));
    assert.equal(results[0].gradingStatus, "failed"); assert.ok(results.slice(1).every(result => result.gradingStatus === "graded"));
    const beforeRetry = await prisma.aiInteractionEvent.findMany({ where: { userId: students[0].user.id }, orderBy: { id: "asc" } }); assert.equal(beforeRetry.length, 3);
    // Already accepted grading can finish after closure; no original answer is replaced.
    await prisma.classroomInstance.update({ where: { id: instance.id }, data: { status: "COMPLETED" } });
    const retry = await gradeKnowledgeLectureQuestion(args(students[0], raw));
    const snapshot = async () => ({
      workspace: await prisma.studentProjectWorkspace.findUniqueOrThrow({ where: { participationId: students[0].participation.id } }),
      course: await prisma.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } }),
      events: await prisma.domainEvent.findMany({ where: { classroomInstanceId: instance.id }, orderBy: { id: "asc" } }),
    });
    const beforeCommit = await snapshot();
    await prisma.$executeRawUnsafe(`CREATE FUNCTION fail_grade_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated grade commit fault'; END; $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_grade_commit BEFORE INSERT ON "DomainEvent" FOR EACH ROW EXECUTE FUNCTION fail_grade_commit()`);
    await assert.rejects(persistKnowledgeLectureAttempt(students[0].input, new Map([["question", retry]])), /isolated grade commit fault/);
    assert.deepEqual(await snapshot(), beforeCommit);
    await prisma.$executeRawUnsafe('DROP TRIGGER fail_grade_commit ON "DomainEvent"'); await prisma.$executeRawUnsafe('DROP FUNCTION fail_grade_commit()');
    const saved = await persistKnowledgeLectureAttempt(students[0].input, new Map([["question", retry]])); assert.equal(saved.gradingStatus, "graded");
    console.log("PASS final grade DomainEvent insert failure rolls back workspace, course version and all domain events; retained model facts survive and the same result can commit after repair");
    const oldIds = beforeRetry.map(row => row.id); assert.deepEqual(await prisma.aiInteractionEvent.findMany({ where: { id: { in: oldIds } }, orderBy: { id: "asc" } }), beforeRetry);
    const facts = await prisma.aiInteractionEvent.findMany({ where: { offeringId: offering.id } }); assert.equal(facts.length, 123);
    for (const student of students) {
      const own = facts.filter(fact => fact.userId === student.user.id);
      assert.ok(own.every(fact => fact.participationId === student.participation.id && fact.researchKey === student.enrollment.researchKey));
      for (const fact of own.filter(fact => (fact.payload as { detail: { kind: string } }).detail.kind === "model-output")) {
        const detail = (fact.payload as { detail: { rawSha256: string; rawLength: number } }).detail;
        assert.equal(detail.rawSha256, createHash("sha256").update(fact.content!).digest("hex")); assert.equal(detail.rawLength, fact.content!.length);
      }
      const workspace = await prisma.studentProjectWorkspace.findUniqueOrThrow({ where: { participationId: student.participation.id } });
      const progress = (workspace.projectState as { aiLearningProgress: { knowledgeLectureAttempts: KnowledgeLectureAttempt[] } }).aiLearningProgress;
      assert.equal(progress.knowledgeLectureAttempts[0].questions[0].rawAnswer, student.input.attempt.questions[0].rawAnswer);
    }
    const { verifyCapacityGradingRecords } = await import("./verify-capacity-grading-records.mjs");
    for (const [index, student] of students.entries()) {
      await verifyCapacityGradingRecords({ db: prisma, fixture: { instanceId: instance.id, offeringId: offering.id, classroomId: "lecture" }, user: student.user, attemptId: student.input.attempt.id, expectedInvocations: index === 0 ? 2 : 1 });
    }
    console.log("PASS production read-only grading verifier reconciles all 40 students against real PostgreSQL rows");
    console.log("PASS 40 concurrent actual grading helper calls with deterministic in-process model: full raw/hash/ownership, 39 successes + 1 parse failure; retry after closure keeps old facts and all original answers");
    const protectedGrade = await persistKnowledgeLectureAttempt(students[0].input, new Map([["question", { ...retry, earned: 0, gradingStatus: "failed" }]])); assert.deepEqual(protectedGrade, saved);
    // Audit DB failure forces disk retention; same saved file replay must not duplicate any fact.
    await prisma.$executeRawUnsafe(`CREATE FUNCTION fail_grade_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated audit fault'; END; $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_grade_audit BEFORE INSERT ON "AiInteractionEvent" FOR EACH ROW EXECUTE FUNCTION fail_grade_audit()`);
    const deferred = await gradeKnowledgeLectureQuestion(args(students[1], raw)); assert.equal(deferred.gradingStatus, "graded");
    const directory = process.env.AI_AUDIT_OUTBOX_DIR!;
    const files = await readdir(directory); assert.equal(files.length, 2);
    const batches = await Promise.all(files.map(async name => ({ name, body: await readFile(path.join(directory, name), "utf8") })));
    await prisma.$executeRawUnsafe('DROP TRIGGER fail_grade_audit ON "AiInteractionEvent"'); await prisma.$executeRawUnsafe('DROP FUNCTION fail_grade_audit()');
    await drainAiAuditOutbox(); assert.equal(await prisma.aiInteractionEvent.count(), 126); assert.deepEqual(await readdir(directory), []);
    for (const batch of batches) await writeFile(path.join(directory, batch.name), batch.body);
    await drainAiAuditOutbox(); assert.equal(await prisma.aiInteractionEvent.count(), 126);
    console.log("PASS real PostgreSQL audit insert fault -> fsynced request/raw/terminal outbox -> recovered exact facts; replay zero duplicates; graded answer remains protected");
  } finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
