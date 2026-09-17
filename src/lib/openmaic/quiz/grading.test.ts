import { describe, expect, it } from "vitest";
import type { QuizQuestion } from "@openmaic/lib/types/stage";
import { gradeChoiceQuestions } from "./grading";

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
