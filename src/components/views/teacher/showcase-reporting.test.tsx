import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import type { ShowcaseData, ShowcaseQueueItem } from "@/lib/showcase/types";
import { getStagesForSystemMode } from "@/lib/system-mode";

type MockState = { loading: boolean; error?: string; data: ShowcaseData };

const mocks = vi.hoisted(() => ({
  state: undefined as MockState | undefined,
  runAction: vi.fn(),
}));

vi.mock("@/hooks/use-showcase-presentation", () => ({
  useShowcasePresentation: () => ({ ...mocks.state, runAction: mocks.runAction }),
}));
vi.mock("@/components/showcase/showcase-artifact-viewer", () => ({ ShowcaseArtifactViewer: () => <div data-testid="artifact-viewer" /> }));

import { TeacherPresentationActionsProvider } from "@/components/classroom/teacher-presentation-actions";
import { NewShowcaseTeacherView } from "./showcase-reporting";

const now = "2026-09-05T10:00:00.000Z";
const artifact = { kind: "document" as const, versionId: "a1", title: "校园节水方案", sequence: 1, submittedAt: now, displayModes: ["continuous" as const] };
const course: Course = {
  id: "course-1", name: "测试课", subject: "科学", grade: "六年级", hours: 2, summary: "", drivingQuestion: "", status: "teaching",
  stages: getStagesForSystemMode("new"), currentStageIndex: 3,
  students: [{ id: "s1", name: "小林", joinedAt: now, stageProgress: {} }],
  groups: [{ id: "g1", name: "小林的个人项目", topic: "节水", keywords: [], selectedForms: [], members: [{ studentId: "s1", name: "小林" }], createdAt: now, updatedAt: now }],
  content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } },
  createdAt: now, updatedAt: now,
};

function baseState(overrides: Partial<ShowcaseData> = {}): MockState {
  const queueItem: ShowcaseQueueItem = { studentId: "s1", studentName: "小林", groupId: "g1", position: 1, status: "waiting", artifacts: [artifact], primaryArtifactTitle: artifact.title };
  return {
    loading: false,
    error: undefined,
    data: {
      courseId: "course-1", stageKey: "showcase", presentingGroupId: undefined, presentingStudentId: undefined,
      students: [], ownArtifacts: [], activePresentation: null, presentations: [], queue: [queueItem], minutesPerStudent: 5,
      currentQueueItem: null, nextQueueItem: queueItem,
      ...overrides,
    },
  };
}

describe("NewShowcaseTeacherView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state = baseState();
    mocks.runAction.mockResolvedValue(baseState().data);
  });

  it("starts the default queue from the prominent current-report panel", async () => {
    render(<NewShowcaseTeacherView course={course} />);
    expect(screen.getByText("尚未点名")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "按提交顺序开始" }));
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledWith({ action: "assign", groupId: "g1", studentId: "s1" }));
  });

  it("puts teacher evaluation in the flow and finishes it with an optional note", async () => {
    const evaluation = { id: "p1", courseId: "course-1", groupId: "g1", studentId: "s1", studentName: "小林", artifactKind: "document" as const, artifactVersionId: "a1", artifactTitle: artifact.title, displayMode: "continuous" as const, status: "evaluating" as const, revision: 2, requestedAt: now, endedAt: now, updatedAt: now };
    mocks.state = baseState({
      presentingGroupId: "g1", presentingStudentId: "s1",
      queue: [{ studentId: "s1", studentName: "小林", groupId: "g1", position: 1, status: "evaluating", artifacts: [artifact], primaryArtifactTitle: artifact.title, presentationId: "p1" }],
      currentQueueItem: { studentId: "s1", studentName: "小林", groupId: "g1", position: 1, status: "evaluating", artifacts: [artifact], primaryArtifactTitle: artifact.title, presentationId: "p1" },
      nextQueueItem: null, presentations: [evaluation],
    });
    render(<NewShowcaseTeacherView course={course} />);
    fireEvent.change(screen.getByRole("textbox", { name: "课堂点评记录（可选）" }), { target: { value: "表达清楚" } });
    fireEvent.click(screen.getByRole("button", { name: "结束评价并点名下一位" }));
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledWith({ action: "finish-evaluation", presentationId: "p1", note: "表达清楚" }));
  });
});


