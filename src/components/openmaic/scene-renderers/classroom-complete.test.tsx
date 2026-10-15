import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Scene } from "@openmaic/lib/types/stage";
import type { KnowledgeLectureAttempt } from "@/lib/session/types";
import { KnowledgeLectureQuizLockProvider } from "@/components/openmaic-bridge/knowledge-lecture-quiz-lock";
import { I18nProvider } from "@openmaic/lib/hooks/use-i18n";
import { useStageStore } from "@openmaic/lib/store";
import i18n from "@openmaic/lib/i18n/config";
import { ClassroomCompletePage, ClassroomCompletePageConnected } from "./classroom-complete";

const scene = { id: "complete-weighted-quiz", outlineId: "complete-outline", type: "quiz", content: { type: "quiz", questions: [
  { id: "choice", type: "single", points: 15 },
  { id: "blank", type: "short_answer", format: "fill_blank", points: 10 },
] } } as Scene;
const grades = [
  { questionId: "choice", correct: true, status: "correct", earned: 15 },
  { questionId: "blank", correct: null, status: "graded", earned: 10 },
];
const initialStage = useStageStore.getState();

function saveQuiz(results = grades) {
  localStorage.setItem(`quizAnswers:${scene.id}`, JSON.stringify({ choice: "A", blank: "答案" }));
  localStorage.setItem(`quizResults:${scene.id}`, JSON.stringify(results));
}
function metric(label: string) {
  return screen.getByText(label, { selector: "dt" }).nextElementSibling;
}
function serverAttempt(pending = false): KnowledgeLectureAttempt {
  return {
    id: "server-attempt", sectionId: "section", quizOutlineId: scene.outlineId!, runtimeSceneId: "previous-device-scene",
    submittedAt: "2026-10-15T00:00:00Z", gradingSource: "server", gradingStatus: pending ? "pending" : "graded",
    score: pending ? 0 : 25, maxScore: 25, knowledgePointIds: [],
    questions: grades.map((grade, index) => ({
      ...grade, questionType: index ? "short_answer" : "single", prompt: "问题", answer: "答案", points: index ? 10 : 15,
      earned: pending ? 0 : grade.earned, gradingStatus: pending ? "pending" : "graded", feedback: "", knowledgePointIds: [],
    })),
  };
}
function renderConnected(attempt: KnowledgeLectureAttempt) {
  useStageStore.setState({ scenes: [scene], stage: { id: "course", name: "科学观察", createdAt: 1, updatedAt: 1 } });
  return render(<I18nProvider locale="zh-CN"><KnowledgeLectureQuizLockProvider attemptsBySceneId={new Map([[scene.outlineId!, attempt]])}>
    <ClassroomCompletePageConnected />
  </KnowledgeLectureQuizLockProvider></I18nProvider>);
}

beforeEach(async () => { await i18n.changeLanguage("zh-CN"); });
afterEach(() => {
  localStorage.removeItem(`quizAnswers:${scene.id}`);
  localStorage.removeItem(`quizResults:${scene.id}`);
  useStageStore.setState({ scenes: initialStage.scenes, stage: initialStage.stage });
});

