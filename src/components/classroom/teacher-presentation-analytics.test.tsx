import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import { TeacherPresentationAnalytics } from "./teacher-presentation-analytics";
import { deriveTeacherClassroomPulse } from "./teacher-classroom-pulse";

function makeCourse(overrides: Partial<Course> = {}): Course {
  return {
    id: "course-1", name: "测试课堂", subject: "综合实践", grade: "七年级", hours: 2,
    summary: "", drivingQuestion: "", status: "teaching", stages: [], currentStageIndex: 0,
    content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: {} },
    students: [{ id: "s1", name: "隐藏姓名小明" }, { id: "s2", name: "隐藏姓名小华" }],
    resources: [{ id: "r1", title: "项目说明", type: "PDF", size: "1 MB", stageKey: "launch", downloadedBy: ["s1"] }],
    ...overrides,
  } as Course;
}

describe("TeacherPresentationAnalytics", () => {
  it.each([
    ["launch", "资料阅读覆盖", "已完成0、阅读中1、未打开1"],
    ["ai-learning", "知识掌握汇总", "已完成0、学习中0、未开始2"],
    ["make", "AI 协作汇总", "已提交0、编制中0、待形成2"],
    ["showcase", "汇报安排", "已评价0、进行中0、等待中0、未就绪2"],
    ["reflection", "反思评价分布", "已提交0、待提交2"],
  ])("shows aggregate-only %s data and lets the teacher explicitly open details", (stageKey, title, distribution) => {
    const onDetails = vi.fn();
    const { container } = render(<TeacherPresentationAnalytics course={makeCourse()} stageKey={stageKey} onDetails={onDetails} />);
    expect(screen.getByRole("region", { name: title })).toBeTruthy();
    expect(screen.getByRole("img", { name: distribution })).toBeTruthy();
    expect(container.textContent).not.toContain("隐藏姓名");
    expect(onDetails).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "查看明细" }));
    expect(onDetails).toHaveBeenCalledOnce();
    fireEvent.click(screen.getAllByRole("button")[1]!);
    expect(onDetails).toHaveBeenCalledTimes(2);
  });

  it("shows an explicit empty state for legacy stages instead of reflection statistics", () => {
    render(<TeacherPresentationAnalytics course={makeCourse()} stageKey="legacy-inquiry" onDetails={vi.fn()} />);
    expect(screen.getByText("当前阶段暂无可用统计")).toBeTruthy();
    expect(screen.queryByText("反思提交状态")).toBeNull();
    expect(deriveTeacherClassroomPulse(makeCourse(), "legacy-inquiry").metrics).toEqual([]);
  });

  it.each(["launch", "ai-learning", "make", "showcase", "reflection"])("represents an empty %s classroom without inventing percentages", (stageKey) => {
    const { container } = render(<TeacherPresentationAnalytics course={makeCourse({ students: [], resources: [] })} stageKey={stageKey} onDetails={vi.fn()} />);
    expect(screen.getByText("暂无学生加入课堂")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.textContent).not.toMatch(/NaN|Infinity|0\/0/);
  });

  it("preserves observed values while marking a delayed snapshot", () => {
    render(<TeacherPresentationAnalytics course={makeCourse()} stageKey="launch" degraded onDetails={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toContain("数据同步延迟");
    expect(screen.getByRole("button", { name: /资料阅读覆盖率/ }).textContent).toContain("50%");
    expect(screen.getByRole("button", { name: /全部资料浏览完成/ }).textContent).toContain("0/2");
  });

  it("shows missing reading records as missing, not a measured zero", () => {
    const course = makeCourse();
    course.resources![0]!.downloadedBy = [];
    render(<TeacherPresentationAnalytics course={course} stageKey="launch" onDetails={vi.fn()} />);
    expect(screen.getByRole("button", { name: /资料阅读覆盖率/ }).textContent).toContain("—");
  });

  it("uses only the latest valid reflection for each current student and hides individual text", () => {
    const record = (id: string, studentId: string, updatedAt: string, score: number) => ({
      id, studentId, updatedAt, content: "个人问题不可投影", survey: {
        schemaVersion: 1, learningReflection: "个人反思不可投影", systemReflection: "个人意见不可投影",
        aiHelpfulness: score, systemUsability: score, reuseIntention: score,
      },
    });
    const course = makeCourse({ reflections: [
      record("old", "s1", "2026-01-01", 1), record("new", "s1", "2026-01-02", 5),
      record("removed", "former-student", "2026-01-02", 2),
    ] as Course["reflections"] });
    const { container } = render(<TeacherPresentationAnalytics course={course} stageKey="reflection" onDetails={vi.fn()} />);
    const distribution = screen.getByRole("region", { name: "反思评价分布" });
    expect(within(distribution).getAllByText("1 分：0 2 分：0 3 分：0 4 分：0 5 分：1")).toHaveLength(3);
    expect(container.textContent).not.toContain("不可投影");
    expect(container.textContent).not.toContain("隐藏姓名");
  });
});
