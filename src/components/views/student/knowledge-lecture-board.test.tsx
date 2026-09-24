import { render, screen, within } from "@testing-library/react";
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
});
