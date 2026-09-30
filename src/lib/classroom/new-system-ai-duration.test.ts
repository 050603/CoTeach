import { describe, expect, it, vi } from "vitest";
import {
  buildNewSystemAiDurationMessages,
  deriveKnowledgeTeachingClusters,
  generateNewSystemAiDurationRecommendation,
  normalizeNewSystemAiDurationRecommendation,
  type NewSystemAiDurationInput,
} from "./new-system-ai-duration";

function durationInput(): NewSystemAiDurationInput {
  return {
    course: {
      name: "校园节能",
      subject: "科学",
      grade: "初中",
      hours: 2,
      summary: "理解能耗并提出节能判断。",
      learningObjectives: ["解释能耗", "判断节能方案"],
      learnerProfile: { priorKnowledge: "认识常见用电设备" },
    },
    teacherBrief: "两课时完成校园节能主题 PBL 课程。",
    generationMode: "standard",
    knowledgePoints: [
      { id: "kp-1", name: "能耗", description: "理解能耗", level: "foundation" },
      { id: "kp-2", name: "节能判断", description: "比较方案", level: "application" },
    ],
    knowledgeGraph: {
      nodes: [
        { id: "kp-1", label: "能耗", description: "理解能耗", instructionalRole: "lesson" },
        { id: "kp-2", label: "节能判断", description: "比较方案", instructionalRole: "lesson" },
      ],
      edges: [{
        id: "edge-1",
        source: "kp-1",
        target: "kp-2",
        label: "支持",
        type: "supports",
      }],
    },
  };
}

