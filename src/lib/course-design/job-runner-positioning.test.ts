import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";

const generateProjectSkeleton = vi.fn();
const callLLM = vi.fn();

vi.mock("@/lib/teaching-ai/support-engine", () => ({ generateProjectSkeleton }));
vi.mock("@/lib/llm/client", () => ({
  callLLM,
  generateCourseContent: vi.fn(),
  parseLLMJson: (value: string) => JSON.parse(value),
}));

describe("quick positioning generation", () => {
  beforeEach(() => {
    generateProjectSkeleton.mockReset();
    callLLM.mockReset();
  });

  it("restores a transport attempt budget only for the same input and model", async () => {
    const {
      restoreCourseDesignAttemptCount,
      restoreCourseDesignStageResponse,
    } = await import("./job-runner");
    const checkpoint = {
      schemaVersion: 1,
      inputFingerprint: "input-a",
      modelFingerprint: "model-a",
      attemptsStarted: 2,
    };

    expect(restoreCourseDesignAttemptCount(checkpoint, "input-a", "model-a")).toBe(2);
    expect(restoreCourseDesignAttemptCount(checkpoint, "input-b", "model-a")).toBe(0);
    expect(restoreCourseDesignAttemptCount(checkpoint, "input-a", "model-b")).toBe(0);

    const completedResponse = {
      schemaVersion: 1,
      status: "response-complete",
      inputFingerprint: "input-a",
      modelFingerprint: "model-a",
      rawResponse: '{"knowledgePoints":[],"knowledgeGraph":{"nodes":[],"edges":[]}}',
    };
    expect(restoreCourseDesignStageResponse(completedResponse, "input-a", "model-a"))
      .toBe(completedResponse.rawResponse);
    expect(restoreCourseDesignStageResponse(completedResponse, "input-b", "model-a")).toBeNull();
    expect(restoreCourseDesignStageResponse(completedResponse, "input-a", "model-b")).toBeNull();
    expect(restoreCourseDesignStageResponse({ ...completedResponse, status: "validated" }, "input-a", "model-a"))
      .toBeNull();
  }, 15_000);

  it("derives section teaching budgets and page suggestions from the actual duration", async () => {
    const { buildTeachingBlueprintSectionPlans } = await import("./job-runner");
    const groupSizes = [3, 5, 3, 3, 3, 3];
    const knowledgePoints = groupSizes.flatMap((size, groupIndex) =>
      Array.from({ length: size }, (_, pointIndex) => ({
        id: `g${groupIndex + 1}-p${pointIndex + 1}`,
        name: `第 ${groupIndex + 1} 组知识 ${pointIndex + 1}`,
        description: "用于验证蓝图容量。",
        level: "core" as const,
        groupName: `第 ${groupIndex + 1} 组`,
      })),
    );

    const plans = buildTeachingBlueprintSectionPlans({ knowledgePoints }, 30 * 60);
    const shorterPlans = buildTeachingBlueprintSectionPlans({ knowledgePoints }, 15 * 60);

    expect(plans).toHaveLength(6);
    expect(plans.reduce((sum, plan) => sum + (plan.teachingBudgetSec ?? 0), 0)).toBe(1_584);
    expect(shorterPlans.reduce((sum, plan) => sum + (plan.teachingBudgetSec ?? 0), 0)).toBe(792);
    expect(shorterPlans.reduce((sum, plan) => sum + (plan.suggestedMaxPages ?? 0), 0))
      .toBeLessThan(plans.reduce((sum, plan) => sum + (plan.suggestedMaxPages ?? 0), 0));
    expect(plans.every((plan) => (
      (plan.teachingBudgetSec ?? 0) / Math.max(1, plan.suggestedMinPages ?? 1) <= 180
    ))).toBe(true);
    expect(plans.flatMap((plan) => plan.knowledgePointIds)).toEqual(
      knowledgePoints.map((point) => point.id),
    );
    expect(new Set(plans.flatMap((plan) => plan.knowledgePointIds)).size).toBe(20);
  }, 15_000);

  it("keeps resource knowledge count separate from page count", async () => {
    const { buildTeachingBlueprintSectionPlans } = await import("./job-runner");
    const knowledgePoints = Array.from({ length: 6 }, (_, index) => ({
      id: `source-${index + 1}`,
      name: `相关知识 ${index + 1}`,
      description: `知识说明 ${index + 1}`,
      level: "core" as const,
      groupId: "group-related",
      groupName: "关联概念",
      sourceKnowledgePointIds: [`source-${index + 1}`],
    }));

    const plans = buildTeachingBlueprintSectionPlans({ knowledgePoints }, 6 * 60);

    expect(plans.flatMap((plan) => plan.knowledgePointIds)).toEqual(
      knowledgePoints.map((point) => point.id),
    );
    expect(plans.reduce((sum, plan) => sum + (plan.suggestedMaxPages ?? 0), 0))
      .toBeLessThan(knowledgePoints.length);
  }, 15_000);

  it("attributes a shared cluster duration once instead of multiplying it by member count", async () => {
    const { buildTeachingBlueprintSectionPlans } = await import("./job-runner");
    const knowledgePoints = [
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `shared-${index + 1}`,
        name: `共享知识 ${index + 1}`,
        description: "共同解释一个关系",
        level: "core" as const,
        groupId: "shared",
        groupName: "共享关系",
      })),
      {
        id: "independent",
        name: "独立应用",
        description: "单独完成一次应用",
        level: "application" as const,
        groupId: "application",
        groupName: "独立应用",
      },
    ];
    const moduleTimingPlan = {
      allocations: [
        { stageKey: "ai-learning", durationMin: 6, knowledgePointIds: knowledgePoints.slice(0, 4).map((point) => point.id) },
        { stageKey: "ai-learning", durationMin: 4, knowledgePointIds: ["independent"] },
      ],
    } as never;

    const plans = buildTeachingBlueprintSectionPlans({ knowledgePoints, moduleTimingPlan }, 10 * 60);
    const ratio = (plans[0]?.teachingBudgetSec ?? 0) / (plans[1]?.teachingBudgetSec ?? 1);

    expect(plans).toHaveLength(2);
    expect(ratio).toBeGreaterThan(1.4);
    expect(ratio).toBeLessThan(1.6);
  }, 15_000);

  it("keeps missing groups separate and splits an overlong group at knowledge boundaries", async () => {
    const { buildTeachingBlueprintSectionPlans } = await import("./job-runner");
    const ungrouped = buildTeachingBlueprintSectionPlans({
      knowledgePoints: [
        { id: "a", name: "概念 A", description: "", level: "core" as const },
        { id: "b", name: "概念 B", description: "", level: "core" as const },
      ],
    }, 20 * 60);
    expect(ungrouped.map((plan) => plan.knowledgePointIds)).toEqual([["a"], ["b"]]);

    const grouped = buildTeachingBlueprintSectionPlans({
      knowledgePoints: ["a", "b", "c", "d"].map((id) => ({
        id,
        name: `知识 ${id.toUpperCase()}`,
        description: "",
        level: "core" as const,
        groupId: "whole-lesson",
        groupName: "整节课",
      })),
    }, 30 * 60);
    expect(grouped).toHaveLength(4);
    expect(grouped.flatMap((plan) => plan.knowledgePointIds)).toEqual(["a", "b", "c", "d"]);
    expect(grouped.every((plan) => (plan.suggestedMinPages ?? 0) >= 2)).toBe(true);
  }, 15_000);

  it("restores every full-course outline field after a one-section test preview", async () => {
    const { restoreCourseOutlineSnapshotForFullPromotion } = await import("./job-runner");
    const fullOutlines = [
      {
        id: "section-1-page", type: "slide" as const, title: "第一节讲解", description: "讲解第一节",
        keyPoints: ["第一节知识"], order: 0, lectureSectionId: "section-1", lectureSectionTitle: "第一节", knowledgePointIds: ["kp-1"], targetDurationSec: 120,
      },
      {
        id: "section-1-check", type: "quiz" as const, title: "第一节检测", description: "检测第一节",
        keyPoints: ["第一节检测"], order: 1, lectureSectionId: "section-1", lectureSectionTitle: "第一节", knowledgePointIds: ["kp-1"], targetDurationSec: 60,
      },
      {
        id: "section-2-page", type: "slide" as const, title: "第二节讲解", description: "讲解第二节",
        keyPoints: ["第二节知识"], order: 2, lectureSectionId: "section-2", lectureSectionTitle: "第二节", knowledgePointIds: ["kp-2"], targetDurationSec: 120,
      },
      {
        id: "section-2-check", type: "quiz" as const, title: "第二节检测", description: "检测第二节",
        keyPoints: ["第二节检测"], order: 3, lectureSectionId: "section-2", lectureSectionTitle: "第二节", knowledgePointIds: ["kp-2"], targetDurationSec: 60,
      },
    ];
    const preview = {
      id: "course-1",
      content: {
        lessonOutline: [{ id: "section-1-page" }],
        _openmaicSceneOutlines: [fullOutlines[0], fullOutlines[1]],
        knowledgeLectureSections: [{ id: "section-1" }],
      },
    } as unknown as Course;

    const restored = restoreCourseOutlineSnapshotForFullPromotion(preview, fullOutlines);

    expect(restored.content._openmaicSceneOutlines?.map((item) => item.id)).toEqual(fullOutlines.map((item) => item.id));
    expect(restored.content.lessonOutline.map((item) => item.id)).toEqual(fullOutlines.map((item) => item.id));
    expect(restored.content.knowledgeLectureSections?.map((item) => item.id)).toEqual(["section-1", "section-2"]);
  }, 15_000);

  it("moves the fixed teaching budget ahead of knowledge-scope generation", async () => {
    const { buildKnowledgePlanningCapacity } = await import("./job-runner");
    const capacity = buildKnowledgePlanningCapacity({
      courseHours: 2,
      assessmentMode: "adaptive",
      stagePlan: {
        schemaVersion: 2,
        source: "resource-package",
        totalMinutes: 100,
        lessonCount: null,
        minutesPerLesson: null,
        stages: [
          { key: "launch", title: "启动", durationMin: 10, requirements: "", outputs: "", teacherActions: "", aiActions: "" },
          { key: "ai-learning", title: "知识讲授", durationMin: 30, requirements: "", outputs: "", teacherActions: "", aiActions: "" },
          { key: "make", title: "实践", durationMin: 45, requirements: "", outputs: "", teacherActions: "", aiActions: "" },
          { key: "showcase", title: "展示", durationMin: 10, requirements: "", outputs: "", teacherActions: "", aiActions: "" },
          { key: "reflection", title: "反思", durationMin: 5, requirements: "", outputs: "", teacherActions: "", aiActions: "" },
        ],
        evaluationCriteria: "",
        reflectionQuestions: [],
      },
    });

    expect(capacity).toEqual({
      durationRangeMin: 30,
      durationRangeMax: 30,
      planningDurationMin: 30,
      durationSource: "resource-package",
      assessmentReserveMin: 4,
      explanationAndActivityMin: 26,
    });
  }, 15_000);

  it("forces every new-system outline into the student AI授知 stage", async () => {
    const { normalizeNewSystemAiOutlines } = await import("./job-runner");
    const outlines = normalizeNewSystemAiOutlines([{
      id: "wrong-stage",
      type: "pbl",
      title: "原始页面",
      description: "原始说明",
      keyPoints: ["核心知识"],
      order: 9,
      stageKey: "launch",
      audience: "teacher",
    }], {
      totalDurationSec: 1_200,
      knowledgePointIds: ["kp-1"],
      courseLanguageDirective: "本课程面向教师，使用专业、清晰的简体中文。",
    });

    expect(outlines).toHaveLength(2);
    expect(outlines.every((item) => item.stageKey === "ai-learning")).toBe(true);
    expect(outlines.every((item) => item.audience === "student")).toBe(true);
    expect(outlines[0]?.type).toBe("slide");
    expect(outlines.some((item) => item.type === "interactive")).toBe(false);
    expect(outlines.some((item) => item.type === "slide")).toBe(true);
    expect(outlines.some((item) => item.type === "quiz")).toBe(true);
    expect(outlines.every((item) => item.knowledgePointIds?.includes("kp-1"))).toBe(true);
    expect(outlines.every((item) => item.courseLanguageDirective === "本课程面向教师，使用专业、清晰的简体中文。"))
      .toBe(true);
  }, 15_000);

  it("keeps the official page semantic fields unchanged after knowledge-point mapping", async () => {
    const { normalizeNewSystemAiOutlines } = await import("./job-runner");
    const input = [{
      id: "constructivism",
      type: "slide" as const,
      title: "建构主义与以学生为中心",
      description: "解释建构主义如何改变教师角色。",
      keyPoints: [
        "知识由学习者主动构建",
        "教师从讲授者转为引导者",
        "学生通过操作发现规律",
        "避免纯讲授",
      ],
      knowledgePointIds: ["kp-constructivism"],
      order: 0,
    }];
    const knowledgePoints = [{
      id: "kp-constructivism",
      name: "建构主义与以学生为中心",
      description: "在 AI 课堂中应设计动手操作和探究活动。",
      keyInfo: "知识基于已有经验主动构建；可让学生调试图像识别模型并自己发现规律。",
      masteryBoundary: "能说明为何不能只使用教师讲授，并给出一项自主探索活动。",
    }];

    const once = normalizeNewSystemAiOutlines(input, {
      totalDurationSec: 600,
      knowledgePointIds: ["kp-constructivism"],
      knowledgePoints,
    });
    const slide = once.find((outline) => outline.type === "slide");
    expect(slide?.description).toBe("解释建构主义如何改变教师角色。");
    expect(slide?.keyPoints).toEqual(input[0]?.keyPoints);
    expect(JSON.stringify(slide)).not.toContain("资料上下文");
    expect(JSON.stringify(slide)).not.toContain("资料事实");

    const twice = normalizeNewSystemAiOutlines(once, {
      totalDurationSec: 600,
      knowledgePointIds: ["kp-constructivism"],
      knowledgePoints,
    });
    expect(twice.find((outline) => outline.type === "slide")?.keyPoints).toEqual(slide?.keyPoints);
    expect(twice.find((outline) => outline.type === "slide")?.description).toEqual(slide?.description);
  });

  it("preserves all upstream points without reserving slots for CoTeach fact packing", async () => {
    const { normalizeNewSystemAiOutlines } = await import("./job-runner");
    const base = {
      type: "slide" as const,
      description: "解释课堂中的学生实践。",
      keyPoints: ["原则一", "原则二", "原则三", "原则四", "[Table] 原则比较"],
      knowledgePointIds: ["kp-practice"],
    };
    const knowledgePoints = [{
      id: "kp-practice",
      name: "课堂实践",
      description: "学生需要在真实任务中动手操作。",
      keyInfo: "先观察模型输出；再调整输入条件；最后解释结果。",
      masteryBoundary: "能够解释一次调整为何改善结果。",
    }];

    const normalized = normalizeNewSystemAiOutlines([
      { ...base, id: "practice-observe", title: "观察模型输出", order: 0 },
      { ...base, id: "practice-explain", title: "调整并解释", order: 1 },
    ], {
      totalDurationSec: 600,
      knowledgePointIds: ["kp-practice"],
      knowledgePoints,
    });
    const slides = normalized.filter((outline) => outline.type === "slide");
    expect(slides).toHaveLength(2);
    expect(slides.every((slide) => slide.keyPoints.length === 5)).toBe(true);
    expect(slides.every((slide) => slide.keyPoints.at(-1) === "[Table] 原则比较")).toBe(true);
    expect(slides.every((slide) => slide.description === "解释课堂中的学生实践。")).toBe(true);
    expect(JSON.stringify(slides)).not.toContain("资料事实：");
    expect(JSON.stringify(slides)).not.toContain("资料上下文：");
  });

  it("maps two knowledge points without changing the upstream comparison brief", async () => {
    const { normalizeNewSystemAiOutlines } = await import("./job-runner");
    const normalized = normalizeNewSystemAiOutlines([{
      id: "shared-page",
      type: "slide",
      title: "学习理论对比",
      description: "比较两种学习理论。",
      keyPoints: ["[Table] 比较理论目标与课堂角色", "识别适用情境", "说明活动差异"],
      knowledgePointIds: ["kp-a", "kp-b"],
      order: 0,
    }], {
      totalDurationSec: 600,
      knowledgePointIds: ["kp-a", "kp-b"],
      knowledgePoints: [
        { id: "kp-a", name: "建构主义", description: "学习者主动建构。", keyInfo: "通过操作和探究形成理解。" },
        { id: "kp-b", name: "情境认知", description: "学习嵌入真实情境。", keyInfo: "真实问题促进知识迁移。" },
      ],
    });
    const slide = normalized.find((outline) => outline.type === "slide");
    expect(slide?.knowledgePointIds).toEqual(["kp-a", "kp-b"]);
    expect(slide?.description).toBe("比较两种学习理论。");
    expect(slide?.keyPoints).toEqual([
      "[Table] 比较理论目标与课堂角色",
      "识别适用情境",
      "说明活动差异",
    ]);
  });

  it("keeps an explicitly planned interaction and gives it the matching resource metadata", async () => {
    const { normalizeNewSystemAiOutlines } = await import("./job-runner");
    const outlines = normalizeNewSystemAiOutlines([
      {
        id: "explain",
        type: "slide",
        title: "变量关系",
        description: "解释变量之间的关系",
        keyPoints: ["变量"],
        order: 0,
      },
      {
        id: "explore",
        type: "interactive",
        title: "改变变量并比较",
        description: "运行两种条件并比较结果",
        keyPoints: ["变量"],
        order: 1,
        widgetType: "code",
        widgetOutline: { concept: "变量实验", language: "python" },
      },
      {
        id: "mastery",
        type: "quiz",
        title: "达标检测",
        description: "检查迁移理解",
        keyPoints: ["变量"],
        order: 2,
      },
    ], { totalDurationSec: 900, knowledgePointIds: ["kp-1"] });

    expect(outlines[0]).toMatchObject({
      detailKind: "knowledge-explanation",
      resourceTypes: ["ppt"],
    });
    expect(outlines[1]).toMatchObject({
      type: "interactive",
      detailKind: "interactive-practice",
      resourceTypes: ["code-interactive"],
      widgetType: "code",
    });
    expect(outlines[2]).toMatchObject({
      type: "quiz",
      detailKind: "other",
      resourceTypes: [],
    });
  });

  it("keeps the planner-owned visual direction separate from semantic page briefs", async () => {
    const { normalizeNewSystemAiOutlines } = await import("./job-runner");
    const direction = "深墨绿与暖沙色的现代编辑风格，以路径节点作为图形母题。";
    const outlines = normalizeNewSystemAiOutlines([
      {
        id: "page-1",
        type: "slide",
        title: "先建立模型",
        description: "解释核心模型。",
        keyPoints: ["模型由条件与结论组成"],
        courseVisualDirection: direction,
        order: 0,
      },
      {
        id: "page-2",
        type: "slide",
        title: "再检验边界",
        description: "用反例检验模型。",
        keyPoints: ["反例用于确认适用边界"],
        courseVisualDirection: direction,
        order: 1,
      },
    ], { totalDurationSec: 600, knowledgePointIds: ["kp-1"] });

    const teachingPages = outlines.filter((outline) => outline.type !== "quiz");
    expect(teachingPages).toHaveLength(2);
    expect(teachingPages.every((outline) => outline.courseVisualDirection === direction)).toBe(true);
    expect(teachingPages.map((outline) => outline.description)).toEqual([
      "解释核心模型。",
      "用反例检验模型。",
    ]);
  });

  it("uses a minimal course requirement and leaves page structure to OpenMAIC", async () => {
    const { buildOpenMaicKnowledgeLectureRequirement } = await import("./job-runner");
    const requirement = buildOpenMaicKnowledgeLectureRequirement({
      name: "AI 教学设计",
      subject: "人工智能教育",
      grade: "本科一年级",
      summary: "理解教学设计理论并应用于真实案例",
      learningObjectives: ["解释理论", "完成案例分析"],
      learnerProfile: { priorKnowledge: "会观察课堂案例，还不熟悉教学理论", learningNeeds: "需要展开因果关系", familiarContexts: "校园广播" },
    } as Course, {
      knowledgePoints: Array.from({ length: 12 }, (_, index) => ({
        id: `kp-${index + 1}`,
        name: `知识点 ${index + 1}`,
        description: "",
        groupName: `小节 ${Math.floor(index / 2) + 1}`,
      })),
    } as never, { courseId: "course-1", teacherBrief: "" } as never, 30);

    expect(requirement).toContain("AI 授知阶段总时长约 30 分钟");
    expect(requirement).toContain("PPT 讲授与必要互动约 26 分钟");
    expect(requirement).toContain("不要生成 quiz 或 PBL");
    expect(requirement).toContain("不要把一个完整概念机械拆成多张稀疏页面");
    expect(requirement).toContain("不设条目配额");
    expect(requirement).toContain("会观察课堂案例，还不熟悉教学理论");
    expect(requirement).toContain("需要展开因果关系");
    expect(requirement).toContain("校园广播");
    expect(requirement).toContain("不要为排版而默认添加 Table");
    expect(requirement).toContain("内容按以下小节组织");
    expect(requirement).toContain("以教师提供的课程资料作为事实依据");
    expect(requirement).not.toContain("全课规划约");
    expect(requirement).not.toContain("OpenMAIC v1.0.2");
    expect(requirement).not.toContain("keyPoints 保留");
    expect(requirement).not.toContain("[Table]");
    expect(requirement).not.toContain("[Chart]");
    expect(requirement).not.toContain("Workbench");
    expect(requirement).not.toContain("materialFacts");
    expect(requirement).not.toContain("【全课视觉方向】");
    expect(requirement).not.toContain("110–180");
    expect(requirement).not.toContain("Office 蓝橙");
    expect(requirement).not.toContain("1–2 scenes per minute");
  });

  it("repairs a blank target grade instead of letting unknown learner context flow downstream", async () => {
    callLLM
      .mockResolvedValueOnce(JSON.stringify({ name: "计算机视觉", subject: "人工智能", grade: "", hours: 2 }))
      .mockResolvedValueOnce(JSON.stringify({ grade: "高中" }));
    const { inferCourseSeed } = await import("./job-runner");
    const course = {
      name: "计算机视觉",
      subject: "人工智能",
      grade: "",
      hours: 2,
    } as Course;

    const seed = await inferCourseSeed(
      course,
      { courseId: "course-cv", teacherBrief: "讲解图像分类、物体检测与计算机视觉工作流程" },
      new AbortController().signal,
    );

    expect(seed.grade).toBe("高中");
    expect(callLLM).toHaveBeenCalledTimes(2);
    expect(callLLM.mock.calls[1][0][0].content).toContain("grade 必须是非空字符串");
  }, 15_000);

  it("falls back to one directly adoptable draft when skeleton candidates are incomplete", async () => {
    generateProjectSkeleton.mockRejectedValue(
      new Error("项目骨架生成失败：AI 返回结构不完整，请检查模型输出后重试。"),
    );
    callLLM.mockResolvedValue(JSON.stringify({
      learningObjectives: ["解释核心概念", "比较不同证据", "形成并修订项目方案"],
      summary: "学生将在真实校园情境中调查问题、比较证据并形成可实施的个人项目方案，同时说明自己的关键判断和改进依据。",
      learnerProfile: {
        priorKnowledge: "具备基础信息检索经验",
        learningNeeds: "需要结构化证据支架",
        familiarContexts: "校园生活",
      },
      drivingQuestion: "我们如何为校园提出一项有证据支持且能够实施的改进方案？",
    }));
    const { generatePositioningDetails } = await import("./job-runner");
    const controller = new AbortController();
    const result = await generatePositioningDetails(
      {
        id: "course-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        name: "未命名课程",
        subject: "综合实践",
        grade: "七年级",
        hours: 2,
        summary: "",
        drivingQuestion: "",
        status: "draft",
        stages: [],
        currentStageIndex: 0,
        content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } },
        students: [],
      },
      { name: "校园改进项目", subject: "综合实践", grade: "七年级", hours: 2 },
      { courseId: "course-1", teacherBrief: "设计一节校园改进项目课" },
      "",
      controller.signal,
    );

    expect(generateProjectSkeleton).toHaveBeenCalledTimes(4);
    expect(result.learningObjectives).toHaveLength(3);
    expect(result.drivingQuestion).toMatch(/[？?]$/);
    expect(result.summary.length).toBeGreaterThan(30);
  }, 15_000);

  it("merges generated authoring fields without restoring a stale course version", async () => {
    const { mergeGeneratedCourseSnapshot } = await import("./job-runner");
    const current = {
      id: "course-1",
      version: 12,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      name: "旧名称",
      subject: "综合实践",
      grade: "七年级",
      hours: 2,
      summary: "",
      drivingQuestion: "",
      status: "draft",
      stages: [],
      currentStageIndex: 0,
      content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } },
      students: [{ id: "student-1", name: "学生", joinedAt: "2026-01-01", stageProgress: {} }],
    } as Course;
    const generated = {
      ...current,
      version: 4,
      name: "校园节能项目",
      content: { ...current.content, knowledgePoints: [{ id: "kp-1", name: "能耗", description: "理解能耗" }] },
      students: [],
    } as Course;

    const merged = mergeGeneratedCourseSnapshot(current, generated);

    expect(merged.version).toBe(12);
    expect(merged.students).toEqual(current.students);
    expect(merged.name).toBe("校园节能项目");
    expect(merged.content.knowledgePoints).toHaveLength(1);
  });

  it("keeps the first usable positioning draft for the teacher checkpoint", async () => {
    generateProjectSkeleton.mockImplementation(async (input: { targetPart: string }) => {
      if (input.targetPart === "learningObjectives") {
        return { learningObjectiveOptions: [["列举 AI 误判案例", "归纳常见错误类型", "撰写校园广播稿", "形成 AI 使用守则"]] };
      }
      if (input.targetPart === "summary") {
        return { summaryOptions: ["学生分析校园生活中的人工智能误判案例，归纳问题成因，并完成面向同学的校园广播内容和使用建议。"] };
      }
      if (input.targetPart === "learnerProfile") {
        return { learnerProfileOptions: [{ priorKnowledge: "了解常见 AI 应用", learningNeeds: "需要案例分类支架", familiarContexts: "校园广播" }] };
      }
      return { drivingQuestions: ["我们如何设计校园广播稿介绍 AI 错误类型和正确用法？"] };
    });
    callLLM.mockResolvedValueOnce(JSON.stringify({ name: "校园 AI 使用指南", subject: "信息科技", grade: "七年级", hours: 2 }));

    const { generatePositioning } = await import("./job-runner");
    const baseCourse = {
      id: "course-agent-review",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      name: "未命名课程",
      subject: "信息科技",
      grade: "七年级",
      hours: 2,
      summary: "",
      drivingQuestion: "",
      status: "draft",
      stages: [],
      currentStageIndex: 0,
      content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } },
      students: [],
    } as Course;

    const result = await generatePositioning(
      baseCourse,
      { courseId: baseCourse.id, teacherBrief: "用两课时设计校园广播稿，帮助学生理解 AI 误判和正确用法" },
      new AbortController().signal,
    );

    expect(result.review.revisionCount).toBe(0);
    expect(result.value.learningObjectives).toHaveLength(4);
    expect(result.value.drivingQuestion).toContain("设计校园广播稿");
    expect(result.value.hours).toBe(2);
    expect(callLLM).toHaveBeenCalledOnce();
  });
});
