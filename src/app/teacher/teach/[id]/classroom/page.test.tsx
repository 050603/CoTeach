import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ClassroomToolPopover,
  DEFAULT_CLASSROOM_DATA_SIDEBAR_COLLAPSED,
  deriveMakeStageLearningMetrics,
  formatAverageInteractionCount,
  shouldShowClassroomDataSidebar,
  TimerPanel,
} from "./classroom-page-parts";
import type { ClassroomTimingSnapshot } from "@/lib/classroom/timing";
import type { Course } from "@/lib/session/types";

const snapshot: ClassroomTimingSnapshot = {
  status: "running",
  coursePlannedSec: 3_600,
  courseElapsedSec: 600,
  courseRemainingSec: 3_000,
  scheduleVarianceSec: -60,
  projectedEndAt: "2026-07-28T02:00:00.000Z",
  activeStage: {
    stageKey: "ai-learning",
    label: "AI 授知",
    status: "active",
    plannedSec: 900,
    elapsedSec: 600,
    remainingSec: 300,
    overrunSec: 0,
    progressPercent: 67,
  },
  stages: [
    {
      stageKey: "launch",
      label: "项目启动",
      status: "completed",
      plannedSec: 300,
      elapsedSec: 240,
      remainingSec: 0,
      overrunSec: 0,
      progressPercent: 100,
    },
    {
      stageKey: "ai-learning",
      label: "AI 授知",
      status: "active",
      plannedSec: 900,
      elapsedSec: 600,
      remainingSec: 300,
      overrunSec: 0,
      progressPercent: 67,
    },
  ],
};

describe("TimerPanel", () => {
  it("shows the active-stage countdown and exposes budget adjustments", () => {
    const onAdjust = vi.fn();
    const onTogglePause = vi.fn();
    const onReset = vi.fn();
    render(
      <TimerPanel
        snapshot={snapshot}
        onAdjust={onAdjust}
        onReset={onReset}
        onTogglePause={onTogglePause}
      />,
    );

    expect(screen.getByText("05:00")).toBeTruthy();
    expect(screen.getByText(/知识讲授 · 阶段剩余/)).toBeTruthy();
    expect(screen.getByText("课程已用 / 计划")).toBeTruthy();
    expect(screen.getByText(/提前 1 分/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "-2 分" }));
    fireEvent.click(screen.getByRole("button", { name: "+2 分" }));
    fireEvent.click(screen.getByRole("button", { name: /暂停/ }));
    fireEvent.click(screen.getByRole("button", { name: /重计/ }));
    expect(onAdjust).toHaveBeenNthCalledWith(1, -120);
    expect(onAdjust).toHaveBeenNthCalledWith(2, 120);
    expect(onTogglePause).toHaveBeenCalledOnce();
    expect(onReset).toHaveBeenCalledOnce();
  });
});

describe("classroom data sidebar", () => {
  it("stays collapsed by default in all five teaching stages", () => {
    expect(DEFAULT_CLASSROOM_DATA_SIDEBAR_COLLAPSED).toBe(true);
    for (const stageKey of ["launch", "ai-learning", "make", "showcase", "reflection"]) {
      expect(shouldShowClassroomDataSidebar(stageKey, DEFAULT_CLASSROOM_DATA_SIDEBAR_COLLAPSED)).toBe(false);
    }
  });

  it("can expand in every teaching stage except showcase", () => {
    expect(shouldShowClassroomDataSidebar("showcase", false)).toBe(true);
    expect(shouldShowClassroomDataSidebar("launch", false)).toBe(true);
    expect(shouldShowClassroomDataSidebar("ai-learning", false)).toBe(true);
    expect(shouldShowClassroomDataSidebar("proposal", false)).toBe(true);
    expect(shouldShowClassroomDataSidebar("make", true)).toBe(false);
    expect(shouldShowClassroomDataSidebar("make", false)).toBe(true);
    expect(shouldShowClassroomDataSidebar("reflection", false)).toBe(true);
  });

  it("separates submission, learning alerts, and average AI interactions", () => {
    const course = {
      students: [{ id: "student-1" }, { id: "student-2" }],
      submissions: [],
      projectDocumentVersions: [
        { stageKey: "make", status: "submitted", studentId: "student-1" },
      ],
      projectPdfVersions: [],
      aiInteractionEvents: [
        { stageKey: "make", actorRole: "student", eventType: "request", source: "sidebar", studentId: "student-1" },
        { stageKey: "make", actorRole: "student", eventType: "request", source: "proactive-comment", studentId: "student-1" },
        { stageKey: "make", actorRole: "student", eventType: "request", source: "selection", studentId: "student-2" },
        { stageKey: "make", actorRole: "ai", eventType: "response", studentId: "student-1" },
        { stageKey: "make", actorRole: "ai", eventType: "comment", source: "proactive-comment", studentId: "student-1" },
        { stageKey: "make", actorRole: "ai", eventType: "comment", source: "proactive-comment", studentId: "student-2" },
        { stageKey: "make", actorRole: "student", eventType: "decision", payload: { decision: "adopted" }, studentId: "student-1" },
        { stageKey: "make", actorRole: "student", eventType: "decision", payload: { decision: "rejected" }, studentId: "student-2" },
      ],
      learningSignals: [
        { stageKey: "make", status: "open", severity: "warning", studentId: "student-2" },
        { stageKey: "make", status: "open", severity: "high", studentId: "student-2" },
        { stageKey: "make", status: "resolved", severity: "high", studentId: "student-1" },
      ],
    } as unknown as Course;

    const metrics = deriveMakeStageLearningMetrics(course);

    expect(metrics.submittedStudentIds).toEqual(new Set(["student-1"]));
    expect(metrics.alertedStudentIds).toEqual(new Set(["student-2"]));
    expect(metrics.interactionEvents).toHaveLength(3);
    expect(formatAverageInteractionCount(metrics.averageInteractionCount)).toBe("1.5");
    expect(metrics.proactiveInterventionEvents).toHaveLength(2);
    expect(formatAverageInteractionCount(metrics.averageProactiveInterventionCount)).toBe("1");
    expect(metrics.studentInitiatedConversationEvents).toHaveLength(2);
    expect(metrics.initiatingStudentIds).toEqual(new Set(["student-1", "student-2"]));
    expect(metrics.suggestionDecisionEvents).toHaveLength(2);
    expect(metrics.adoptedSuggestionEvents).toHaveLength(1);
    expect(metrics.suggestionAcceptanceRate).toBe(50);
  });
});

describe("classroom header tools", () => {
  it("anchors desktop tool content to the triggering button wrapper", () => {
    const { container } = render(<ClassroomToolPopover onClose={vi.fn()}><div>工具内容</div></ClassroomToolPopover>);
    const popover = container.firstElementChild;
    expect(popover?.className).toContain("absolute");
    expect(popover?.className).toContain("top-[calc(100%+12px)]");
    expect(screen.getByText("工具内容")).toBeTruthy();
  });
});
