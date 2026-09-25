import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import { TeacherStageDashboard } from "./teacher-stage-dashboard";

const supportMocks = vi.hoisted(() => ({
  dashboardAdvice: vi.fn(),
  reflectionSummary: vi.fn(),
}));

vi.mock("@/lib/teaching-ai/client-api", () => ({
  buildTeacherDashboardAdvice: supportMocks.dashboardAdvice,
  buildReflectionClassSummary: supportMocks.reflectionSummary,
}));

function makeCourse(): Course {
  return {
    id: "course-1",
    name: "测试课",
    subject: "综合实践",
    grade: "七年级",
    hours: 2,
    summary: "",
    drivingQuestion: "",
    status: "teaching",
    stages: [
      { key: "launch", label: "项目启动", view: "simple-resource", description: "" },
      { key: "ai-learning", label: "知识讲授", view: "ai-learning", description: "" },
      { key: "make", label: "项目实践", view: "ai-collaboration", description: "" },
      { key: "showcase", label: "成果汇报与评价", view: "showcase-reporting", description: "" },
      { key: "reflection", label: "学习反思", view: "reflection-survey", description: "" },
    ],
    currentStageIndex: 0,
    content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: {} },
    students: [{ id: "s1", name: "小明" }],
    resources: [{ id: "r1", title: "项目说明", type: "PDF", size: "1 MB", stageKey: "launch", downloadedBy: [] }],
    experimentPosttestSummary: {
      enabled: true,
      openedAt: "2026-09-25T08:00:00.000Z",
      notStartedCount: 1,
      inProgressCount: 0,
      submittedCount: 0,
      studentRows: [{ studentId: "s1", status: "not-started" }],
    },
  } as unknown as Course;
}

