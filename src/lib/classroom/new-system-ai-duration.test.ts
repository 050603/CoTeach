import { describe, expect, it, vi } from "vitest";
import {
  buildNewSystemAiDurationMessages,
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
    expect(messages[0].content).toContain("确定总时长后再分配知识点预算");
    expect(messages[1].content).toContain('"availableMinutes":120');
  });

  it("uses the model judgment as the AI classroom duration", async () => {
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify({
      durationMin: 42,
      rationale: "概念讲解较短，方案比较需要完整练习与反馈。",
      confidence: "high",
      knowledgePointBudgets: [
        { knowledgePointId: "kp-1", durationMin: 12, rationale: "概念与例证" },
        { knowledgePointId: "kp-2", durationMin: 30, rationale: "比较、练习与检测" },
      ],
      evidence: ["知识图谱包含一条从概念到应用的依赖"],
      assumptions: ["学生已认识常见电器"],
    }));

    const result = await generateNewSystemAiDurationRecommendation(durationInput(), { modelCall });

    expect(result.durationMin).toBe(42);
    expect(result.knowledgePointBudgets.map((item) => item.durationMin)).toEqual([12, 30]);
    expect(modelCall).toHaveBeenCalledOnce();
  });

  it("uses the injected streaming call and preserves duration normalization", async () => {
    const payload = JSON.stringify({
      durationMin: 42,
      rationale: "概念讲解与方案比较需要完整练习。",
      confidence: "high",
      knowledgePointBudgets: [
        { knowledgePointId: "kp-1", durationMin: 12, rationale: "概念" },
        { knowledgePointId: "kp-2", durationMin: 30, rationale: "应用" },
      ],
    });
    const aiCall = vi.fn().mockResolvedValue(payload);
    const modelCall = vi.fn();

    const result = await generateNewSystemAiDurationRecommendation(durationInput(), {
      aiCall,
      modelCall,
    });

    expect(result.durationMin).toBe(42);
    expect(result.knowledgePointBudgets.map((item) => item.durationMin)).toEqual([12, 30]);
    expect(aiCall).toHaveBeenCalledOnce();
    expect(modelCall).not.toHaveBeenCalled();
  });

  it.each([79, 150])("caps an overlong %i minute judgment at 40 percent", (durationMin) => {
    const result = normalizeNewSystemAiDurationRecommendation({
      durationMin,
      rationale: "完整展开需要更长时间。",
      confidence: "medium",
      knowledgePointBudgets: [
        { knowledgePointId: "kp-1", durationMin: 50, rationale: "概念" },
        { knowledgePointId: "kp-2", durationMin: 100, rationale: "应用" },
      ],
      evidence: [],
      assumptions: [],
    }, durationInput());

    expect(result.durationMin).toBe(48);
    expect(result.scopeWarning).toContain("压缩至 48 分钟");
    expect(result.knowledgePointBudgets.reduce((sum, item) => sum + item.durationMin, 0)).toBe(48);
  });

  it("fills missing point budgets without dropping a confirmed knowledge point", () => {
    const result = normalizeNewSystemAiDurationRecommendation({
      durationMin: 36,
      rationale: "需要讲解、练习和检测。",
      confidence: "low",
      knowledgePointBudgets: [
        { knowledgePointId: "kp-1", durationMin: 10, rationale: "概念" },
      ],
    }, durationInput());

    expect(result.knowledgePointBudgets.map((item) => item.knowledgePointId))
      .toEqual(["kp-1", "kp-2"]);
    expect(result.knowledgePointBudgets[1]?.durationMin).toBeGreaterThan(0);
    expect(result.knowledgePointBudgets.reduce((sum, item) => sum + item.durationMin, 0)).toBe(36);
  });

  it("raises too-short advice to 20 percent, not a knowledge-count-based floor", () => {
    const input = durationInput();
    input.knowledgePoints = Array.from({ length: 30 }, (_, i) => ({ id: `kp-${i}`, name: `知识${i}`, description: "" }));
    const result = normalizeNewSystemAiDurationRecommendation({ durationMin: 5, rationale: "精简讲解" }, input);
    expect(result.durationMin).toBe(24);
    expect(result.knowledgePointBudgets.reduce((sum, item) => sum + item.durationMin, 0)).toBeCloseTo(24);
    expect(result.assumptions.join(" ")).toContain("20% 下限");
  });
});
