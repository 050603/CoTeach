import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import { TeacherPresentationActionsProvider } from "@/components/classroom/teacher-presentation-actions";

const { hostPropsSpy, hostUnmountSpy } = vi.hoisted(() => ({
  hostPropsSpy: vi.fn(),
  hostUnmountSpy: vi.fn(),
}));

vi.mock("@/components/openmaic-bridge/student-stage-host", async () => {
  const React = await import("react");
  return {
    StudentStageHost: (props: Record<string, unknown>) => {
      hostPropsSpy(props);
      React.useEffect(() => () => hostUnmountSpy(), []);
      return <div data-testid="student-stage-host">课程播放器</div>;
    },
  };
});

import { AiLearningTeacherPreview } from "./ai-learning-preview";

const knowledgeGraph = {
  nodes: [{ id: "kp-1", label: "像素", description: "数字图像基础" }],
  edges: [],
};

const course = {
  id: "course-1",
  name: "计算机视觉",
  aiLearningClassroomId: "classroom-1",
  content: {
    knowledgePoints: [{ id: "kp-1", name: "像素", description: "数字图像基础" }],
    knowledgeGraph,
  },
} as unknown as Course;

describe("AiLearningTeacherPreview", () => {
  beforeEach(() => vi.clearAllMocks());

  it("controls the same teacher preview from the fullscreen footer", () => {
    const target = render(<div />).container.firstElementChild as HTMLElement;
    render(<TeacherPresentationActionsProvider target={target}>
      <AiLearningTeacherPreview course={course} presentation="teaching" />
    </TeacherPresentationActionsProvider>);
    const player = screen.getByTestId("student-stage-host");
    fireEvent.click(within(target).getByRole("button", { name: "课程目录" }));
    expect(hostPropsSpy).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "teacher-preview", sidebarCollapsed: false }));
    fireEvent.click(within(target).getByRole("button", { name: "收起课程目录" }));
    expect(hostPropsSpy).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "teacher-preview", sidebarCollapsed: true }));
    expect(screen.getByTestId("student-stage-host")).toBe(player);
  });

  it("starts collapsed and unmounts the normal-page player when collapsed again", () => {
    render(<AiLearningTeacherPreview course={course} />);

    const toggle = screen.getByRole("button", { name: /学生知识讲授课程预览/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("student-stage-host")).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByTestId("student-stage-host")).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(toggle);
    expect(screen.queryByTestId("student-stage-host")).toBeNull();
    expect(hostUnmountSpy).toHaveBeenCalledTimes(1);
  });

  it("opens the page rail and supplies the knowledge graph to the player", () => {
    render(<AiLearningTeacherPreview course={course} />);
    fireEvent.click(screen.getByRole("button", { name: /学生知识讲授课程预览/ }));

    expect(hostPropsSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      classroomId: "classroom-1",
      mode: "teacher-preview",
      sidebarCollapsed: false,
      knowledgeGraph,
      knowledgePoints: course.content.knowledgePoints,
    }));
    expect(screen.getByText(/左侧缩略页快速切换/)).toBeTruthy();
  });

  it("labels measured TTS duration separately from the no-TTS estimate", () => {
    const timedCourse = structuredClone(course);
    timedCourse.content.teachingTimingAudit = {
      schemaVersion: 1, totalBudgetSec: 1_800, plannedSubstantiveTeachingSec: 1_224,
      plannedAssessmentSec: 360, plannedLearnerActivitySec: 216,
      substantiveTeachingDurationSec: 1_206, assessmentAudioDurationSec: 82,
      narrationDurationSource: "actual-audio", measuredSegmentCount: 8, narrationSegmentCount: 8,
      complete: true, substantiveTeachingRatio: 0.67, teachingRatioValid: true, generatedAt: "2026-09-17T00:00:00Z",
    };
    const view = render(<AiLearningTeacherPreview course={timedCourse} />);
    expect(screen.getByText(/讲授音频实测 20.1 分钟/)).toBeTruthy();
    timedCourse.content.teachingTimingAudit.narrationDurationSource = "estimated-script";
    timedCourse.content.teachingTimingAudit.substantiveTeachingDurationSec = 1_224;
    view.rerender(<AiLearningTeacherPreview course={timedCourse} />);
    expect(screen.getByText(/讲授时长估算 20.4 分钟（TTS 未开启）/)).toBeTruthy();
  });

  it("retains one teacher-only player across presentation switches and restores the normal workspace rail", () => {
    const view = render(<AiLearningTeacherPreview course={course} />);
    fireEvent.click(screen.getByRole("button", { name: /学生知识讲授课程预览/ }));
    const player = screen.getByTestId("student-stage-host");
    const unmounts = hostUnmountSpy.mock.calls.length;

    view.rerender(<AiLearningTeacherPreview course={course} presentation="teaching" />);
    expect(screen.getByTestId("student-stage-host")).toBe(player);
    expect(hostPropsSpy).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "teacher-preview", sidebarCollapsed: true }));
    view.rerender(<AiLearningTeacherPreview course={course} presentation="analytics" />);
    expect(player.closest('[hidden]')).toBeTruthy();
    view.rerender(<AiLearningTeacherPreview course={course} presentation="teaching" />);
    view.rerender(<AiLearningTeacherPreview course={course} />);
    expect(screen.getByTestId("student-stage-host")).toBe(player);
    expect(player.closest('[hidden]')).toBeNull();
    expect(screen.getByRole("button", { name: /学生知识讲授课程预览/ })).toBeTruthy();
    expect(hostUnmountSpy).toHaveBeenCalledTimes(unmounts);
  });

  it("hides the workspace preview when immersive operations disable it", () => {
    render(<AiLearningTeacherPreview course={course} workspacePreviewEnabled={false} />);
    expect(screen.queryByRole("button", { name: /课程预览/ })).toBeNull();
    expect(screen.queryByTestId("student-stage-host")).toBeNull();
  });

  it("opens the course immediately for teaching and keeps it mounted after returning to a collapsed workspace", () => {
    const view = render(<AiLearningTeacherPreview course={course} presentation="teaching" />);
    const player = screen.getByTestId("student-stage-host");
    view.rerender(<AiLearningTeacherPreview course={course} />);
    expect(screen.getByTestId("student-stage-host")).toBe(player);
    expect(player.closest('[hidden]')).toBeTruthy();
    view.rerender(<AiLearningTeacherPreview course={course} presentation="teaching" />);
    expect(screen.getAllByTestId("student-stage-host")).toHaveLength(1);
    expect(player.closest('[hidden]')).toBeNull();
  });
});
