import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeLectureAttempt, KnowledgeLectureTutorThread } from "@/lib/session/types";
import { KnowledgeLectureBoard } from "./knowledge-lecture-board";

const attempt: KnowledgeLectureAttempt = {
  id: "attempt-1",
  sectionId: "section-1",
  quizOutlineId: "quiz-1",
  runtimeSceneId: "scene-1",
  submittedAt: "2026-09-24T00:00:00.000Z",
  score: 0,
  maxScore: 10,
  knowledgePointIds: [],
  questions: [{
    questionId: "q1",
    prompt: "变量变化方向是什么？",
    options: [{ value: "A", label: "同向变化" }, { value: "B", label: "反向变化" }],
    answer: "B",
    points: 10,
    earned: 0,
    correct: false,
    feedback: "请核对变化方向",
    knowledgePointIds: [],
  }],
};

const thread: KnowledgeLectureTutorThread = {
  id: "thread-1",
  attemptId: "attempt-1",
  questionId: "q1",
  messages: [{ id: "message-1", role: "assistant", content: "我们一起看变化方向。", createdAt: "2026-09-24T00:00:00.000Z" }],
  boardNotes: [],
  createdAt: "2026-09-24T00:00:00.000Z",
  updatedAt: "2026-09-24T00:00:00.000Z",
};

describe("KnowledgeLectureBoard question context", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the question stem and every choice in the tutor explanation", () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    render(<KnowledgeLectureBoard attempt={attempt} courseId="course-1" studentId="student-1" knowledgePointNames={new Map()} initialThreads={[thread]} onClose={vi.fn()} />);

    expect(screen.getByText("变量变化方向是什么？")).toBeInTheDocument();
    const choices = within(screen.getByRole("list", { name: "题目选项" }));
    expect(choices.getByText("A")).toBeInTheDocument();
    expect(choices.getByText("同向变化")).toBeInTheDocument();
    expect(choices.getByText("B")).toBeInTheDocument();
    expect(choices.getByText("反向变化")).toBeInTheDocument();
  });

  it("lets a failed initial explanation retry while retaining the original question analysis", async () => {
    vi.stubGlobal("speechSynthesis", { speak: vi.fn(), cancel: vi.fn() });
    vi.stubGlobal("SpeechSynthesisUtterance", class { constructor(public text: string) {} });
    let explanations = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/settings")) return Response.json({ settings: {} });
      if (++explanations === 1) return Response.json({ error: "TUTOR_REQUEST_FAILED" }, { status: 503 });
      return Response.json({ thread });
    }));
    render(<KnowledgeLectureBoard attempt={attempt} courseId="course-1" studentId="student-1" knowledgePointNames={new Map()} initialThreads={[]} onClose={vi.fn()} />);
    const retry = await screen.findByRole("button", { name: "重试讲解" });
    expect(screen.getByText("变量变化方向是什么？")).toBeInTheDocument();
    fireEvent.click(retry);
    await waitFor(() => expect(explanations).toBe(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: "重试讲解" })).not.toBeInTheDocument());
  });

  it("shows both sets of matching candidates", () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    const matchingAttempt: KnowledgeLectureAttempt = {
      ...attempt,
      questions: [{
        ...attempt.questions[0]!,
        options: undefined,
        matchingOptions: { left: ["输入", "输出"], right: ["结果", "条件"] },
      }],
    };
    render(<KnowledgeLectureBoard attempt={matchingAttempt} courseId="course-1" studentId="student-1" knowledgePointNames={new Map()} initialThreads={[thread]} onClose={vi.fn()} />);

    const candidates = within(screen.getByLabelText("题目匹配项"));
    expect(candidates.getByText("输入")).toBeInTheDocument();
    expect(candidates.getByText("输出")).toBeInTheDocument();
    expect(candidates.getByText("结果")).toBeInTheDocument();
    expect(candidates.getByText("条件")).toBeInTheDocument();
  });

  it("keeps composing and Shift+Enter in the draft, then sends on a plain Enter", async () => {
    const fetch = vi.fn(async (url: string) => Response.json(url.endsWith("/settings") ? {} : { thread }));
    vi.stubGlobal("fetch", fetch);
    render(<KnowledgeLectureBoard attempt={attempt} courseId="course-1" studentId="student-1" knowledgePointNames={new Map()} initialThreads={[thread]} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText("把不明白的地方告诉助教…");
    fireEvent.change(input, { target: { value: "请解释变化方向" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(fetch.mock.calls.filter(([url]) => url === "/api/knowledge-lecture")).toHaveLength(0);
    expect(input).toHaveValue("请解释变化方向");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/knowledge-lecture", expect.objectContaining({
      body: expect.stringContaining('"message":"请解释变化方向"'),
    })));
  });

  it("moves focus inside, traps Tab and restores the previous control when closed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const { unmount } = render(<KnowledgeLectureBoard attempt={attempt} courseId="course-1" studentId="student-1" knowledgePointNames={new Map()} initialThreads={[thread]} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "助教题目讲解" });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    const first = within(dialog).getAllByRole("button")[0]!;
    const last = screen.getByRole("button", { name: "发送追问" });
    fireEvent.change(screen.getByPlaceholderText("把不明白的地方告诉助教…"), { target: { value: "问题" } });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    unmount();
    await waitFor(() => expect(trigger).toHaveFocus());
    trigger.remove();
  });

  it("isolates player shortcuts and only closes on a non-composing Escape", () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
    const onClose = vi.fn();
    const playerShortcut = vi.fn();
    window.addEventListener("keydown", playerShortcut);
    try {
      render(<KnowledgeLectureBoard attempt={attempt} courseId="course-1" studentId="student-1" knowledgePointNames={new Map()} initialThreads={[thread]} onClose={onClose} />);
      const input = screen.getByPlaceholderText("把不明白的地方告诉助教…");
      fireEvent.keyDown(input, { key: "ArrowRight" });
      fireEvent.keyDown(input, { key: " ", code: "Space" });
      expect(playerShortcut).not.toHaveBeenCalled();
      fireEvent.keyDown(input, { key: "Escape", isComposing: true });
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.keyDown(input, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", playerShortcut);
    }
  });
});