describe("classroom completion review", () => {
  it("displays the actual weighted grade including AI-graded answers", () => {
    saveQuiz();
    render(<I18nProvider locale="zh-CN"><ClassroomCompletePage scenes={[scene]} title="课程" /></I18nProvider>);
    expect(screen.getByText("25 / 25 分")).toBeInTheDocument();
    expect(metric("已提交")).toHaveTextContent("2 / 2 题");
    expect(metric("完全答对")).toHaveTextContent("2 题");
    expect(screen.getByText(/这次小测全部答对了/)).toBeInTheDocument();
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getByRole("group", { name: "小测回顾" })).toBeInTheDocument();
    expect(screen.queryByText(/原始得分|掌握率|知识讲授|随堂检测回顾|本课内容/)).toBeNull();
    expect(screen.getAllByRole("heading")).toHaveLength(1);
  });

  it("shows pending grading without treating submitted questions as unanswered", () => {
    saveQuiz([grades[0], { ...grades[1], status: "pending", earned: 0 }]);
    render(<I18nProvider locale="zh-CN"><ClassroomCompletePage scenes={[scene]} title="课程" /></I18nProvider>);
    expect(metric("待批阅")).toHaveTextContent("1 题");
    expect(metric("已提交")).toHaveTextContent("2 / 2 题");
    expect(metric("完全答对")).toHaveTextContent("1 题");
    expect(screen.getByText(/批阅完成后记得回来/)).toBeInTheDocument();
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.queryByText("待提交")).toBeNull();
  });

  it("offers the unfinished quiz and forwards review choices to the player", () => {
    const onReviewScene = vi.fn();
    const intro = { id: "intro", type: "slide" } as Scene;
    render(<I18nProvider locale="zh-CN"><ClassroomCompletePage scenes={[intro, scene]} title="课程" onReviewScene={onReviewScene} /></I18nProvider>);
    expect(metric("已提交")).toHaveTextContent("0 / 2 题");
    expect(metric("待提交")).toHaveTextContent("2 题");
    expect(screen.getByText(/还有小测未完成，提交后别忘了回看/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续完成小测" }));
    expect(onReviewScene).toHaveBeenLastCalledWith(scene.id);
    fireEvent.click(screen.getByRole("button", { name: "回顾本课内容" }));
    expect(onReviewScene).toHaveBeenLastCalledWith("intro");
  });

  it("separates pending grades from unsubmitted questions without showing a final score", () => {
    saveQuiz([grades[0], { ...grades[1], status: "pending", earned: 0 }]);
    const unfinished = { ...scene, id: "not-submitted-quiz" };
    render(<I18nProvider locale="zh-CN"><ClassroomCompletePage scenes={[scene, unfinished]} title="课程" /></I18nProvider>);
    expect(metric("已提交")).toHaveTextContent("2 / 4 题");
    expect(metric("完全答对")).toHaveTextContent("1 题");
    expect(metric("待批阅")).toHaveTextContent("1 题");
    expect(screen.getByText(/还有小测未完成/)).toBeInTheDocument();
    expect(screen.queryByText("小测得分")).toBeNull();
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("keeps the same encouraging headline for a low score with a direct review action", () => {
    saveQuiz(grades.map((grade) => ({ ...grade, earned: 0, status: "incorrect" })));
    render(<I18nProvider locale="zh-CN"><ClassroomCompletePage scenes={[scene]} title="课程" onReviewScene={vi.fn()} /></I18nProvider>);
    expect(screen.getByRole("heading", { name: "又向前迈进了一步！" })).toBeInTheDocument();
    expect(screen.getByText("0 / 25 分")).toBeInTheDocument();
    expect(metric("完全答对")).toHaveTextContent("0 题");
    expect(screen.getByText(/别忘了回看错题与解析/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "回看错题与解析" })).toBeInTheDocument();
    expect(screen.queryByText(/万事开头难|完美发挥/)).toBeNull();
  });

  it("opens the quiz that needs review instead of an earlier full-credit quiz", () => {
    const onReviewScene = vi.fn();
    const reviewScene = { ...scene, id: "quiz-needs-review" };
    render(<I18nProvider locale="zh-CN"><ClassroomCompletePage scenes={[scene, reviewScene]} title="课程" onReviewScene={onReviewScene}
      readSubmission={(id) => ({ kind: "reviewing", answers: {}, results: grades.map((grade) => ({
        ...grade, status: "graded", earned: id === reviewScene.id && grade.questionId === "blank" ? 5 : grade.earned,
      })) })} /></I18nProvider>);
    expect(metric("完全答对")).toHaveTextContent("3 题");
    fireEvent.click(screen.getByRole("button", { name: "回看错题与解析" }));
    expect(onReviewScene).toHaveBeenCalledWith(reviewScene.id);
  });

  it("does not invent scores or actions for a course without quizzes or content", () => {
    const view = render(<I18nProvider locale="zh-CN"><ClassroomCompletePage scenes={[{ id: "intro", type: "slide" } as Scene]} title="课程" /></I18nProvider>);
    expect(screen.getByRole("heading", { name: "又向前迈进了一步！" })).toBeInTheDocument();
    expect(screen.getByText("课程", { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "小测回顾" })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(<I18nProvider locale="zh-CN"><ClassroomCompletePage scenes={[]} title="" onReviewScene={vi.fn()} /></I18nProvider>);
    expect(screen.getByText("这里还没有可回顾的学习内容。")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it.each(["missing", "stale"])("prefers saved server attempts by outline identity over %s browser grades", (cache) => {
    if (cache === "stale") saveQuiz(grades.map((grade) => ({ ...grade, earned: 0 })));
    renderConnected(serverAttempt());
    expect(screen.getByText("25 / 25 分")).toBeInTheDocument();
    expect(metric("已提交")).toHaveTextContent("2 / 2 题");
    expect(metric("完全答对")).toHaveTextContent("2 题");
  });

  it("updates an already open review when authoritative grading arrives after a pending attempt", () => {
    renderConnected(serverAttempt(true));
    expect(metric("待批阅")).toHaveTextContent("2 题");
    act(() => window.dispatchEvent(new CustomEvent("openpbl:knowledge-lecture-server-graded", {
      detail: { sceneId: scene.id, results: grades },
    })));
    expect(screen.getByText("25 / 25 分")).toBeInTheDocument();
    expect(metric("完全答对")).toHaveTextContent("2 题");
    expect(screen.queryByText("待批阅")).toBeNull();
  });

  it("uses refreshed server records after an earlier event still reported pending grading", () => {
    const view = renderConnected(serverAttempt(true));
    act(() => window.dispatchEvent(new CustomEvent("openpbl:knowledge-lecture-server-graded", {
      detail: { sceneId: scene.id, results: grades.map((grade) => ({ ...grade, status: "pending", earned: 0 })) },
    })));
    expect(metric("待批阅")).toHaveTextContent("2 题");
    view.rerender(<I18nProvider locale="zh-CN"><KnowledgeLectureQuizLockProvider attemptsBySceneId={new Map([[scene.outlineId!, serverAttempt()]])}>
      <ClassroomCompletePageConnected />
    </KnowledgeLectureQuizLockProvider></I18nProvider>);
    expect(screen.getByText("25 / 25 分")).toBeInTheDocument();
  });

  it("refreshes browser submissions changed in another tab", () => {
    render(<I18nProvider locale="zh-CN"><ClassroomCompletePage scenes={[scene]} title="课程" /></I18nProvider>);
    expect(metric("待提交")).toHaveTextContent("2 题");
    saveQuiz();
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: `quizResults:${scene.id}` })));
    expect(screen.getByText("25 / 25 分")).toBeInTheDocument();
    expect(metric("已提交")).toHaveTextContent("2 / 2 题");
  });
});
