import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Course, TeacherResourceScene } from "@/lib/session/types";
import { DEFAULT_STAGES } from "@/lib/session/types";

const mocks = vi.hoisted(() => ({
  setUiState: vi.fn(), resources: [] as TeacherResourceScene[],
  playerProps: undefined as undefined | { onPlaybackStateChange?: (state: unknown) => void; experience: string },
}));
vi.mock("@/lib/session/store", () => ({
  useSession: () => ({ addActivity: vi.fn(), refresh: vi.fn(), setUiState: mocks.setUiState }),
}));
vi.mock("@/lib/openmaic-bridge/teacher-resources", () => ({
  getTeacherResourcesForStage: () => mocks.resources,
  teacherResourceTypeLabel: () => "演示",
}));
vi.mock("./openmaic-resource-player", () => ({
  OpenMaicResourcePlayer: (props: typeof mocks.playerProps) => { mocks.playerProps = props; return <div>资源播放器</div>; },
}));

vi.mock("@openmaic/lib/store/interaction-sync", () => ({
  useInteractionSyncStore: (selector: (state: { versions: Record<string, number>; states: Record<string, unknown> }) => unknown) => selector({ versions: {}, states: {} }),
}));

import { TeacherStageResources } from "./teacher-stage-resources";

const course: Course = {
  id: "course-1",
  name: "测试课程",
  subject: "科学",
  grade: "六年级",
  hours: 3,
  summary: "测试",
  drivingQuestion: "如何解决问题？",
  status: "teaching",
  stages: DEFAULT_STAGES,
  currentStageIndex: 0,
  content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } },
  students: [],
  createdAt: "",
  updatedAt: "",
};

describe("TeacherStageResources", () => {
  beforeEach(() => { mocks.resources = []; mocks.setUiState.mockClear(); mocks.playerProps = undefined; });

  it("observes another teacher without writing local empty interaction or idle playback, and offers explicit takeover", () => {
    mocks.resources = [{ id: "interactive-1", type: "interactive", role: "teaching-aid", title: "互动", description: "", keyPoints: [] }];
    const projection = { classroomId: "room-1", sceneId: "interactive-1", stageKey: "launch", title: "互动", sceneType: "interactive" as const, startedAt: "now", interactionState: { value: "teacher-a" } };
    const projected = { ...course, teacherClassroomId: "room-1", uiState: { teacherResourceProjection: projection, projectionController: { teacherId: "teacher-a", clientId: "other-tab" } } };
    const view = render(<TeacherStageResources course={projected} stageKey="launch" />);
    expect(mocks.setUiState).not.toHaveBeenCalled();
    expect(mocks.playerProps?.experience).toBe("projected-readonly");
    mocks.playerProps?.onPlaybackStateChange?.({ engineMode: "idle", snapshot: { sceneIndex: 0, actionIndex: 0, consumedDiscussions: [] } });
    view.rerender(<TeacherStageResources course={{ ...projected, uiState: { ...projected.uiState, teacherResourceProjection: { ...projection, interactionState: { value: "new" } } } }} stageKey="launch" />);
    expect(mocks.setUiState).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: /停止投屏/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "接管并投屏" }));
    expect(mocks.setUiState).toHaveBeenCalledWith("course-1", expect.objectContaining({ teacherResourceProjection: expect.objectContaining({ sceneId: "interactive-1" }) }), { takeover: true });
  });
  it("collapses and expands the whole stage resource area", () => {
    render(<TeacherStageResources course={course} stageKey="launch" />);

    const trigger = screen.getByRole("button", { name: /本阶段授课资源/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("本阶段暂无生成的授课资源。")).toBeTruthy();

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("本阶段暂无生成的授课资源。")).toBeNull();
  });
});
