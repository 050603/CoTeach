import { describe, expect, it } from "vitest";
import type { Scene, QuizQuestion } from "@openmaic/lib/types/stage";
import type { SubmittedState } from "@openmaic/lib/quiz/persistence";
import { summarizeScenes } from "./complete-summary";

const scenes = [35, 35, 35, 35, 45, 35].map((points, index) => ({
  id: `quiz-${index}`, type: "quiz", content: { type: "quiz", questions: [
    { id: "choice", type: "single", points: points - 10 },
    { id: "blank", type: "short_answer", format: "fill_blank", points: 10 },
  ] as QuizQuestion[] },
})) as Scene[];
const submission = (sceneId: string): SubmittedState => {
  const questions = scenes.find((scene) => scene.id === sceneId)!.content;
  if (questions.type !== "quiz") return null;
  return { kind: "reviewing", answers: {}, results: questions.questions.map((question) => ({
    questionId: question.id, correct: question.type === "short_answer" ? null : true,
    status: question.type === "short_answer" ? "graded" : "correct", earned: question.points!,
  })) };
};

describe("classroom quiz score", () => {
  it("converts all 220 raw points to 100, including fill blanks", () => {
    const summary = summarizeScenes(scenes, submission);
    expect(summary.quiz).toEqual({ score: 220, total: 220, pct: 100, pendingCount: 0 });
    expect(summary.assessment).toMatchObject({ submittedCount: 12, correctCount: 12, pendingCount: 0 });
  });
  it("weights sections by their authored points, rather than averaging percentages", () => {
    const summary = summarizeScenes(scenes, (id) => {
      const state = submission(id);
      if (id === "quiz-4" && state?.kind === "reviewing") {
        state.results = state.results.map((result) => ({ ...result, earned: 0, status: "incorrect" }));
      }
      return state;
    });
    expect(summary.quiz).toEqual({ score: 175, total: 220, pct: 80, pendingCount: 0 });
  });
  it("includes unsubmitted and ungraded questions in the full denominator without inventing a score", () => {
    expect(summarizeScenes(scenes, (id) => id === "quiz-0" ? submission(id) : null).quiz)
      .toEqual({ score: 35, total: 220, pct: undefined, pendingCount: 10 });
    expect(summarizeScenes(scenes, () => ({ kind: "answering", answers: { choice: "A" } })).quiz?.pct).toBeUndefined();
  });
  it("uses retained grades rather than rescoring answers or accepting drafts", () => {
    const state = submission("quiz-0");
    if (state?.kind !== "reviewing") throw new Error("Missing submission");
    state.answers = { choice: "incorrect", blank: "equivalent answer" };
    expect(summarizeScenes([scenes[0]], () => state).quiz?.pct).toBe(100);
    expect(summarizeScenes([], () => null).quiz).toBeNull();
  });

  it("separates unsubmitted questions from submitted questions awaiting grading", () => {
    const summary = summarizeScenes(scenes.slice(0, 3), (id) => id === "quiz-0" ? submission(id)
      : id === "quiz-1" ? { kind: "answering", answers: {} } : null);
    expect(summary.assessment).toEqual({
      questionCount: 6, submittedCount: 4, gradedCount: 2, correctCount: 2, pendingCount: 2, unsubmittedCount: 2,
      reviewCount: 0, reviewSceneId: "quiz-2",
    });
    expect(summary.quiz?.pct).toBeUndefined();
  });

  it("counts only valid full-credit grades as correct, including AI answers without a correctness flag", () => {
    const state = submission("quiz-0");
    if (state?.kind !== "reviewing") throw new Error("Missing submission");
    state.results[0].earned = 5;
    expect(summarizeScenes([scenes[0]], () => state).assessment)
      .toMatchObject({ submittedCount: 2, correctCount: 1, reviewCount: 1, pendingCount: 0 });
    state.results[1].earned = Number.NaN;
    expect(summarizeScenes([scenes[0]], () => state).assessment)
      .toMatchObject({ submittedCount: 2, correctCount: 0, reviewCount: 1, pendingCount: 1 });
  });

  it("prioritizes unsubmitted quizzes, then pending grading, then questions below full credit", () => {
    const reader = (id: string): SubmittedState => {
      const state = submission(id);
      if (id === "quiz-0" && state?.kind === "reviewing") state.results[0].earned = 1;
      return id === "quiz-1" ? { kind: "answering", answers: {} } : state;
    };
    expect(summarizeScenes(scenes.slice(0, 2), reader).assessment)
      .toMatchObject({ reviewCount: 1, reviewSceneId: "quiz-1" });
    expect(summarizeScenes([scenes[0], scenes[2]], reader).assessment)
      .toMatchObject({ reviewCount: 1, reviewSceneId: "quiz-0" });
    expect(summarizeScenes([scenes[2]], submission).assessment)
      .toMatchObject({ reviewCount: 0, reviewSceneId: "quiz-2" });
  });

  it("counts authored content without claiming student completion or inventing quizzes", () => {
    const content = ['slide', 'slide', 'interactive', 'pbl'].map((type, index) => ({ id: `content-${index}`, type })) as Scene[];
    expect(summarizeScenes(content, () => null)).toEqual({
      countsByType: { slide: 2, interactive: 1, pbl: 1 }, quiz: null, assessment: null,
    });
    expect(summarizeScenes([{ ...scenes[0], content: { type: 'quiz', questions: [] } }] as Scene[], () => null).assessment).toBeNull();
  });
});
