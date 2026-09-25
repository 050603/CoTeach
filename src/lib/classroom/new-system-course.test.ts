import { describe, expect, it } from "vitest";
import type { Course } from "@/lib/session/types";
import { getStagesForSystemMode } from "@/lib/system-mode";
import {
  buildNewSystemAiTimingPlan,
  buildNewSystemAiTeachingOutline,
  buildNewSystemTimingPlan,
  getNewSystemCourseReadiness,
  isNewSystemCourseReady,
  isNewSystemAiTimingPlan,
  hasExactKnowledgeLecturePageBudget,
} from "./new-system-course";

function readyCourse(): Course {
  const timingPlan = buildNewSystemTimingPlan(27, "2026-08-30T00:00:00.000Z");
  return {
    id: "course-new-ready",
    name: "校园节能",
    subject: "科学",
    grade: "初中",
    hours: 1.5,
    summary: "理解节能知识并完成课堂项目。",
    drivingQuestion: "如何改善校园节能？",
    status: "ready",
    stages: getStagesForSystemMode("new"),
    currentStageIndex: 0,
    content: {
      pblOutline: "",
      knowledgePoints: [{ id: "kp-1", name: "能耗", description: "理解能耗", level: "core" }],
      teachingOutline: [],
      lessonOutline: [],
      evaluationPlan: { dimensions: [], overallRubric: "" },
      moduleTimingPlan: timingPlan,
      _openmaicClassroomId: "classroom-ai",
      _openmaicSceneOutlines: [{
        id: "scene-ai",
        title: "能耗基础",
        stageKey: "ai-learning",
        audience: "student",
      }],
    },
    aiLearningClassroomId: "classroom-ai",
    students: [],
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
}

describe("new-system course contract", () => {
  it("blocks publishing while a downstream design artifact is stale", () => {
    const course = readyCourse();
    course.content.designWorkspaceRevision = {
      schemaVersion: 1,
      revision: 2,
      updatedAt: "2026-09-20T00:00:00.000Z",
      sections: {},
      pendingUpdates: [{
        id: "2:knowledge:classroom",
        source: "knowledge",
        target: "classroom",
        reason: "知识结构已修改",
        affectedSectionIds: ["section-1"],
        affectedOutlineIds: ["scene-ai"],
        includesManualEdits: true,
        createdAt: "2026-09-20T00:00:00.000Z",
      }],
    };
    expect(getNewSystemCourseReadiness(course).find((check) => check.id === "design-workspace-freshness"))
      .toMatchObject({ ok: false, label: "课程设计依赖" });
    expect(isNewSystemCourseReady(course)).toBe(false);
  });

  it("keeps measured duration deviation advisory while requiring complete usable audio evidence", () => {
    const course = readyCourse();
    course.content.teachingBlueprint = { assessmentMode: "adaptive" } as Course["content"]["teachingBlueprint"];
    course.content.teachingTimingAudit = {
      schemaVersion: 1, totalBudgetSec: 1_620, plannedSubstantiveTeachingSec: 1_100,
      plannedAssessmentSec: 320, plannedLearnerActivitySec: 200,
      substantiveTeachingDurationSec: 1_400, assessmentAudioDurationSec: 0,
      narrationDurationSource: "actual-audio", measuredSegmentCount: 2, narrationSegmentCount: 2,
      complete: true, substantiveTeachingRatio: 0.8642, teachingRatioValid: false,
      generatedAt: "2026-09-20T00:00:00Z",
    };
    expect(isNewSystemCourseReady(course)).toBe(true);
    expect(course.content.teachingTimingAudit.teachingRatioValid).toBe(false);

    const audit = course.content.teachingTimingAudit;
    for (const patch of [
      { complete: false }, { measuredSegmentCount: 1 }, { narrationSegmentCount: 0, measuredSegmentCount: 0 },
      { substantiveTeachingDurationSec: 0 }, { substantiveTeachingDurationSec: Number.NaN },
    ]) {
      const incomplete = { ...course, content: { ...course.content, teachingTimingAudit: { ...audit, ...patch } } };
      expect(getNewSystemCourseReadiness(incomplete).find((check) => check.id === "timing")?.ok).toBe(false);
    }
    delete course.content.teachingTimingAudit;
    expect(getNewSystemCourseReadiness(course).find((check) => check.id === "timing"))
      .toMatchObject({ ok: false, message: expect.stringContaining("重新核查全部音频") });
  });

  it("preserves the confirmed page budget even when narration duration is only advisory", () => {
    const course = readyCourse();
    course.content.knowledgeLectureSections = [{ id: "section", title: "节能", order: 0, knowledgePointIds: ["kp-1"], sceneOutlineIds: ["scene-ai"], quizOutlineId: "quiz", estimatedMinutes: 27 }];
    course.content._openmaicSceneOutlines![0]!.targetDurationSec = 120;
    expect(getNewSystemCourseReadiness(course).find((check) => check.id === "timing")?.ok).toBe(false);
  });

  it("recognizes teacher confirmation without an optional quality report", () => {
    const course = readyCourse();
    course.content.qualityReviewRequired = true;
    course.content.teacherReview = { schemaVersion: 1, courseId: course.id, classroomId: "classroom-ai", signature: "a".repeat(64), teacherId: "teacher", confirmedAt: "2026-09-14", acceptedIssueIds: [], seal: "b".repeat(64) };
    expect(getNewSystemCourseReadiness(course).find((check) => check.id === "teacher-review")?.ok).toBe(true);
    course.content.teacherReview.classroomId = "old-classroom";
    expect(getNewSystemCourseReadiness(course).find((check) => check.id === "teacher-review")?.ok).toBe(false);
  });
  it("keeps a single-lesson production sample out of the publishable state", () => {
    const course = readyCourse();
    course.content.classroomGenerationRun = {
      scope: "test-lesson",
      status: "completed",
      generatedOutlineIds: ["scene-ai"],
      fullOutlineCount: 8,
      testLesson: { sectionId: "section-1", sectionTitle: "第一节", sceneOutlineIds: ["scene-ai"], durationSeconds: 300 },
    };
    const check = getNewSystemCourseReadiness(course).find((item) => item.id === "full-classroom-generation");
    expect(check).toMatchObject({ ok: false, label: "完整课程生成" });
    expect(check?.message).toContain("测试样本");

    course.content.classroomGenerationRun = {
      scope: "full-course",
      status: "completed",
      generatedOutlineIds: ["scene-ai"],
      fullOutlineCount: 1,
    };
    expect(getNewSystemCourseReadiness(course).find((item) => item.id === "full-classroom-generation")?.ok).toBe(true);
  });
  it("builds an AI-only compatibility plan without fixed five-stage ratios", () => {
    const plan = buildNewSystemTimingPlan(90, "2026-08-30T00:00:00.000Z");
    expect(plan.status).toBe("confirmed");
    expect(plan.allocations.map((item) => item.stageKey)).toEqual(["ai-learning"]);
    expect(plan.allocations.reduce((sum, item) => sum + item.durationMin, 0)).toBe(90);
    expect(plan.recommendationSource).toBe("deterministic-fallback");
    expect(plan.recommendedStageTotals.knowledge).toBe(90);
    expect(plan.recommendedStageTotals.launch).toBe(0);
    expect(plan.recommendedStageTotals.proposal).toBe(0);
  });

  it("turns the AI judgment into exact shared knowledge-cluster budgets", () => {
    const points = [
      { id: "kp-1", name: "概念", description: "理解概念", level: "foundation" as const },
      { id: "kp-2", name: "应用", description: "完成应用", level: "application" as const },
    ];
    const plan = buildNewSystemAiTimingPlan({
      durationMin: 42,
      rationale: "第二个知识点需要操作与反馈。",
      confidence: "high",
      teachingClusterBudgets: [
        { clusterId: "foundation", title: "概念基础", knowledgePointIds: ["kp-1"], durationMin: 12, rationale: "建立概念" },
        { clusterId: "application", title: "应用判断", knowledgePointIds: ["kp-2"], durationMin: 30, rationale: "操作与检测" },
      ],
      evidence: ["一条依赖链"],
      assumptions: [],
    }, points, "2026-08-30T00:00:00.000Z");

    expect(plan.totalMinutes).toBe(42);
    expect(plan.allocations.map((item) => item.durationMin)).toEqual([12, 30]);
    expect(plan.allocations.every((item) => item.stageKey === "ai-learning")).toBe(true);
    expect(plan.recommendedStageTotals.knowledge).toBe(42);
  });

  it("does not add a semicolon after a strategy sentence's period", () => {
    const plan = buildNewSystemAiTimingPlan({
      durationMin: 10,
      rationale: "共同讲解。",
      confidence: "high",
      teachingClusterBudgets: [{
        clusterId: "cluster-1",
        title: "共同关系",
        knowledgePointIds: ["kp-1"],
        durationMin: 10,
        rationale: "建立概念。",
        difficultyStrategies: [{
          requirementId: "req-1",
          learnerObstacle: "容易混淆两个概念。",
          teachingApproach: "用正反例对照。",
          understandingEvidence: "能够说明差异。",
        }],
      }],
      evidence: [],
      assumptions: [],
    }, [{ id: "kp-1", name: "概念", description: "理解概念", level: "foundation" }]);

    expect(plan.allocations[0]?.notes).toContain(
      "难点策略：容易混淆两个概念；用正反例对照；理解证据：能够说明差异。",
    );
    expect(plan.allocations[0]?.notes).not.toContain("。；");
  });

  it("stores several related knowledge points in one non-additive timing allocation", () => {
    const points = Array.from({ length: 4 }, (_, index) => ({
      id: `kp-${index + 1}`,
      name: `相关知识 ${index + 1}`,
      description: "共同解释同一关系",
      groupId: "shared-group",
      groupName: "共同关系",
    }));
    const plan = buildNewSystemAiTimingPlan({
      durationMin: 10,
      rationale: "使用同一关系图共同讲解。",
      confidence: "high",
      teachingClusterBudgets: [{
        clusterId: "teaching-cluster-1",
        title: "共同关系",
        knowledgePointIds: points.map((point) => point.id),
        durationMin: 10,
        rationale: "共享引入、关系图和案例。",
      }],
      evidence: [],
      assumptions: [],
    }, points);

    expect(plan.allocations).toHaveLength(1);
    expect(plan.allocations[0]).toMatchObject({
      durationMin: 10,
      knowledgePointIds: points.map((point) => point.id),
    });
    expect(plan.totalMinutes).toBe(10);
  });

  it("creates only the AI授知 teaching outline during preparation", () => {
    const plan = buildNewSystemTimingPlan(60);
    const outline = buildNewSystemAiTeachingOutline(plan, [
      { id: "kp-1", name: "知识点", description: "说明", level: "core" },
    ]);
    expect(outline).toHaveLength(1);
    expect(outline[0]).toMatchObject({
      stageKey: "ai-learning",
      durationMin: 60,
      openMaicUse: "student-ai-learning",
      knowledgePointIds: ["kp-1"],
    });
  });

  it("blocks publishing when any generated page leaks into another stage", () => {
    const course = readyCourse();
    expect(isNewSystemCourseReady(course)).toBe(true);
    const invalid = {
      ...course,
      content: {
        ...course.content,
        _openmaicSceneOutlines: [
          ...(course.content._openmaicSceneOutlines ?? []),
          { id: "teacher-launch", title: "启动", stageKey: "launch", audience: "teacher" as const },
        ],
      },
    };
    expect(isNewSystemCourseReady(invalid)).toBe(false);
    expect(getNewSystemCourseReadiness(invalid).find((item) => item.id === "ai-outline")?.ok)
      .toBe(false);
  });

  it("accepts a lecture duration within 20–40 percent of the course", () => {
    const course = readyCourse();
    course.content.moduleTimingPlan = buildNewSystemTimingPlan(30);
    expect(course.hours * 60).toBe(90);
    expect(getNewSystemCourseReadiness(course).find((item) => item.id === "timing")?.ok)
      .toBe(true);
  });

  it.each([12, 79, 120])("rejects an out-of-range %i minute saved plan for a 120 minute course", (minutes) => {
    const course = readyCourse();
    course.hours = 2;
    course.content.moduleTimingPlan = buildNewSystemTimingPlan(minutes);
    expect(isNewSystemAiTimingPlan(course.content.moduleTimingPlan, course.hours)).toBe(false);
    expect(getNewSystemCourseReadiness(course).find((check) => check.id === "timing")?.ok).toBe(false);
  });

  it.each([24, 36, 48])("accepts a valid saved %i minute plan", (minutes) => {
    expect(isNewSystemAiTimingPlan(buildNewSystemTimingPlan(minutes), 2)).toBe(true);
  });

  it("requires all page and quiz durations to sum to the approved total", () => {
    expect(hasExactKnowledgeLecturePageBudget([{ targetDurationSec: 1260 }, { targetDurationSec: 180 }], 24)).toBe(true);
    expect(hasExactKnowledgeLecturePageBudget([{ targetDurationSec: 1440 }, { targetDurationSec: 180 }], 24)).toBe(false);
    expect(hasExactKnowledgeLecturePageBudget([{ targetDurationSec: NaN }], 24)).toBe(false);
    expect(hasExactKnowledgeLecturePageBudget([], 24)).toBe(false);
  });

  it("requires light questions in normal mode and one short answer in deep-response mode", () => {
    const course = readyCourse();
    course.content.knowledgeLectureSections = [{
      id: "section-1", title: "第一节", order: 0, knowledgePointIds: ["kp-1"],
      sceneOutlineIds: ["teach-1"], quizOutlineId: "quiz-1", estimatedMinutes: 27,
    }];
    course.content._openmaicSceneOutlines = [
      { id: "teach-1", type: "slide", title: "讲解", stageKey: "ai-learning", audience: "student", targetDurationSec: 1_300 },
      { id: "quiz-1", type: "quiz", title: "检测", stageKey: "ai-learning", audience: "student", targetDurationSec: 320,
        quizConfig: { questionCount: 2, questionTypes: ["single", "true_false", "fill_blank", "matching"], minShortAnswerQuestions: 0, maxShortAnswerQuestions: 0 } },
    ];
    course.content.teachingBlueprint = { assessmentMode: "adaptive" } as Course["content"]["teachingBlueprint"];
    course.content.teachingTimingAudit = {
      schemaVersion: 1, totalBudgetSec: 1_620, plannedSubstantiveTeachingSec: 1_102,
      plannedAssessmentSec: 320, plannedLearnerActivitySec: 198, substantiveTeachingDurationSec: 1_102,
      assessmentAudioDurationSec: 0, narrationDurationSource: "estimated-script", measuredSegmentCount: 0,
      narrationSegmentCount: 2, complete: true, substantiveTeachingRatio: 0.6802, teachingRatioValid: true,
      generatedAt: "2026-09-17T00:00:00Z",
    };
    expect(getNewSystemCourseReadiness(course).find((check) => check.id === "ai-outline")?.ok).toBe(true);
    (course.content._openmaicSceneOutlines[1]!.quizConfig as { questionTypes: string[] }).questionTypes.push("short_answer");
    expect(getNewSystemCourseReadiness(course).find((check) => check.id === "ai-outline")?.ok).toBe(false);
    course.content.teachingBlueprint = { assessmentMode: "constructed-response" } as Course["content"]["teachingBlueprint"];
    course.content._openmaicSceneOutlines[1]!.quizConfig = { questionCount: 1, questionTypes: ["short_answer"], minShortAnswerQuestions: 1, maxShortAnswerQuestions: 1 };
    expect(getNewSystemCourseReadiness(course).find((check) => check.id === "ai-outline")?.ok).toBe(true);
  });

  it("accepts two to four normal-mode questions when teaching targets require them", () => {
    const course = readyCourse();
    course.content.knowledgeLectureSections = [{
      id: "section-1", title: "第一节", order: 0, knowledgePointIds: ["kp-1", "kp-2", "kp-3"],
      sceneOutlineIds: ["teach-1"], quizOutlineId: "quiz-1", estimatedMinutes: 27,
    }];
    course.content._openmaicSceneOutlines = [
      { id: "teach-1", type: "slide", title: "讲解", stageKey: "ai-learning", audience: "student", targetDurationSec: 1_300 },
      {
        id: "quiz-1", type: "quiz", title: "检测", stageKey: "ai-learning", audience: "student", targetDurationSec: 320,
        knowledgePointIds: ["kp-1", "kp-2", "kp-3"],
        assessmentTargets: [
          { unitId: "unit-1", knowledgePointId: "kp-1", unitTitle: "一", learningOutcome: "识别一" },
          { unitId: "unit-2", knowledgePointId: "kp-2", unitTitle: "二", learningOutcome: "识别二" },
          { unitId: "unit-3", knowledgePointId: "kp-3", unitTitle: "三", learningOutcome: "识别三" },
        ],
        quizConfig: { questionCount: 3, questionTypes: ["single", "matching", "true_false", "fill_blank"], minShortAnswerQuestions: 0, maxShortAnswerQuestions: 0 },
      },
    ];
    course.content.teachingBlueprint = { assessmentMode: "adaptive" } as Course["content"]["teachingBlueprint"];
    course.content.teachingTimingAudit = {
      schemaVersion: 1, totalBudgetSec: 1_620, plannedSubstantiveTeachingSec: 1_102,
      plannedAssessmentSec: 320, plannedLearnerActivitySec: 198, substantiveTeachingDurationSec: 1_102,
      assessmentAudioDurationSec: 0, narrationDurationSource: "estimated-script", measuredSegmentCount: 0,
      narrationSegmentCount: 2, complete: true, substantiveTeachingRatio: 0.6802, teachingRatioValid: true,
      generatedAt: "2026-09-17T00:00:00Z",
    };

    expect(getNewSystemCourseReadiness(course).find((check) => check.id === "ai-outline")?.ok).toBe(true);
    (course.content._openmaicSceneOutlines[1]!.quizConfig as { questionCount: number }).questionCount = 4;
    expect(getNewSystemCourseReadiness(course).find((check) => check.id === "ai-outline")?.ok).toBe(true);
    (course.content._openmaicSceneOutlines[1]!.quizConfig as { questionCount: number }).questionCount = 5;
    expect(getNewSystemCourseReadiness(course).find((check) => check.id === "ai-outline")?.ok).toBe(false);
  });
});
