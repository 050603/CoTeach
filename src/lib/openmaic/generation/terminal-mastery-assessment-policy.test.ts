import { describe, expect, it } from "vitest";
import type { SceneOutline } from "@openmaic/lib/types/generation";
import { ensureTerminalMasteryAssessment } from "./terminal-mastery-assessment-policy";

function scene(id: string, type: SceneOutline["type"], knowledgePointIds: string[]): SceneOutline {
  return {
    id, type, title: id, description: id, keyPoints: [id], order: 0,
    stageKey: "ai-learning", stageLabel: "AI 授课", audience: "student",
    generationPurpose: "knowledge-teaching", parentActivityId: "activity-ai",
    activityId: "activity-ai", detailKind: "knowledge-explanation",
    knowledgePointIds, targetDurationSec: 180, ttsPolicy: "target-duration",
  };
}

describe("ensureTerminalMasteryAssessment", () => {
  it("keeps one concise subjective assessment after every knowledge section", () => {
    const result = ensureTerminalMasteryAssessment([
      scene("explain-1", "slide", ["kp-1"]),
      scene("check-1", "quiz", ["kp-1"]),
      scene("practice-2", "interactive", ["kp-2"]),
      scene("check-2", "quiz", ["kp-2"]),
    ]);
    expect(result.map((item) => item.type)).toEqual(["slide", "quiz", "interactive", "quiz"]);
    expect(result.filter((item) => item.type === "quiz")).toEqual([
      expect.objectContaining({
        id: "check-1",
        title: "第 1 节 · 节末小测",
        knowledgePointIds: ["kp-1"],
        targetDurationSec: 180,
        quizConfig: expect.objectContaining({ questionCount: 2, questionTypes: ["short_answer"] }),
      }),
      expect.objectContaining({
        id: "check-2",
        title: "第 2 节 · 节末小测",
        knowledgePointIds: ["kp-2"],
        targetDurationSec: 180,
        quizConfig: expect.objectContaining({ questionCount: 2, questionTypes: ["short_answer"] }),
      }),
    ]);
  });

  it("adds one terminal assessment when the model omitted it", () => {
    const result = ensureTerminalMasteryAssessment([
      {
        ...scene("explain", "slide", ["kp-1"]),
        teachingToolPlan: [{
          id: "explanation-board",
          tool: "whiteboard",
          trigger: "讲解概念关系时",
          purpose: "展示概念关系",
          content: ["概念 A → 概念 B"],
          required: true,
        }],
      },
    ]);
    expect(result.filter((item) => item.type === "quiz")).toHaveLength(1);
    expect(result.at(-1)?.type).toBe("quiz");
    expect(result.at(-1)?.teachingToolPlan).toBeUndefined();
  });

  it("does not alter teacher-only resources", () => {
    const teacher = { ...scene("teacher", "slide", ["kp-1"]), audience: "teacher" as const };
    expect(ensureTerminalMasteryAssessment([teacher])).toEqual([teacher]);
  });
});
