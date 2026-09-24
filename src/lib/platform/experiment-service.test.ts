import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";

const mocks = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    classroomInstance: { findUnique: vi.fn() },
    enrollment: { findUnique: vi.fn() },
    classroomParticipation: { findUnique: vi.fn() },
    experimentAssessmentSubmission: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    experimentAssessmentAssignment: { findUnique: vi.fn(), count: vi.fn(), create: vi.fn(), findMany: vi.fn() },
  };
  return { tx, transaction: vi.fn(), student: vi.fn(), teacher: vi.fn(), link: vi.fn(), results: vi.fn(), count: vi.fn() };
});
vi.mock("@/lib/db/client", () => ({ prisma: {
  classroomInstance: mocks.tx.classroomInstance,
  courseTeacher: { findFirst: mocks.link },
  enrollment: { count: mocks.count },
  experimentAssessmentSubmission: { findMany: mocks.results },
  experimentAssessmentAssignment: { findMany: mocks.tx.experimentAssessmentAssignment.findMany },
} }));
vi.mock("@/lib/db/transaction-retry", () => ({ runMutationTransaction: mocks.transaction }));
vi.mock("./access", () => ({ requireStudentUser: mocks.student, requireTeacherUser: mocks.teacher }));

import { ensureExperimentAssignment, getClassroomExperimentResults, submitExperimentAssessment } from "./experiment-service";

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
  mocks.tx.classroomParticipation.findUnique.mockResolvedValue({ id: "participation" });
  mocks.tx.experimentAssessmentSubmission.create.mockImplementation(({ data }) => ({ ...data, submittedAt: new Date() }));
});

describe("classroom experiment submissions", () => {
  it("accepts a pretest before the lesson and stores a run-specific question snapshot", async () => {
    const row = await submitExperimentAssessment(claims, "run", { phase: "pretest", answers: { q1: "乙" } });
    expect(row).toMatchObject({ instanceId: "run", enrollmentId: "enrollment", phase: "pretest", researchKey: "anonymous", objectiveScore: 1, objectiveTotal: 1 });
    expect(mocks.tx.experimentAssessmentSubmission.create.mock.calls[0][0].data.questionnaire).toMatchObject(experiment);
    expect(mocks.tx.experimentAssessmentSubmission.create.mock.calls[0][0].data.questionnaire).not.toHaveProperty("randomizeQuestionOrder");
    expect(row).toMatchObject({ assignmentId: "assignment" });
    expect(mocks.tx.$queryRaw.mock.calls[0][0].join("")).toContain('FROM "ClassroomInstance"');
    expect(mocks.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.tx.experimentAssessmentAssignment.findUnique.mock.invocationCallOrder[0]);
  });

  it("requires class completion and the student's pretest plus participation before a posttest", async () => {
    await expect(submitExperimentAssessment(claims, "run", { phase: "posttest", answers: { q2: "说明" } })).rejects.toMatchObject({ code: "POSTTEST_UNAVAILABLE" });
    mocks.tx.classroomInstance.findUnique.mockResolvedValue({ ...instance, status: "FINISHED" });
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
    mocks.count.mockResolvedValue(2);
    mocks.results.mockResolvedValue([{ id: "submission", phase: "pretest", researchKey: "anonymous", submittedAt: new Date(), questionnaire: experiment, answers: { q1: "乙" }, objectiveScore: 1, objectiveTotal: 1, assignment: { variant: "A_PRE_B_POST" }, enrollment: { user: { displayName: "学生甲", username: "s1" } } }]);
    const result = await getClassroomExperimentResults({ role: "teacher", sub: "teacher" } as AuthClaims, "run");
    expect(result).toMatchObject({ enabled: true, enrollmentCount: 2, pretestCount: 1, posttestCount: 0, variantCounts: { aPreBPost: 1, bPreAPost: 1 }, submissions: [{ variant: "A_PRE_B_POST", student: { displayName: "学生甲" } }] });
    expect(result.submissions[0]).not.toHaveProperty("researchKey");
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
});