describe("TeacherStageDashboard", () => {
  beforeEach(() => {
    supportMocks.dashboardAdvice.mockReset();
    supportMocks.reflectionSummary.mockReset();
    supportMocks.dashboardAdvice.mockResolvedValue({
      summary: "当前没有足够证据形成课堂判断。",
      actions: [],
      generatedAt: "2026-09-06T08:30:00.000Z",
      source: "llm",
    });
  });

  it("keeps a compact stage indicator and launch-level follow-up", () => {
    const onFocus = vi.fn();
    const onSelectStage = vi.fn();
    render(<TeacherStageDashboard course={makeCourse()} degraded={false} onCollapse={vi.fn()} onFocus={onFocus} onSelectStage={onSelectStage} stageKey="launch" />);
    expect(screen.getByText("课堂实时监控")).toBeTruthy();
    expect(screen.getByText("项目启动")).toBeTruthy();
    expect(screen.getByText("启动")).toBeTruthy();
    expect(screen.queryByText("轮询")).toBeNull();
    const knowledgeStage = screen.getByRole("button", { name: "第 2 阶段：知识讲授" });
    expect(knowledgeStage.textContent).toBe("2讲授");
    fireEvent.click(knowledgeStage);
    expect(onSelectStage).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole("button", { name: "查看小明的关注证据" }));
    expect(onFocus).toHaveBeenCalledWith(expect.objectContaining({ stageKey: "launch", studentId: "s1", status: "not-opened" }));
    expect(screen.getByRole("button", { name: "第 5 阶段：后测" })).toBeTruthy();
  });

  it("does not start sidebar analysis while the dashboard is inactive", () => {
    render(<TeacherStageDashboard active={false} course={makeCourse()} degraded={false} onCollapse={vi.fn()} onFocus={vi.fn()} onSelectStage={vi.fn()} stageKey="launch" />);
    expect(screen.queryByText("课堂实时监控")).toBeNull();
    expect(supportMocks.dashboardAdvice).not.toHaveBeenCalled();
    expect(supportMocks.reflectionSummary).not.toHaveBeenCalled();
  });

  it("changes the decision model by stage and reports degraded sync honestly", () => {
    render(<TeacherStageDashboard course={makeCourse()} degraded onCollapse={vi.fn()} onFocus={vi.fn()} onSelectStage={vi.fn()} stageKey="reflection" />);
    expect(screen.getByText("同步延迟")).toBeTruthy();
    expect(screen.getByText("后测提交进度")).toBeTruthy();
    expect(screen.getByText("需要跟进")).toBeTruthy();
    expect(screen.queryByText("AI 实时教学建议")).toBeNull();
    expect(screen.queryByText("反思提交进度")).toBeNull();
  });

  it("shows knowledge states as clearly labelled count cards", () => {
    render(<TeacherStageDashboard course={makeCourse()} degraded={false} onCollapse={vi.fn()} onFocus={vi.fn()} onSelectStage={vi.fn()} stageKey="ai-learning" />);
    const section = screen.getByText("全班学习状态").closest("section");
    expect(section?.textContent).toContain("未开始");
    expect(section?.textContent).toContain("1人");
    expect(section?.textContent).toContain("100%");
  });

  it.each([
    ["launch", "优先巡场"],
    ["ai-learning", "优先巡场"],
    ["make", "优先巡场"],
    ["showcase", "现场关注"],
    ["reflection", "个别跟进"],
  ])("provides stage-aware teaching actions for %s", (stageKey, attentionTitle) => {
    render(<TeacherStageDashboard course={makeCourse()} degraded={false} onCollapse={vi.fn()} onFocus={vi.fn()} onSelectStage={vi.fn()} stageKey={stageKey} />);
    if (stageKey !== "reflection") expect(screen.getByText("AI 实时教学建议")).toBeTruthy();
    expect(screen.getByText(attentionTitle)).toBeTruthy();
  });

  it("focuses a student who has not submitted the posttest", () => {
    const onFocus = vi.fn();
    render(<TeacherStageDashboard course={makeCourse()} onCollapse={vi.fn()} onFocus={onFocus} onSelectStage={vi.fn()} stageKey="reflection" />);
    fireEvent.click(screen.getByRole("button", { name: "查看小明的后测状态" }));
    expect(onFocus).toHaveBeenCalledWith({ stageKey: "reflection", target: "student-list", filter: "pending", studentId: "s1" });
  });

  it("shows an empty state when the classroom has no experiment", () => {
    const course = makeCourse();
    course.experimentPosttestSummary = undefined;
    render(<TeacherStageDashboard course={course} onCollapse={vi.fn()} onFocus={vi.fn()} onSelectStage={vi.fn()} stageKey="reflection" />);
    expect(screen.getByText("本课堂未开启后测，请在实验配置中设置后测题目。")).toBeTruthy();
    expect(screen.queryByText("反思提交进度")).toBeNull();
  });

  it("shows whole priority advice and opens the complete set in a centered dialog", async () => {
    supportMocks.dashboardAdvice.mockResolvedValue({
      summary: "三名学生在资料阅读与问题理解上出现不同程度的停滞，建议先巡视明确卡点，再组织一次短讨论。",
      actions: [
        { title: "先巡视小明并确认卡点", detail: "小明已经停留较长时间，请当面询问他是未理解任务要求，还是缺少继续阅读所需的资料。", kind: "patrol", studentIds: ["s1"] },
        { title: "组织两分钟同伴交流", detail: "请让已经完成阅读的学生分享一个关键发现，并邀请仍在浏览的学生提出一个具体问题。", kind: "offline-task", studentIds: [] },
        { title: "核对下一阶段入口", detail: "确认大多数学生完成当前资料后，再开放下一阶段，避免尚未完成的学生失去必要背景。", kind: "next-step", studentIds: [] },
      ],
      generatedAt: "2026-09-06T08:30:00.000Z",
      source: "llm",
    });

    render(<TeacherStageDashboard course={makeCourse()} degraded={false} onCollapse={vi.fn()} onFocus={vi.fn()} onSelectStage={vi.fn()} stageKey="launch" />);

    expect(await screen.findByText("小明已经停留较长时间，请当面询问他是未理解任务要求，还是缺少继续阅读所需的资料。")).toBeTruthy();
    expect(screen.getByText("涉及同学：小明")).toBeTruthy();
    expect(screen.getByText("请让已经完成阅读的学生分享一个关键发现，并邀请仍在浏览的学生提出一个具体问题。")).toBeTruthy();
    expect(screen.queryByText("核对下一阶段入口")).toBeNull();
    expect(screen.queryByText("三名学生在资料阅读与问题理解上出现不同程度的停滞，建议先巡视明确卡点，再组织一次短讨论。")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /还有 1 条建议，查看全部/ }));

    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(screen.getByText("AI 实时教学建议 · 项目启动")).toBeTruthy();
    expect(screen.getByText("三名学生在资料阅读与问题理解上出现不同程度的停滞，建议先巡视明确卡点，再组织一次短讨论。")).toBeTruthy();
    expect(screen.getByText("核对下一阶段入口")).toBeTruthy();
    expect(screen.getByText("确认大多数学生完成当前资料后，再开放下一阶段，避免尚未完成的学生失去必要背景。")).toBeTruthy();
  });

  it("uses the concise empty label when no action is necessary", async () => {
    render(<TeacherStageDashboard course={makeCourse()} degraded={false} onCollapse={vi.fn()} onFocus={vi.fn()} onSelectStage={vi.fn()} stageKey="launch" />);

    expect(await screen.findByText("暂无建议")).toBeTruthy();
  });
});
