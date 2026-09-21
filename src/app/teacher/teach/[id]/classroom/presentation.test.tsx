import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import type { TeacherPresentationMode } from "@/lib/classroom/presentation";
import { createClassroomTimingState } from "@/lib/classroom/timing";
import { getStagesForSystemMode } from "@/lib/system-mode";

const mocks = vi.hoisted(() => ({
  course: undefined as Course | undefined,
  updateCourse: vi.fn(),
  endTeaching: vi.fn(),
  flushSaves: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "projection-course" }), useRouter: () => ({ replace: mocks.replace }) }));
vi.mock("@/lib/session/store", () => ({
  useCourse: () => mocks.course,
  useHydrated: () => true,
  useSession: () => ({ user: { name: "测试教师", role: "teacher" }, updateCourse: mocks.updateCourse, endTeaching: mocks.endTeaching, flushSaves: mocks.flushSaves, retrySave: vi.fn(), saveState: "saved" }),
}));
vi.mock("@/hooks/use-realtime-sync", () => ({ useRealtimeSync: vi.fn() }));
vi.mock("@/hooks/use-course-presence", () => ({ useCoursePresence: () => ({ onlineStudentIds: new Set<string>(), degraded: false }) }));
vi.mock("@/hooks/use-showcase-presentation", () => ({ useShowcasePresentation: () => ({ data: undefined, loading: false, runAction: vi.fn() }) }));
vi.mock("@/components/dashboard-shell", () => ({
  DashboardShell: ({ children, headerSlot, immersive }: { children: ReactNode; headerSlot: ReactNode; immersive: boolean }) => <div data-testid="shell" data-immersive={immersive}>{!immersive ? headerSlot : null}{children}</div>,
  Avatar: ({ name }: { name: string }) => <span>{name}</span>,
}));
vi.mock("@/components/views/teacher/stage-dispatcher", () => ({
  TeacherStageView: ({ presentation, immersive }: { presentation: TeacherPresentationMode; immersive: boolean }) => <div data-testid="stage" data-presentation={presentation} data-immersive={immersive}><input aria-label="阶段编辑草稿" defaultValue="" />{presentation === "workspace" ? <button type="button">原有阶段操作</button> : null}</div>,
}));
vi.mock("@/components/views/teacher/public-discussion-workspace", () => ({
  PublicDiscussionTeacherWorkspace: ({ hidden }: { hidden: boolean }) => <section aria-label="AI 公开讨论工作台" hidden={hidden}>讨论工作台内容<input aria-label="讨论临时记录" defaultValue="" /></section>,
}));
vi.mock("@/components/classroom/teacher-classroom-pulse", () => ({ TeacherClassroomPulse: () => null }));
vi.mock("@/components/classroom/teacher-stage-dashboard", () => ({ TeacherStageDashboard: () => null, RealtimeTeachingActions: () => <div>当前教学建议</div> }));
vi.mock("@/components/classroom/teacher-presentation-analytics", () => ({
  TeacherPresentationAnalytics: ({ onDetails }: { onDetails: () => void }) => <section aria-label="班级汇总"><button type="button" onClick={onDetails}>查看明细</button></section>,
}));
vi.mock("@/components/classroom/classroom-chrome", () => ({
  StageGateDialog: ({ open, onConfirm, targetIndex }: { open: boolean; onConfirm: () => void; targetIndex: number }) => open ? <div role="dialog" aria-label="阶段切换确认"><span>目标阶段 {targetIndex + 1}</span><button type="button" onClick={onConfirm}>确认阶段切换</button></div> : null,
}));
vi.mock("@/lib/classroom/stage-gates", () => ({ evaluateStageGate: () => ({ canAdvance: false, blockers: [{ message: "仍有未完成学习" }], warnings: [] }) }));

import TeachClassroomPage from "./page";

function makeCourse(): Course {
  const stages = getStagesForSystemMode("new");
  return {
    id: "projection-course", name: "大屏课堂", subject: "科学", grade: "六年级", hours: 1, summary: "", drivingQuestion: "", status: "teaching", stages, currentStageIndex: 0, students: [],
    content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } },
    uiState: { classroomTiming: createClassroomTimingState({ stages, totalMinutes: 60, activeStageKey: "launch" }) },
    createdAt: "2026-09-12T00:00:00.000Z", updatedAt: "2026-09-12T00:00:00.000Z",
  };
}

