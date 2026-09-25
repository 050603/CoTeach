import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import type { ShowcaseData, ShowcaseQueueItem } from "@/lib/showcase/types";
import { getStagesForSystemMode } from "@/lib/system-mode";

type MockState = { loading: boolean; error?: string; data: ShowcaseData; reload?: () => Promise<void> };

const mocks = vi.hoisted(() => ({ state: undefined as MockState | undefined, runAction: vi.fn() }));

vi.mock("@/hooks/use-showcase-presentation", () => ({ useShowcasePresentation: () => ({ ...mocks.state, runAction: mocks.runAction }) }));
vi.mock("@/lib/session/store", () => ({ useSession: () => ({ studentId: "s1", studentName: "小林" }) }));
vi.mock("@/components/showcase/showcase-artifact-viewer", () => ({
  ShowcaseArtifactViewer: ({ artifact, displayMode }: { artifact: { versionId: string }; displayMode?: string }) => (
    <div data-display-mode={displayMode} data-testid="artifact-viewer" data-version-id={artifact.versionId} />
  ),
}));

import { NewShowcaseStudentView } from "./showcase-reporting";

const now = "2026-09-05T10:00:00.000Z";
const artifact = { kind: "document" as const, versionId: "a1", title: "校园节水方案", sequence: 1, submittedAt: now, displayModes: ["continuous" as const] };
const pdfArtifact = { kind: "pdf" as const, versionId: "pdf-1", title: "节水成果汇报演示稿.pdf", sequence: 2, submittedAt: now, displayModes: ["continuous" as const, "slides" as const], mimeType: "application/pdf" };
const course: Course = {
  id: "course-1", name: "测试课", subject: "科学", grade: "六年级", hours: 2, summary: "", drivingQuestion: "", status: "teaching",
  stages: getStagesForSystemMode("new"), currentStageIndex: 3,
  students: [{ id: "s1", name: "小林", joinedAt: now, stageProgress: {} }],
  content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } },
  createdAt: now, updatedAt: now,
};

function state(): MockState {
  const mine: ShowcaseQueueItem = { studentId: "s1", studentName: "小林", position: 1, status: "called", artifacts: [artifact], primaryArtifactTitle: artifact.title };
  return {
    loading: false,
    error: undefined,
    data: { courseId: "course-1", stageKey: "showcase", students: [], ownArtifacts: [artifact], activePresentation: null, presentations: [], queue: [mine], minutesPerStudent: 5, currentQueueItem: mine, nextQueueItem: null },
  };
}

