import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";

const mocks = vi.hoisted(() => ({ teacher: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: {} }));
vi.mock("./access", () => ({ requireTeacherUser: mocks.teacher }));

import { createSurveyCsvExport } from "./survey-export";

const claims = { sub: "teacher", role: "teacher" } as AuthClaims;
const submittedAt = new Date("2026-09-14T08:09:10.000Z");
const activity = {
  id: "survey-1",
  title: "学习/体验调查",
  type: "FORM",
  config: {
    schemaVersion: 1,
    content: "",
    questions: [
      {
        id: "focus",
        title: "你最关注什么？",
        type: "single-choice",
        chartType: "donut",
        required: true,
        options: [
          { id: "environment", label: "校园环境" },
          { id: "other", label: "其他", allowTextInput: true },
        ],
      },
      {
        id: "methods",
        title: "你用过哪些方法？",
        type: "multiple-choice",
        chartType: "bar",
        required: true,
        options: [
          { id: "observe", label: "观察" },
          { id: "interview", label: "访谈" },
        ],
      },
      {
        id: "reflection",
        title: "请写下你的发现",
        type: "short-text",
        chartType: "donut",
        required: true,
        options: [],
      },
    ],
  },
  chapter: {
    id: "chapter-1",
    title: "发现问题",
    offeringId: "offering-1",
    offering: { id: "offering-1", name: "设计/思维" },
  },
};

function database(overrides?: { link?: unknown; activity?: typeof activity | null }) {
  return {
    activity: { findUnique: vi.fn().mockResolvedValue(overrides?.activity === undefined ? activity : overrides.activity) },
    courseTeacher: { findFirst: vi.fn().mockResolvedValue(overrides?.link === undefined ? { id: "link" } : overrides.link) },
    activityProgress: { findMany: vi.fn().mockResolvedValue([{
      id: "progress-1",
      completedAt: submittedAt,
      updatedAt: submittedAt,
      progressData: {
        submission: {
          answers: {
            focus: { selected: "other", optionText: { other: "操场照明" } },
            methods: { selected: ["observe", "interview"] },
            reflection: "  =SUM(A1:A2)\n第二行,含逗号  ",
          },
        },
      },
      enrollment: {
        id: "enrollment-1",
        researchKey: "research-1",
        user: { id: "student-1", username: "+student", displayName: "林同学" },
      },
    }]) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.teacher.mockResolvedValue({ id: "teacher" });
});

describe("survey CSV export", () => {
  it("exports each student's latest real response with stable codes and readable labels", async () => {
    const db = database();
    const exported = await createSurveyCsvExport(claims, "survey-1", db as never);

    expect(exported.fileName).toBe("设计-思维-学习-体验调查-问卷数据.csv");
    expect(exported.rowCount).toBe(1);
    expect(exported.csv.charCodeAt(0)).toBe(0xfeff);
    expect(exported.csv).toContain("research_key,student_id,student_username,student_name,submitted_at");
    expect(exported.csv).toContain("Q1 [focus] 你最关注什么？（选项编码）");
    expect(exported.csv).toContain("other,其他：操场照明");
    expect(exported.csv).toContain("observe | interview,观察 | 访谈");
    expect(exported.csv).toContain("'+student");
    expect(exported.csv).toContain("\"'=SUM(A1:A2)\n第二行,含逗号\"");
    expect(exported.csv).toContain(submittedAt.toISOString());
    expect(db.activityProgress.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        activityId: "survey-1",
        status: { in: ["COMPLETED", "completed"] },
        enrollment: {
          offeringId: "offering-1",
          status: { in: ["ACTIVE", "active", "COMPLETED", "completed"] },
        },
      },
    }));
  });

  it("checks teaching membership before reading any response data", async () => {
    const db = database({ link: null });
    await expect(createSurveyCsvExport(claims, "survey-1", db as never)).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
    expect(db.activityProgress.findMany).not.toHaveBeenCalled();
  });

  it("rejects non-questionnaire activities before reading response data", async () => {
    const db = database({ activity: { ...activity, type: "ASSIGNMENT" } });
    await expect(createSurveyCsvExport(claims, "survey-1", db as never)).rejects.toMatchObject({
      code: "INVALID_ACTIVITY",
      status: 400,
    });
    expect(db.activityProgress.findMany).not.toHaveBeenCalled();
  });
});
