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
    } as Course, {
      knowledgePoints: Array.from({ length: 12 }, (_, index) => ({
        id: `kp-${index + 1}`,
        name: `知识点 ${index + 1}`,
        description: "",
        groupName: `小节 ${Math.floor(index / 2) + 1}`,
      })),
    } as never, { courseId: "course-1", teacherBrief: "" } as never, 30);

    expect(requirement).toContain("AI 授知阶段总时长约 30 分钟");
    expect(requirement).toContain("PPT 讲授与必要互动约 12 分钟");
    expect(requirement).toContain("不要生成 quiz 或 PBL");
    expect(requirement).toContain("不要把一个完整概念机械拆成多张稀疏页面");
    expect(requirement).toContain("keyPoints 应包含 4–6 个互补且可见的信息单元");
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

  it("lets the design agent repair positioning misalignment instead of failing the quick flow", async () => {
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
    callLLM
      .mockResolvedValueOnce(JSON.stringify({ name: "校园 AI 使用指南", subject: "信息科技", grade: "七年级", hours: 2 }))
      .mockResolvedValueOnce(JSON.stringify({
        passed: false,
        summary: "目标与驱动问题不一致且任务量偏大",
        issues: [
          "驱动问题要求介绍AI错误类型，但课程目标未完整覆盖错误类型与正确用法",
          "2课时内同时完成多个大型成果，任务量超出范围",
        ],
      }))
      .mockResolvedValueOnce(JSON.stringify({
        summary: "已直接修订课程定位",
        revised: {
          summary: "学生在两课时内分析三个校园 AI 误判案例，归纳错误类型和核验方法，最终共同形成一份简明校园广播稿。",
          learningObjectives: ["识别校园情境中的 AI 误判", "归纳两类常见错误及核验方法", "依据案例撰写简明校园广播稿"],
          learnerProfile: { priorKnowledge: "了解常见 AI 应用", learningNeeds: "需要案例分类与写作支架", familiarContexts: "校园广播" },
          drivingQuestion: "我们如何用一份校园广播稿帮助同学识别 AI 错误并正确核验？",
        },
      }))
      .mockResolvedValueOnce(JSON.stringify({ passed: true, summary: "定位一致且课时可执行", issues: [] }));

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

    expect(result.review.revisionCount).toBe(1);
    expect(result.value.learningObjectives).toHaveLength(3);
    expect(result.value.drivingQuestion).toContain("识别 AI 错误");
    expect(result.value.hours).toBe(2);
    expect(callLLM).toHaveBeenCalledTimes(4);
  });
});
