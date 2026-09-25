import { describe, expect, it } from "vitest";
import {
  adaptiveResourceAddsNovelContent,
  calculateKnowledgePointAssessmentScores,
  calculateAdaptiveRemainingBudgetSec,
  buildAdaptiveResourceRequirement,
  companionMicroLessonStageContext,
  confirmAdaptiveLearningPlan,
  createDefaultAdaptiveLearningPlan,
  deriveMasteryAssessmentSceneIds,
  deriveAdaptivePrerequisiteCandidates,
  derivePretestKnowledgeEvidence,
  ensureAdaptiveResourceCoverage,
  evaluateAdaptiveLearningPlanQuality,
  evaluateAdaptiveBranchDecision,
  estimateAdaptivePretestMinutes,
  extractLearningRequestTopic,
  isCompanionMicroLessonStage,
  improveAdaptiveLearningPlanQuality,
  hasCompleteAdaptivePrerequisiteLoop,
  normalizeAdaptiveLearningPlan,
  resolveAdaptiveSceneIdentity,
  scoreAdaptiveAssessment,
} from "@/lib/adaptive-learning";
import type { AdaptiveBranchOutline, AdaptiveLearningPlan, KnowledgeGraph, StudentAdaptiveLearningState } from "@/lib/session/types";
import { knowledgeStructureSignature } from "@/lib/knowledge-graph-quality";

function resource(overrides: Partial<AdaptiveBranchOutline> = {}): AdaptiveBranchOutline {
  return {
    id: "resource-1",
    kind: "application",
    title: "强化学习的新应用",
    objective: "把策略学习迁移到新的机器人任务。",
    keyPoints: ["新情境", "边界判断"],
    anchorKnowledgePointIds: ["reinforcement-learning"],
    prerequisiteKnowledgePointIds: [],
    noveltyStatement: "使用主课未出现的仓储机器人案例，比较奖励稀疏时的策略差异。",
    mainCourseOverlapSceneIds: ["main-1"],
    sceneType: "slide",
    targetDurationSec: 120,
    generationGuidance: "不得重复主课定义与原例题。",
    preparedResource: { status: "ready", classroomId: "resource-classroom", scenesCount: 1 },
    trigger: {
      placement: "after-module",
      assessmentSceneIds: ["quiz-1"],
      answerRule: "score-at-least",
      evidenceRule: "module-mastery",
      scoreThreshold: 80,
      minimumRemainingSec: 120,
    },
    status: "teacher-confirmed",
    ...overrides,
  };
}

function plan(branches = [resource()]): AdaptiveLearningPlan {
  return {
    enabled: true,
    status: "teacher-confirmed",
    updatedAt: "2026-07-26T00:00:00.000Z",
    timeBudgetMin: 8,
    thresholds: { enrichmentMasteryMin: 80 },
    pretest: {
      title: "先决知识检查",
      introduction: "检查前序知识",
      estimatedMinutes: 3,
      questions: [{
        id: "q-1",
        prompt: "监督学习需要什么？",
        options: ["标签", "奖励"],
        correctOptionIndex: 0,
        knowledgePointIds: ["supervised-learning"],
      }],
    },
    branches,
  };
}

function state(overrides: Partial<StudentAdaptiveLearningState> = {}): StudentAdaptiveLearningState {
  return {
    pretestCompletedAt: "2026-07-26T00:00:00.000Z",
    pretestScore: 100,
    pretestWeakKnowledgePointIds: [],
    pretestMasteredKnowledgePointIds: ["supervised-learning"],
    evidence: [],
    branchRuns: [],
    microLessons: [],
    ...overrides,
  };
}