function enterPresentation() {
  fireEvent.click(screen.getAllByRole("button", { name: "全屏授课" })[0]);
  expect(screen.getByTestId("shell").dataset.immersive).toBe("true");
  expect(screen.getByTestId("stage").dataset.presentation).toBe("teaching");
}

describe("teacher full-screen classroom integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.course = makeCourse();
    mocks.flushSaves.mockResolvedValue(true);
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
    Object.defineProperty(document.documentElement, "requestFullscreen", { configurable: true, value: undefined });
  });

  it("opens teaching by default, reveals analytics details in the same immersive stage, and never changes student projection", () => {
    render(<TeachClassroomPage />);
    const stage = screen.getByTestId("stage");
    fireEvent.change(screen.getByLabelText("阶段编辑草稿"), { target: { value: "保留中的课堂点评" } });
    enterPresentation();
    const footer = screen.getByRole("contentinfo", { name: "全屏课堂操作栏" });
    expect(footer).toHaveAttribute("data-layout", "single-row");
    expect(within(screen.getByRole("group", { name: "左侧展示操作" })).getByRole("button", { name: "授课展示" })).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "右侧课堂操作" })).getByRole("button", { name: "课堂操作" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "原有阶段操作" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "班级学情" }));
    expect(screen.getByTestId("stage").dataset.presentation).toBe("analytics");
    expect(screen.getByRole("region", { name: "班级汇总" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看明细" }));
    expect(screen.getByTestId("stage")).toBe(stage);
    expect(stage.dataset.presentation).toBe("workspace");
    expect(stage.dataset.immersive).toBe("true");
    expect((screen.getByLabelText("阶段编辑草稿") as HTMLInputElement).value).toBe("保留中的课堂点评");
    fireEvent.click(screen.getByRole("button", { name: "返回汇总" }));
    expect(stage.dataset.presentation).toBe("analytics");
    fireEvent.click(screen.getByRole("button", { name: "退出全屏" }));
    expect(stage.dataset.presentation).toBe("workspace");
    expect(stage.dataset.immersive).toBe("false");
    expect(mocks.updateCourse).not.toHaveBeenCalled();
  });

  it("exposes all existing classroom operations and returns to the projected lesson without exiting", () => {
    render(<TeachClassroomPage />);
    enterPresentation();
    fireEvent.click(screen.getByRole("button", { name: "课堂操作" }));
    expect(screen.getByRole("button", { name: "原有阶段操作" })).toBeTruthy();
    expect(screen.getByTestId("stage").dataset.immersive).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "返回展示" }));
    expect(screen.getByTestId("stage").dataset.presentation).toBe("teaching");
    expect(screen.getByTestId("shell").dataset.immersive).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("shell").dataset.immersive).toBe("false");
    expect(mocks.updateCourse).not.toHaveBeenCalled();
  });

  it("opens public discussion from its own footer entry and keeps it separate from classroom operations", () => {
    mocks.course = { ...makeCourse(), currentStageIndex: 1 };
    render(<TeachClassroomPage />);
    fireEvent.change(screen.getByLabelText("阶段编辑草稿"), { target: { value: "保留课堂操作草稿" } });
    enterPresentation();

    const discussionButton = screen.getByRole("button", { name: "AI 公开讨论" });
    fireEvent.click(discussionButton);
    expect(discussionButton).toHaveAttribute("aria-pressed", "true");
    const discussionWorkspace = screen.getByRole("region", { name: "AI 公开讨论工作台" });
    expect(discussionWorkspace).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("stage").closest("section")).toHaveAttribute("hidden");
    fireEvent.change(screen.getByLabelText("讨论临时记录"), { target: { value: "保留讨论状态" } });
    expect(screen.queryByRole("button", { name: "原有阶段操作" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "课堂操作" }));
    expect(screen.getByTestId("stage").dataset.presentation).toBe("workspace");
    expect(screen.getByTestId("stage").closest("section")).not.toHaveAttribute("hidden");
    expect((screen.getByLabelText("阶段编辑草稿") as HTMLInputElement).value).toBe("保留课堂操作草稿");
    expect(discussionWorkspace).toHaveAttribute("hidden");

    fireEvent.click(screen.getByRole("button", { name: "AI 公开讨论" }));
    expect((screen.getByLabelText("讨论临时记录") as HTMLInputElement).value).toBe("保留讨论状态");
    expect(screen.getByTestId("stage").closest("section")).toHaveAttribute("hidden");
  });

  it("only shows the public discussion entry during knowledge teaching", () => {
    render(<TeachClassroomPage />);
    enterPresentation();
    expect(screen.queryByRole("button", { name: "AI 公开讨论" })).toBeNull();
  });

  it("keeps reflection in a single-row footer without teaching and analytics toggles", () => {
    mocks.course = { ...makeCourse(), currentStageIndex: 4 };
    render(<TeachClassroomPage />);
    enterPresentation();
    const stage = screen.getByTestId("stage");
    expect(screen.queryByRole("button", { name: "授课展示" })).toBeNull();
    expect(screen.queryByRole("button", { name: "班级学情" })).toBeNull();
    expect(screen.getByRole("contentinfo", { name: "全屏课堂操作栏" })).toHaveAttribute("data-layout", "single-row");
    expect(stage.dataset.presentation).toBe("teaching");
    expect(stage.closest("section")).not.toHaveAttribute("hidden");
    expect(screen.queryByRole("region", { name: "班级汇总" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "课堂操作" }));
    expect(stage.dataset.presentation).toBe("workspace");
    fireEvent.click(screen.getByRole("button", { name: "返回展示" }));
    expect(stage.dataset.presentation).toBe("teaching");
    expect(stage.closest("section")).not.toHaveAttribute("hidden");
    expect(mocks.updateCourse).not.toHaveBeenCalled();
  });

  it("uses the stage gate and existing transition audit before advancing from fullscreen", () => {
    const { rerender } = render(<TeachClassroomPage />);
    enterPresentation();
    fireEvent.click(screen.getByRole("button", { name: "课堂操作" }));
    fireEvent.click(screen.getByRole("button", { name: "下一教学阶段" }));
    expect(screen.getByRole("dialog", { name: "阶段切换确认" })).toBeTruthy();
    expect(mocks.updateCourse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认阶段切换" }));
    expect(mocks.updateCourse).toHaveBeenCalledOnce();
    const [id, patch] = mocks.updateCourse.mock.calls[0] as [string, Partial<Course>];
    expect(id).toBe("projection-course");
    expect(patch.currentStageIndex).toBe(1);
    expect(patch.stageTransitions?.[0]).toMatchObject({ fromStageKey: "launch", toStageKey: "ai-learning", gateStatus: "overridden", blockers: ["仍有未完成学习"] });
    expect(patch.uiState?.classroomTiming?.activeStageKey).toBe("ai-learning");
    mocks.course = { ...mocks.course!, ...patch };
    rerender(<TeachClassroomPage />);
    expect(screen.getByTestId("stage").dataset.presentation).toBe("teaching");
    expect(screen.getByTestId("stage").dataset.immersive).toBe("true");
  });

  it("uses existing timer adjustments inside a fullscreen dialog", () => {
    render(<TeachClassroomPage />);
    enterPresentation();
    expect(screen.queryByRole("button", { name: "计时" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "工具" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "课堂工具" })).getByRole("button", { name: "课堂计时" }));
    const dialog = screen.getByRole("dialog", { name: "课堂计时" });
    fireEvent.click(within(dialog).getByRole("button", { name: "+2 分" }));
    expect(mocks.updateCourse).toHaveBeenCalledOnce();
    const firstPatch = mocks.updateCourse.mock.calls[0][1] as Partial<Course>;
    const before = mocks.course!.uiState!.classroomTiming!;
    const after = firstPatch.uiState!.classroomTiming!;
    expect(after.stages.find((stage) => stage.stageKey === "launch")!.adjustmentSec).toBe(before.stages.find((stage) => stage.stageKey === "launch")!.adjustmentSec + 120);
    fireEvent.click(within(dialog).getByRole("button", { name: /暂停/ }));
    expect(mocks.updateCourse.mock.calls[1][1].uiState.classroomTiming.status).toBe("paused");
    expect(screen.getByTestId("shell").dataset.immersive).toBe("true");
  });

  it("keeps end-of-class saving and confirmation available in fullscreen", async () => {
    render(<TeachClassroomPage />);
    enterPresentation();
    fireEvent.click(screen.getByRole("button", { name: "结束课堂" }));
    expect(mocks.endTeaching).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "结束课堂" }));
    await waitFor(() => expect(mocks.endTeaching).toHaveBeenCalledWith("projection-course"));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/teacher/classrooms/projection-course"));
    expect(mocks.flushSaves).toHaveBeenCalledTimes(2);
  });
});
