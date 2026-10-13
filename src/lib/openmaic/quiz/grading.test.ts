import { describe, expect, it } from "vitest";
import type { QuizQuestion } from "@openmaic/lib/types/stage";
import { calculateQuizScore, gradeChoiceQuestions } from "./grading";

describe("objective quiz grading", () => {
  it("scores choice, judgment, and matching locally while leaving short answers to AI", () => {
    const questions: QuizQuestion[] = [
      { id: "single", type: "single", format: "single_choice", question: "单选", answer: ["B"], points: 10 },
      { id: "multiple", type: "multiple", format: "multiple_choice", question: "多选", answer: ["A", "C"], points: 20 },
      { id: "judge", type: "single", format: "true_false", question: "判断", answer: ["false"], points: 10 },
      {
        id: "matching", type: "matching", format: "matching", question: "匹配",
        matchingPairs: [
          { leftId: "L1", left: "训练集", rightId: "R1", right: "学习参数" },
          { leftId: "L2", left: "测试集", rightId: "R2", right: "独立评估" },
        ],
        answer: ["L1:R1", "L2:R2"], points: 20,
      },
      { id: "short", type: "short_answer", format: "short_answer", question: "简答", points: 20 },
    ];

    expect(gradeChoiceQuestions(questions, {
      single: "B",
      multiple: ["C", "A"],
      judge: "true",
      matching: ["L2:R2", "L1:R1"],
      short: "学生自己的解释",
    })).toEqual([
      { questionId: "single", correct: true, status: "correct", earned: 10 },
      { questionId: "multiple", correct: true, status: "correct", earned: 20 },
      { questionId: "judge", correct: false, status: "incorrect", earned: 0 },
      { questionId: "matching", correct: true, status: "correct", earned: 20 },
    ]);
  });
});

describe("percentage scoring", () => {
  it("awards multiple-choice partial credit only without incorrect selections", () => {
    const question: QuizQuestion = { id: "q", type: "multiple", question: "多选", points: 8, answer: ["A", "C"], scoringPolicy: "course-100-v1" };
    expect(gradeChoiceQuestions([question], { q: ["A"] })[0].earned).toBe(4);
    expect(gradeChoiceQuestions([question], { q: ["A", "B"] })[0].earned).toBe(0);
    expect(gradeChoiceQuestions([question], { q: ["A", "A"] })[0].earned).toBe(0);
  });
  it("awards matching credit per correct relation without accepting duplicate pair IDs", () => {
    const question: QuizQuestion = { id: "q", type: "matching", question: "配对", points: 4, scoringPolicy: "course-100-v1",
      matchingPairs: [1, 2, 3].map((index) => ({ leftId: `L${index}`, left: `左${index}`, rightId: `R${index}`, right: `右${index}` })),
      answer: ["L1:R1", "L2:R2", "L3:R3"] };
    expect(gradeChoiceQuestions([question], { q: ["L1:R1", "L2:R3", "L3:R2"] })[0].earned).toBe(1.33);
    expect(gradeChoiceQuestions([question], { q: ["L1:R1", "L1:R1"] })[0].earned).toBe(0);
  });
  const questions = [{ id: "choice", points: 15 }, { id: "blank", points: 10 }, { id: "judge", points: 10 }];
  const results = [
    { questionId: "choice", status: "correct" as const, earned: 15 },
    { questionId: "blank", status: "graded" as const, earned: 10 },
    { questionId: "judge", status: "correct" as const, earned: 10 },
  ];
  it("counts AI-graded fill blanks toward a perfect score", () => {
    expect(calculateQuizScore(questions, results)).toEqual({
      earned: 35, possible: 35, gradedCount: 3, pendingCount: 0, percentage: 100,
    });
  });
  it("uses authored points and retains partial AI credit", () => {
    const score = calculateQuizScore(questions, [results[0], { ...results[1], earned: 6 }, { ...results[2], status: "incorrect", earned: 0 }]);
    expect(score.earned).toBe(21);
    expect(score.percentage).toBe(60);
  });
  it.each(["pending", "missing", "invalid"])("withholds a final score for %s grading", (kind) => {
    const grades = kind === "missing" ? [results[0], results[2]]
      : [results[0], { ...results[1], ...(kind === "pending" ? { status: "pending" as const } : { earned: 11 }) }, results[2]];
    expect(calculateQuizScore(questions, grades)).toEqual({ earned: 25, possible: 35, gradedCount: 2, pendingCount: 1 });
  });
  it("ignores stale results and does not count a question twice", () => {
    expect(calculateQuizScore(questions, [...results, results[0], { questionId: "stale", status: "correct", earned: 100 }]).percentage).toBe(100);
    expect(calculateQuizScore([], []).percentage).toBeUndefined();
  });
});