describe("new-system AI duration judgment", () => {
  it("chooses a total budget within 20–40 percent before generating content", () => {
    const messages = buildNewSystemAiDurationMessages(durationInput());
    expect(messages[0].content).toContain("20%–40%");
    expect(messages[0].content).toContain("24–48 分钟");
    expect(messages[0].content).toContain("确定总时长后再分配知识簇预算");
    expect(messages[0].content).toContain("不得输出逐知识点时间表");
    expect(messages[0].content).toContain("不得套用固定讲解比例");
    expect(messages[0].content).not.toContain("68%");
    expect(messages[1].content).toContain('"availableMinutes":120');
    expect(messages[1].content).toContain('"assessmentMode":"adaptive"');
  });

  it("gives each teaching cluster a deterministic learning boundary instead of treating mastery as prior knowledge", () => {
    const input = durationInput();
    input.course.learnerProfile = { priorKnowledge: "能观察并描述熟悉的课堂活动" };
    input.knowledgePoints = [
      {
        id: "kp-framework",
        name: "教学理论、模式与方法",
        description: "根据课堂安排辨析三个层次",
        masteryBoundary: "能将建构主义与项目式学习分别归类",
        level: "foundation",
      },
      {
        id: "kp-constructivism",
        name: "建构主义",
        description: "理解学习者如何主动建构意义",
        masteryBoundary: "能判断教学安排是否体现主动建构",
        level: "core",
      },
      {
        id: "kp-pbl",
        name: "项目式学习",
        description: "理解围绕真实问题完成项目的教学模式",
        masteryBoundary: "能判断一项完整课堂任务是否属于项目式学习",
        level: "application",
      },
    ];
    input.knowledgeGraph = {
      nodes: [
        {
          id: "pre-observation",
          label: "描述熟悉的课堂活动",
          description: "用日常语言描述教师和学生做了什么",
          instructionalRole: "prerequisite",
          priorKnowledgeEvidence: "学生有课堂活动经验",
          diagnosticBoundary: "能说出课堂片段中的具体行为",
        },
        ...input.knowledgePoints.map((point) => ({
          id: point.id,
          label: point.name,
          description: point.description,
          instructionalRole: "lesson" as const,
          masteryBoundary: point.masteryBoundary,
        })),
      ],
      edges: [
        {
          id: "pre-framework",
          source: "pre-observation",
          target: "kp-framework",
          label: "为层次辨析提供具体对象",
          type: "required-prerequisite",
          strength: "required",
          rationale: "先能描述行为，才能辨析抽象层次",
        },
        {
          id: "framework-constructivism",
          source: "kp-framework",
          target: "kp-constructivism",
          label: "提供理论层次",
          type: "required-prerequisite",
          strength: "required",
          rationale: "先区分概念层次，再学习具体理论",
        },
        {
          id: "constructivism-pbl",
          source: "kp-constructivism",
          target: "kp-pbl",
          label: "支持比较",
          type: "supports",
          strength: "helpful",
          rationale: "课后可比较理论与教学模式",
        },
      ],
    };

    const messages = buildNewSystemAiDurationMessages(input);
    const payload = JSON.parse(messages[1].content) as {
      teachingClusters: Array<{ title: string; learningBoundary: Record<string, unknown> }>;
    };

    expect(payload.teachingClusters).toHaveLength(3);
    expect(payload.teachingClusters[0]).toMatchObject({
      title: "教学理论、模式与方法",
      learningBoundary: {
        prerequisiteKnowledge: [{
          id: "pre-observation",
          name: "描述熟悉的课堂活动",
          priorKnowledgeEvidence: "学生有课堂活动经验",
          diagnosticBoundary: "能说出课堂片段中的具体行为",
        }],
        previouslyTaughtKnowledge: [],
        currentKnowledge: [{ id: "kp-framework", name: "教学理论、模式与方法" }],
        futureKnowledge: [
          { id: "kp-constructivism", name: "建构主义" },
          { id: "kp-pbl", name: "项目式学习" },
        ],
      },
    });
    expect(payload.teachingClusters[1]?.learningBoundary).toMatchObject({
      prerequisiteKnowledge: [],
      previouslyTaughtKnowledge: [{ id: "kp-framework", name: "教学理论、模式与方法" }],
      currentKnowledge: [{ id: "kp-constructivism", name: "建构主义" }],
      futureKnowledge: [{ id: "kp-pbl", name: "项目式学习" }],
    });
    expect(messages[0].content).toContain("masteryBoundary");
    expect(messages[0].content).toContain("课程完成后");
    expect(messages[0].content).toContain("futureKnowledge");
    expect(messages[0].content).toContain("不得作为当前理解前提");
  });

  it("uses the model judgment as the AI classroom duration", async () => {
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify({
      durationMin: 42,
      rationale: "概念讲解较短，方案比较需要完整练习与反馈。",
      confidence: "high",
      teachingClusterBudgets: [
        { clusterId: "teaching-cluster-1", knowledgePointIds: ["kp-1"], durationMin: 12, rationale: "概念与例证" },
        { clusterId: "teaching-cluster-2", knowledgePointIds: ["kp-2"], durationMin: 30, rationale: "比较、练习与检测" },
      ],
      evidence: ["知识图谱包含一条从概念到应用的依赖"],
      assumptions: ["学生已认识常见电器"],
    }));

    const result = await generateNewSystemAiDurationRecommendation(durationInput(), { modelCall });

    expect(result.durationMin).toBe(42);
    expect(result.teachingClusterBudgets.map((item) => item.durationMin)).toEqual([12, 30]);
    expect(modelCall).toHaveBeenCalledOnce();
  });

  it("uses the injected streaming call and preserves duration normalization", async () => {
    const payload = JSON.stringify({
      durationMin: 42,
      rationale: "概念讲解与方案比较需要完整练习。",
      confidence: "high",
      teachingClusterBudgets: [
        { clusterId: "teaching-cluster-1", knowledgePointIds: ["kp-1"], durationMin: 12, rationale: "概念" },
        { clusterId: "teaching-cluster-2", knowledgePointIds: ["kp-2"], durationMin: 30, rationale: "应用" },
      ],
    });
    const aiCall = vi.fn().mockResolvedValue(payload);
    const modelCall = vi.fn();

    const result = await generateNewSystemAiDurationRecommendation(durationInput(), {
      aiCall,
      modelCall,
    });

    expect(result.durationMin).toBe(42);
    expect(result.teachingClusterBudgets.map((item) => item.durationMin)).toEqual([12, 30]);
    expect(aiCall).toHaveBeenCalledOnce();
    expect(modelCall).not.toHaveBeenCalled();
  });

  it("stops only when the duration response cannot be parsed", async () => {
    const aiCall = vi.fn()
      .mockResolvedValueOnce('{"durationMin":')
      .mockResolvedValueOnce(JSON.stringify({
        durationMin: 36,
        rationale: "概念讲解和应用判断均需要课堂时间。",
        confidence: "medium",
        teachingClusterBudgets: [
          { clusterId: "teaching-cluster-1", knowledgePointIds: ["kp-1"], durationMin: 12, rationale: "概念" },
          { clusterId: "teaching-cluster-2", knowledgePointIds: ["kp-2"], durationMin: 24, rationale: "应用" },
        ],
      }));

    await expect(generateNewSystemAiDurationRecommendation(durationInput(), {
      aiCall,
      retrySleep: async () => undefined,
    })).rejects.toThrow();
    expect(aiCall).toHaveBeenCalledTimes(1);
  });

  it.each([79, 150])("caps an overlong %i minute judgment at 40 percent", (durationMin) => {
    const result = normalizeNewSystemAiDurationRecommendation({
      durationMin,
      rationale: "完整展开需要更长时间。",
      confidence: "medium",
      teachingClusterBudgets: [
        { clusterId: "teaching-cluster-1", knowledgePointIds: ["kp-1"], durationMin: 50, rationale: "概念" },
        { clusterId: "teaching-cluster-2", knowledgePointIds: ["kp-2"], durationMin: 100, rationale: "应用" },
      ],
      evidence: [],
      assumptions: [],
    }, durationInput());

    expect(result.durationMin).toBe(48);
    expect(result.scopeWarning).toBeUndefined();
    expect(result.assumptions.join(" ")).toContain("已按整课 40% 上限调整为 48 分钟");
    expect(result.teachingClusterBudgets.reduce((sum, item) => sum + item.durationMin, 0)).toBe(48);
  });

  it("fills missing point budgets without dropping a confirmed knowledge point", () => {
    const result = normalizeNewSystemAiDurationRecommendation({
      durationMin: 36,
      rationale: "需要讲解、练习和检测。",
      confidence: "low",
      teachingClusterBudgets: [
        { clusterId: "teaching-cluster-1", knowledgePointIds: ["kp-1"], durationMin: 10, rationale: "概念" },
      ],
    }, durationInput());

    expect(result.teachingClusterBudgets.map((item) => item.clusterId))
      .toEqual(["teaching-cluster-1", "teaching-cluster-2"]);
    expect(result.teachingClusterBudgets[1]?.durationMin).toBeGreaterThan(0);
    expect(result.teachingClusterBudgets.reduce((sum, item) => sum + item.durationMin, 0)).toBe(36);
  });

  it("raises too-short advice to 20 percent, not a knowledge-count-based floor", () => {
    const input = durationInput();
    input.knowledgePoints = Array.from({ length: 30 }, (_, i) => ({ id: `kp-${i}`, name: `知识${i}`, description: "" }));
    const result = normalizeNewSystemAiDurationRecommendation({ durationMin: 5, rationale: "精简讲解" }, input);
    expect(result.durationMin).toBe(24);
    expect(result.teachingClusterBudgets.reduce((sum, item) => sum + item.durationMin, 0)).toBeCloseTo(24);
    expect(result.assumptions.join(" ")).toContain("20% 下限");
  });

  it("assigns one shared budget to several related knowledge points", () => {
    const input = durationInput();
    input.knowledgePoints = Array.from({ length: 4 }, (_, index) => ({
      id: `related-${index + 1}`,
      name: `相关概念 ${index + 1}`,
      description: "共同解释同一机制",
      groupId: "shared-mechanism",
      groupName: "同一机制",
    }));
    const clusters = deriveKnowledgeTeachingClusters(input.knowledgePoints);
    const result = normalizeNewSystemAiDurationRecommendation({
      durationMin: 24,
      rationale: "四个概念通过一张关系图和同一个案例共同讲解。",
      teachingClusterBudgets: [{
        clusterId: "teaching-cluster-1",
        knowledgePointIds: input.knowledgePoints.map((point) => point.id),
        durationMin: 24,
        rationale: "共享引入、关系解释、案例与检测。",
      }],
      scopeWarning: "平均每个知识点只有 6 分钟，因此讲不完。",
    }, input);

    expect(clusters).toEqual([{
      id: "teaching-cluster-1",
      title: "同一机制",
      knowledgePointIds: input.knowledgePoints.map((point) => point.id),
      learningBoundary: {
        prerequisiteKnowledge: [],
        previouslyTaughtKnowledge: [],
        currentKnowledge: input.knowledgePoints.map((point) => ({ id: point.id, name: point.name })),
        futureKnowledge: [],
      },
    }]);
    expect(result.teachingClusterBudgets).toEqual([expect.objectContaining({
      knowledgePointIds: input.knowledgePoints.map((point) => point.id),
      durationMin: 24,
    })]);
    expect(result.scopeWarning).toBeUndefined();
  });

  it("keeps a structured cluster-level capacity conflict for teacher resolution", () => {
    const result = normalizeNewSystemAiDurationRecommendation({
      durationMin: 30,
      rationale: "先合并共同讲解，再检查最低掌握边界。",
      teachingClusterBudgets: [
        { clusterId: "teaching-cluster-1", knowledgePointIds: ["kp-1"], durationMin: 10, rationale: "共享概念讲解" },
        { clusterId: "teaching-cluster-2", knowledgePointIds: ["kp-2"], durationMin: 20, rationale: "应用练习" },
      ],
      capacityConflict: {
        unresolvedClusterIds: ["teaching-cluster-2"],
        reason: "仍缺少一次完整的方案判断与反馈",
        compressionTried: "合并概念引入并取消第二个扩展示例",
      },
    }, durationInput());

    expect(result.scopeWarning).toContain("仍缺少一次完整的方案判断与反馈");
    expect(result.scopeWarning).toContain("节能判断");
    expect(result.scopeWarning).toContain("合并概念引入并取消第二个扩展示例");
  });

  it("keeps the fixed budget while tracing highlights and concrete difficulty strategies", () => {
    const input = durationInput();
    input.knowledgePoints[0]!.sourceKnowledgePointIds = ["source-energy"];
    input.teachingRequirements = {
      schemaVersion: 1,
      items: [
        { id: "highlight-energy", kind: "highlight", source: "resource-package", text: "能耗的含义与计算是教学重点。", sourceKnowledgePointIds: ["source-energy"] },
        { id: "difficulty-energy", kind: "difficulty", source: "resource-package", text: "学生容易把功率和能耗混为一谈。", sourceKnowledgePointIds: ["source-energy"] },
      ],
      conflicts: [],
    };
    const result = normalizeNewSystemAiDurationRecommendation({
      durationMin: 36,
      rationale: "保持总预算，在概念簇中增加对比和判断证据。",
      teachingClusterBudgets: [
        {
          clusterId: "teaching-cluster-1", knowledgePointIds: ["kp-1"], durationMin: 16,
          rationale: "用相同设备的功率与运行时间对比，展开重点概念。",
          requirementIds: ["highlight-energy", "difficulty-energy"],
          difficultyStrategies: [{ requirementId: "difficulty-energy", learnerObstacle: "把瞬时功率当成累计能耗", teachingApproach: "固定功率，分步比较运行一小时与两小时的累计用电量", understandingEvidence: "能说明运行时间改变时功率不变但能耗增加" }],
        },
        { clusterId: "teaching-cluster-2", knowledgePointIds: ["kp-2"], durationMin: 20, rationale: "比较方案并检测" },
      ],
    }, input);

    expect(result.durationMin).toBe(36);
    expect(result.teachingClusterBudgets[0]).toMatchObject({
      requirementIds: ["highlight-energy", "difficulty-energy"],
      difficultyStrategies: [expect.objectContaining({ requirementId: "difficulty-energy" })],
    });
    expect(result.teachingClusterBudgets[0]!.durationMin).toBeGreaterThan(16);
    expect(result.teachingClusterBudgets.reduce((sum, item) => sum + item.durationMin, 0)).toBe(36);
    expect(() => normalizeNewSystemAiDurationRecommendation({
      durationMin: 36,
      rationale: "缺少重点落实。",
      teachingClusterBudgets: [
        { clusterId: "teaching-cluster-1", knowledgePointIds: ["kp-1"], durationMin: 16, rationale: "概念" },
        { clusterId: "teaching-cluster-2", knowledgePointIds: ["kp-2"], durationMin: 20, rationale: "应用" },
      ],
    }, input)).toThrow("未进入任何知识簇预算");
  });

  it("assigns shared-source priorities to one cluster while requiring every distinct source topic", () => {
    const input = durationInput();
    input.knowledgePoints[0]!.sourceKnowledgePointIds = ["source-theory"];
    input.knowledgePoints[1]!.sourceKnowledgePointIds = ["source-theory"];
    input.teachingRequirements = {
      schemaVersion: 1,
      items: [
        { id: "highlight-theory", kind: "highlight", source: "resource-package", text: "解释共同理论。", responsibility: "instruction", sourceKnowledgePointIds: ["source-theory"] },
        { id: "difficulty-theory", kind: "difficulty", source: "resource-package", text: "抽象机制难以理解。", responsibility: "instruction", sourceKnowledgePointIds: ["source-theory"] },
        { id: "student-task", kind: "stage-requirement", source: "resource-package", text: "向 AI 提问并记录定义。", responsibility: "learner-activity", sourceKnowledgePointIds: [] },
      ],
      conflicts: [],
    };
    const raw = {
      durationMin: 36,
      rationale: "两个知识簇共享理论介绍，后续知识簇用于练习。",
      teachingClusterBudgets: [
        { clusterId: "teaching-cluster-1", knowledgePointIds: ["kp-1"], durationMin: 16, rationale: "讲解共同理论和具体障碍", requirementIds: ["highlight-theory", "difficulty-theory"], difficultyStrategies: [{ requirementId: "difficulty-theory", learnerObstacle: "将变化误当成静态定义", teachingApproach: "比较同一场景的两轮判断并解释差异", understandingEvidence: "能指出变化发生在哪一步" }] },
        { clusterId: "teaching-cluster-2", knowledgePointIds: ["kp-2"], durationMin: 20, rationale: "用已建立的概念作练习" },
      ],
    };
    expect(normalizeNewSystemAiDurationRecommendation(raw, input).teachingClusterBudgets[1]?.requirementIds).toBeUndefined();
    const messages = buildNewSystemAiDurationMessages(input);
    expect(messages[0].content).toContain("不要求每个相关簇重复落实");
    expect(messages[1].content).not.toContain('"id":"student-task"');

    input.knowledgePoints[1]!.sourceKnowledgePointIds = ["source-activity"];
    input.teachingRequirements.items[0]!.sourceKnowledgePointIds = ["source-theory", "source-activity"];
    expect(() => normalizeNewSystemAiDurationRecommendation(raw, input)).toThrow('知识主题“source-activity”未进入任何知识簇预算');
    const bothTopics = {
      ...raw,
      teachingClusterBudgets: [raw.teachingClusterBudgets[0], { ...raw.teachingClusterBudgets[1], requirementIds: ["highlight-theory"] }],
    };
    expect(normalizeNewSystemAiDurationRecommendation(bothTopics, input).teachingClusterBudgets[1]?.requirementIds).toEqual(["highlight-theory"]);
    input.knowledgePoints[1]!.sourceKnowledgePointIds = ["unrelated-topic"];
    expect(() => normalizeNewSystemAiDurationRecommendation(raw, input)).toThrow('知识主题“source-activity”未纳入本次知识讲授范围');
  });

  it("assigns a global priority requirement to exactly one relevant cluster", () => {
    const input = durationInput();
    input.teachingRequirements = {
      schemaVersion: 1,
      items: [{
        id: "highlight-global",
        kind: "highlight",
        source: "resource-package",
        text: "重点比较两种方案的判断依据。",
        sourceKnowledgePointIds: [],
      }],
      conflicts: [],
    };
    const raw = {
      durationMin: 36,
      rationale: "在方案判断知识簇中落实全局重点。",
      teachingClusterBudgets: [
        { clusterId: "teaching-cluster-1", knowledgePointIds: ["kp-1"], durationMin: 16, rationale: "概念解释" },
        { clusterId: "teaching-cluster-2", knowledgePointIds: ["kp-2"], durationMin: 20, rationale: "比较两种方案并说明判断依据", requirementIds: ["highlight-global"] },
      ],
    };

    const result = normalizeNewSystemAiDurationRecommendation(raw, input);
    expect(result.teachingClusterBudgets[1]?.requirementIds).toEqual(["highlight-global"]);
    expect(() => normalizeNewSystemAiDurationRecommendation({
      ...raw,
      teachingClusterBudgets: raw.teachingClusterBudgets.map((budget) => ({
        ...budget,
        requirementIds: ["highlight-global"],
      })),
    }, input)).toThrow("必须只安排到一个最相关的知识簇");
  });
});

