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
    expect(summarizeScenes(scenes, submission).quiz).toEqual({ score: 220, total: 220, pct: 100, pendingCount: 0 });
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
});
