import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import { pauseClassroomTiming, resumeClassroomTiming, type ClassroomTimingState } from "@/lib/classroom/timing";
import { StageTaskPresentation } from "./stage-task-presentation";
import { adaptPersonalProjectText, emptyResourcePackageDraft } from "@/lib/resource-package/types";

describe("StageTaskPresentation", () => {
  afterEach(() => vi.useRealTimers());

  it("uses only current-stage authored goals and student deliverables, including old stage keys", () => {
    const course = {
      stages: [{ key: "proposal", label: "方案设计", description: "比较两种方案" }],
      currentStageIndex: 0,
      content: { teachingOutline: [
        { id: "other", stageKey: "make", title: "不属于本阶段的任务", studentActivity: "制作最终成果" },
        { id: "current", stageKey: "proposal", title: "方案比选", teachingGoal: "用证据比较方案", studentActivity: "提交比较表", teacherRole: "个别巡视名单", notes: "教师私人备课笔记" },
      ] },
    } as unknown as Course;
    render(<StageTaskPresentation course={course} />);
    expect(screen.getByRole("heading", { name: "方案设计" })).toBeTruthy();
    expect(screen.getByText("比较两种方案")).toBeTruthy();
    expect(screen.getByText("学习目标：用证据比较方案")).toBeTruthy();
    expect(screen.getByText("任务与交付：提交比较表")).toBeTruthy();
    expect(screen.queryByText("不属于本阶段的任务")).toBeNull();
    expect(screen.queryByText("个别巡视名单")).toBeNull();
    expect(screen.queryByText("教师私人备课笔记")).toBeNull();
  });

  it("has an explicit empty state when the stage has no authored task", () => {
    render(<StageTaskPresentation course={{ stages: [], content: {} } as unknown as Course} />);
    expect(screen.getByText("本阶段暂无任务或展示资料。")).toBeTruthy();
  });

  it("presents the driving question prominently when no separate project task was authored", () => {
    const course = {
      stages: [{ key: "make", label: "项目实践", description: "完成个人方案" }],
      currentStageIndex: 0,
      drivingQuestion: "如何改善校园环境？",
      content: { teachingOutline: [] },
    } as unknown as Course;
    render(<StageTaskPresentation course={course} />);
    expect(screen.queryByRole("heading", { name: "项目实践" })).toBeNull();
    expect(screen.getByRole("heading", { name: "任务驱动问题" })).toBeTruthy();
    expect(screen.getByText("如何改善校园环境？")).toBeTruthy();
    expect(screen.getByText("如何改善校园环境？").className).toContain("font-bold");
    expect(screen.queryByRole("heading", { name: "项目任务" })).toBeNull();
    expect(screen.getByText("完成个人方案")).toBeTruthy();
  });

  it("shows the third-stage project task and requirements without evaluation criteria or private notes", () => {
    const draft = emptyResourcePackageDraft();
    const course = { currentStageIndex: 0, stages: [{ key: "make", label: "项目实践", description: "旧的默认说明" }], drivingQuestion: "如何设计一堂有趣的 AI 体验课？", content: { teachingOutline: [], stagePlan: {
      ...draft, schemaVersion: 1, source: "resource-package", totalMinutes: 135,
      stages: draft.stages.map((stage) => ({ ...stage, durationMin: 60, requirements: adaptPersonalProjectText("每组4人，比较教学方案"), outputs: "提交个人教案", teacherActions: "教师私人提示" })),
      projectTask: "设计一堂面向六年级的 AI 体验课",
      evaluationCriteria: "用理论解释设计选择",
    } } } as unknown as Course;
    render(<StageTaskPresentation course={course} />);
    expect(screen.queryByRole("heading", { name: "项目实践" })).toBeNull();
    expect(screen.getByRole("heading", { name: "任务驱动问题" })).toBeTruthy();
    expect(screen.getByText("如何设计一堂有趣的 AI 体验课？")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "项目任务" })).toBeTruthy();
    const details = screen.getByRole("region", { name: "项目任务说明" });
    const timer = screen.getByRole("complementary", { name: "项目制作计时" });
    expect(timer.parentElement).toBe(details.parentElement);
    expect(timer.parentElement?.className).toContain("lg:grid-cols-");
    expect(screen.getByText("设计一堂面向六年级的 AI 体验课")).toBeTruthy();
    expect(screen.getByText(/任务要求：每位学生与自己的 AI 伙伴协作/)).toBeTruthy();
    expect(screen.getByText("交付要求：提交个人教案")).toBeTruthy();
    expect(screen.queryByText(/评价标准/)).toBeNull();
    expect(screen.queryByText("用理论解释设计选择")).toBeNull();
    expect(screen.queryByText("旧的默认说明")).toBeNull();
    expect(screen.queryByText("教师私人提示")).toBeNull();
  });

  it("shows a flip countdown with one control entry and keeps pause and overtime in sync", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-27T10:00:00.000Z");
    const timing: ClassroomTimingState = {
      schemaVersion: 1,
      status: "running",
      sessionStartedAt: "2026-09-27T10:00:00.000Z",
      activeStageKey: "make",
      lastResumedAt: "2026-09-27T10:00:00.000Z",
      updatedAt: "2026-09-27T10:00:00.000Z",
      stages: [{ stageKey: "make", label: "项目实践", basePlannedSec: 60, adjustmentSec: 0, elapsedSec: 0, status: "active" }],
    };
    const course = { currentStageIndex: 0, stages: [{ key: "make", label: "项目实践" }],
      content: { stagePlan: { stages: [{ key: "make", durationMin: 1 }] } },
      uiState: { classroomTiming: timing },
    } as unknown as Course;
    const controls = { onTogglePause: vi.fn(), onAdjust: vi.fn(), onReset: vi.fn() };
    const { rerender } = render(<StageTaskPresentation course={course} timerControls={controls} />);
    expect(screen.getByRole("timer").textContent).toBe("01:00");
    expect(screen.queryByText(/限定制作时间|请在限定制作时间内完成/)).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "计时控制" }));
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    fireEvent.click(screen.getByRole("button", { name: "-2 分" }));
    fireEvent.click(screen.getByRole("button", { name: "+2 分" }));
    fireEvent.click(screen.getByRole("button", { name: "重计" }));
    expect(controls.onTogglePause).toHaveBeenCalledOnce();
    expect(controls.onAdjust.mock.calls).toEqual([[-120], [120]]);
    expect(controls.onReset).toHaveBeenCalledOnce();

    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByRole("timer").textContent).toBe("00:30");
    const paused = pauseClassroomTiming(timing, new Date().toISOString());
    rerender(<StageTaskPresentation course={{ ...course, uiState: { classroomTiming: paused } }} timerControls={controls} />);
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByText(/已暂停/)).toBeTruthy();
    expect(screen.getByRole("timer").textContent).toBe("00:30");
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(controls.onTogglePause).toHaveBeenCalledTimes(2);

    const resumed = resumeClassroomTiming(paused, new Date().toISOString());
    rerender(<StageTaskPresentation course={{ ...course, uiState: { classroomTiming: resumed } }} timerControls={controls} />);
    act(() => vi.advanceTimersByTime(35_000));
    expect(screen.getByRole("timer").textContent).toBe("+00:05");
    expect(screen.getByText(/已超时/)).toBeTruthy();
  });
});
