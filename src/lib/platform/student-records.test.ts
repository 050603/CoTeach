import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";

const mocks = vi.hoisted(() => ({ teacher: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: {} }));
vi.mock("./access", () => ({ requireTeacherUser: mocks.teacher }));

import { getOfferingStudentDetail, getOfferingStudentsSummary, getStudentActivitySubmissions, withdrawOfferingStudent } from "./student-records";

const claims = { sub: "teacher", role: "teacher" } as AuthClaims;
const at = new Date("2026-09-10T08:00:00.000Z");

function dbWithOffering(offering: unknown) {
  return {
    courseTeacher: { findFirst: vi.fn().mockResolvedValue({ id: "link" }) },
    courseOffering: { findUnique: vi.fn().mockResolvedValue(offering) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.teacher.mockResolvedValue({ id: "teacher" });
});

describe("student learning summary", () => {
  it("does not count pre-created NOT_STARTED rows as participation and excludes closed or archived activities from the completion denominator", async () => {
    const offering = {
      id: "offering", name: "设计思维", term: "秋季", status: "OPEN",
      chapters: [{
        id: "chapter", title: "第一章", position: 1, isOpen: true, opensAt: null, archivedAt: null,
        activities: [
          { id: "open", title: "开放作业", type: "ASSIGNMENT", position: 1, isOpen: true, opensAt: null, archivedAt: null },
          { id: "closed", title: "关闭作业", type: "ASSIGNMENT", position: 2, isOpen: false, opensAt: null, archivedAt: null },
          { id: "archived", title: "归档作业", type: "ASSIGNMENT", position: 3, isOpen: true, opensAt: null, archivedAt: at },
        ],
      }],
      enrollments: [{
        id: "enrollment", status: "ACTIVE", joinedAt: at,
        user: { id: "student", username: "student", displayName: "小林" },
        activityProgress: [
          { activityId: "open", status: "NOT_STARTED", startedAt: null, completedAt: null, lastAccessedAt: null },
          { activityId: "closed", status: "COMPLETED", startedAt: at, completedAt: at, lastAccessedAt: at },
        ],
        submissions: [], participations: [],
      }, {
        id: "precreated", status: "ACTIVE", joinedAt: at,
        user: { id: "new-student", username: "new", displayName: "新同学" },
        activityProgress: [{ activityId: "open", status: "NOT_STARTED", startedAt: null, completedAt: null, lastAccessedAt: null }],
        submissions: [], participations: [],
      }],
    };
    const database = dbWithOffering(offering);
    const result = await getOfferingStudentsSummary(claims, "offering", database as never, at);
    expect(result.students[0]).toMatchObject({ participated: true, completedOpenActivities: 0, openActivityCount: 1 });
    expect(result.students[0].attentionReasons).toEqual(["incomplete_open_activity"]);
    expect(result.students[1]).toMatchObject({ participated: false, classroomParticipationCount: 0 });
    expect(result.students[1].attentionReasons).toEqual(["not_participated", "incomplete_open_activity"]);
    expect(result.activities.find((item) => item.id === "archived")?.archived).toBe(true);
    expect(database.courseOffering.findUnique).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({
      enrollments: expect.objectContaining({ where: { status: { in: ["ACTIVE", "active", "COMPLETED", "completed"] } } }),
    }) }));
  });

  it("counts actual classroom runs separately and only flags submitted outcomes without a teacher evaluation", async () => {
    const assemble = (evaluations: Array<{ evaluatorType: string }>) => ({
      id: "offering", name: "课程", term: null, status: "OPEN", chapters: [],
      enrollments: [{
        id: "enrollment", status: "ACTIVE", joinedAt: at, user: { id: "student", username: "s", displayName: "学生" }, activityProgress: [], submissions: [],
        participations: [
          { id: "first-run", firstEnteredAt: new Date("2026-09-09T08:00:00.000Z"), lastEnteredAt: new Date("2026-09-09T09:00:00.000Z"), submissions: [], artifacts: [], reflections: [], evaluations: [] },
          { id: "run", firstEnteredAt: at, lastEnteredAt: at, submissions: [{ status: "SUBMITTED", submittedAt: at }], artifacts: [{ versions: [{ status: "SUBMITTED", submittedAt: at }] }], reflections: [{ createdAt: at }], evaluations },
        ],
      }],
    });
    const pending = await getOfferingStudentsSummary(claims, "offering", dbWithOffering(assemble([])) as never, at);
    expect(pending.students[0]).toMatchObject({ participated: true, classroomParticipationCount: 2 });
    expect(pending.students[0].attentionReasons).toContain("pending_teacher_evaluation");
    const evaluated = await getOfferingStudentsSummary(claims, "offering", dbWithOffering(assemble([{ evaluatorType: "TEACHER" }])) as never, at);
    expect(evaluated.students[0].attentionReasons).not.toContain("pending_teacher_evaluation");
  });

  it("marks a classroom activity started only after entering one of its own runs", async () => {
    const activity = (id: string, position: number) => ({ id, title: id, type: "CLASSROOM", position, isOpen: true, opensAt: null, archivedAt: null });
    const participation = (activityId: string) => ({
      id: `run-${activityId}`, instance: { activityId }, firstEnteredAt: at, lastEnteredAt: at,
      submissions: [], artifacts: [], reflections: [], evaluations: [],
    });
    const offering = {
      id: "offering", name: "课程", term: null, status: "OPEN",
      chapters: [{ id: "chapter", title: "第一章", position: 1, isOpen: true, opensAt: null, archivedAt: null, activities: [activity("target", 1), activity("other", 2)] }],
      enrollments: [{ id: "enrollment", status: "ACTIVE", joinedAt: at, user: { id: "student", username: "s", displayName: "学生" }, activityProgress: [], submissions: [], participations: [participation("other")] }],
    };
    const database = dbWithOffering(offering);
    const result = await getOfferingStudentsSummary(claims, "offering", database as never, at);
    expect(result.students[0].activityStatuses).toEqual({ target: "not_started", other: "in_progress" });
    expect(database.courseOffering.findUnique).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({
      enrollments: expect.objectContaining({ select: expect.objectContaining({ participations: expect.objectContaining({ select: expect.objectContaining({ instance: { select: { activityId: true } } }) }) }) }),
    }) }));
  });

  it("reports no denominator when the course has no open non-classroom activities", async () => {
    const offering = { id: "offering", name: "课程", term: null, status: "OPEN", chapters: [], enrollments: [{ id: "e", status: "ACTIVE", joinedAt: at, user: { id: "s", username: "s", displayName: "学生" }, activityProgress: [], submissions: [], participations: [] }] };
    const result = await getOfferingStudentsSummary(claims, "offering", dbWithOffering(offering) as never, at);
    expect(result.students[0]).toMatchObject({ openActivityCount: 0, completedOpenActivities: 0, participated: false });
    expect(result.students[0].attentionReasons).toEqual(["not_participated"]);
  });

  it("rejects teachers and student identifiers outside the offering", async () => {
    const forbiddenDb = { courseTeacher: { findFirst: vi.fn().mockResolvedValue(null) }, courseOffering: { findUnique: vi.fn() } } as never;
    await expect(getOfferingStudentsSummary(claims, "other", forbiddenDb, at)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    const missingStudentDb = { courseTeacher: { findFirst: vi.fn().mockResolvedValue({ id: "link" }) }, enrollment: { findFirst: vi.fn().mockResolvedValue(null) } } as never;
    await expect(getOfferingStudentDetail(claims, "offering", "foreign-enrollment", missingStudentDb)).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("withdraws a class member without deleting the student or learning records", async () => {
    const update = vi.fn().mockResolvedValue({ id: "enrollment", status: "WITHDRAWN", withdrawnAt: at });
    const database = {
      courseTeacher: { findFirst: vi.fn().mockResolvedValue({ id: "link" }) },
      enrollment: {
        findFirst: vi.fn().mockResolvedValue({ id: "enrollment", user: { id: "student", username: "student", displayName: "小林" } }),
        update,
      },
    } as never;
    const result = await withdrawOfferingStudent(claims, "offering", "enrollment", database, at);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "enrollment" },
      data: { status: "WITHDRAWN", withdrawnAt: at },
    }));
    expect(result).toMatchObject({ enrollmentId: "enrollment", status: "withdrawn", student: { id: "student" } });
  });
});

