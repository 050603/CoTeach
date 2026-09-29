import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { QuizQuestion } from "@openmaic/lib/types/stage";
import type { KnowledgeLectureAttempt } from "@/lib/session/types";
import { KnowledgeLectureQuizLockProvider } from "@/components/openmaic-bridge/knowledge-lecture-quiz-lock";
import { I18nProvider } from "@openmaic/lib/hooks/use-i18n";
import { QuizView } from "./quiz-view";
import { gradeShortAnswerQuestion } from "./quiz-grade-client";

vi.mock("./quiz-grade-client", () => ({ gradeShortAnswerQuestion: vi.fn() }));

describe("QuizView single-attempt review", () => {
  it("releases submission before delayed grading and waits for review confirmation", async () => {
    const sceneId = "staged-delay-quiz";
    const questions: QuizQuestion[] = [{
      id: "short-1",
      type: "short_answer",
      format: "fill_blank",
      question: "实验中需要控制什么？",
      points: 10,
      analysis: "需要控制其他可能影响结果的条件。",
    }];
    let finishGrading!: (result: Awaited<ReturnType<typeof gradeShortAnswerQuestion>>) => void;
    vi.mocked(gradeShortAnswerQuestion).mockImplementationOnce(() => new Promise((resolve) => {
      finishGrading = resolve;
    }));
    const events: string[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent<{ purpose: string }>).detail.purpose);
    window.addEventListener("openmaic:playback-activity-complete", listener);

    render(
      <I18nProvider>
        <KnowledgeLectureQuizLockProvider attemptsBySceneId={new Map()}>
          <QuizView questions={questions} quizOutlineId="staged-delay" sceneId={sceneId} stagedPlayback />
        </KnowledgeLectureQuizLockProvider>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /开始答题|Start Quiz/ }));
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "其他变量" } });
    fireEvent.click(screen.getByRole("button", { name: /提交答案|Submit Answers/ }));
    expect(events).toEqual(["quiz-submit"]);
    expect(await screen.findByText("正在批阅")).toBeTruthy();

    finishGrading({ questionId: "short-1", correct: null, status: "graded", earned: 10, aiComment: "正确" });
    await waitFor(() => expect(screen.getByText("Quiz Report")).toBeTruthy());
    expect(events).toEqual(["quiz-submit"]);
    fireEvent.click(screen.getByRole("button", { name: "我已经理解，可以继续" }));
    expect(events).toEqual(["quiz-submit", "quiz"]);

    window.removeEventListener("openmaic:playback-activity-complete", listener);
    localStorage.removeItem(`quizAnswers:${sceneId}`);
    localStorage.removeItem(`quizResults:${sceneId}`);
  });

  it("restores an already submitted staged quiz at the review gate", async () => {
    const sceneId = "staged-restored-quiz";
    const questions: QuizQuestion[] = [{
      id: "choice-1", type: "single", format: "single_choice", question: "哪项是前提？",
      options: [{ value: "A", label: "观察证据" }, { value: "B", label: "猜测" }],
      answer: ["A"], analysis: "观察证据是前提。", points: 1,
    }];
    localStorage.setItem(`quizAnswers:${sceneId}`, JSON.stringify({ "choice-1": "A" }));
    localStorage.setItem(`quizResults:${sceneId}`, JSON.stringify([{
      questionId: "choice-1", correct: true, status: "correct", earned: 1,
    }]));
    const events: string[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent<{ purpose: string }>).detail.purpose);
    window.addEventListener("openmaic:playback-activity-complete", listener);

    render(
      <I18nProvider>
        <KnowledgeLectureQuizLockProvider attemptsBySceneId={new Map()}>
          <QuizView questions={questions} quizOutlineId="staged-restored" sceneId={sceneId} stagedPlayback />
        </KnowledgeLectureQuizLockProvider>
      </I18nProvider>,
    );

    expect(await screen.findByText("Quiz Report")).toBeTruthy();
    expect(events).toEqual(["quiz-submit"]);
    fireEvent.click(screen.getByRole("button", { name: "我已经理解，可以继续" }));
    expect(events).toEqual(["quiz-submit", "quiz"]);

    window.removeEventListener("openmaic:playback-activity-complete", listener);
    localStorage.removeItem(`quizAnswers:${sceneId}`);
    localStorage.removeItem(`quizResults:${sceneId}`);
  });
  it("renders ordinary checks as direct choices and a one-line fill input", async () => {
    const questions: QuizQuestion[] = [
      {
        id: "single-1",
        type: "single",
        format: "single_choice",
        question: "训练集的主要用途是什么？",
        options: [{ value: "A", label: "学习模型参数" }, { value: "B", label: "最终独立评估" }],
        answer: ["A"],
        points: 10,
      },
      {
        id: "judge-1",
        type: "single",
        format: "true_false",
        question: "测试集可以反复用于调参。",
        options: [{ value: "true", label: "正确" }, { value: "false", label: "错误" }],
        answer: ["false"],
        points: 10,
      },
      {
        id: "blank-1",
        type: "short_answer",
        format: "fill_blank",
        question: "测试集用于____模型的泛化表现。",
        commentPrompt: "填写一个短语即可。",
        points: 10,
      },
      {
        id: "multiple-1",
        type: "multiple",
        format: "multiple_choice",
        question: "哪些做法能保持测试集独立？",
        options: [{ value: "A", label: "只在最终评估时使用" }, { value: "B", label: "每轮调参后都查看结果" }, { value: "C", label: "调参阶段使用验证集" }],
        answer: ["A", "C"],
        points: 10,
      },
      {
        id: "scenario-1",
        type: "short_answer",
        format: "scenario_task",
        question: "为一个小型研究设计数据划分方案。",
        commentPrompt: "说明判断和依据。",
        points: 10,
      },
    ];

    render(
      <I18nProvider>
        <KnowledgeLectureQuizLockProvider attemptsBySceneId={new Map()}>
          <QuizView questions={questions} quizOutlineId="quiz-objective" sceneId="scene-objective" />
        </KnowledgeLectureQuizLockProvider>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /开始答题|Start Quiz/ }));
    expect(await screen.findByRole("button", { name: /学习模型参数/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /错误/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /只在最终评估时使用/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByPlaceholderText("填写关键概念或关系").tagName).toBe("INPUT");
    expect(screen.getByPlaceholderText("写出你的判断、依据和解决思路").tagName).toBe("TEXTAREA");
    expect(screen.queryByRole("textbox", { name: /理由/ })).toBeNull();
  });

  it("shows answered progress, keeps the answer key hidden, and restores a saved draft", async () => {
    const questions: QuizQuestion[] = [{
      id: "progress-1",
      type: "single",
      format: "single_choice",
      question: "哪组数据用于学习模型参数？",
      options: [{ value: "A", label: "训练集" }, { value: "B", label: "测试集" }],
      answer: ["A"],
      analysis: "训练集用于学习参数，测试集用于独立评估。",
      points: 10,
    }];
    localStorage.setItem("quizDraft:scene-draft", JSON.stringify({ "progress-1": "A" }));

    render(
      <I18nProvider>
        <KnowledgeLectureQuizLockProvider attemptsBySceneId={new Map()}>
          <QuizView questions={questions} quizOutlineId="quiz-draft" sceneId="scene-draft" />
        </KnowledgeLectureQuizLockProvider>
      </I18nProvider>,
    );

    expect(screen.queryByText("训练集用于学习参数，测试集用于独立评估。")).toBeNull();
    expect(screen.queryByText("正确答案")).toBeNull();
    expect(await screen.findByText("已完成 1 / 1")).toBeTruthy();
    expect(screen.getByText("已全部完成")).toBeTruthy();
    expect(screen.getByRole("button", { name: /训练集/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Submit Answers|提交答案/ })).not.toBeDisabled();

    localStorage.removeItem("quizDraft:scene-draft");
  });

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
    const completionListener = vi.fn();
    window.addEventListener("openmaic:playback-activity-complete", completionListener);

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
    fireEvent.click(screen.getByRole("button", { name: "我已经理解，可以继续" }));
    expect(completionListener).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "已确认理解" })).toBeDisabled();
    window.removeEventListener("openmaic:playback-activity-complete", completionListener);
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
