import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getStagesForSystemMode } from "@/lib/system-mode";
import type { AiSupportRecord, Course } from "@/lib/session/types";
import { NewReflectionTeacherView } from "./reflection-survey";
import { REFLECTION_SURVEY_QUESTIONS } from "@/lib/reflection-survey";

const summaryApi = vi.hoisted(() => vi.fn());
vi.mock("@/lib/teaching-ai/client-api", () => ({ buildReflectionClassSummary: summaryApi }));
vi.mock("@/components/platform/survey-word-cloud", () => ({
  SurveyWordCloud: ({ terms }: { terms: Array<{ label: string; value: number }> }) => <div aria-label="词云画布">{terms.map((term) => <span key={term.label}>{term.label}</span>)}</div>,
}));

vi.mock("@/lib/session/store", () => ({
  useSession: () => ({
    user: { role: "teacher", name: "教师" },
    studentId: undefined,
    studentName: undefined,
    markResourceDownloaded: vi.fn(),
  }),
}));

function makeCourse(overrides: Partial<Course> = {}): Course {
  const now = "2026-08-01T00:00:00.000Z";
  return {
    id: "course-1",
    name: "校园减塑",
    subject: "科学",
    grade: "六年级",
    hours: 5,
    summary: "完成个人项目",
    drivingQuestion: "如何改善校园环境？",
    status: "teaching",
    stages: getStagesForSystemMode("new"),
    currentStageIndex: 4,
    students: [
      { id: "student-1", name: "小林", joinedAt: now, stageProgress: {} },
      { id: "student-2", name: "小周", joinedAt: now, stageProgress: {} },
    ],
    reflections: [{
      id: "reflection-1",
      courseId: "course-1",
      studentId: "student-1",
      studentName: "小林",
      content: "兼容文本",
      survey: {
        schemaVersion: 1,
        learningReflection: "通过数据修改了方案。",
        systemReflection: "AI 提问很有帮助。",
        aiHelpfulness: 4,
        systemUsability: 5,
        reuseIntention: 4,
      },
      createdAt: now,
      updatedAt: "2026-08-01T00:10:00.000Z",
    }],
    resources: [],
    groups: [],
    content: {
      pblOutline: "",
      knowledgePoints: [],
      lessonOutline: [],
      evaluationPlan: { dimensions: [], overallRubric: "" },
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("NewReflectionTeacherView", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps detailed distributions and unsubmitted students in the main work area", () => {
    render(<NewReflectionTeacherView course={makeCourse()} />);

    expect(screen.queryByText("提交率 50%")).toBeNull();
    expect(screen.getAllByText("4.0").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("img", { name: "AI 引导帮助：1分0人、2分0人、3分0人、4分1人、5分0人" })).toBeTruthy();
    expect(screen.getAllByText("同意 100%").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("小周")).toBeTruthy();
    expect(screen.getByText("待提交")).toBeTruthy();
    expect((screen.getByRole("button", { name: "导出 CSV" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("reveals the two open answers for a selected student", () => {
    render(<NewReflectionTeacherView course={makeCourse()} />);

    fireEvent.click(screen.getByRole("button", { name: "小林的反思详情" }));
    expect(screen.getAllByText("通过数据修改了方案。").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("AI 提问很有帮助。").length).toBeGreaterThanOrEqual(1);
  });

  it("disables export when no structured responses exist", () => {
    const course = makeCourse({ reflections: [] });
    render(<NewReflectionTeacherView course={course} />);
    expect((screen.getByRole("button", { name: "导出 CSV" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("暂无有效回答")).toBeTruthy();
  });
});


describe("reflection projection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("projects the first question without student answers and resets an open personal dialog", () => {
    const course = makeCourse();
    const { rerender } = render(<NewReflectionTeacherView course={course} />);
    fireEvent.click(screen.getByRole("button", { name: "小林的反思详情" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    rerender(<NewReflectionTeacherView course={course} presentation="teaching" />);
    expect(screen.getByRole("heading", { name: REFLECTION_SURVEY_QUESTIONS.learningReflection })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("小林")).toBeNull();
    expect(screen.queryByText("通过数据修改了方案。")).toBeNull();
    rerender(<NewReflectionTeacherView course={course} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

function summarySupport(course: Course): AiSupportRecord {
  return {
    id: "summary-projection", courseId: course.id, targetType: "course", targetId: course.id,
    kind: "reflection-class-summary", updatedAt: "2026-09-05T12:00:00.000Z",
    structuredPayload: {
      schemaVersion: 1, trigger: "manual", generatedAt: "2026-09-05T12:00:00.000Z",
      courseSummary: "学会依据证据修订方案。", responseCount: 1, totalStudentCount: 2, teachingRecommendations: ["教师应单独辅导小林"],
      sourceRefs: course.reflections!.map((reflection) => ({ reflectionId: reflection.id, studentId: reflection.studentId, updatedAt: reflection.updatedAt })),
      categories: [{ key: "learning-gains", title: "主要收获", summary: "学会依据证据修订方案。", terms: [
        { label: "证据比较", sources: [{ studentId: "student-1", fields: ["learningReflection"] }] },
        { label: "方案改进", sources: [{ studentId: "student-1", fields: ["learningReflection"] }] },
      ] }],
    },
  } as unknown as AiSupportRecord;
}

it("uses the existing summary for the question cloud without requesting analysis or exposing recommendations", () => {
  summaryApi.mockClear();
  const course = makeCourse();
  course.aiSupports = [summarySupport(course)];
  render(<NewReflectionTeacherView course={course} presentation="teaching" />);
  expect(screen.getByText("证据比较")).toBeTruthy();
  expect(screen.getByText("方案改进")).toBeTruthy();
  expect(screen.queryByText("教师应单独辅导小林")).toBeNull();
  expect(screen.queryByText("小林")).toBeNull();
  expect(summaryApi).not.toHaveBeenCalled();
});

it("refreshes the cloud only on request through the existing summary API and allows retry after failure", async () => {
  const course = makeCourse();
  course.students = course.students.slice(0, 1);
  summaryApi.mockReset().mockRejectedValueOnce(new Error("分析暂不可用")).mockResolvedValueOnce(summarySupport(course));
  render(<NewReflectionTeacherView course={course} presentation="teaching" />);
  expect(summaryApi).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "更新词云" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("分析暂不可用"));
  expect(summaryApi).toHaveBeenCalledWith(course.id, "manual");
  fireEvent.click(screen.getByRole("button", { name: "更新词云" }));
  await waitFor(() => expect(screen.getByText("证据比较")).toBeTruthy());
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("教师应单独辅导小林")).toBeNull();
  expect(summaryApi).toHaveBeenCalledTimes(2);
});
