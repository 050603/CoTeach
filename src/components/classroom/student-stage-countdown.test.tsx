import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pauseClassroomTiming, transitionClassroomStageTiming, type ClassroomTimingState } from "@/lib/classroom/timing";
import type { Course } from "@/lib/session/types";
import { StudentClassroomHeaderStatus } from "./student-classroom-header-status";
import { StudentStageCountdown } from "./student-stage-countdown";

vi.mock("@/components/student-leave-button", () => ({
  StudentLeaveButton: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));

const startedAt = "2026-09-25T02:00:00.000Z";
const stages = [
  { key: "launch", label: "项目启动", view: "simple-resource", description: "了解任务" },
  { key: "make", label: "项目实践", view: "ai-collaboration", description: "完成作品" },
] as Course["stages"];

function makeTiming(): ClassroomTimingState {
  return {
    schemaVersion: 1,
    status: "running",
    sessionStartedAt: startedAt,
    activeStageKey: "launch",
    lastResumedAt: startedAt,
    updatedAt: startedAt,
    stages: [
      { stageKey: "launch", label: "项目启动", basePlannedSec: 120, adjustmentSec: 0, elapsedSec: 0, status: "active", startedAt },
      { stageKey: "make", label: "项目实践", basePlannedSec: 180, adjustmentSec: 0, elapsedSec: 0, status: "pending" },
    ],
  };
}

function makeCourse(timing = makeTiming(), currentStageIndex = 0): Course {
  return {
    id: "course-1",
    status: "teaching",
    stages,
    currentStageIndex,
    content: { stagePlan: { stages: [
      { key: "launch", durationMin: 2 },
      { key: "make", durationMin: 3 },
    ] } },
    uiState: { classroomTiming: timing },
  } as unknown as Course;
}

describe("StudentStageCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(startedAt);
  });

  afterEach(() => vi.useRealTimers());

  it("counts down from the shared classroom clock and respects a teacher pause", () => {
    const { rerender } = render(<StudentStageCountdown course={makeCourse()} />);
    expect(screen.getByRole("timer").textContent).toBe("02:00");
    expect(screen.getByLabelText(/项目启动 · 预设 2 分钟 · 剩余 02:00/)).toBeTruthy();

    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByRole("timer").textContent).toBe("01:30");

    const paused = pauseClassroomTiming(makeTiming(), new Date().toISOString());
    rerender(<StudentStageCountdown course={makeCourse(paused)} />);
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByText("已暂停")).toBeTruthy();
    expect(screen.getByRole("timer").textContent).toBe("01:30");
  });

  it("shows overtime and never reuses the previous stage's clock during a transition", () => {
    const { rerender } = render(<StudentStageCountdown course={makeCourse()} />);
    act(() => vi.advanceTimersByTime(125_000));
    expect(screen.getByText("已超时")).toBeTruthy();
    expect(screen.getByRole("timer").textContent).toBe("+00:05");

    rerender(<StudentStageCountdown course={makeCourse(makeTiming(), 1)} />);
    expect(screen.getByRole("timer").textContent).toBe("--:--");
    expect(screen.getByText("时间同步中")).toBeTruthy();

    const next = transitionClassroomStageTiming(makeTiming(), "make", new Date().toISOString());
    rerender(<StudentStageCountdown course={makeCourse(next, 1)} />);
    expect(screen.getByRole("timer").textContent).toBe("03:00");
    expect(screen.getByLabelText(/项目实践 · 预设 3 分钟 · 剩余 03:00/)).toBeTruthy();
  });

  it("shows the top bar clock only during project practice", () => {
    const { rerender } = render(<StudentClassroomHeaderStatus course={makeCourse()} />);
    expect(screen.queryByRole("timer")).toBeNull();

    const practiceTiming = transitionClassroomStageTiming(makeTiming(), "make", startedAt);
    const practiceCourse = makeCourse(practiceTiming, 1);
    rerender(<StudentClassroomHeaderStatus course={practiceCourse} />);
    expect(screen.queryByRole("timer")).toBeNull();

    rerender(<StudentClassroomHeaderStatus course={{
      ...practiceCourse,
      currentStageIndex: 2,
      stages: [
        stages[0]!,
        { key: "ai-learning", label: "知识讲授", view: "ai-learning", description: "学习知识" },
        stages[1]!,
      ],
    }} />);
    expect(screen.getByRole("timer").textContent).toBe("03:00");
    expect(screen.getByRole("button", { name: "离开" })).toBeTruthy();
    expect(screen.queryByText(/在线人数|在线 \d+/)).toBeNull();
  });
});
