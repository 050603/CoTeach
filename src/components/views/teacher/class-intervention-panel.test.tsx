import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import { DEFAULT_STAGES } from "@/lib/session/types";
import { ClassInterventionPanel } from "./class-intervention-panel";

const session = vi.hoisted(() => ({ setUiState: vi.fn(), addActivity: vi.fn() }));
vi.mock("@/lib/session/store", () => ({ useSession: () => session }));
vi.mock("@/components/openmaic-bridge/openmaic-resource-player", () => ({
  OpenMaicResourcePlayer: ({ sceneId }: { sceneId: string }) => <div role="status">页面：{sceneId}</div>,
}));

const course = {
  id: "course", name: "课程", subject: "科学", grade: "七年级", hours: 1, summary: "", drivingQuestion: "",
  status: "teaching", stages: DEFAULT_STAGES, currentStageIndex: 1, students: [],
  aiLearningClassroomId: "classroom", createdAt: "2026-10-13", updatedAt: "2026-10-13",
  content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" },
    _openmaicSceneOutlines: ["A", "B"].map((id, order) => ({ id, title: id, order, type: "slide", stageKey: "ai-learning", audience: "student" })),
  },
} as Course;
const scenes = ["A", "B"].map(id => ({ id: `scene-${id}`, outlineId: id, title: id, type: "slide" }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("补讲页面请求顺序", () => {
  it("keeps the latest choice when an older request completes last", async () => {
    const requests: Array<(value: Response) => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => requests.push(resolve))));
    render(<ClassInterventionPanel course={course} commonIssues={[]} />);
    const select = screen.getByRole("combobox", { name: "自主选择知识讲授PPT页面" });
    fireEvent.change(select, { target: { value: "A" } });
    fireEvent.change(select, { target: { value: "B" } });
    await act(async () => requests[1](Response.json({ classroom: { scenes } })));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("页面：scene-B"));
    await act(async () => requests[0](Response.json({ classroom: { scenes } })));
    expect(select).toHaveValue("B");
    expect(screen.getByRole("status")).toHaveTextContent("页面：scene-B");
  });

  it("aborts loading when the teaching panel is removed", () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<ClassInterventionPanel course={course} commonIssues={[]} />);
    fireEvent.change(screen.getByRole("combobox", { name: "自主选择知识讲授PPT页面" }), { target: { value: "A" } });
    const signal = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].signal;
    view.unmount();
    expect(signal?.aborted).toBe(true);
    expect(session.setUiState).not.toHaveBeenCalled();
  });
});
