import { describe, expect, it } from "vitest";
import { DEFAULT_EVALUATION_FLOWS } from "@/lib/session/types";
import {
  ensureEvaluationResponsibility,
  evaluateEvaluationPlan,
  evaluateLessonOutlines,
  evaluatePositioning,
} from "./quality-gates";

describe("quick course design quality gates", () => {
  it("rejects knowledge-check lists as the course driving question", () => {
    const result = evaluatePositioning({
      name: "图书分类项目",
      subject: "信息科技",
      grade: "七年级",
      hours: 2,
      summary: "学生面向学校图书馆开展分类需求调查，设计并验证一套可解释的分类方案，形成规则说明和测试证据。",
      learningObjectives: ["解释分类规则", "设计分类方案", "使用数据验证方案"],
      drivingQuestion: "如何确定关键词的权重？如果一本书同时包含多个类别关键词怎么办？如何验证分类规则的准确性？统计方法与规则方法相比有哪些优缺点？",
    } as Parameters<typeof evaluatePositioning>[0]);

    expect(result.passed).toBe(false);
    expect(result.issues.join("；")).toContain("一个核心问题");
  });

  it("restores AI and teacher evaluation responsibilities", () => {
    const plan = ensureEvaluationResponsibility({
      dimensions: [
        { id: "one", name: "证据运用", weight: 50, description: "使用证据", responsibleRole: "teacher" },
        { id: "two", name: "成果表达", weight: 50, description: "清楚表达", responsibleRole: "teacher" },
      ],
      overallRubric: "按证据评价",
    });

    expect(plan.flows).toEqual(DEFAULT_EVALUATION_FLOWS);
    expect(plan.dimensions.map((item) => item.responsibleRole)).toContain("ai");
    expect(plan.dimensions.filter((item) => item.responsibleRole === "ai").reduce((sum, item) => sum + item.weight, 0)).toBe(40);
    expect(plan.dimensions.filter((item) => item.responsibleRole === "teacher").reduce((sum, item) => sum + item.weight, 0)).toBe(60);
    expect(plan.dimensions.reduce((sum, item) => sum + item.weight, 0)).toBe(100);
    expect(evaluateEvaluationPlan(plan).passed).toBe(true);
  });

  it("normalizes per-role rubric percentages into final-grade contributions", () => {
    const plan = ensureEvaluationResponsibility({
      dimensions: [
        { id: "ai-one", name: "过程证据", weight: 50, description: "过程", responsibleRole: "ai" },
        { id: "ai-two", name: "专业准确", weight: 50, description: "专业", responsibleRole: "ai" },
        { id: "teacher-one", name: "现场答辩", weight: 70, description: "答辩", responsibleRole: "teacher" },
        { id: "teacher-two", name: "成果表达", weight: 30, description: "表达", responsibleRole: "teacher" },
      ],
      overallRubric: "根据课程证据结构自动确定 AI 与教师占比。",
      flows: DEFAULT_EVALUATION_FLOWS.map((flow) => flow.sourceRole === "ai"
        ? { ...flow, weight: 35 }
        : flow.sourceRole === "teacher"
          ? { ...flow, weight: 65 }
          : flow),
    });

    expect(plan.dimensions.map((item) => [item.id, item.weight])).toEqual([
      ["ai-one", 18],
      ["ai-two", 17],
      ["teacher-one", 46],
      ["teacher-two", 19],
    ]);
    expect(plan.flows?.filter((flow) => flow.scored !== false).map((flow) => flow.weight)).toEqual([35, 65]);
  });

  it("rejects long student slides and missing teacher-stage resources", () => {
    const result = evaluateLessonOutlines([
      { id: "long", type: "slide", title: "长讲授", description: "", keyPoints: [], order: 0, audience: "student", stageKey: "ai-learning", targetDurationSec: 22 * 60 },
    ]);

    expect(result.passed).toBe(false);
    expect(result.issues.join("；")).toContain("8 分钟");
    expect(result.issues.join("；")).toContain("教师资源阶段");
  });

  it("rejects student knowledge that is assigned outside its parent activity", () => {
    const result = evaluateLessonOutlines([
      {
        id: "student-a",
        type: "slide",
        title: "模块 A",
        description: "讲解模块 A。",
        keyPoints: ["A"],
        order: 0,
        audience: "student",
        stageKey: "ai-learning",
        parentActivityId: "activity-a",
        knowledgePointIds: ["b-1"],
      },
      {
        id: "student-b",
        type: "slide",
        title: "模块 B",
        description: "讲解模块 B。",
        keyPoints: ["B"],
        order: 1,
        audience: "student",
        stageKey: "ai-learning",
        parentActivityId: "activity-b",
        knowledgePointIds: ["b-1"],
      },
      {
        id: "checkpoint",
        type: "quiz",
        title: "理解检查",
        description: "检查理解。",
        keyPoints: ["A", "B"],
        order: 2,
        audience: "student",
        stageKey: "ai-learning",
        parentActivityId: "activity-b",
        knowledgePointIds: ["b-1"],
      },
      ...["launch", "proposal", "make", "showcase"].map((stageKey, index) => ({
        id: `teacher-${stageKey}`,
        type: "slide" as const,
        title: `教师资源 ${stageKey}`,
        description: "教师资源。",
        keyPoints: ["提示"],
        order: index + 3,
        audience: "teacher" as const,
        stageKey,
      })),
    ], [
      {
        activityId: "activity-a",
        stageKey: "ai-learning",
        title: "模块 A",
        durationMin: 10,
        knowledgePointIds: ["a-1"],
      },
      {
        activityId: "activity-b",
        stageKey: "ai-learning",
        title: "模块 B",
        durationMin: 10,
        knowledgePointIds: ["b-1"],
      },
    ]);

    expect(result.passed).toBe(false);
    expect(result.issues.join("；")).toContain("父活动");
    expect(result.issues.join("；")).toContain("a-1");
  });

  it("does not require student AI-learning pages to cover teacher project activities", () => {
    const result = evaluateLessonOutlines([
      {
        id: "explain-1", type: "slide", title: "概念讲解", description: "完整解释概念并给出例子。",
        keyPoints: ["概念", "例子", "误区"], order: 0, audience: "student", stageKey: "ai-learning",
        parentActivityId: "pbl-module-ai-learning", knowledgePointIds: ["kp-1", "kp-2"], targetDurationSec: 360,
      },
      {
        id: "explain-2", type: "slide", title: "应用推演", description: "推演知识如何用于项目。",
        keyPoints: ["关系", "推演", "应用"], order: 1, audience: "student", stageKey: "ai-learning",
        parentActivityId: "pbl-module-ai-learning", knowledgePointIds: ["kp-1", "kp-2"], targetDurationSec: 360,
      },
      {
        id: "practice", type: "interactive", title: "互动练习", description: "操作并观察反馈。",
        keyPoints: ["操作", "观察", "反馈"], order: 2, audience: "student", stageKey: "ai-learning",
        parentActivityId: "pbl-module-ai-learning", knowledgePointIds: ["kp-1", "kp-2"], targetDurationSec: 180,
      },
      {
        id: "quiz", type: "quiz", title: "主课达标测", description: "集中检查掌握情况。",
        keyPoints: ["理解", "应用"], order: 3, audience: "student", stageKey: "ai-learning",
        parentActivityId: "pbl-module-ai-learning", knowledgePointIds: ["kp-1", "kp-2"], targetDurationSec: 180,
      },
      ...["launch", "proposal", "make", "showcase"].map((stageKey, index) => ({
        id: `teacher-${stageKey}`, type: "slide" as const, title: `教师资源 ${stageKey}`,
        description: "教师活动支持。", keyPoints: ["提示"], order: index + 4,
        audience: "teacher" as const, stageKey,
      })),
    ], [
      {
        activityId: "pbl-module-ai-learning", stageKey: "ai-learning", title: "AI 授知",
        durationMin: 20, knowledgePointIds: ["kp-1", "kp-2"],
      },
      {
        activityId: "pbl-module-proposal", stageKey: "proposal", title: "方案构思",
        durationMin: 10, knowledgePointIds: ["kp-1", "kp-2", "kp-7", "kp-8"],
      },
      {
        activityId: "pbl-module-make", stageKey: "make", title: "项目制作",
        durationMin: 20, knowledgePointIds: ["kp-1", "kp-2", "kp-5", "kp-7", "kp-8"],
      },
    ]);

    expect(result.passed).toBe(true);
    expect(result.issues.join("；")).not.toContain("pbl-module-proposal");
    expect(result.issues.join("；")).not.toContain("pbl-module-make");
  });

  it("accepts one terminal check for each explicit teaching section", () => {
    const result = evaluateLessonOutlines([
      { id: "explain-1", type: "slide", title: "概念与例子", description: "先解释概念，再用具体例子说明。", keyPoints: ["概念", "例子", "误区"], order: 0, audience: "student", stageKey: "ai-learning", parentActivityId: "section-1", knowledgePointIds: ["kp-1"] },
      { id: "practice-1", type: "interactive", title: "观察变化", description: "操作并观察结果。", keyPoints: ["预测", "操作", "反馈"], order: 1, audience: "student", stageKey: "ai-learning", parentActivityId: "section-1", knowledgePointIds: ["kp-1"] },
      { id: "quiz-1", type: "quiz", title: "章节测验", description: "测验一。", keyPoints: ["kp-1"], order: 2, audience: "student", stageKey: "ai-learning", parentActivityId: "section-1", knowledgePointIds: ["kp-1"] },
      { id: "explain-2", type: "slide", title: "第二个概念", description: "解释第二个概念并比较。", keyPoints: ["概念", "比较", "例子"], order: 3, audience: "student", stageKey: "ai-learning", parentActivityId: "section-2", knowledgePointIds: ["kp-2"] },
      { id: "quiz-final", type: "quiz", title: "第二节检测", description: "检查第二节。", keyPoints: ["kp-2"], order: 4, audience: "student", stageKey: "ai-learning", parentActivityId: "section-2", knowledgePointIds: ["kp-2"] },
      ...["launch", "proposal", "make", "showcase"].map((stageKey, index) => ({ id: `teacher-${stageKey}`, type: "slide" as const, title: `教师资源 ${stageKey}`, description: "教师资源。", keyPoints: ["提示"], order: index + 5, audience: "teacher" as const, stageKey })),
    ]);

    expect(result.passed).toBe(true);
    expect(result.issues.join("；")).not.toContain("重复测验");
  });

  it("rejects assessment before all knowledge has been explained on slides", () => {
    const result = evaluateLessonOutlines([
      { id: "explain", type: "slide", title: "概念讲解", description: "解释概念并提供例子。", keyPoints: ["概念", "例子", "误区"], order: 0, audience: "student", stageKey: "ai-learning", knowledgePointIds: ["kp-1"] },
      { id: "practice", type: "interactive", title: "引导探索", description: "操作、观察并获得解释反馈。", keyPoints: ["预测", "操作", "反馈"], order: 1, audience: "student", stageKey: "ai-learning", knowledgePointIds: ["kp-1"] },
      { id: "quiz", type: "quiz", title: "主课达标测", description: "综合检查。", keyPoints: ["kp-1", "kp-2"], order: 2, audience: "student", stageKey: "ai-learning", knowledgePointIds: ["kp-1", "kp-2"] },
      ...["launch", "proposal", "make", "showcase"].map((stageKey, index) => ({ id: `teacher-${stageKey}`, type: "slide" as const, title: `教师资源 ${stageKey}`, description: "教师资源。", keyPoints: ["提示"], order: index + 3, audience: "teacher" as const, stageKey })),
    ]);

    expect(result.passed).toBe(false);
    expect(result.issues.join("；")).toContain("尚未通过讲解页完整教学");
  });
});
