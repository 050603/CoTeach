import { describe, expect, it } from "vitest";
import type { SceneOutline } from "@openmaic/lib/types/generation";
import { ensureTerminalMasteryAssessment, refreshSectionQuizForGeneration } from "./terminal-mastery-assessment-policy";

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
  it("upgrades an old section only when explicitly preparing it for regeneration", () => {
    const old = {
      ...scene("old-check", "quiz", ["kp-1"]),
      keyPoints: ["第 1 题综合考查：辨认概念", "第 2 题综合考查：说明条件"],
      teachingBrief: { schemaVersion: 1 as const, explanation: '', examples: [], conditions: [], evidence: [],
        assessmentFocus: '辨认概念；说明条件' },
      quizConfig: { questionCount: 2, difficulty: 'medium' as const,
        questionTypes: ['single' as const, 'multiple' as const], coveragePolicy: 'section-synthesis' as const },
    };
    const upgraded = refreshSectionQuizForGeneration(old);
    expect(upgraded.quizConfig).toMatchObject({
      questionCountRange: { min: 2, max: 4 }, qualityContract: 'grounded-v1',
      maxShortAnswerQuestions: 0,
    });
    expect(upgraded.keyPoints).toEqual(['辨认概念', '说明条件']);
    expect(old.quizConfig).not.toHaveProperty('qualityContract');
    expect(refreshSectionQuizForGeneration(upgraded)).toEqual(upgraded);
  });
  it("removes written-response formats from a previously grounded ordinary quiz on explicit regeneration", () => {
    const stale: SceneOutline = {
      ...scene("stale-check", "quiz", ["kp-1"]),
      quizConfig: {
        questionCount: 3, questionCountRange: { min: 2, max: 4 },
        difficulty: "medium", coveragePolicy: "section-synthesis", qualityContract: "grounded-v1",
        questionTypes: ["single", "short_answer", "scenario_task"],
        minShortAnswerQuestions: 0, maxShortAnswerQuestions: 4,
      },
    };
    expect(stale.quizConfig?.questionTypes).toContain("short_answer");
    const refreshed = refreshSectionQuizForGeneration(stale, "adaptive");
    expect(refreshed.quizConfig).toMatchObject({
      questionCountRange: { min: 2, max: 4 },
      questionTypes: ["single", "multiple", "true_false", "matching", "fill_blank"],
      minShortAnswerQuestions: 0, maxShortAnswerQuestions: 0,
    });
    expect(stale.quizConfig?.questionTypes).toContain("short_answer");
  });
  it("keeps one flexible assessment after every knowledge section by default", () => {
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
        quizConfig: expect.objectContaining({
          questionCount: 2,
          questionTypes: ["single", "multiple", "true_false", "matching", "fill_blank"],
          maxShortAnswerQuestions: 0,
          questionCountRange: { min: 2, max: 4 },
        }),
      }),
      expect.objectContaining({
        id: "check-2",
        title: "第 2 节 · 节末小测",
        knowledgePointIds: ["kp-2"],
        targetDurationSec: 180,
        quizConfig: expect.objectContaining({
          questionCount: 2,
          questionTypes: ["single", "multiple", "true_false", "matching", "fill_blank"],
          maxShortAnswerQuestions: 0,
          questionCountRange: { min: 2, max: 4 },
        }),
      }),
    ]);
  });

  it("uses one synthesis response only when deep response was explicitly selected", () => {
    const result = ensureTerminalMasteryAssessment([
      scene("explain", "slide", ["kp-1", "kp-2"]),
    ], "constructed-response");
    expect(result.at(-1)?.quizConfig).toMatchObject({
      questionCount: 1,
      questionTypes: ["short_answer"],
      minShortAnswerQuestions: 1,
      maxShortAnswerQuestions: 1,
    });
  });

  it("adds one section assessment when the model omitted it", () => {
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