describe("activity submission history", () => {
  it("paginates immutable attempts in groups of twenty", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: "submission", submittedAt: at, activityVersion: 2, activitySnapshot: {}, payload: {} }]);
    const database = {
      courseTeacher: { findFirst: vi.fn().mockResolvedValue({ id: "link" }) },
      enrollment: { findFirst: vi.fn().mockResolvedValue({ id: "enrollment" }) },
      activity: { findFirst: vi.fn().mockResolvedValue({ id: "activity", title: "", type: "ASSIGNMENT", version: 2, config: {} }) },
      activitySubmission: { count: vi.fn().mockResolvedValue(25), findMany },
      activityProgress: { findUnique: vi.fn() },
    } as never;
    const result = await getStudentActivitySubmissions(claims, "offering", "enrollment", "activity", 2, database);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 20 }));
    expect(result.pagination).toEqual({ total: 25, page: 2, pageSize: 20, hasMore: false });
  });

  it("uses current activity configuration for a legacy projected answer without a snapshot", async () => {
    const database = {
      courseTeacher: { findFirst: vi.fn().mockResolvedValue({ id: "link" }) },
      enrollment: { findFirst: vi.fn().mockResolvedValue({ id: "enrollment" }) },
      activity: { findFirst: vi.fn().mockResolvedValue({ id: "activity", title: "问卷", type: "FORM", version: 3, config: { questions: [] } }) },
      activitySubmission: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
      activityProgress: { findUnique: vi.fn().mockResolvedValue({ progressData: { answers: { q1: "a" } }, completedAt: at }) },
    } as never;
    const result = await getStudentActivitySubmissions(claims, "offering", "enrollment", "activity", 1, database);
    expect(result.submissions[0]).toMatchObject({ snapshotSource: "legacy", activityVersion: 3 });
  });
});
