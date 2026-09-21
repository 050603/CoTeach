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

  it("retries only when the duration response cannot be parsed", async () => {
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

    const result = await generateNewSystemAiDurationRecommendation(durationInput(), {
      aiCall,
      retrySleep: async () => undefined,
    });

    expect(result.durationMin).toBe(36);
    expect(aiCall).toHaveBeenCalledTimes(2);
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
    }, input)).toThrow("未落实教学重点");
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
