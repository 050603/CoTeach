import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { QuizQuestion } from "@openmaic/lib/types/stage";
import type { KnowledgeLectureAttempt } from "@/lib/session/types";
import { KnowledgeLectureQuizLockProvider } from "@/components/openmaic-bridge/knowledge-lecture-quiz-lock";
import { I18nProvider } from "@openmaic/lib/hooks/use-i18n";
import { QuizView } from "./quiz-view";

describe("QuizView single-attempt review", () => {
  it("restores the server submission as read-only and never renders a retry action", () => {
    const questions = [{
      id: "question-1",
      type: "short_answer",
      question: "什么是变量关系？",
      points: 10,
      analysis: "说明变量之间的变化关系。",
    }] as QuizQuestion[];
    const attempt: KnowledgeLectureAttempt = {
      id: "attempt-1",
      sectionId: "section-1",
      quizOutlineId: "quiz-1",
      runtimeSceneId: "old-runtime-scene",
      submittedAt: "2026-09-01T10:00:00.000Z",
      score: 4,
      maxScore: 10,
      knowledgePointIds: ["kp-1"],
      questions: [{
        questionId: "question-1",
        prompt: "什么是变量关系？",
        answer: "首次提交的答案",
        points: 10,
        earned: 4,
        correct: false,
        feedback: "需要说明变化方向",
        referenceAnswer: "因变量随自变量变化",
        knowledgePointIds: ["kp-1"],
      }],
    };
    const attempts = new Map([["quiz-1", attempt]]);

    render(
      <I18nProvider>
        <KnowledgeLectureQuizLockProvider attemptsBySceneId={attempts}>
          <QuizView questions={questions} quizOutlineId="quiz-1" sceneId="new-runtime-scene" />
        </KnowledgeLectureQuizLockProvider>
      </I18nProvider>,
    );

    expect(screen.getByText("首次提交的答案")).toBeTruthy();
    expect(screen.getByText("本小节测验仅可作答一次")).toBeTruthy();
    expect(screen.queryByText("重做")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("supports dragging an assigned card back to the pool before grading", async () => {
    const questions: QuizQuestion[] = [{
      id: "matching-1",
      type: "matching",
      format: "matching",
      question: "匹配数据角色与用途",
      matchingPairs: [
        { leftId: "L1", left: "训练集", rightId: "R1", right: "学习参数" },
        { leftId: "L2", left: "测试集", rightId: "R2", right: "独立评估" },
      ],
      answer: ["L1:R1", "L2:R2"],
      analysis: "训练用于学习，测试用于独立评估。",
      points: 10,
    }];

    render(
      <I18nProvider>
        <KnowledgeLectureQuizLockProvider attemptsBySceneId={new Map()}>
          <QuizView questions={questions} quizOutlineId="quiz-matching" sceneId="scene-matching" />
        </KnowledgeLectureQuizLockProvider>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start Quiz" }));
    fireEvent.click(await screen.findByRole("button", { name: "选择匹配项 学习参数" }));
    fireEvent.click(screen.getByRole("button", { name: "匹配到 训练集" }));

    const transferValues = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "none",
      getData: vi.fn((type: string) => transferValues.get(type) ?? ""),
      setData: vi.fn((type: string, data: string) => transferValues.set(type, data)),
      setDragImage: vi.fn(),
    };
    fireEvent.dragStart(screen.getByLabelText("移动匹配项 学习参数"), { dataTransfer });
    expect(dataTransfer.setDragImage).toHaveBeenCalledOnce();
    fireEvent.drop(screen.getByLabelText("待选匹配项"), { dataTransfer });
    expect(screen.getByRole("button", { name: "选择匹配项 学习参数" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "选择匹配项 学习参数" }));
    fireEvent.click(screen.getByRole("button", { name: "匹配到 训练集" }));
    fireEvent.click(screen.getByRole("button", { name: "选择匹配项 独立评估" }));
    fireEvent.click(screen.getByRole("button", { name: "匹配到 测试集" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit Answers" }));

    await waitFor(() => expect(screen.getByText("Quiz Report")).toBeTruthy());
    expect(screen.getByText("训练集")).toBeTruthy();
    expect(screen.getByText("训练用于学习，测试用于独立评估。")).toBeTruthy();
  });
});