describe("adaptive learning evidence model", () => {
  it("calculates mastery separately for each knowledge point in the terminal assessment", () => {
    expect(calculateKnowledgePointAssessmentScores({
      questions: [
        { id: "q-1", knowledgePointIds: ["kp-1"] },
        { id: "q-2", knowledgePointIds: ["kp-2"] },
        { id: "q-3", knowledgePointIds: ["kp-1", "kp-2"] },
      ],
      results: [
        { questionId: "q-1", correct: true },
        { questionId: "q-2", correct: false },
        { questionId: "q-3", correct: true },
      ],
      fallbackKnowledgePointIds: [],
    })).toEqual([
      { knowledgePointId: "kp-1", correct: 2, total: 2, score: 100 },
      { knowledgePointId: "kp-2", correct: 1, total: 2, score: 50 },
    ]);
  });

  it("confirms the plan and every resource when entering course generation", () => {
    const draft = plan([resource({ status: "draft" })]);
    draft.status = "draft";

    const confirmed = confirmAdaptiveLearningPlan(draft, "2026-07-26T12:00:00.000Z");

    expect(confirmed.status).toBe("teacher-confirmed");
    expect(confirmed.updatedAt).toBe("2026-07-26T12:00:00.000Z");
    expect(confirmed.branches.every((branch) => branch.status === "teacher-confirmed")).toBe(true);
  });

  it("scores and maps pretest answers to knowledge-level evidence", () => {
    const questions = plan().pretest.questions;
    expect(scoreAdaptiveAssessment(questions, { "q-1": 1 })).toBe(0);
    expect(derivePretestKnowledgeEvidence(questions, { "q-1": 1 })).toEqual({
      weakKnowledgePointIds: ["supervised-learning"],
      masteredKnowledgePointIds: [],
    });
  });

  it("scores matching questions without free-text answers and keeps the pretest under five minutes", () => {
    const matching = {
      id: "q-match",
      type: "matching" as const,
      prompt: "把表征与含义匹配",
      options: ["横向位置", "纵向位置"],
      correctOptionIndex: 0,
      matchingPairs: [
        { left: "横轴", right: "横向位置" },
        { left: "纵轴", right: "纵向位置" },
      ],
      knowledgePointIds: ["coordinates"],
    };
    const questions = [matching, ...Array.from({ length: 4 }, (_, index) => ({
      id: `q-choice-${index}`,
      type: "single-choice" as const,
      prompt: "选择正确答案",
      options: ["正确", "错误"],
      correctOptionIndex: 0,
      knowledgePointIds: ["coordinates"],
    }))];

    expect(scoreAdaptiveAssessment([matching], {
      "q-match": { 横轴: "横向位置", 纵轴: "纵向位置" },
    })).toBe(100);
    expect(scoreAdaptiveAssessment([matching], {
      "q-match": { 横轴: "纵向位置", 纵轴: "横向位置" },
    })).toBe(0);
    expect(estimateAdaptivePretestMinutes(questions)).toBeLessThanOrEqual(5);
  });

  it("caps generated and normalized pretests at five questions", () => {
    const points = Array.from({ length: 8 }, (_, index) => ({
      id: `kp-${index}`,
      name: `知识 ${index}`,
      description: "描述",
    }));
    const fallback = createDefaultAdaptiveLearningPlan({ knowledgePoints: points });
    expect(fallback.pretest.questions).toHaveLength(5);
    const normalized = normalizeAdaptiveLearningPlan({
      pretest: { questions: Array.from({ length: 8 }, (_, index) => ({
        id: `q-${index}`,
        prompt: `题目 ${index}`,
        options: ["A", "B"],
        correctOptionIndex: 0,
        knowledgePointIds: [`kp-${index}`],
      })) },
    }, fallback);
    expect(normalized.pretest.questions).toHaveLength(5);
  });

  it("uses upstream foundation nodes instead of treating current lesson concepts as prerequisites", () => {
    const knowledgePoints = [
      { id: "data", name: "数据与特征", description: "区分样本和特征", keyInfo: "特征是对样本的可观察描述", level: "foundation" as const },
      { id: "ai-ml", name: "人工智能与机器学习的关系", description: "理解包含关系", level: "core" as const },
      { id: "classification", name: "分类模型", description: "使用特征进行分类", level: "application" as const },
    ];
    const knowledgeGraph: KnowledgeGraph = {
      nodes: knowledgePoints.map((point) => ({ id: point.id, label: point.name, description: point.description, level: point.level })),
      edges: [
        { id: "e-1", source: "data", target: "classification", label: "是理解分类输入的前提" },
        { id: "e-2", source: "ai-ml", target: "classification", label: "用于解释" },
      ],
    };
    const candidates = deriveAdaptivePrerequisiteCandidates({ knowledgePoints, knowledgeGraph });
    const fallback = createDefaultAdaptiveLearningPlan({ knowledgePoints, knowledgeGraph });

    expect(candidates.map((candidate) => candidate.point.id)).toEqual(["data"]);
    expect(fallback.pretest.questions).toHaveLength(1);
    expect(fallback.pretest.questions[0].prompt).toContain("数据与特征");
    expect(fallback.pretest.questions[0].prompt).not.toContain("最关键的前序判断");
    expect(fallback.pretest.questions[0].rationale).toContain("分类模型");
  });

  it("derives prerequisite diagnostics from required curriculum paths outside lesson targets", () => {
    const knowledgePoints = [
      { id: "kp-nlp", name: "自然语言处理基本任务", description: "本课讲授文本处理任务", keyInfo: "文本需要转化为数据表示", level: "core" as const },
      { id: "kp-classification", name: "文本分类实践", description: "本课完成文本分类", keyInfo: "使用特征训练并验证模型", level: "application" as const },
    ];
    const knowledgeGraph: KnowledgeGraph = {
      nodes: [
        ...knowledgePoints.map((point) => ({ id: point.id, label: point.name, description: point.description, keyInfo: point.keyInfo, level: point.level, instructionalRole: "lesson" as const })),
        { id: "prereq-ai", label: "人工智能三大基石", description: "理解数据、算法与算力", keyInfo: "三者共同支撑人工智能系统", level: "foundation" as const, instructionalRole: "prerequisite" as const, priorKnowledgeEvidence: "高中信息技术前序人工智能模块", diagnosticBoundary: "能解释数据、算法、算力各自作用" },
        { id: "prereq-split", label: "数据集划分", description: "理解训练集、验证集和测试集", keyInfo: "三类数据承担不同职责", level: "foundation" as const, instructionalRole: "prerequisite" as const, priorKnowledgeEvidence: "高中信息技术前序机器学习模块", diagnosticBoundary: "能按用途区分三类数据集" },
      ],
      edges: [
        { id: "e-1", source: "prereq-ai", target: "kp-nlp", label: "是理解数据处理的前提", type: "required-prerequisite" as const, strength: "required" as const, rationale: "缺失会阻断对数据表示与算法处理的理解" },
        { id: "e-2", source: "prereq-split", target: "kp-classification", label: "是训练与验证的前提", type: "required-prerequisite" as const, strength: "required" as const, rationale: "缺失会导致训练和评价流程混淆" },
        { id: "e-3", source: "prereq-ai", target: "kp-classification", label: "有助于理解", type: "supports" as const, strength: "helpful" as const, rationale: "仅提供背景" },
      ],
    };
    knowledgeGraph.semanticReview = {
      status: "passed",
      summary: "课程先修与本课目标边界清晰。",
      sourceSignature: knowledgeStructureSignature(knowledgeGraph, knowledgePoints),
      lessonDecisions: knowledgePoints.map((point) => ({ knowledgePointId: point.id, verdict: "accept", issues: [] })),
      prerequisiteDecisions: [
        { nodeId: "prereq-ai", verdict: "accept", issues: [] },
        { nodeId: "prereq-split", verdict: "accept", issues: [] },
      ],
      relationshipDecisions: [
        { edgeId: "e-1", verdict: "accept", issues: [] },
        { edgeId: "e-2", verdict: "accept", issues: [] },
        { edgeId: "e-3", verdict: "accept", issues: [] },
      ],
    };

    const candidates = deriveAdaptivePrerequisiteCandidates({ knowledgePoints, knowledgeGraph });

    expect(candidates.map((candidate) => candidate.point.id)).toEqual(["prereq-ai", "prereq-split"]);
    expect(candidates[0].supportsKnowledgePoints.map((point) => point.id)).toEqual(["kp-nlp"]);
    expect(candidates[1].supportsKnowledgePoints.map((point) => point.id)).toEqual(["kp-classification"]);

    knowledgeGraph.edges[0] = {
      ...knowledgeGraph.edges[0],
      rationale: "教师手动修改了依赖理由，原审核结论应立即失效",
    };
    expect(deriveAdaptivePrerequisiteCandidates({ knowledgePoints, knowledgeGraph })).toEqual([]);
  });

  it("repairs generic meta questions and removes diagnostics that are not graph-backed prerequisites", () => {
    const knowledgePoints = [
      { id: "data", name: "数据与特征", description: "区分样本和特征", level: "foundation" as const },
      { id: "model", name: "分类模型", description: "根据特征分类", level: "core" as const },
    ];
    const knowledgeGraph = {
      nodes: knowledgePoints.map((point) => ({ id: point.id, label: point.name, description: point.description, level: point.level })),
      edges: [{ id: "e-1", source: "data", target: "model", label: "是构建的前提" }],
    };
    const fallback = createDefaultAdaptiveLearningPlan({ knowledgePoints, knowledgeGraph });
    const generated = normalizeAdaptiveLearningPlan({
      pretest: { questions: [
        { id: "bad-1", prompt: "要理解本节课的新内容，关于‘数据与特征’最关键的前序判断是什么？", options: ["A", "B"], correctOptionIndex: 0, knowledgePointIds: ["data"] },
        { id: "bad-2", prompt: "分类模型是什么？", options: ["A", "B"], correctOptionIndex: 0, knowledgePointIds: ["model"] },
      ] },
    }, fallback);
    const improved = improveAdaptiveLearningPlanQuality(generated, fallback, { knowledgePoints, knowledgeGraph });

    expect(improved.pretest.questions).toHaveLength(1);
    expect(improved.pretest.questions[0].id).toBe("pretest-data");
    expect(improved.pretest.questions[0].prompt).not.toContain("最关键的前序判断");
  });

  it("keeps an external data prerequisite, rejects lesson concepts, and fixes an inconsistent no-pretest title", () => {
    const knowledgePoints = [
      { id: "kp-deep", name: "深度学习的概念", description: "本节正式学习深度学习", level: "core" as const },
      { id: "kp-methods", name: "人工智能三大学习方法", description: "比较三类方法", level: "core" as const },
    ];
    const mainScenes = [
      { id: "scene-deep", title: "深度学习的概念", type: "slide" as const, stageKey: "ai-learning", audience: "student" as const, knowledgePointIds: ["kp-deep"] },
      { id: "scene-methods", title: "人工智能三大学习方法", type: "slide" as const, stageKey: "ai-learning", audience: "student" as const, knowledgePointIds: ["kp-methods"] },
    ];
    const fallback = createDefaultAdaptiveLearningPlan({ knowledgePoints, mainScenes });
    const generated = normalizeAdaptiveLearningPlan({
      prerequisiteKnowledgePoints: [
        { id: "prereq-data", name: "数据", description: "对事实、观察或测量结果的记录", keyInfo: "数据是可被记录和处理的信息", relatedIds: ["kp-deep", "missing"] },
        { id: "prereq-deep", name: "深度学习的概念", description: "本节新授内容", relatedIds: ["kp-deep"] },
      ],
      pretest: {
        title: "无需前测",
        introduction: "无需前测",
        questions: [
          { id: "q-data", prompt: "下面哪一项属于可以被计算机记录和处理的数据？", options: ["一组温度读数", "无法表达的空白", "没有任何记录的猜想"], correctOptionIndex: 0, rationale: "温度读数是测量结果，会影响后续理解深度学习为何依赖大量数据。", knowledgePointIds: ["prereq-data"] },
          { id: "q-deep", prompt: "关于深度学习的概念，哪项正确？", options: ["A", "B"], correctOptionIndex: 0, knowledgePointIds: ["kp-deep"] },
        ],
      },
      branches: [],
    }, fallback);
    const improved = ensureAdaptiveResourceCoverage(
      improveAdaptiveLearningPlanQuality(generated, fallback, { knowledgePoints, mainScenes }),
      { knowledgePoints, mainScenes },
    );

    expect(improved.prerequisiteKnowledgePoints?.map((point) => point.id)).toEqual(["prereq-data"]);
    expect(improved.prerequisiteKnowledgePoints?.[0].relatedIds).toEqual(["kp-deep"]);
    expect(improved.pretest.title).toBe("课前先决知识检查");
    expect(improved.pretest.questions.map((question) => question.id)).toEqual(["q-data"]);
    expect(improved.branches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "prerequisite",
        prerequisiteKnowledgePointIds: ["prereq-data"],
        anchorKnowledgePointIds: ["kp-deep"],
      }),
    ]));
    expect(hasCompleteAdaptivePrerequisiteLoop(improved, knowledgePoints.length)).toBe(true);

    const evidence = derivePretestKnowledgeEvidence(improved.pretest.questions, { "q-data": 1 });
    improved.branches = improved.branches.map((branch) => branch.kind === "prerequisite"
      ? { ...branch, preparedResource: { status: "ready", classroomId: "data-review" } }
      : branch);
    const decision = evaluateAdaptiveBranchDecision({
      plan: confirmAdaptiveLearningPlan(improved),
      state: state({ pretestWeakKnowledgePointIds: evidence.weakKnowledgePointIds }),
      anchorKnowledgePointIds: [],
      phase: "pre-course",
      remainingBudgetSec: 480,
    });
    expect(evidence.weakKnowledgePointIds).toEqual(["prereq-data"]);
    if (decision.decision.action !== "insert") throw new Error("expected the matching prerequisite resource to be inserted");
    expect(decision.decision.branch?.prerequisiteKnowledgePointIds).toEqual(["prereq-data"]);
  });

  it("makes enrichment generation conditional on mastery, early completion, and remaining time", () => {
    const requirement = buildAdaptiveResourceRequirement("机器学习入门", resource());
    expect(requirement).toContain("模块得分达到 80 分");
    expect(requirement).toContain("学生提前完成");
    expect(requirement).toContain("剩余时间不少于 120 秒");
    expect(requirement).toContain("大纲外但重要且经典的新知识");
  });

  it("guarantees prerequisite remediation without fabricating enrichment for every module", () => {
    const uncoveredPlan: AdaptiveLearningPlan = {
      ...plan([]),
      status: "draft",
      pretest: {
        ...plan([]).pretest,
        questions: [{
          id: "q-combined",
          prompt: "比较监督学习与无监督学习",
          options: ["A", "B"],
          correctOptionIndex: 0,
          knowledgePointIds: ["supervised-learning", "unsupervised-learning"],
        }],
      },
    };
    const covered = ensureAdaptiveResourceCoverage(uncoveredPlan, {
      knowledgePoints: [
        { id: "supervised-learning", name: "监督学习", description: "有标签学习" },
        { id: "unsupervised-learning", name: "无监督学习", description: "无标签发现结构" },
        { id: "reinforcement-learning", name: "强化学习", description: "奖励驱动学习" },
      ],
      mainScenes: [
        {
          id: "module-quiz-1",
          type: "quiz",
          title: "学习范式测验",
          stageKey: "ai-learning",
          audience: "student",
          knowledgePointIds: ["supervised-learning", "unsupervised-learning"],
        },
        {
          id: "module-quiz-2",
          type: "quiz",
          title: "强化学习测验",
          stageKey: "ai-learning",
          audience: "student",
          knowledgePointIds: ["reinforcement-learning"],
        },
      ],
    });

    const prerequisiteCoverage = new Set(covered.branches.flatMap((branch) =>
      branch.trigger?.placement === "before-main-course"
        ? branch.prerequisiteKnowledgePointIds
        : [],
    ));
    expect(prerequisiteCoverage).toEqual(new Set(["supervised-learning", "unsupervised-learning"]));
    expect(covered.branches.filter((branch) => branch.trigger?.placement === "after-module")).toHaveLength(0);
    expect(covered.branches).toHaveLength(2);
  });

  it("rejects a pretest item that exposes an unlocked lesson concept in its stem", () => {
    const knowledgePoints = [
      { id: "machine-learning", name: "机器学习", description: "本课新授", level: "core" as const },
      { id: "deep-learning", name: "深度学习", description: "本课新授", level: "core" as const },
      { id: "reinforcement-learning", name: "强化学习", description: "本课新授", level: "core" as const },
    ];
    const mainScenes = knowledgePoints.map((point, index) => ({
      id: `scene-${index}`,
      title: point.name,
      type: "slide" as const,
      stageKey: "ai-learning",
      audience: "student" as const,
      knowledgePointIds: [point.id],
    }));
    const fallback = createDefaultAdaptiveLearningPlan({ knowledgePoints, mainScenes });
    const generated = normalizeAdaptiveLearningPlan({
      prerequisiteKnowledgePoints: [{
        id: "prereq-feedback",
        name: "反馈与调整",
        description: "根据结果信息调整下一步行为",
        relatedIds: ["reinforcement-learning"],
      }],
      pretest: {
        title: "课前检查",
        introduction: "检查基础",
        questions: [{
          id: "q-feedback",
          type: "true-false",
          prompt: "在强化学习中，智能体根据环境给予的奖励信号调整行为，奖励是一种反馈机制。",
          options: ["正确", "错误"],
          correctOptionIndex: 0,
          knowledgePointIds: ["prereq-feedback"],
        }],
      },
      branches: [],
    }, fallback);

    const improved = improveAdaptiveLearningPlanQuality(generated, fallback, { knowledgePoints, mainScenes });

    expect(improved.pretest.questions).toHaveLength(0);
    expect(improved.pretest.title).toBe("前序知识诊断尚未生成");
  });

  it("keeps one duplicate enrichment topic and places it after the latest related checkpoint", () => {
    const knowledgePoints = [
      { id: "machine-learning", name: "机器学习", description: "基础方法", level: "core" as const },
      { id: "deep-learning", name: "深度学习", description: "深层模型", level: "core" as const },
      { id: "reinforcement-learning", name: "强化学习", description: "交互决策", level: "core" as const },
    ];
    const mainScenes = knowledgePoints.flatMap((point, index) => ([
      { id: `lesson-${index}`, title: point.name, type: "slide" as const, order: index * 2, stageKey: "ai-learning", audience: "student" as const, knowledgePointIds: [point.id] },
      { id: `quiz-${index}`, title: `${point.name}测验`, type: "quiz" as const, order: index * 2 + 1, stageKey: "ai-learning", audience: "student" as const, knowledgePointIds: [point.id] },
    ]));
    const fallback = createDefaultAdaptiveLearningPlan({ knowledgePoints, mainScenes });
    const prerequisite = resource({
      id: "prereq-resource",
      kind: "prerequisite",
      title: "分类与反馈基础",
      keyPoints: ["按特征归类", "根据结果调整"],
      prerequisiteKnowledgePointIds: ["prereq-foundation"],
      trigger: { placement: "before-main-course", evidenceRule: "pretest-gap", minimumRemainingSec: 120 },
    });
    const repeated = [0, 1, 2].map((index) => resource({
      id: `pet-system-${index}`,
      title: "设计一个宠物识别系统：综合应用三大学习方法",
      objective: "综合比较三类方法并完成宠物识别方案",
      noveltyStatement: "新增宠物识别项目约束、方法选择证据和系统边界比较。",
      anchorKnowledgePointIds: [knowledgePoints[index].id],
      trigger: { placement: "after-module", assessmentSceneIds: [`quiz-${index}`], evidenceRule: "module-mastery", answerRule: "score-at-least", scoreThreshold: 80, minimumRemainingSec: 120 },
    }));
    const generated = normalizeAdaptiveLearningPlan({
      prerequisiteKnowledgePoints: [{ id: "prereq-foundation", name: "分类与反馈基础", description: "按特征归类并根据结果调整", relatedIds: ["machine-learning"] }],
      pretest: { title: "课前检查", introduction: "检查基础", questions: [{ id: "q-foundation", prompt: "把物品按可观察特征归类时，哪种做法更可靠？", options: ["使用一致特征", "随意改变标准"], correctOptionIndex: 0, knowledgePointIds: ["prereq-foundation"] }] },
      branches: [prerequisite, ...repeated],
    }, fallback);

    const improved = improveAdaptiveLearningPlanQuality(generated, fallback, { knowledgePoints, mainScenes });
    const enrichment = improved.branches.filter((branch) => branch.kind !== "prerequisite");

    expect(enrichment).toHaveLength(1);
    expect(enrichment[0].trigger?.assessmentSceneIds).toEqual(["quiz-2"]);
    expect(enrichment[0].anchorKnowledgePointIds).toEqual(expect.arrayContaining(knowledgePoints.map((point) => point.id)));
    expect(evaluateAdaptiveLearningPlanQuality(improved, { knowledgePoints, mainScenes }).issues)
      .toContain("课程级拓展机会不足：建议 2-4 处，当前 1 处");
  });

  it("requires a course-level enrichment review for a rich multi-module course without forcing every module", () => {
    const knowledgePoints = Array.from({ length: 9 }, (_, index) => ({
      id: `kp-${index}`,
      name: `知识点 ${index}`,
      description: `第 ${index} 个新授知识`,
      level: "core" as const,
    }));
    const mainScenes = knowledgePoints.slice(0, 6).flatMap((point, index) => ([
      { id: `lesson-rich-${index}`, title: point.name, type: "slide" as const, order: index * 2, stageKey: "ai-learning", audience: "student" as const, knowledgePointIds: [point.id] },
      ...(index % 2 === 1 ? [{ id: `quiz-rich-${index}`, title: `${point.name}测验`, type: "quiz" as const, order: index * 2 + 1, stageKey: "ai-learning", audience: "student" as const, knowledgePointIds: [point.id] }] : []),
    ]));
    const noEnrichment = createDefaultAdaptiveLearningPlan({ knowledgePoints, mainScenes });

    const quality = evaluateAdaptiveLearningPlanQuality(noEnrichment, { knowledgePoints, mainScenes });

    expect(quality.recommendedMin).toBe(4);
    expect(quality.recommendedMax).toBe(6);
    expect(quality.runtimeMaxPerStudent).toBe(2);
    expect(quality.issues).toContain("课程级拓展机会不足：建议 4-6 处，当前 0 处");
  });

  it("treats value-type variety as guidance instead of blocking a useful course library", () => {
    const knowledgePoints = Array.from({ length: 6 }, (_, index) => ({
      id: `quality-kp-${index}`,
      name: `质量知识点 ${index}`,
      description: `用于质量检查的知识点 ${index}`,
      level: "core" as const,
    }));
    const mainScenes = [
      ...knowledgePoints.map((point, index) => ({ id: `quality-lesson-${index}`, title: point.name, type: "slide" as const, order: index, stageKey: "ai-learning", audience: "student" as const, knowledgePointIds: [point.id] })),
      { id: "quality-mastery-quiz", title: "主课达标测", type: "quiz" as const, order: knowledgePoints.length, stageKey: "ai-learning", audience: "student" as const, knowledgePointIds: knowledgePoints.map((point) => point.id) },
    ];
    const current = plan([
      resource({
        id: "quality-prerequisite",
        kind: "prerequisite",
        title: "数据读取基础回顾",
        prerequisiteKnowledgePointIds: ["prereq-data-reading"],
        anchorKnowledgePointIds: [],
        trigger: { placement: "before-main-course", evidenceRule: "pretest-gap", minimumRemainingSec: 120 },
      }),
      ...Array.from({ length: 4 }, (_, index) => resource({
        id: `quality-application-${index}`,
        kind: "application",
        title: `真实场景迁移 ${index}`,
        objective: `把知识用于真实场景 ${index}`,
        noveltyStatement: `使用主课未出现的真实行业案例 ${index}，分析新的约束条件和决策边界。`,
        anchorKnowledgePointIds: [knowledgePoints[index].id],
        trigger: { placement: "after-module", assessmentSceneIds: ["quality-mastery-quiz"], evidenceRule: "module-mastery", answerRule: "score-at-least", scoreThreshold: 80, minimumRemainingSec: 120 },
      })),
    ]);
    current.prerequisiteKnowledgePoints = [{
      id: "prereq-data-reading",
      name: "数据读取基础",
      description: "能够从表格中读取数据",
      relatedIds: [knowledgePoints[0].id],
      expectedPriorKnowledgeEvidence: "高中信息技术课此前已经训练过表格读取。",
      necessityRationale: "无法读取输入数据会直接阻断后续六个知识点中的首个任务。",
      diagnosticBoundary: "能够依据行列含义定位并读出指定单元格。",
    }];
    current.prerequisiteAnalysis = {
      summary: "仅表格读取需要课前诊断，其余内容由本课讲授。",
      decisions: knowledgePoints.map((point, index) => ({
        targetKnowledgePointId: point.id,
        decision: index === 0 ? "diagnose-prerequisite" as const : "teach-in-main-course" as const,
        prerequisiteKnowledgePointIds: index === 0 ? ["prereq-data-reading"] : [],
        rationale: index === 0 ? "必须先会读取输入表格。" : "该知识由本课负责讲授。",
      })),
    };
    current.prerequisiteSemanticReview = {
      status: "passed",
      summary: "表格读取基础属于真实先修知识。",
      decisions: [{
        prerequisiteKnowledgePointId: "prereq-data-reading",
        verdict: "accept",
        issues: [],
      }],
    };
    current.pretest.questions = [{
      id: "quality-pretest",
      type: "single-choice",
      prompt: "从表格中读取某一行数据时，应先确定什么？",
      options: ["行列含义", "颜色喜好", "页面大小", "字体样式"],
      correctOptionIndex: 0,
      knowledgePointIds: ["prereq-data-reading"],
    }];

    const quality = evaluateAdaptiveLearningPlanQuality(current, { knowledgePoints, mainScenes });

    expect(quality.passed).toBe(true);
    expect(quality.issues).toEqual([]);
    expect(quality.warnings).toContain("课程库当前集中于一种教学价值；如课程内容允许，可再补充迁移应用、例题深化或经典拓展中的另一类");

    current.enrichmentStrategy = {
      recommendedMin: 4,
      recommendedMax: 6,
      runtimeMaxPerStudent: 2,
      summary: "技术形态相同，但教学价值不同",
      decisions: [
        { id: "quality-decision-0", decision: "selected", title: "真实场景迁移 0", valueType: "task-transfer", rationale: "迁移应用", anchorKnowledgePointIds: [knowledgePoints[0].id], branchId: "quality-application-0" },
        { id: "quality-decision-1", decision: "selected", title: "真实场景迁移 1", valueType: "concept-depth", rationale: "概念深化", anchorKnowledgePointIds: [knowledgePoints[1].id], branchId: "quality-application-1" },
      ],
    };
    const declaredQuality = evaluateAdaptiveLearningPlanQuality(current, { knowledgePoints, mainScenes });
    expect(declaredQuality.passed).toBe(true);
    expect(declaredQuality.warnings).not.toContain("课程库当前集中于一种教学价值；如课程内容允许，可再补充迁移应用、例题深化或经典拓展中的另一类");
  });

  it("keeps model-authored resources and only repairs missing coverage", () => {
    const existingPrerequisite = resource({
      id: "pre-combined",
      kind: "prerequisite",
      prerequisiteKnowledgePointIds: ["supervised-learning", "unsupervised-learning"],
      trigger: {
        placement: "before-main-course",
        evidenceRule: "pretest-gap",
        minimumRemainingSec: 120,
      },
    });
    const existingExtension = resource({
      id: "extension-combined",
      trigger: {
        placement: "after-module",
        assessmentSceneIds: ["quiz-1", "quiz-2"],
        answerRule: "score-at-least",
        evidenceRule: "module-mastery",
        minimumRemainingSec: 120,
      },
    });
    const current = plan([existingPrerequisite, existingExtension]);
    current.pretest.questions[0].knowledgePointIds = ["supervised-learning", "unsupervised-learning"];
    const covered = ensureAdaptiveResourceCoverage(current, {
      knowledgePoints: [
        { id: "supervised-learning", name: "监督学习", description: "" },
        { id: "unsupervised-learning", name: "无监督学习", description: "" },
      ],
      mainScenes: [
        { id: "quiz-1", type: "quiz", title: "模块一", stageKey: "ai-learning", knowledgePointIds: ["supervised-learning"] },
        { id: "quiz-2", type: "quiz", title: "模块二", stageKey: "ai-learning", knowledgePointIds: ["unsupervised-learning"] },
      ],
    });
    expect(covered.branches.map((branch) => branch.id)).toEqual(["pre-combined", "extension-combined"]);
  });

  it("does not truncate a complete resource pool at twelve items", () => {
    const fallback = createDefaultAdaptiveLearningPlan({
      knowledgePoints: [{ id: "kp", name: "知识", description: "描述" }],
    });
    const rawBranches = Array.from({ length: 15 }, (_, index) => ({
      ...resource({ id: `resource-${index}` }),
    }));
    expect(normalizeAdaptiveLearningPlan({ branches: rawBranches }, fallback).branches).toHaveLength(15);
  });

  it("selects a prepared prerequisite resource only for a matching pretest gap", () => {
    const prerequisite = resource({
      id: "pre-1",
      kind: "prerequisite",
      prerequisiteKnowledgePointIds: ["supervised-learning"],
      anchorKnowledgePointIds: ["supervised-learning"],
      noveltyStatement: "回顾主课没有讲授、但理解强化学习对比所必需的标签反馈差异。",
      trigger: {
        placement: "before-main-course",
        evidenceRule: "pretest-gap",
        minimumRemainingSec: 120,
      },
    });
    const result = evaluateAdaptiveBranchDecision({
      plan: plan([prerequisite]),
      state: state({ pretestWeakKnowledgePointIds: ["supervised-learning"] }),
      anchorKnowledgePointIds: [],
      phase: "pre-course",
      remainingBudgetSec: 480,
    });
    expect(result.decision.action).toBe("insert");
    const evidenceText = result.evaluations[0].conditions.find((condition) => condition.key === "evidence")?.actual;
    expect(evidenceText).toContain("关联先决知识");
    expect(evidenceText).not.toContain("supervised-learning");
  });

  it("requires a matching prerequisite even when the AI teaching budget is exhausted", () => {
    const prerequisite = resource({
      id: "pre-required",
      kind: "prerequisite",
      prerequisiteKnowledgePointIds: ["supervised-learning"],
      anchorKnowledgePointIds: ["supervised-learning"],
      noveltyStatement: "补充主课不会重讲、但理解后续对比必需的有监督学习反馈基础。",
      trigger: {
        placement: "before-main-course",
        evidenceRule: "pretest-gap",
        minimumRemainingSec: 600,
      },
    });
    const result = evaluateAdaptiveBranchDecision({
      plan: plan([prerequisite]),
      state: state({ pretestWeakKnowledgePointIds: ["supervised-learning"] }),
      anchorKnowledgePointIds: [],
      phase: "pre-course",
      remainingBudgetSec: 0,
    });

    expect(result.decision.action).toBe("insert");
    expect(result.evaluations[0].conditions.find((condition) => condition.key === "time"))
      .toMatchObject({ passed: true, actual: "先决知识补充为开课前必经环节" });
  });

  it("does not relecture after an incorrect module quiz", () => {
    const result = evaluateAdaptiveBranchDecision({
      plan: plan(),
      state: state(),
      nodeQuizScore: 50,
      anchorKnowledgePointIds: ["reinforcement-learning"],
      completedSceneId: "quiz-1",
      phase: "after-module",
      remainingBudgetSec: 480,
    });
    expect(result.decision.action).toBe("continue");
    expect(result.evaluations[0].conditions.find((condition) => condition.key === "evidence")?.passed).toBe(false);
  });

  it("inserts enrichment after mastery when time and prepared content are available", () => {
    const result = evaluateAdaptiveBranchDecision({
      plan: plan(),
      state: state(),
      nodeQuizScore: 90,
      anchorKnowledgePointIds: ["reinforcement-learning"],
      completedSceneId: "quiz-1",
      phase: "after-module",
      remainingBudgetSec: 480,
    });
    expect(result.decision.action).toBe("insert");
    expect(result.evaluations[0].score).toBe(90);
  });

  it("uses the branch's attributed knowledge-point score instead of the whole-quiz score", () => {
    const result = evaluateAdaptiveBranchDecision({
      plan: plan(),
      state: state(),
      nodeQuizScore: 90,
      knowledgePointScores: [
        { knowledgePointId: "reinforcement-learning", correct: 1, total: 2, score: 50 },
        { knowledgePointId: "unrelated", correct: 2, total: 2, score: 100 },
      ],
      anchorKnowledgePointIds: ["reinforcement-learning", "unrelated"],
      completedSceneId: "quiz-1",
      phase: "after-module",
      remainingBudgetSec: 480,
    });

    expect(result.decision.action).toBe("continue");
    expect(result.evaluations[0].score).toBe(50);
  });

  it("keeps a rich course library while limiting one student's live enrichment path", () => {
    const currentPlan = plan([resource()]);
    currentPlan.enrichmentStrategy = {
      recommendedMin: 4,
      recommendedMax: 6,
      runtimeMaxPerStudent: 1,
      summary: "资源库丰富，学生路径克制",
      decisions: [],
    };
    const result = evaluateAdaptiveBranchDecision({
      plan: currentPlan,
      state: state({
        branchRuns: [{
          id: "completed-extension",
          branchOutlineId: "another-resource",
          kind: "extension",
          status: "completed",
          reason: "mastery",
          createdAt: "2026-07-26T00:00:00.000Z",
          completedAt: "2026-07-26T00:03:00.000Z",
        }],
      }),
      nodeQuizScore: 100,
      anchorKnowledgePointIds: ["reinforcement-learning"],
      completedSceneId: "quiz-1",
      phase: "after-module",
      remainingBudgetSec: 480,
    });

    expect(result.decision.action).toBe("continue");
    expect(result.evaluations[0].conditions.find((condition) => condition.key === "path-limit"))
      .toMatchObject({ passed: false, actual: "已使用 1 份拓展" });
  });

  it("rejects a resource without a meaningful novelty statement", () => {
    const branch = resource({ noveltyStatement: "把策略学习迁移到新的机器人任务。" });
    expect(adaptiveResourceAddsNovelContent(branch)).toBe(false);
    const result = evaluateAdaptiveBranchDecision({
      plan: plan([branch]),
      state: state(),
      nodeQuizScore: 100,
      anchorKnowledgePointIds: ["reinforcement-learning"],
      completedSceneId: "quiz-1",
      phase: "after-module",
      remainingBudgetSec: 480,
    });
    expect(result.decision.action).toBe("continue");
  });

  it("accounts for completed resources in the total time budget", () => {
    const currentPlan = plan();
    expect(calculateAdaptiveRemainingBudgetSec(currentPlan, state({
      branchRuns: [{
        id: "run-1",
        branchOutlineId: "resource-1",
        kind: "application",
        status: "completed",
        reason: "mastery",
        createdAt: "2026-07-26T00:00:00.000Z",
      }],
    }))).toBe(360);
  });

  it("clamps adaptive resources to the live AI-stage budget", () => {
    const currentPlan = plan();
    const currentState = state({
      branchRuns: [{
        id: "run-1",
        branchOutlineId: "resource-1",
        kind: "application",
        status: "completed",
        reason: "mastery",
        createdAt: "2026-07-26T00:00:00.000Z",
      }],
    });

    expect(calculateAdaptiveRemainingBudgetSec(currentPlan, currentState, 90)).toBe(90);
    expect(calculateAdaptiveRemainingBudgetSec(currentPlan, currentState, -10)).toBe(0);
    expect(calculateAdaptiveRemainingBudgetSec(currentPlan, currentState)).toBe(360);
  });

  it("uses stable outline ids and derives module quiz checkpoints", () => {
    expect(resolveAdaptiveSceneIdentity({ id: "runtime", outlineId: "outline" })).toEqual({
      stableSceneId: "outline",
      runtimeSceneId: "runtime",
    });
    expect(deriveMasteryAssessmentSceneIds([
      { id: "slide", type: "slide", stageKey: "ai-learning", knowledgePointIds: ["kp"] },
      { id: "quiz", type: "quiz", stageKey: "ai-learning", knowledgePointIds: ["kp"] },
    ])).toEqual(["quiz"]);
  });
});

