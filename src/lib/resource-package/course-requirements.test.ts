import { describe, expect, it } from "vitest";
import type { Course } from "@/lib/session/types";
import { adaptPersonalProjectText, emptyResourcePackageDraft } from "./types";
import { buildCourseStageRequirementsContext, getCourseStageRequirements } from "./course-requirements";
import { buildAuthoritativeCourseContext } from "@/lib/ai-collaboration/document-policy";

function resourceCourse(): Course {
  return {
    name: "教学设计", grade: "本科一年级", drivingQuestion: "如何设计课程？", stages: [{ key: "make", label: "项目实践" }],
    content: { knowledgePoints: [], evaluationPlan: {}, resourcePackage: { privateSource: "教师私有资料原文" }, stagePlan: {
      ...emptyResourcePackageDraft(), schemaVersion: 1, source: "resource-package", totalMinutes: 135,
      stages: emptyResourcePackageDraft().stages.map((stage) => ({ ...stage, durationMin: stage.key === "make" ? 60 : 10, requirements: adaptPersonalProjectText(stage.key === "make" ? "将学生分成6组，每组4-6人，比较教学理论后设计一节课。" : "回顾学习过程"), outputs: "个人教案和理由说明", teacherActions: "教师私人提醒", aiActions: "比较两种设计方案" })),
      evaluationCriteria: "用理论解释设计选择，并提供学习证据", reflectionQuestions: ["哪次修改让教学设计更适切？"],
    } },
  } as unknown as Course;
}

describe("resource-package classroom requirements", () => {
  it("projects the exact authored stage time, tasks and evidence criteria into individual AI collaboration", () => {
    const course = resourceCourse();
    const requirements = getCourseStageRequirements(course, "make");
    expect(requirements).toMatchObject({ durationMin: 60, outputs: "个人教案和理由说明", evaluationCriteria: "用理论解释设计选择，并提供学习证据" });
    expect(requirements?.requirements).toContain("每位学生与自己的 AI 伙伴");
    expect(requirements?.requirements).not.toContain("4-6人");
    expect(requirements?.requirements).toContain("比较教学理论后设计一节课");
    expect(adaptPersonalProjectText(requirements!.requirements)).toBe(requirements!.requirements);
  });

  it("feeds document and code shared context without raw package files or teacher private actions", () => {
    const context = buildAuthoritativeCourseContext(resourceCourse(), "student-1", "make");
    expect(context).toContain("计划时长：60 分钟");
    expect(context).toContain("交付要求：个人教案和理由说明");
    expect(context).toContain("课程评价标准：用理论解释设计选择");
    expect(context).not.toContain("教师私有资料原文");
    expect(context).not.toContain("教师私人提醒");
    expect(context).not.toContain("哪次修改让教学设计更适切");
  });

  it("includes lesson-plan reflection prompts only for reflection and preserves old course behavior", () => {
    expect(buildCourseStageRequirementsContext(resourceCourse(), "reflection")).toContain("哪次修改让教学设计更适切？");
    expect(getCourseStageRequirements({ content: {} } as Course, "make")).toBeNull();
    expect(buildCourseStageRequirementsContext({ content: {} } as Course, "make")).toBe("");
  });
  it("includes confirmed checkpoints, final deliverables and structured grading in the AI context", () => {
    const course = resourceCourse(); const plan = course.content.stagePlan!;
    plan.stages.find((stage) => stage.key === "make")!.checkpoints = ["第3课时前完成PPT终稿"];
    plan.stages.find((stage) => stage.key === "make")!.observationPoints = ["检查学生是否核对AI给出的依据"];
    plan.finalDeliverables = [{ id: "pptx", name: "个人PPT", format: "pptx", requirements: "10页终稿", required: true }];
    plan.evaluationRubric = { id: "rubric", version: 1, sourceWeights: { teacher: 60, ai: 40 }, dimensions: [{ id: "theory", name: "理论适切性", weight: 100, description: "以证据解释教学选择" }] };
    const context = buildCourseStageRequirementsContext(course, "make");
    expect(context).toContain("第3课时前完成PPT终稿");
    expect(context).toContain("检查学生是否核对AI给出的依据");
    expect(context).toContain("个人PPT（pptx）：10页终稿");
    expect(context).toContain("教师60%、AI40%");
    expect(context).toContain("教师选取部分学生");
  });
});