describe("showcase projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state = baseState();
    mocks.runAction.mockResolvedValue(baseState().data);
  });

  it("keeps queue details opt-in while preserving the real start control", async () => {
    const { rerender } = render(<NewShowcaseTeacherView course={course} presentation="teaching" />);
    expect(screen.queryByRole("heading", { name: "汇报队列" })).toBeNull();
    expect(screen.queryByText("成果查看")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看汇报队列与成果" }));
    expect(screen.getByRole("heading", { name: "汇报队列" })).toBeTruthy();
    rerender(<NewShowcaseTeacherView course={course} presentation="analytics" />);
    rerender(<NewShowcaseTeacherView course={course} presentation="teaching" />);
    expect(screen.queryByRole("heading", { name: "汇报队列" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "开始汇报流程" }));
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledWith({ action: "assign", groupId: "g1", studentId: "s1" }));
  });

  it("keeps one active viewer inline across presentation changes and ends through the controller", async () => {
    const active = { id: "p1", courseId: "course-1", groupId: "g1", studentId: "s1", studentName: "小林", artifactKind: "document" as const, artifactVersionId: "a1", artifactTitle: artifact.title, displayMode: "continuous" as const, status: "active" as const, revision: 2, requestedAt: now, updatedAt: now };
    mocks.state = baseState({ activePresentation: active, presentations: [active] });
    const { rerender } = render(<NewShowcaseTeacherView course={course} presentation="teaching" immersive />);
    const viewer = screen.getByTestId("artifact-viewer");
    expect(screen.getByRole("region", { name: artifact.title })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(viewer.closest(".fixed")).toBeNull();
    rerender(<NewShowcaseTeacherView course={course} presentation="analytics" immersive />);
    expect(screen.getByTestId("artifact-viewer")).toBe(viewer);
    expect(viewer.closest("[hidden]")).toBeTruthy();
    rerender(<NewShowcaseTeacherView course={course} immersive />);
    expect(screen.getByTestId("artifact-viewer")).toBe(viewer);
    expect(viewer.closest(".fixed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "结束汇报" }));
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledWith({ action: "end", presentationId: "p1" }));
  });
});