it("authors only relative effort once and does not add a second difficulty multiplier", async () => {
  const input = durationInput();
  input.knowledgePoints[0]!.sourceKnowledgePointIds = ["source-energy"];
  input.teachingRequirements = { schemaVersion: 1, conflicts: [], items: [
    { id: "difficulty-energy", kind: "difficulty", source: "resource-package", responsibility: "instruction",
      text: "区分功率与能耗。", sourceKnowledgePointIds: ["source-energy"] },
  ] };
  const raw = { authoringContract: "duration-v1", durationMin: 36, rationale: "投入已经考虑概念难点和判断练习。",
    teachingClusterBudgets: [
      { clusterId: "teaching-cluster-1", relativeWeight: 1, rationale: "区分功率和累计能耗需要具体比较。", requirementIds: ["difficulty-energy"] },
      { clusterId: "teaching-cluster-2", relativeWeight: 1, rationale: "用相同投入完成方案判断。" },
    ] };
  const aiCall = vi.fn().mockResolvedValue(JSON.stringify(raw));
  const result = await generateNewSystemAiDurationRecommendation(input, { aiCall });
  expect(aiCall).toHaveBeenCalledOnce();
  expect(result.teachingClusterBudgets.map((budget) => budget.durationMin)).toEqual([18, 18]);
  expect(result.teachingClusterBudgets[0]?.difficultyStrategies).toBeUndefined();
  expect(normalizeNewSystemAiDurationRecommendation(JSON.parse(JSON.stringify(result)), input)).toEqual(result);
  const historicalNormalized = JSON.parse(JSON.stringify(result));
  delete historicalNormalized.normalizationVersion;
  expect(normalizeNewSystemAiDurationRecommendation(historicalNormalized, input, { normalized: true })).toEqual(result);
  const withConflict = normalizeNewSystemAiDurationRecommendation({ ...raw, capacityConflict: {
    unresolvedClusterIds: ["teaching-cluster-2"], reason: "还需一次完整反馈", compressionTried: "已合并重复引入",
  } }, input);
  expect(normalizeNewSystemAiDurationRecommendation(JSON.parse(JSON.stringify(withConflict)), input)).toEqual(withConflict);
  const withoutMarker = { ...raw, authoringContract: undefined };
  expect(normalizeNewSystemAiDurationRecommendation(withoutMarker, input)).toEqual(result);
  const fixedInput: NewSystemAiDurationInput = { ...input, stagePlan: {
    schemaVersion: 2, source: "resource-package", totalMinutes: 120, lessonCount: 2, minutesPerLesson: 60,
    evaluationCriteria: "", reflectionQuestions: [],
    stages: (["launch", "ai-learning", "make", "showcase", "reflection"] as const).map((key) => ({
      key, title: key, durationMin: key === "ai-learning" ? 36 : 21,
      requirements: "", outputs: "", teacherActions: "", aiActions: "",
    })),
  } };
  const fixedResult = normalizeNewSystemAiDurationRecommendation({ ...raw, durationMin: undefined }, fixedInput);
  expect(fixedResult.durationMin).toBe(36);
  expect(fixedResult.teachingClusterBudgets.map((budget) => budget.durationMin)).toEqual([18, 18]);
  expect(buildNewSystemAiDurationMessages(fixedInput)[0].content.split("只返回 JSON：")[1]).not.toContain('"durationMin":');
  expect(result.teachingClusterBudgets.map((budget) => budget.knowledgePointIds)).toEqual([["kp-1"], ["kp-2"]]);
  expect(buildNewSystemAiDurationMessages(input)[1].content).not.toContain('"applicableRequirements"');
  expect(() => normalizeNewSystemAiDurationRecommendation({ ...raw, teachingClusterBudgets: raw.teachingClusterBudgets.slice(1) }, input)).toThrow("缺少知识簇投入");
  expect(() => normalizeNewSystemAiDurationRecommendation({ ...raw, teachingClusterBudgets: raw.teachingClusterBudgets.map((budget) => ({ ...budget, requirementIds: [] })) }, input)).toThrow("未进入任何知识簇预算");
});
