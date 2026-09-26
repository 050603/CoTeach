import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";

const mocks = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    classroomInstance: { findUnique: vi.fn() },
    enrollment: { findUnique: vi.fn() },
    classroomParticipation: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    experimentAssessmentSubmission: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    experimentAssessmentAssignment: { findUnique: vi.fn(), count: vi.fn(), create: vi.fn(), findMany: vi.fn() },
    experimentAssessmentDraft: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
    domainEvent: { create: vi.fn() },
  };
  return { tx, transaction: vi.fn(), student: vi.fn(), teacher: vi.fn(), link: vi.fn(), results: vi.fn(), count: vi.fn(), enrollments: vi.fn(), publish: vi.fn() };
});
vi.mock("@/lib/db/client", () => ({ prisma: {
  classroomInstance: mocks.tx.classroomInstance,
  classroomParticipation: mocks.tx.classroomParticipation,
  courseTeacher: { findFirst: mocks.link },
  enrollment: { count: mocks.count, findMany: mocks.enrollments, findUnique: mocks.tx.enrollment.findUnique },
  experimentAssessmentSubmission: { findMany: mocks.results, findUnique: mocks.tx.experimentAssessmentSubmission.findUnique },
  experimentAssessmentAssignment: { findMany: mocks.tx.experimentAssessmentAssignment.findMany, findUnique: mocks.tx.experimentAssessmentAssignment.findUnique },
  experimentAssessmentDraft: { findMany: mocks.tx.experimentAssessmentDraft.findMany, findUnique: mocks.tx.experimentAssessmentDraft.findUnique },
} }));
vi.mock("@/lib/db/transaction-retry", () => ({ runMutationTransaction: mocks.transaction }));
vi.mock("@/lib/realtime/event-bus", () => ({ publishCourseEvent: mocks.publish }));
vi.mock("./access", () => ({ requireStudentUser: mocks.student, requireTeacherUser: mocks.teacher }));

import { ensureExperimentAssignment, getClassroomExperimentResults, getStudentExperimentAssessment, saveExperimentAssessmentDraft, submitExperimentAssessment } from "./experiment-service";

const claims = { role: "student", sub: "student" } as AuthClaims;
const experiment = {
  enabled: true,
  pretest: [{ id: "q1", type: "single-choice", prompt: "哪项正确？", options: ["甲", "乙"], correctAnswer: "乙" }],
  posttest: [{ id: "q2", type: "short-answer", prompt: "解释你的方法" }],
};
const instance = {
  id: "run", status: "SCHEDULED", activityId: "activity",
  activity: { id: "activity", chapterId: "chapter", archivedAt: null, isOpen: true, config: { schemaVersion: 1, experiment }, chapter: { offeringId: "course", archivedAt: null, isOpen: true, offering: { id: "course", status: "OPEN" } } },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation((operation) => operation(mocks.tx));
  mocks.student.mockResolvedValue({ id: "student" });
  mocks.teacher.mockResolvedValue({ id: "teacher" });
  mocks.tx.classroomInstance.findUnique.mockResolvedValue(instance);
  mocks.tx.enrollment.findUnique.mockResolvedValue({ id: "enrollment", offeringId: "course", status: "ACTIVE", researchKey: "anonymous" });
  mocks.tx.experimentAssessmentSubmission.findFirst.mockResolvedValue(null);
  mocks.tx.experimentAssessmentSubmission.findUnique.mockResolvedValue(null);
  mocks.tx.experimentAssessmentAssignment.findUnique.mockResolvedValue({ id: "assignment", variant: "none", pretestForm: experiment.pretest, posttestForm: experiment.posttest });
  mocks.tx.experimentAssessmentAssignment.findMany.mockResolvedValue([]);
  mocks.tx.classroomParticipation.findUnique.mockResolvedValue({ id: "participation" });
  mocks.tx.classroomParticipation.findMany.mockResolvedValue([]);
  mocks.tx.experimentAssessmentDraft.findMany.mockResolvedValue([]);
  mocks.tx.experimentAssessmentDraft.findUnique.mockResolvedValue(null);
  mocks.enrollments.mockResolvedValue([{ id: "enrollment", user: { id: "student", displayName: "学生甲" } }]);
  mocks.tx.experimentAssessmentSubmission.create.mockImplementation(({ data }) => ({ ...data, submittedAt: new Date() }));
});