describe("NewShowcaseStudentView", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state = state();
    mocks.runAction.mockResolvedValue(state().data);
  });

  it("shows the student's highlighted position without a student-side projection action", () => {
    render(<NewShowcaseStudentView course={course} />);
    expect(screen.getByText("你已被选为汇报学生，请到讲台准备汇报")).toBeTruthy();
    expect(screen.getByText(/教师会在教师机打开你的汇报材料并发起投屏/)).toBeTruthy();
    const sidebar = screen.getByTestId("student-showcase-sidebar");
    expect(sidebar.textContent).toContain("汇报顺序 · 1 人");
    expect(sidebar.textContent).toContain("小林 · 我");
    expect(screen.queryByRole("dialog", { name: "汇报队列与流程" })).toBeNull();
    expect(screen.queryByRole("button", { name: /申请.*投屏|发起.*投屏/ })).toBeNull();
    expect(mocks.runAction).not.toHaveBeenCalled();
  });

  it("keeps upload in the title and progress in the compact sidebar", () => {
    render(<NewShowcaseStudentView course={course} />);
    const sidebar = screen.getByTestId("student-showcase-sidebar");
    expect(sidebar.textContent).toContain("我的汇报进度");
    expect(screen.getByText("上传材料")).toBeTruthy();
    expect(screen.queryByText("成果准备区")).toBeNull();
    expect(screen.getByTestId("large-artifact-preview")).toBeTruthy();
  });

  it("switches between the main document and a PDF presentation preview", () => {
    const withPdf = state();
    withPdf.data = {
      ...withPdf.data,
      ownArtifacts: [artifact, pdfArtifact],
      queue: [{ ...withPdf.data.queue[0], artifacts: [artifact, pdfArtifact] }],
    };
    mocks.state = withPdf;
    render(<NewShowcaseStudentView course={course} />);

    fireEvent.click(screen.getByRole("button", { name: "选择主汇报资料" }));
    fireEvent.click(screen.getByRole("option", { name: /节水成果汇报演示稿/ }));
    expect(screen.getByTestId("artifact-viewer").getAttribute("data-version-id")).toBe("pdf-1");
    expect(screen.getByTestId("artifact-viewer").getAttribute("data-display-mode")).toBe("continuous");

    fireEvent.click(screen.getByRole("button", { name: "逐页演示" }));
    expect(screen.getByTestId("artifact-viewer").getAttribute("data-display-mode")).toBe("slides");
    expect(screen.getByRole("button", { name: "选择主汇报资料" }).textContent).toContain("节水成果汇报演示稿");
  });

  it("filters long material lists and returns focus after selecting one", () => {
    const withPdf = state();
    withPdf.data = { ...withPdf.data, ownArtifacts: [artifact, pdfArtifact] };
    mocks.state = withPdf;
    render(<NewShowcaseStudentView course={course} />);
    const picker = screen.getByRole("button", { name: "选择主汇报资料" });
    fireEvent.click(picker);
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索材料" }), { target: { value: "演示稿" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.click(screen.getByRole("option", { name: /节水成果汇报演示稿/ }));
    expect(document.activeElement).toBe(picker);
    expect(screen.getByTestId("artifact-viewer").getAttribute("data-version-id")).toBe("pdf-1");
  });

  it("keeps the selected material after a new upload changes list order", async () => {
    const initial = state();
    const added = { ...pdfArtifact, versionId: "new-pdf", title: "新上传成果.pdf", sequence: 3 };
    initial.data = { ...initial.data, ownArtifacts: [artifact, pdfArtifact] };
    initial.reload = async () => { mocks.state = { ...initial, data: { ...initial.data, ownArtifacts: [added, artifact, pdfArtifact] } }; };
    mocks.state = initial;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sequence: 3 }) }));
    const view = render(<NewShowcaseStudentView course={course} />);
    fireEvent.click(screen.getByRole("button", { name: "选择主汇报资料" }));
    fireEvent.click(screen.getByRole("option", { name: /节水成果汇报演示稿/ }));
    const input = screen.getByText("上传材料").closest("label")?.querySelector("input[type=file]");
    expect(input).toBeTruthy();
    fireEvent.change(input!, { target: { files: [new File(["sample"], "新上传成果.pdf", { type: "application/pdf" })] } });
    await waitFor(() => expect(mocks.state?.data.ownArtifacts[0]?.versionId).toBe("new-pdf"));
    view.rerender(<NewShowcaseStudentView course={course} />);
    expect(screen.getByTestId("artifact-viewer").getAttribute("data-version-id")).toBe("pdf-1");
  });

  it("shows submitted work as awaiting teacher selection", () => {
    const submitted = state();
    submitted.data = { ...submitted.data, queue: [], currentQueueItem: null, queueConfig: { schemaVersion: 2, selectionMode: "teacher-selected", selectedStudentIds: [], orderedStudentIds: [], minutesPerStudent: 5, presentationSec: 180, discussionSec: 60, transitionSec: 20, updatedAt: now } };
    mocks.state = submitted;
    render(<NewShowcaseStudentView course={course} />);
    expect(screen.getByTestId("student-showcase-sidebar").textContent).toContain("已提交，等待教师选择");
    expect(screen.getByTestId("student-showcase-sidebar").textContent).not.toContain("成果未就绪");
  });

  it("explains that the teacher is evaluating after the projection ends", () => {
    const evaluation = { ...state().data.queue[0], status: "evaluating" as const };
    mocks.state = { ...state(), data: { ...state().data, queue: [evaluation], currentQueueItem: evaluation, presentations: [{ id: "p1", courseId: "course-1", groupId: "g1", studentId: "s1", artifactKind: "document" as const, artifactVersionId: "a1", artifactTitle: artifact.title, displayMode: "continuous" as const, status: "evaluating" as const, revision: 2, requestedAt: now, endedAt: now, updatedAt: now }] } };
    render(<NewShowcaseStudentView course={course} />);
    expect(screen.getByText("教师正在进行课堂点评，评价结束后会自动进入下一位。")).toBeTruthy();
  });
});