describe("extractLearningRequestTopic", () => {
  it("recognizes the knowledge-corner request wrapper", () => {
    expect(
      extractLearningRequestTopic(
        "请围绕这个问题解释概念、补充背景，并给出可继续查证的资料线索：什么是光合作用",
      ),
    ).toBe("什么是光合作用");
  });

  it.each([
    "为什么桥梁要设计成拱形？",
    "请解释浮力的原理",
    "我想了解怎样判断一条资料是否可信",
  ])("recognizes a natural knowledge-learning request: %s", (message) => {
    expect(extractLearningRequestTopic(message)).toBeTruthy();
  });

  it("does not classify an ordinary project action as a knowledge topic", () => {
    expect(extractLearningRequestTopic("帮我把小组任务分成三步")).toBeNull();
  });

  it("enables on-demand micro lessons only in the four companion stages", () => {
    expect(["proposal", "make", "showcase"].every(isCompanionMicroLessonStage)).toBe(true);
    expect(isCompanionMicroLessonStage("reflection")).toBe(false);
    expect(isCompanionMicroLessonStage("launch")).toBe(false);
    expect(isCompanionMicroLessonStage("ai-learning")).toBe(false);
    expect(companionMicroLessonStageContext("showcase")).toBe("成果汇报");
  });

  it("keeps a reviewed prerequisite when its explanation names the lesson target it unlocks", () => {
    const knowledgePoints = [{
      id: "kp-classification",
      name: "图像分类",
      description: "理解图像分类模型如何作出类别判断",
      keyInfo: "特征支撑类别判断",
      masteryBoundary: "能解释图像分类流程",
      objectiveIndexes: [0],
      level: "application" as const,
    }];
    const knowledgeGraph: KnowledgeGraph = {
      nodes: [
        { ...knowledgePoints[0], label: knowledgePoints[0].name, instructionalRole: "lesson" },
        {
          id: "prereq-feature",
          label: "数据特征与分类判断",
          description: "理解可观察的数据特征如何为图像分类提供判断依据",
          keyInfo: "不同特征会影响分类结果和算法选择",
          level: "foundation",
          instructionalRole: "prerequisite",
          priorKnowledgeEvidence: "课程概念递进上，分类学习建立在数据特征概念之上",
          diagnosticBoundary: "能为一个分类任务指出可用特征并说明作用",
        },
      ],
      edges: [{
        id: "e-feature",
        source: "prereq-feature",
        target: "kp-classification",
        label: "是理解分类依据的必要前提",
        type: "required-prerequisite",
        strength: "required",
        rationale: "缺失会无法理解图像信息如何成为分类依据",
      }],
    };
    knowledgeGraph.semanticReview = {
      status: "passed",
      summary: "先修边界成立",
      sourceSignature: knowledgeStructureSignature(knowledgeGraph, knowledgePoints),
      lessonDecisions: [{ knowledgePointId: "kp-classification", verdict: "accept", issues: [] }],
      prerequisiteDecisions: [{ nodeId: "prereq-feature", verdict: "accept", issues: [] }],
      relationshipDecisions: [{ edgeId: "e-feature", verdict: "accept", issues: [] }],
    };
    const fallback = createDefaultAdaptiveLearningPlan({ knowledgePoints, knowledgeGraph });

    const improved = improveAdaptiveLearningPlanQuality(fallback, fallback, {
      knowledgePoints,
      knowledgeGraph,
      mainScenes: [{ id: "scene-classification", title: "图像分类", type: "slide", order: 1, stageKey: "ai-learning", audience: "student", knowledgePointIds: ["kp-classification"] }],
    });

    expect(improved.prerequisiteKnowledgePoints?.map((point) => point.id)).toContain("prereq-feature");
  });
});
