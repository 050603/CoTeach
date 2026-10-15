import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeLectureAttempt, KnowledgeLectureTutorThread } from "@/lib/session/types";
import type { KnowledgeLectureExplanation } from "@/lib/courses/knowledge-explanation-types";
import { KnowledgeLectureBoard } from "./knowledge-lecture-board";

const telemetry = vi.hoisted(() => ({
  createLearningEvent: vi.fn((type, draft) => ({ type, ...draft })),
  postLearningEvents: vi.fn(async () => undefined),
}));
vi.mock("@/lib/learning-analytics/telemetry", () => telemetry);

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
    authoredAnalysis: "从变化关系判断，两个量的变化方向一致。",
    knowledgePointIds: [],
  }],
};

const explanation: KnowledgeLectureExplanation = {
  id: "prepared-1", questionFingerprint: "fingerprint-1", source: "prepared",
  text: "A选项正确，两个量同向变化。B选项不正确，它表示一个量增加时另一个量减少。",
  boardNotes: [{ id: "note-1", title: "判断方法", body: "先看一个量增加时另一个量如何变化。", kind: "concept", createdAt: attempt.submittedAt }],
};

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

function mockFetch(resource: KnowledgeLectureExplanation = explanation) {
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => Response.json({ explanation: resource }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function renderBoard(patch: Partial<Parameters<typeof KnowledgeLectureBoard>[0]> = {}) {
  return render(<KnowledgeLectureBoard attempt={attempt} courseId="course-1" studentId="student-1"
    knowledgePointNames={new Map()} initialThreads={[thread]} onClose={vi.fn()} {...patch} />);
}

function mockStoredAudio() {
  const instances: Array<{ src: string; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal("Audio", class {
    ended = false;
    onplay?: () => void;
    onpause?: () => void;
    onended?: () => void;
    onerror?: () => void;
    play = vi.fn(async () => { this.onplay?.(); });
    pause = vi.fn(() => { this.onpause?.(); });
    constructor(public src: string) { instances.push(this); }
  });
  return instances;
}

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
  beforeEach(() => {
    telemetry.createLearningEvent.mockClear();
    telemetry.postLearningEvents.mockClear();
    sessionStorage.clear();
    vi.stubGlobal("speechSynthesis", { speak: vi.fn(), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn() });
    vi.stubGlobal("SpeechSynthesisUtterance", class { constructor(public text: string) {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the question stem and every choice in the tutor explanation", async () => {
    mockFetch();
    render(<KnowledgeLectureBoard attempt={attempt} courseId="course-1" studentId="student-1" knowledgePointNames={new Map()} initialThreads={[thread]} onClose={vi.fn()} />);

    expect(screen.getByText("变量变化方向是什么？")).toBeInTheDocument();
    const choices = within(screen.getByRole("list", { name: "题目选项" }));
    expect(choices.getByText("A")).toBeInTheDocument();
    expect(choices.getByText("同向变化")).toBeInTheDocument();
    expect(choices.getByText("B")).toBeInTheDocument();
    expect(choices.getByText("反向变化")).toBeInTheDocument();
    const lesson = await screen.findByLabelText("统一题目讲解");
    expect(lesson).toHaveTextContent(explanation.text);
    expect(lesson.compareDocumentPosition(screen.getByText("你的回答 · 对照查看")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(attempt.questions[0]!.feedback)).not.toBeInTheDocument();
    expect(screen.queryByText(thread.messages[0]!.content)).not.toBeInTheDocument();
  });

  it("lets a failed initial explanation retry while retaining the original question analysis", async () => {
    vi.stubGlobal("speechSynthesis", { speak: vi.fn(), cancel: vi.fn() });
    vi.stubGlobal("SpeechSynthesisUtterance", class { constructor(public text: string) {} });
    let explanations = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/settings")) return Response.json({ settings: {} });
      if (++explanations === 1) return Response.json({ error: "TUTOR_REQUEST_FAILED" }, { status: 503 });
      return Response.json({ explanation });
    }));
    render(<KnowledgeLectureBoard attempt={attempt} courseId="course-1" studentId="student-1" knowledgePointNames={new Map()} initialThreads={[]} onClose={vi.fn()} />);
    const retry = await screen.findByRole("button", { name: "重试讲解" });
    expect(screen.getByText("变量变化方向是什么？")).toBeInTheDocument();
    expect(screen.getByText(attempt.questions[0]!.authoredAnalysis!)).toBeInTheDocument();
    expect(screen.queryByText(attempt.questions[0]!.feedback)).not.toBeInTheDocument();
    fireEvent.click(retry);
    await waitFor(() => expect(explanations).toBe(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: "重试讲解" })).not.toBeInTheDocument());
  });

  it("loads once without a personal receipt, settings lookup or realtime TTS, including replay", async () => {
    const fetch = mockFetch();
    renderBoard();
    await screen.findByLabelText("统一题目讲解");
    await waitFor(() => expect(window.speechSynthesis.speak).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "再听一遍" }));
    await waitFor(() => expect(window.speechSynthesis.speak).toHaveBeenCalledTimes(2));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requestBody(fetch.mock.calls[0]?.[1])).toMatchObject({ action: "tutor-explain" });
    expect(requestBody(fetch.mock.calls[0]?.[1])).not.toHaveProperty("requestId");
    expect(telemetry.createLearningEvent).toHaveBeenCalledWith("knowledge_explanation_view", expect.objectContaining({
      metadata: expect.objectContaining({ source: "prepared", explanationId: explanation.id }),
    }));
    expect(telemetry.postLearningEvents).toHaveBeenCalledTimes(1);
  });

  it("prefers stored audio and stops it on replay, question change and close", async () => {
    const instances = mockStoredAudio();
    const fetch = mockFetch({ ...explanation, audioUrl: "/api/media/prepared.mp3", audioDurationSec: 58 });
    const onClose = vi.fn();
    renderBoard({ onClose, attempt: { ...attempt, questions: [...attempt.questions, { ...attempt.questions[0]!, questionId: "q2", prompt: "第二题" }] } });
    await waitFor(() => expect(instances).toHaveLength(1));
    expect(instances[0]?.src).toBe("/api/media/prepared.mp3");
    fireEvent.click(screen.getByRole("button", { name: "再听一遍" }));
    await waitFor(() => expect(instances).toHaveLength(2));
    expect(instances[0]?.pause).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /第 2 题/ }));
    await waitFor(() => expect(instances).toHaveLength(3));
    expect(instances[1]?.pause).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "关闭讲解" }));
    expect(instances[2]?.pause).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
  });

  it("uses browser speech when prepared audio fails without requesting synthesis", async () => {
    vi.stubGlobal("Audio", class { play = vi.fn(async () => { throw new Error("media unavailable"); }); pause = vi.fn(); });
    const fetch = mockFetch({ ...explanation, audioUrl: "/missing.mp3" });
    renderBoard();
    await waitFor(() => expect(window.speechSynthesis.speak).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("统一题目讲解")).toHaveTextContent(explanation.text);
  });

  it("shows reference fallback without using personalized grading feedback", async () => {
    const resource = { ...explanation, source: "reference" as const, text: "原题解析：两个量的变化方向一致。", boardNotes: [] };
    const fetch = mockFetch(resource);
    renderBoard();
    expect(await screen.findByLabelText("统一题目讲解")).toHaveTextContent(resource.text);
    expect(screen.queryByText(attempt.questions[0]!.feedback)).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("treats short_answer fill_blank as a shared lesson", async () => {
    const fetch = mockFetch();
    renderBoard({ attempt: { ...attempt, questions: [{ ...attempt.questions[0]!, questionType: "short_answer", questionFormat: "fill_blank" }] } });
    await screen.findByLabelText("统一题目讲解");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requestBody(fetch.mock.calls[0]?.[1])).not.toHaveProperty("requestId");
  });

  it("reads a legacy fill blank with no format without TTS or settings requests", async () => {
    const fetch = mockFetch();
    renderBoard({ attempt: { ...attempt, questions: [{ ...attempt.questions[0]!, questionType: "short_answer" }] } });
    await screen.findByLabelText("统一题目讲解");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requestBody(fetch.mock.calls[0]?.[1]).requestId).toEqual(expect.any(String));
    await waitFor(() => expect(window.speechSynthesis.speak).toHaveBeenCalledTimes(1));
    expect(vi.mocked(window.speechSynthesis.speak).mock.calls[0]?.[0].text).toBe(explanation.text);
    expect(sessionStorage.length).toBe(0);
  });

  it("polls an unknown-format short answer from 202 to 200 using the existing receipt", async () => {
    const key = `knowledge-tutor-request:${JSON.stringify(["course-1", "student-1", attempt.id, "q1", "tutor-explain", ""])}`;
    const receipt = "123e4567-e89b-42d3-a456-426614174000";
    sessionStorage.setItem(key, receipt);
    const posts: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/settings")) return Response.json({ settings: {} });
      posts.push(requestBody(init));
      return posts.length === 1
        ? Response.json({ error: "TUTOR_REQUEST_RUNNING", status: "RUNNING" }, { status: 202 })
        : Response.json({ thread });
    }));
    renderBoard({ initialThreads: [], attempt: { ...attempt,
      questions: [{ ...attempt.questions[0]!, questionType: "short_answer", options: undefined }] } });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(screen.queryByRole("button", { name: "重试讲解" })).not.toBeInTheDocument();
    expect(sessionStorage.getItem(key)).toBe(receipt);
    await screen.findByText(thread.messages[0]!.content, {}, { timeout: 3_000 });
    expect(posts).toHaveLength(2);
    expect(posts.map(body => body.requestId)).toEqual([receipt, receipt]);
    expect(posts.every(body => body.action === "tutor-explain")).toBe(true);
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(screen.queryByRole("button", { name: "重试讲解" })).not.toBeInTheDocument();
  });

  it("keeps deep-answer threads and voices only their initial explanation", async () => {
    mockStoredAudio();
    const history: KnowledgeLectureTutorThread = { ...thread, messages: [...thread.messages,
      { id: "deep-student", role: "student", content: "以前的深度追问", createdAt: attempt.submittedAt },
      { id: "deep-assistant", role: "assistant", content: "以前的深度回答", createdAt: attempt.submittedAt }] };
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/settings")) return Response.json({ settings: { ttsProviderId: "test-tts", ttsVoice: "voice" } });
      if (url.endsWith("/tts")) return Response.json({ base64: "audio", format: "mp3" });
      return Response.json({ thread: history });
    });
    vi.stubGlobal("fetch", fetch);
    renderBoard({ initialThreads: [history], attempt: { ...attempt, questions: [{ ...attempt.questions[0]!,
      questionType: "short_answer", questionFormat: "short_answer", options: undefined }] } });
    expect(await screen.findByText("以前的深度回答")).toBeInTheDocument();
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url.endsWith("/tts"))).toHaveLength(1));
    expect(screen.queryByLabelText("统一题目讲解")).not.toBeInTheDocument();
    expect(screen.getByText(attempt.questions[0]!.feedback)).toBeInTheDocument();
    expect(telemetry.createLearningEvent).not.toHaveBeenCalled();
  });

  it("does not automatically speak historical follow-ups when reopened", async () => {
    const history = { ...thread, messages: [...thread.messages,
      { id: "student-old", role: "student" as const, content: "以前的追问", createdAt: attempt.submittedAt },
      { id: "assistant-old", role: "assistant" as const, content: "以前的追问回答", createdAt: attempt.submittedAt }] };
    const fetch = mockFetch();
    const first = renderBoard({ initialThreads: [history] });
    await screen.findByLabelText("统一题目讲解");
    expect(screen.getByText("以前的追问回答")).toBeInTheDocument();
    await waitFor(() => expect(window.speechSynthesis.speak).toHaveBeenCalledTimes(1));
    first.unmount();
    renderBoard({ initialThreads: [history] });
    await screen.findByLabelText("统一题目讲解");
    await waitFor(() => expect(window.speechSynthesis.speak).toHaveBeenCalledTimes(2));
    const spoken = vi.mocked(window.speechSynthesis.speak).mock.calls.map(([item]) => item.text);
    expect(spoken).toEqual([explanation.text, explanation.text]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops the shared audio and synthesizes only a genuinely new follow-up", async () => {
    const instances = mockStoredAudio();
    const reply = "针对你选的B，比较两个量增加和减少的方向即可。";
    const updatedThread: KnowledgeLectureTutorThread = { ...thread, messages: [...thread.messages,
      { id: "student-new", role: "student", content: "为什么B错？", createdAt: attempt.submittedAt },
      { id: "assistant-new", role: "assistant", content: reply, createdAt: attempt.submittedAt }] };
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/settings")) return Response.json({ settings: { ttsProviderId: "test-tts", ttsVoice: "voice" } });
      if (url.endsWith("/tts")) return Response.json({ base64: "audio", format: "mp3" });
      return Response.json(requestBody(init).action === "tutor-message" ? { thread: updatedThread }
        : { explanation: { ...explanation, audioUrl: "/prepared.mp3" } });
    });
    vi.stubGlobal("fetch", fetch);
    renderBoard({ initialThreads: [] });
    await waitFor(() => expect(instances).toHaveLength(1));
    fireEvent.change(screen.getByPlaceholderText("把不明白的地方告诉助教…"), { target: { value: "为什么B错？" } });
    fireEvent.click(screen.getByRole("button", { name: "发送追问" }));
    expect(instances[0]?.pause).toHaveBeenCalledTimes(1);
    await screen.findByText(reply);
    await waitFor(() => expect(instances).toHaveLength(2));
    const synthesis = fetch.mock.calls.filter(([url]) => url.endsWith("/tts"));
    expect(synthesis).toHaveLength(1);
    expect(requestBody(synthesis[0]?.[1]).text).toBe(reply);
    const followup = fetch.mock.calls.find(([url, init]) => url === "/api/knowledge-lecture" && requestBody(init).action === "tutor-message");
    expect(requestBody(followup?.[1]).requestId).toEqual(expect.any(String));
  });

  it("shows both sets of matching candidates", async () => {
    mockFetch();
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
    await screen.findByLabelText("统一题目讲解");
  });

  it("keeps composing and Shift+Enter in the draft, then sends on a plain Enter", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => Response.json(requestBody(init).action === "tutor-message" ? { thread } : { explanation }));
    vi.stubGlobal("fetch", fetch);
    render(<KnowledgeLectureBoard attempt={attempt} courseId="course-1" studentId="student-1" knowledgePointNames={new Map()} initialThreads={[thread]} onClose={vi.fn()} />);
    await screen.findByLabelText("统一题目讲解");
    const input = screen.getByPlaceholderText("把不明白的地方告诉助教…");
    fireEvent.change(input, { target: { value: "请解释变化方向" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(fetch.mock.calls.filter(([, init]) => requestBody(init).action === "tutor-message")).toHaveLength(0);
    expect(input).toHaveValue("请解释变化方向");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/knowledge-lecture", expect.objectContaining({
      body: expect.stringContaining('"message":"请解释变化方向"'),
    })));
  });

  it("moves focus inside, traps Tab and restores the previous control when closed", async () => {
    mockFetch();
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const { unmount } = render(<KnowledgeLectureBoard attempt={attempt} courseId="course-1" studentId="student-1" knowledgePointNames={new Map()} initialThreads={[thread]} onClose={vi.fn()} />);
    await screen.findByLabelText("统一题目讲解");
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

  it("isolates player shortcuts and only closes on a non-composing Escape", async () => {
    mockFetch();
    const onClose = vi.fn();
    const playerShortcut = vi.fn();
    window.addEventListener("keydown", playerShortcut);
    try {
      render(<KnowledgeLectureBoard attempt={attempt} courseId="course-1" studentId="student-1" knowledgePointNames={new Map()} initialThreads={[thread]} onClose={onClose} />);
      await screen.findByLabelText("统一题目讲解");
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