describe("classroom experiment submissions", () => {
  it("accepts a pretest before the lesson and stores a run-specific question snapshot", async () => {
    const row = await submitExperimentAssessment(claims, "run", { phase: "pretest", answers: { q1: "乙" } });
    expect(row).toMatchObject({ instanceId: "run", enrollmentId: "enrollment", phase: "pretest", researchKey: "anonymous", objectiveScore: 1, objectiveTotal: 1 });
    expect(mocks.tx.experimentAssessmentSubmission.create.mock.calls[0][0].data.questionnaire).toMatchObject(experiment);
    expect(mocks.tx.experimentAssessmentSubmission.create.mock.calls[0][0].data.questionnaire).not.toHaveProperty("randomizeQuestionOrder");
    expect(row).toMatchObject({ assignmentId: "assignment" });
    expect(mocks.tx.domainEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: "experiment-assessment-submitted", payload: { scope: "student", studentId: "student", phase: "pretest" } }) }));
    expect(mocks.publish).toHaveBeenCalledWith("run", expect.objectContaining({ type: "submission-updated" }));
    expect(mocks.tx.$queryRaw.mock.calls[0][0].join("")).toContain('FROM "ClassroomInstance"');
    expect(mocks.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.tx.experimentAssessmentAssignment.findUnique.mock.invocationCallOrder[0]);
  });

  it("requires class completion and the student's pretest plus participation before a posttest", async () => {
    await expect(submitExperimentAssessment(claims, "run", { phase: "posttest", answers: { q2: "说明" } })).rejects.toMatchObject({ code: "POSTTEST_UNAVAILABLE" });
    mocks.tx.classroomInstance.findUnique.mockResolvedValue({ ...instance, status: "FINISHED", runtimeConfig: { currentStageIndex: 4 } });
    await expect(submitExperimentAssessment(claims, "run", { phase: "posttest", answers: { q2: "说明" } })).rejects.toMatchObject({ code: "CLASSROOM_PARTICIPATION_REQUIRED" });
    mocks.tx.experimentAssessmentSubmission.findUnique.mockResolvedValueOnce({ id: "pre" });
    const row = await submitExperimentAssessment(claims, "run", { phase: "posttest", answers: { q2: "说明" } });
    expect(row).toMatchObject({ phase: "posttest", objectiveScore: 0, objectiveTotal: 0 });
  });

  it("rejects invalid answers and a changed second submission", async () => {
    await expect(submitExperimentAssessment(claims, "run", { phase: "pretest", answers: { q1: "错误选项" } })).rejects.toMatchObject({ code: "INVALID_ANSWERS" });
    mocks.tx.experimentAssessmentSubmission.findUnique.mockResolvedValue({ id: "previous", answers: { q1: "甲" } });
    await expect(submitExperimentAssessment(claims, "run", { phase: "pretest", answers: { q1: "乙" } })).rejects.toMatchObject({ code: "ASSESSMENT_SUBMITTED" });
    expect(mocks.tx.experimentAssessmentSubmission.create).not.toHaveBeenCalled();
  });

  it("respects a scheduled activity opening time on direct pretest requests", async () => {
    mocks.tx.classroomInstance.findUnique.mockResolvedValue({ ...instance, activity: { ...instance.activity, opensAt: new Date("2099-01-01T00:00:00Z") } });
    await expect(submitExperimentAssessment(claims, "run", { phase: "pretest", answers: { q1: "乙" } })).rejects.toMatchObject({ code: "PRETEST_UNAVAILABLE" });
    expect(mocks.tx.experimentAssessmentSubmission.create).not.toHaveBeenCalled();
  });

  it("does not let one teacher inspect another class's results", async () => {
    mocks.tx.classroomInstance.findUnique.mockResolvedValue({ ...instance, runNo: 1 });
    mocks.link.mockResolvedValue(null);
    await expect(getClassroomExperimentResults({ role: "teacher", sub: "teacher" } as AuthClaims, "run")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.results).not.toHaveBeenCalled();
  });

  it("summarizes each counterbalanced group for the classroom teacher", async () => {
    mocks.tx.classroomInstance.findUnique.mockResolvedValue({ ...instance, runNo: 1 });
    mocks.link.mockResolvedValue({ id: "teacher-link" });
    mocks.tx.experimentAssessmentAssignment.findMany.mockResolvedValue([{ variant: "A_PRE_B_POST" }, { variant: "B_PRE_A_POST" }]);
    mocks.enrollments.mockResolvedValue([{ id: "enrollment", user: { id: "student", displayName: "学生甲" } }, { id: "other", user: { id: "other", displayName: "学生乙" } }]);
    mocks.count.mockResolvedValue(2);
    mocks.results.mockResolvedValue([{ id: "submission", enrollmentId: "enrollment", phase: "pretest", researchKey: "anonymous", submittedAt: new Date(), questionnaire: experiment, answers: { q1: "乙" }, objectiveScore: 1, objectiveTotal: 1, assignment: { variant: "A_PRE_B_POST" }, enrollment: { user: { displayName: "学生甲", username: "s1" } } }]);
    const result = await getClassroomExperimentResults({ role: "teacher", sub: "teacher" } as AuthClaims, "run");
    expect(result).toMatchObject({ enabled: true, enrollmentCount: 2, pretestCount: 1, posttestCount: 0, variantCounts: { aPreBPost: 1, bPreAPost: 1 }, submissions: [{ variant: "A_PRE_B_POST", student: { displayName: "学生甲" } }] });
    expect(result.submissions[0]).not.toHaveProperty("researchKey");
  });

  it("counts posttests within this run's entered participants and pretests within active members", async () => {
    mocks.link.mockResolvedValue({ id: "teacher-link" });
    mocks.enrollments.mockResolvedValue(["active", "waiting", "drafting"].map((id) => ({ id, user: { id, displayName: id } })));
    mocks.tx.classroomParticipation.findMany.mockResolvedValue(["active", "withdrawn", "drafting"].map((id) => ({
      enrollmentId: id, enrollment: { status: id === "withdrawn" ? "WITHDRAWN" : "ACTIVE", user: { id, displayName: id } },
    })));
    mocks.tx.experimentAssessmentDraft.findMany.mockResolvedValue([{ assignment: { enrollmentId: "drafting" } }, { assignment: { enrollmentId: "waiting" } }]);
    const submission = (enrollmentId: string, phase: "pretest" | "posttest", id = `${enrollmentId}-${phase}`) => ({
      id, enrollmentId, phase, submittedAt: new Date("2026-09-25T08:00:00.000Z"), questionnaire: experiment,
      answers: {}, objectiveScore: 0, objectiveTotal: 0, assignment: { variant: "none" },
      enrollment: { user: { id: enrollmentId, displayName: enrollmentId, username: enrollmentId } },
    });
    mocks.results.mockResolvedValue([
      submission("active", "pretest"), submission("active", "pretest", "duplicate-pretest"), submission("waiting", "pretest"),
      submission("active", "posttest"), submission("active", "posttest", "duplicate-posttest"),
      submission("withdrawn", "posttest"), submission("waiting", "posttest"),
    ]);
    const result = await getClassroomExperimentResults({ role: "teacher", sub: "teacher" } as AuthClaims, "run");
    expect(result).toMatchObject({ enrollmentCount: 3, participantCount: 3, pretestCount: 2, posttestCount: 2, posttestDraftCount: 1 });
    expect(result.studentRows.map((row) => ({ id: row.student.id, status: row.status, enrollmentStatus: row.enrollmentStatus }))).toEqual([
      { id: "active", status: "submitted", enrollmentStatus: "active" },
      { id: "withdrawn", status: "submitted", enrollmentStatus: "withdrawn" },
      { id: "drafting", status: "in-progress", enrollmentStatus: "active" },
    ]);
    expect(result.submissions).toHaveLength(7);
    expect(mocks.tx.classroomParticipation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { instanceId: "run", enrollment: { offeringId: "course" }, OR: [{ firstEnteredAt: { not: null } }, { lastEnteredAt: { not: null } }] },
    }));
  });

  it("balances A/B assignments under parent locks and saves shuffled forms once", async () => {
    const scenarioPair = { a: { id: "a", type: "short-answer", prompt: "设计情境 A" }, b: { id: "b", type: "short-answer", prompt: "设计情境 B" } };
    mocks.tx.classroomInstance.findUnique.mockResolvedValue({ ...instance, activity: { ...instance.activity, config: { experiment: { ...experiment, scenarioPair } } } });
    mocks.tx.experimentAssessmentAssignment.findUnique.mockResolvedValue(null);
    mocks.tx.experimentAssessmentAssignment.count.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    mocks.tx.experimentAssessmentAssignment.create.mockImplementation(({ data }) => data);
    const assigned = await ensureExperimentAssignment("run", "enrollment");
    expect(assigned).toMatchObject({ variant: "B_PRE_A_POST", pretestForm: expect.arrayContaining([expect.objectContaining({ id: "b" })]), posttestForm: expect.arrayContaining([expect.objectContaining({ id: "a" })]) });
    expect(mocks.tx.$queryRaw.mock.calls.map((call) => call[0].join(""))).toEqual(expect.arrayContaining([expect.stringContaining('FROM "Chapter"'), expect.stringContaining('FROM "Activity"'), expect.stringContaining('FROM "ClassroomInstance"')]));
  });

  it("returns an existing assignment unchanged on repeated access", async () => {
    const previous = { id: "assignment", variant: "A_PRE_B_POST", pretestForm: experiment.pretest, posttestForm: experiment.posttest };
    mocks.tx.experimentAssessmentAssignment.findUnique.mockResolvedValue(previous);
    expect(await ensureExperimentAssignment("run", "enrollment")).toBe(previous);
    expect(mocks.tx.experimentAssessmentAssignment.create).not.toHaveBeenCalled();
    expect(mocks.tx.experimentAssessmentAssignment.count).not.toHaveBeenCalled();
  });

  it("opens the assigned posttest on stage five, but keeps the assigned form private before then", async () => {
    mocks.tx.classroomInstance.findUnique.mockResolvedValue({ ...instance, status: "TEACHING", runtimeConfig: {} });
    mocks.tx.experimentAssessmentSubmission.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "pre" });
    const closed = await getStudentExperimentAssessment(claims, "run", "posttest");
    expect(closed).toMatchObject({ enabled: true, available: false, questions: [] });

    mocks.tx.classroomInstance.findUnique.mockResolvedValue({ ...instance, status: "TEACHING", runtimeConfig: { posttestOpenedAt: "2026-09-25T00:00:00.000Z" } });
    mocks.tx.experimentAssessmentSubmission.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "pre" });
    const opened = await getStudentExperimentAssessment(claims, "run", "posttest");
    expect(opened).toMatchObject({ available: true, questions: [{ id: "q2", prompt: "解释你的方法" }] });
    expect(opened.questions[0]).not.toHaveProperty("correctAnswer");
    mocks.tx.experimentAssessmentSubmission.findUnique.mockResolvedValueOnce({ id: "pre" });
    await expect(submitExperimentAssessment(claims, "run", { phase: "posttest", answers: { q2: "我的解释" } })).resolves.toMatchObject({ phase: "posttest" });
  });

  it("does not release posttest questions when a lesson ends before stage five", async () => {
    mocks.tx.classroomInstance.findUnique.mockResolvedValue({ ...instance, status: "FINISHED", runtimeConfig: { currentStageIndex: 3 } });
    const closed = await getStudentExperimentAssessment(claims, "run", "posttest");
    expect(closed).toMatchObject({ available: false, questions: [], blockedReason: "本场课堂结束前未开放后测" });
    await expect(submitExperimentAssessment(claims, "run", { phase: "posttest", answers: { q2: "说明" } })).rejects.toMatchObject({ code: "POSTTEST_UNAVAILABLE" });
  });

  it("saves partial answers with versions and rejects a stale tab", async () => {
    mocks.tx.classroomInstance.findUnique.mockResolvedValue({ ...instance, status: "TEACHING", runtimeConfig: { posttestOpenedAt: "2026-09-25T00:00:00.000Z" } });
    mocks.tx.experimentAssessmentSubmission.findUnique.mockResolvedValueOnce({ id: "pre" });
    mocks.tx.experimentAssessmentDraft.create.mockImplementation(({ data }) => ({ ...data, version: 1, updatedAt: new Date() }));
    const saved = await saveExperimentAssessmentDraft(claims, "run", { phase: "posttest", answers: { q2: "" }, currentPage: 0, version: 0 });
    expect(saved.draft).toMatchObject({ version: 1, answers: { q2: "" } });
    mocks.tx.experimentAssessmentSubmission.findUnique.mockResolvedValueOnce({ id: "pre" });
    mocks.tx.experimentAssessmentDraft.findUnique.mockResolvedValue({ version: 1 });
    await expect(saveExperimentAssessmentDraft(claims, "run", { phase: "posttest", answers: { q2: "新答案" }, currentPage: 0, version: 0 })).rejects.toMatchObject({ code: "DRAFT_VERSION_CONFLICT" });
  });

  it("accepts a complete assigned form larger than either teacher question bank", async () => {
    const shared = Array.from({ length: 30 }, (_, index) => ({ id: `shared-${index}`, type: "short-answer", prompt: `共用题 ${index}` }));
    const specific = Array.from({ length: 30 }, (_, index) => ({ id: `post-${index}`, type: "short-answer", prompt: `专属题 ${index}` }));
    mocks.tx.classroomInstance.findUnique.mockResolvedValue({ ...instance, status: "FINISHED", runtimeConfig: { currentStageIndex: 4 } });
    mocks.tx.experimentAssessmentAssignment.findUnique.mockResolvedValue({ id: "assignment", pretestForm: shared, posttestForm: [...shared, ...specific] });
    mocks.tx.experimentAssessmentSubmission.findUnique.mockResolvedValueOnce({ id: "pre" });
    const row = await submitExperimentAssessment(claims, "run", { phase: "posttest", answers: Object.fromEntries([...shared, ...specific].map((question) => [question.id, "作答"])) });
    expect((row.questionnaire as { posttest: unknown[] }).posttest).toHaveLength(60);
  });
});
