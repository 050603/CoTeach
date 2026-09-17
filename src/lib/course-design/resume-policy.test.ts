import { describe, expect, it } from "vitest";
import type { SceneOutline } from "@openmaic/lib/types/generation";
import {
  canResumeAfterValidatedStage,
  canResumeAfterValidatedPositioning,
  canResumeAfterValidatedLessonOutline,
  canResumeAfterValidatedTeachingOutline,
  isSameCourseDesignRequest,
} from "./resume-policy";

const validOutline: SceneOutline = {
  id: "scene-1",
  type: "slide",
  title: "核心概念",
  description: "解释核心概念并给出案例",
  keyPoints: ["核心概念"],
  estimatedDuration: 180,
  targetDurationSec: 180,
  order: 0,
  stageKey: "ai-learning",
  audience: "student",
  generationPurpose: "knowledge-teaching",
  teachingObjective: "学生能够解释核心概念",
  knowledgePointIds: ["kp-1"],
};

const validOutlines: SceneOutline[] = [
  validOutline,
  { ...validOutline, id: "scene-2", title: "案例比较", order: 1 },
  { ...validOutline, id: "scene-3", type: "interactive", title: "迁移练习", order: 2 },
  { ...validOutline, id: "scene-4", type: "quiz", title: "主课达标测", order: 3, targetDurationSec: 90, estimatedDuration: 90 },
  ...["launch", "proposal", "make", "showcase"].map((stageKey, index): SceneOutline => ({
    ...validOutline,
    id: `teacher-${stageKey}`,
    title: `${stageKey} 教师资源`,
    order: index + 4,
    stageKey,
    audience: "teacher",
    generationPurpose: "teacher-resource",
  })),
];

describe("quick-design resume policy", () => {
  it("reuses any saved middle-stage checkpoint only when its hard gate still passes", () => {
    const trace = [
      { step: "knowledgePoints", status: "completed" },
      { step: "projectDesign", status: "completed" },
    ];
    expect(canResumeAfterValidatedStage({ trace, step: "knowledgePoints", qualityPassed: true })).toBe(true);
    expect(canResumeAfterValidatedStage({ trace, step: "projectDesign", qualityPassed: false })).toBe(false);
    expect(canResumeAfterValidatedStage({ trace, step: "evaluationPlan", qualityPassed: true })).toBe(false);
  });

  it("does not regenerate a still-valid positioning checkpoint during managed recovery", () => {
    expect(canResumeAfterValidatedPositioning({
      trace: [{ step: "base", status: "completed" }],
      positioningPassed: true,
    })).toBe(true);
    expect(canResumeAfterValidatedPositioning({
      trace: [{ step: "base", status: "completed" }],
      positioningPassed: false,
    })).toBe(false);
  });
  it("requires both a completed trace entry and a still-valid saved outline", () => {
    expect(canResumeAfterValidatedLessonOutline({
      trace: [{ step: "lessonOutline", status: "completed" }],
      outlines: validOutlines,
    })).toBe(true);
    expect(canResumeAfterValidatedLessonOutline({
      trace: [],
      outlines: validOutlines,
    })).toBe(false);
    expect(canResumeAfterValidatedLessonOutline({
      trace: [{ step: "lessonOutline", status: "completed" }],
      outlines: [],
    })).toBe(false);
  });

  it("does not reuse a stage that was recorded as failed", () => {
    expect(canResumeAfterValidatedLessonOutline({
      trace: [{ step: "lessonOutline", status: "failed" }],
      outlines: validOutlines,
    })).toBe(false);
  });

  it("resumes at lesson generation only when every saved upstream gate is still valid", () => {
    const valid = {
      trace: [{ step: "teachingOutline", status: "completed" }],
      positioningPassed: true,
      projectDesignPassed: true,
      evaluationPlanPassed: true,
      knowledgePointCount: 10,
      knowledgeGraphNodeCount: 10,
      teachingOutlineCount: 6,
      timingPlanConfirmed: true,
    };
    expect(canResumeAfterValidatedTeachingOutline(valid)).toBe(true);
    expect(canResumeAfterValidatedTeachingOutline({
      ...valid,
      timingPlanConfirmed: false,
    })).toBe(false);
    expect(canResumeAfterValidatedTeachingOutline({
      ...valid,
      trace: [{ step: "teachingOutline", status: "failed" }],
    })).toBe(false);
  });

  it("preserves checkpoints only when the retried design request is unchanged", () => {
    const request = {
      courseId: "course-1",
      teacherBrief: "设计一节人工智能课程",
      options: {
        enableImageGeneration: true,
        enableTTS: true,
        enableVideoGeneration: false,
      },
    };
    expect(isSameCourseDesignRequest(request, { ...request })).toBe(true);
    expect(isSameCourseDesignRequest(request, {
      ...request,
      teacherBrief: "设计一节机器人课程",
    })).toBe(false);
    expect(isSameCourseDesignRequest(request, {
      ...request,
      generationMode: "deep-interaction",
    })).toBe(false);
    expect(isSameCourseDesignRequest({
      ...request,
      generationModelString: "deepseek:deepseek-v4-flash",
    }, {
      ...request,
      generationModelString: "openai:gpt-5",
    })).toBe(false);
    expect(isSameCourseDesignRequest({
      ...request,
      generationMode: "standard",
    }, request)).toBe(true);
    expect(isSameCourseDesignRequest(request, {
      ...request,
      generationScope: "test-lesson",
    })).toBe(false);
    expect(isSameCourseDesignRequest({
      ...request,
      generationContractVersion: 2,
      assessmentMode: "adaptive",
    }, {
      ...request,
      generationContractVersion: 2,
      assessmentMode: "constructed-response",
    })).toBe(false);
    expect(isSameCourseDesignRequest(request, {
      ...request,
      generationContractVersion: 2,
      assessmentMode: "adaptive",
    })).toBe(false);
    expect(isSameCourseDesignRequest({
      ...request,
      referenceMaterials: [{ id: "reference-1", fileName: "资料一.md" }],
    }, {
      ...request,
      referenceMaterials: [{ id: "reference-2", fileName: "资料二.md" }],
    })).toBe(false);
    expect(isSameCourseDesignRequest({
      ...request,
      referenceMaterials: [
        { id: "reference-2", fileName: "资料二.md" },
        { id: "reference-1", fileName: "资料一.md" },
      ],
    }, {
      ...request,
      referenceMaterials: [
        { id: "reference-1", fileName: "资料一.md" },
        { id: "reference-2", fileName: "资料二.md" },
      ],
    })).toBe(true);
  });
});
