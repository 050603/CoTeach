import { describe, expect, it } from "vitest";
import type { SceneOutline } from "@openmaic/lib/types/generation";
import type {
  Course,
  KnowledgeLectureAttempt,
  OpenMaicSceneOutlineSnapshot,
  StudentAiProgress,
} from "@/lib/session/types";
import {
  aggregateKnowledgePointMastery,
  deriveKnowledgeLectureSectionsFromOutlines,
  knowledgeLectureQuizEstimate,
  organizeKnowledgeLectureOutlines,
} from "./knowledge-lecture";

function outline(
  id: string,
  knowledgePointIds: string[],
): SceneOutline & OpenMaicSceneOutlineSnapshot {
  return {
    id,
    type: "slide",
    title: id,
    description: id,
    keyPoints: [id],
    order: 0,
    stageKey: "ai-learning",
    stageLabel: "知识讲授",
    audience: "student",
    generationPurpose: "knowledge-teaching",
    activityId: "knowledge",
    parentActivityId: "knowledge",
    detailKind: "knowledge-explanation",
    knowledgePointIds,
    targetDurationSec: 180,
    ttsPolicy: "target-duration",
  };
}

describe("knowledge lecture sections", () => {
  it("preserves source groups and gives each section quiz all of its teaching evidence", () => {
    const first = { ...outline("first", ["a"]), teachingBrief: { schemaVersion: 1 as const, explanation: "第一个概念的核心解释", examples: ["例一"], conditions: ["条件一"], evidence: [{ sourceId: "doc", quote: "原文一" }], assessmentFocus: "解释概念一" } };
    const second = { ...outline("second", ["b"]), teachingBrief: { ...first.teachingBrief, explanation: "第二个概念的核心解释", examples: ["例二"], conditions: ["条件二"], assessmentFocus: "解释概念二" } };
    const result = organizeKnowledgeLectureOutlines([first, second, outline("third", ["c"])], { totalDurationSec: 1200, knowledgePoints: [
      { id: "a", name: "概念一", description: "", groupId: "g1", groupName: "理论依据" },
      { id: "b", name: "概念二", description: "", groupId: "g1", groupName: "理论依据" },
      { id: "c", name: "概念三", description: "", groupId: "g2", groupName: "课堂方法" },
    ] });
    expect(result.sections.map((section) => section.knowledgePointIds)).toEqual([["a", "b"], ["c"]]);
    expect(result.sections[0].title).toContain("理论依据");
    const quiz = result.outlines.find((page) => page.id === result.sections[0].quizOutlineId)!;
    expect(quiz.teachingBrief?.explanation).toContain("第一个概念");
    expect(quiz.teachingBrief?.explanation).toContain("第二个概念");
    expect(quiz.teachingBrief?.conditions).toEqual(["条件一", "条件二"]);
    expect(quiz.teachingBrief?.evidence).toHaveLength(1);
  });
  it.each([600, 1440, 2880, 1501])("keeps teaching and quizzes inside an exact %i second budget", (totalDurationSec) => {
    const points = Array.from({ length: 5 }, (_, index) => ({ id: `kp-${index}`, name: `知识${index}`, description: "" }));
    const result = organizeKnowledgeLectureOutlines(points.map((point) => outline(`page-${point.id}`, [point.id])), {
      totalDurationSec, knowledgePoints: points,
    });
    expect(result.outlines.reduce((sum, item) => sum + (item.targetDurationSec ?? 0), 0)).toBe(totalDurationSec);
    expect(result.outlines.filter((item) => item.type !== "quiz")).toHaveLength(points.length);
    expect(result.outlines.filter((item) => item.type === "quiz").every((item) => item.targetDurationSec! >= 120 && item.targetDurationSec! <= 300)).toBe(true);
  });

  it("refuses an impossible budget rather than silently extending the lecture", () => {
    expect(() => organizeKnowledgeLectureOutlines([outline("p", ["kp"])], {
      totalDurationSec: 100,
      knowledgePoints: [{ id: "kp", name: "概念", description: "" }],
    })).toThrow("时间预算");
  });

  it("groups related knowledge points and appends a concise subjective quiz to every section", () => {
    const result = organizeKnowledgeLectureOutlines([
      outline("page-1", ["kp-1"]),
      outline("page-2", ["kp-2"]),
      outline("page-3", ["kp-3"]),
    ], {
      totalDurationSec: 1_200,
      knowledgePoints: [
        { id: "kp-1", name: "概念", description: "" },
        { id: "kp-2", name: "依据", description: "" },
        { id: "kp-3", name: "应用", description: "" },
      ],
      knowledgeGraph: {
        nodes: [],
        edges: [{ id: "edge-1", source: "kp-1", target: "kp-2", label: "支撑" }],
      },
    });

    expect(result.sections).toHaveLength(2);
    expect(result.outlines.filter((item) => item.type === "quiz")).toHaveLength(2);
    expect(result.outlines.filter((item) => item.type !== "quiz").map((item) => item.id)).toEqual([
      "page-1",
      "page-2",
      "page-3",
    ]);
    for (const quiz of result.outlines.filter((item) => item.type === "quiz")) {
      expect(quiz.targetDurationSec).toBeGreaterThanOrEqual(120);
      expect(quiz.targetDurationSec).toBeLessThanOrEqual(300);
      expect(quiz.quizConfig?.questionCount).toBeGreaterThanOrEqual(2);
      expect(quiz.quizConfig?.questionCount).toBeLessThanOrEqual(3);
      expect(quiz.quizConfig?.questionTypes).toEqual(["short_answer"]);
    }
    expect(deriveKnowledgeLectureSectionsFromOutlines(result.outlines)).toEqual(result.sections);
  });

  it("reports the exact generated quiz question count and duration", () => {
    const section = {
      id: "knowledge-section-1",
      title: "第一节",
      order: 0,
      knowledgePointIds: ["kp-1", "kp-2", "kp-3"],
      sceneOutlineIds: ["scene-1"],
      quizOutlineId: "quiz-1",
      estimatedMinutes: 10,
    };
    const course = {
      content: {
        knowledgePoints: [],
        _openmaicSceneOutlines: [{
          id: "quiz-1",
          type: "quiz",
          title: "节末小测",
          targetDurationSec: 240,
          quizConfig: { questionCount: 3 },
        }],
      },
      aiLearningProgress: {},
    } as unknown as Course;

    expect(knowledgeLectureQuizEstimate(course, section)).toEqual({
      questionCount: 3,
      estimatedMinutes: 4,
    });
  });

  it("uses the first submission and reports unmet rate, score loss, coverage, and evidence state", () => {
    const attempt = (
      submittedAt: string,
      earned: number,
      knowledgePointId: string,
    ): KnowledgeLectureAttempt => ({
      id: `attempt-${submittedAt}`,
      sectionId: "knowledge-section-1",
      quizOutlineId: "knowledge-section-1-check",
      runtimeSceneId: "runtime-quiz",
      submittedAt,
      score: earned,
      maxScore: 10,
      knowledgePointIds: [knowledgePointId],
      questions: [{
        questionId: "q-1",
        prompt: "为什么？",
        answer: "回答",
        points: 10,
        earned,
        correct: earned >= 8,
        feedback: "反馈",
        knowledgePointIds: [knowledgePointId],
      }],
    });
    const progress = (studentId: string, attempts: KnowledgeLectureAttempt[]): StudentAiProgress => ({
      classroomId: "classroom",
      studentId,
      currentSceneIndex: 1,
      totalScenes: 3,
      completedScenes: [],
      lastActiveAt: "2026-01-01T00:00:00.000Z",
      masteryLevel: "in-progress",
      knowledgeLectureAttempts: attempts,
    });
    const course = {
      content: {
        knowledgePoints: [
          { id: "kp-1", name: "概念", description: "" },
          { id: "kp-2", name: "应用", description: "" },
        ],
      },
      aiLearningProgress: {
        student1: progress("student1", [
          attempt("2026-01-01T00:00:00.000Z", 2, "kp-1"),
          attempt("2026-01-02T00:00:00.000Z", 4, "kp-1"),
        ]),
        student2: progress("student2", [attempt("2026-01-02T00:00:00.000Z", 9, "kp-2")]),
      },
      students: [
        { id: "student1", name: "学生1" },
        { id: "student2", name: "学生2" },
      ],
    } as unknown as Course;

    expect(aggregateKnowledgePointMastery(course)).toEqual([
      expect.objectContaining({ knowledgePointId: "kp-1", unmetRate: 100, scoreLossRate: 80, responseCoverage: 50, answeredStudents: 1, status: "collecting" }),
      expect.objectContaining({ knowledgePointId: "kp-2", unmetRate: 0, scoreLossRate: 10, responseCoverage: 50, answeredStudents: 1, status: "collecting" }),
    ]);
  });

  it("separates early observation from a confirmed class-wide misconception", () => {
    const makeProgress = (studentId: string, earned: number): StudentAiProgress => ({
      classroomId: "classroom",
      studentId,
      currentSceneIndex: 1,
      totalScenes: 3,
      completedScenes: [],
      lastActiveAt: "2026-01-01T00:00:00.000Z",
      masteryLevel: "in-progress",
      knowledgeLectureAttempts: [{
        id: `attempt-${studentId}`,
        sectionId: "section-1",
        quizOutlineId: "quiz-1",
        runtimeSceneId: "runtime-1",
        submittedAt: "2026-01-01T00:00:00.000Z",
        score: earned,
        maxScore: 10,
        knowledgePointIds: ["kp-1"],
        questions: [{ questionId: "q-1", prompt: "解释概念", answer: "错误理解", points: 10, earned, correct: earned >= 8, feedback: "概念定义混淆", knowledgePointIds: ["kp-1"] }],
      }],
    });
    const students = Array.from({ length: 5 }, (_, index) => ({ id: `s-${index}`, name: `学生${index}` }));
    const base = { content: { knowledgePoints: [{ id: "kp-1", name: "概念", description: "" }] }, students };

    const observing = aggregateKnowledgePointMastery({ ...base, aiLearningProgress: { "s-0": makeProgress("s-0", 2), "s-1": makeProgress("s-1", 3) } } as unknown as Course)[0];
    expect(observing).toMatchObject({ status: "observing", answeredStudents: 2, minimumSampleSize: 3, unmetRate: 100 });

    const confirmed = aggregateKnowledgePointMastery({ ...base, aiLearningProgress: { "s-0": makeProgress("s-0", 2), "s-1": makeProgress("s-1", 3), "s-2": makeProgress("s-2", 9) } } as unknown as Course)[0];
    expect(confirmed).toMatchObject({ status: "confirmed", answeredStudents: 3, incorrectStudents: 2, unmetRate: 67, responseCoverage: 60 });
    expect(confirmed.misconceptionGroups[0]).toMatchObject({ code: "concept", studentCount: 2 });
  });
});