describe("showcase fullscreen footer actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state = baseState();
    mocks.runAction.mockResolvedValue(baseState().data);
  });
  afterEach(() => document.querySelectorAll('[data-testid="showcase-footer"]').forEach((element) => element.remove()));

  function renderFooter(presentation: "teaching" | "analytics" | "workspace" = "teaching") {
    const target = document.createElement("footer");
    target.dataset.testid = "showcase-footer";
    document.body.append(target);
    const renderView = (mode: typeof presentation) => <TeacherPresentationActionsProvider target={target}><NewShowcaseTeacherView course={course} presentation={mode} immersive /></TeacherPresentationActionsProvider>;
    const result = render(renderView(presentation));
    return { footer: within(target), target, rerender: (mode: typeof presentation = presentation) => result.rerender(renderView(mode)) };
  }

  it("starts the first eligible student in the existing queue from the analytics footer without auto-approving", async () => {
    const first = baseState().data.queue[0];
    mocks.state = baseState({ queue: [
      { ...first, studentId: "not-ready", status: "not-ready", groupId: undefined },
      { ...first, studentId: "s2", studentName: "小周", groupId: "g2" },
      first,
    ] });
    const { footer, target } = renderFooter("analytics");
    expect(target.closest("[hidden]")).toBeNull();
    expect(footer.queryByText("小周")).toBeNull();
    expect(footer.getByRole("button", { name: "开始汇报" }).dataset.tone).toBe("primary");
    expect(mocks.runAction).not.toHaveBeenCalled();
    fireEvent.click(footer.getByRole("button", { name: "开始汇报" }));
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledExactlyOnceWith({ action: "assign", groupId: "g2", studentId: "s2" }));
  });

  it("waits for an application and only approves after the teacher clicks", async () => {
    const item = { ...baseState().data.queue[0], status: "called" as const };
    mocks.state = baseState({ currentQueueItem: item, queue: [item] });
    const { footer, rerender } = renderFooter();
    expect((footer.getByRole("button", { name: "等待学生申请" }) as HTMLButtonElement).disabled).toBe(true);
    const pending = { id: "p1", courseId: course.id, groupId: "g1", studentId: "s1", artifactKind: "document" as const, artifactVersionId: "a1", artifactTitle: artifact.title, displayMode: "continuous" as const, status: "pending" as const, revision: 1, requestedAt: now, updatedAt: now };
    mocks.state = baseState({ currentQueueItem: { ...item, status: "pending-approval", presentationId: "p1" }, presentations: [pending] });
    rerender("analytics");
    expect(mocks.runAction).not.toHaveBeenCalled();
    fireEvent.click(footer.getByRole("button", { name: "批准汇报" }));
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledExactlyOnceWith({ action: "review", presentationId: "p1", decision: "approve", reason: undefined }));
  });

  it("ends an active report directly from the analytics footer", async () => {
    const active = { id: "p1", courseId: course.id, groupId: "g1", studentId: "s1", artifactKind: "document" as const, artifactVersionId: "a1", artifactTitle: artifact.title, displayMode: "continuous" as const, status: "active" as const, revision: 2, requestedAt: now, updatedAt: now };
    mocks.state = baseState({ activePresentation: active, presentations: [active] });
    const { footer } = renderFooter("analytics");
    fireEvent.click(footer.getByRole("button", { name: "结束汇报" }));
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledExactlyOnceWith({ action: "end", presentationId: "p1" }));
  });

  it("submits the existing evaluation draft and keeps it after a failed footer action", async () => {
    const evaluation = { id: "p1", courseId: course.id, groupId: "g1", studentId: "s1", artifactKind: "document" as const, artifactVersionId: "a1", artifactTitle: artifact.title, displayMode: "continuous" as const, status: "evaluating" as const, revision: 2, requestedAt: now, updatedAt: now };
    mocks.state = baseState({ currentQueueItem: { ...baseState().data.queue[0], status: "evaluating", presentationId: "p1" }, presentations: [evaluation] });
    const { footer, rerender } = renderFooter("workspace");
    fireEvent.change(screen.getByRole("textbox", { name: "课堂点评记录（可选）" }), { target: { value: "保留学生的关键证据" } });
    rerender("analytics");
    mocks.runAction.mockRejectedValueOnce(new Error("保存点评失败，请重试"));
    fireEvent.click(footer.getByRole("button", { name: "结束点评并点名下一位" }));
    await waitFor(() => expect(footer.getByRole("alert").textContent).toBe("保存点评失败，请重试"));
    expect(mocks.runAction).toHaveBeenCalledWith({ action: "finish-evaluation", presentationId: "p1", note: "保留学生的关键证据" });
    rerender("workspace");
    expect((screen.getByRole("textbox", { name: "课堂点评记录（可选）" }) as HTMLInputElement).value).toBe("保留学生的关键证据");
  });

  it("disables empty queues and avoids duplicate submissions while a start is pending", async () => {
    mocks.state = baseState({ queue: [], nextQueueItem: null });
    const { footer, rerender } = renderFooter();
    expect((footer.getByRole("button", { name: "暂无待汇报成果" }) as HTMLButtonElement).disabled).toBe(true);
    mocks.state = baseState();
    let finish: (value: ShowcaseData) => void = () => undefined;
    mocks.runAction.mockImplementationOnce(() => new Promise<ShowcaseData>((resolve) => { finish = resolve; }));
    rerender();
    fireEvent.click(footer.getByRole("button", { name: "开始汇报" }));
    expect((footer.getByRole("button", { name: "开始汇报" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(footer.getByRole("button", { name: "开始汇报" }));
    expect(mocks.runAction).toHaveBeenCalledOnce();
    finish(baseState().data);
    await waitFor(() => expect((footer.getByRole("button", { name: "开始汇报" }) as HTMLButtonElement).disabled).toBe(false));
  });
});
