import { describe, expect, it, vi } from "vitest";
import { DURABLE_GENERATION_TRANSIENT_RETRIES } from "@/lib/llm/request-policy";
import {
  buildKnowledgeStructureAuditMessages,
  buildKnowledgeStructureRepairMessages,
  generateKnowledgeStructureOnce,
  generateReviewedKnowledgeStructure,
  KNOWLEDGE_STRUCTURE_POLICY_VERSION,
} from "@/lib/knowledge-structure-generation";
import type { GenerateInput } from "@/lib/llm/types";

const input: GenerateInput = {
  name: "自然语言处理",
  subject: "信息技术",
  grade: "高一",
  hours: 1,
  summary: "理解自然语言处理并完成文本分类项目",
  drivingQuestion: "如何让计算机理解校园文本？",
  learningObjectives: ["理解自然语言处理基本任务", "完成文本分类项目"],
  learnerProfile: { priorKnowledge: "已学人工智能与机器学习基础" },
  stages: [],
};

const candidate = {
  knowledgePoints: [
    { id: "kp-nlp", name: "自然语言处理基本任务", description: "理解文本处理任务", keyInfo: "文本需表示为可计算的数据", masteryBoundary: "能解释两类基本任务", objectiveIndexes: [0], level: "core" },
    { id: "kp-project", name: "文本分类项目", description: "完成分类方案", keyInfo: "依据特征选择并验证算法", masteryBoundary: "能完成并解释分类方案", objectiveIndexes: [1], level: "application" },
  ],
  knowledgeGraph: {
    nodes: [
      { id: "kp-nlp", label: "自然语言处理基本任务", description: "理解文本处理任务", keyInfo: "文本需表示为可计算的数据", masteryBoundary: "能解释两类基本任务", objectiveIndexes: [0], level: "core", instructionalRole: "lesson" },
      { id: "kp-project", label: "文本分类项目", description: "完成分类方案", keyInfo: "依据特征选择并验证算法", masteryBoundary: "能完成并解释分类方案", objectiveIndexes: [1], level: "application", instructionalRole: "lesson" },
      { id: "prereq-ml", label: "监督学习与数据集划分", description: "理解监督学习及训练、验证、测试数据的分工", keyInfo: "三类数据承担不同职责", level: "foundation", instructionalRole: "prerequisite", priorKnowledgeEvidence: "学生画像明确已学机器学习基础", diagnosticBoundary: "能区分三类数据集并概述监督学习过程" },
    ],
    edges: [
      { id: "e-prereq", source: "prereq-ml", target: "kp-project", label: "是训练与验证文本模型的必要前提", type: "required-prerequisite", strength: "required", rationale: "缺失会直接导致训练和评价流程混淆" },
      { id: "e-lesson", source: "kp-nlp", target: "kp-project", label: "支撑文本分类实践", type: "application", strength: "required", rationale: "项目应用自然语言处理基本任务" },
    ],
  },
};

describe("reviewed knowledge structure generation", () => {
  it("does not fabricate prerequisite edges or objective mappings to make the draft look complete", async () => {
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify({ ...candidate, knowledgePoints: candidate.knowledgePoints.map((point) => ({ ...point, objectiveIndexes: [] })), knowledgeGraph: { ...candidate.knowledgeGraph, edges: [] } }));
    const result = await generateKnowledgeStructureOnce(input, {}, { modelCall });
    expect(result.knowledgeGraph?.edges).toEqual([]);
    expect(result.knowledgePoints.every((point) => !point.objectiveIndexes?.length)).toBe(true);
    expect(new Set(result.knowledgePoints.map((point) => point.groupId)).size).toBe(result.knowledgePoints.length);
    expect(result.knowledgePoints.every((point) => point.groupName === point.name)).toBe(true);
  });

  it("keeps exact source ids while allowing an additional objective-owned target", async () => {
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify({ ...candidate, knowledgeGraph: { ...candidate.knowledgeGraph, nodes: [...candidate.knowledgeGraph.nodes, { id: "group", label: "语言理解", instructionalRole: "lesson" }] } }));
    const result = await generateKnowledgeStructureOnce(input, { teacherKnowledgePoints: [{ id: "stable-leaf", name: "自然语言处理基本任务", description: "原文说明", groupId: "group", groupName: "语言理解" }] }, { modelCall });
    expect(result.knowledgePoints).toHaveLength(2);
    expect(result.knowledgePoints[0]).toMatchObject({ id: "stable-leaf", groupId: "group", groupName: "语言理解" });
    expect(result.knowledgeGraph?.nodes.some((node) => node.id === "group")).toBe(false);
    expect(result.knowledgeGraph?.nodes.find((node) => node.id === "stable-leaf")?.groupName).toBe("语言理解");
  });

  it("keeps every resource-package leaf even when the model tries to collapse the catalog", async () => {
    const teacherKnowledgePoints = Array.from({ length: 20 }, (_, index) => ({
      id: `source-${index + 1}`,
      name: `来源概念${index + 1}`,
      description: `来源说明${index + 1}`,
      groupId: `group-${Math.floor(index / 5) + 1}`,
      groupName: `主题${Math.floor(index / 5) + 1}`,
    }));
    const compiledPoints = Array.from({ length: 4 }, (_, index) => ({
      id: `target-${index + 1}`,
      name: `核心目标${index + 1}`,
      description: `讲清一组相关概念${index + 1}`,
      keyInfo: `这一组的关键关系${index + 1}`,
      masteryBoundary: `能够解释并判断核心目标${index + 1}`,
      objectiveIndexes: [index % 2],
      level: index < 2 ? "core" : "application",
      sourceKnowledgePointIds: teacherKnowledgePoints.slice(index * 5, index * 5 + 5).map((point) => point.id),
    }));
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify({
      knowledgeScopePlan: {
        rationale: "30分钟只独立建立四个核心目标，其余术语并入关系讲解。",
        decisions: teacherKnowledgePoints.map((point, index) => ({
          sourceKnowledgePointId: point.id,
          disposition: index % 5 === 0 ? "standalone" : "embedded",
          targetKnowledgePointId: `target-${Math.floor(index / 5) + 1}`,
          rationale: "按概念关系合并。",
        })),
      },
      knowledgePoints: compiledPoints,
      knowledgeGraph: {
        nodes: compiledPoints.map((point) => ({ ...point, label: point.name, instructionalRole: "lesson" })),
        edges: [],
      },
    }));

    const result = await generateKnowledgeStructureOnce(input, {
      teacherKnowledgePoints,
      teachingCapacity: {
        durationRangeMin: 30,
        durationRangeMax: 30,
        planningDurationMin: 30,
        durationSource: "resource-package",
        assessmentReserveMin: 4,
        explanationAndActivityMin: 26,
      },
    }, { modelCall });

    expect(result.knowledgePoints).toHaveLength(20);
    expect(result.knowledgePoints.map((point) => point.id)).toEqual(
      teacherKnowledgePoints.map((point) => point.id),
    );
    expect(result.knowledgePoints.map((point) => point.name)).toEqual(
      teacherKnowledgePoints.map((point) => point.name),
    );
    expect(result.knowledgePoints.every((point) => point.sourceKnowledgePointIds?.length === 1)).toBe(true);
    expect(result.knowledgePoints.map((point) => point.keyInfo)).toEqual(
      teacherKnowledgePoints.map((point) => point.description),
    );
    expect(result.knowledgePoints.flatMap((point) => point.sourceKnowledgePointIds ?? []))
      .toEqual(teacherKnowledgePoints.map((point) => point.id));
    expect(result.knowledgeScopePlan).toMatchObject({
      policyVersion: KNOWLEDGE_STRUCTURE_POLICY_VERSION,
      planningDurationMin: 30,
      assessmentReserveMin: 4,
      explanationAndActivityMin: 26,
      sourcePointCount: 20,
      targetPointCount: 20,
    });
    expect(result.knowledgeScopePlan?.decisions).toHaveLength(20);
    expect(result.knowledgeScopePlan?.decisions.every((decision) => (
      decision.disposition === "standalone"
      && decision.targetKnowledgePointId === decision.sourceKnowledgePointId
    ))).toBe(true);
    expect(result.knowledgeScopePlan?.rationale).toContain("完整保留资源包规定的知识点");
  });
  it("allows textbook concepts to split one upstream requirement while preserving evidence and coverage", async () => {
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify({
      knowledgePoints: [
        { id: "target-body", name: "身体参与认知", description: "身体经验参与概念形成", sourceKnowledgePointIds: ["source-embodied"], evidenceItemIds: ["evidence-1"], teachingDepth: "detailed" },
        { id: "target-environment", name: "环境互动认知", description: "环境互动影响认知", sourceKnowledgePointIds: ["source-embodied"], evidenceItemIds: ["evidence-2"], teachingDepth: "brief" },
      ],
      knowledgeGraph: { nodes: [], edges: [] },
      knowledgeScopePlan: { decisions: [{ sourceKnowledgePointId: "source-embodied", rationale: "教材分为身体和环境两个角度。" }] },
    }));
    const result = await generateKnowledgeStructureOnce(input, {
      teacherKnowledgePoints: [{ id: "source-embodied", name: "具身认知", description: "理解具身认知" }],
      textbookEvidence: {
        schemaVersion: 1, version: 1, fingerprint: "f", createdAt: new Date(0).toISOString(), retrievalMode: "hybrid",
        selections: [], warnings: [], mappings: [], items: [
          { id: "evidence-1", kind: "concept", title: "身体经验", content: "身体经验", source: { textbookId: "b", textbookTitle: "教材", revisionId: "r", revisionVersion: 1, sectionPath: [] } },
          { id: "evidence-2", kind: "concept", title: "环境互动", content: "环境互动", source: { textbookId: "b", textbookTitle: "教材", revisionId: "r", revisionVersion: 1, sectionPath: [] } },
        ],
      },
      teachingCapacity: { durationRangeMin: 30, durationRangeMax: 30, planningDurationMin: 30, durationSource: "resource-package", assessmentReserveMin: 4, explanationAndActivityMin: 26 },
    }, { modelCall });
    expect(result.knowledgePoints).toHaveLength(2);
    expect(result.knowledgePoints.every((point) => point.sourceKnowledgePointIds?.includes("source-embodied"))).toBe(true);
    expect(result.knowledgePoints.map((point) => point.evidenceItemIds)).toEqual([["evidence-1"], ["evidence-2"]]);
    expect(result.knowledgeScopePlan?.decisions[0]).toMatchObject({
      disposition: "mapped", targetKnowledgePointIds: ["target-body", "target-environment"],
    });
    expect(modelCall.mock.calls[0][0][1].content).toContain("允许拆分、合并和多对多映射");
  });
  it("generates the new-system teacher checkpoint without an AI review call", async () => {
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify(candidate));

    const result = await generateKnowledgeStructureOnce(input, {}, { modelCall });

    expect(result.knowledgePoints).toHaveLength(2);
    expect(result.knowledgeGraph?.semanticReview).toBeUndefined();
    expect(modelCall).toHaveBeenCalledTimes(1);
    expect(modelCall.mock.calls[0][1]?.requestClass).toBe("long-generation");
  });

  it("uses the injected streaming call without changing the normalized graph", async () => {
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify(candidate));
    const modelCall = vi.fn();

    const streamed = await generateKnowledgeStructureOnce(input, {}, { aiCall, modelCall });
    const legacy = await generateKnowledgeStructureOnce(input, {}, {
      modelCall: vi.fn().mockResolvedValue(JSON.stringify(candidate)),
    });

    expect(streamed).toEqual(legacy);
    expect(aiCall).toHaveBeenCalledOnce();
    expect(aiCall).toHaveBeenCalledWith(expect.stringContaining("知识"), expect.any(String));
    expect(aiCall.mock.calls[0]?.[1]).toContain("驱动问题、最终成果和资料中的“任务关联”不自动成为每个节点");
    expect(aiCall.mock.calls[0]?.[1]).toContain("不能因为某知识将来可用于成果制作");
    expect(aiCall.mock.calls[0]?.[1]).toContain("资源包来源项不得标为 embedded 或 deferred");
    expect(modelCall).not.toHaveBeenCalled();
  });

  it("retries an invalid completed JSON response as a hard-output failure", async () => {
    const aiCall = vi.fn().mockResolvedValue('{"knowledgePoints":[');

    await expect(generateKnowledgeStructureOnce(input, {}, {
      aiCall,
      retrySleep: async () => undefined,
    })).rejects.toThrow();

    expect(aiCall).toHaveBeenCalledTimes(3);
  });

  it("mechanically completes malformed relationship metadata without an AI repair call", async () => {
    const malformed = {
      ...candidate,
      knowledgeGraph: {
        ...candidate.knowledgeGraph,
        edges: [
          {
            id: "e-prereq",
            source: "prereq-ml",
            target: "kp-nlp",
            label: "关联",
            type: "application",
          },
          {
            id: "e-wrong-level",
            source: "kp-project",
            target: "kp-nlp",
            label: "迁移",
            type: "transfer",
          },
        ],
      },
    };
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify(malformed));

    const result = await generateKnowledgeStructureOnce(input, {}, { modelCall });

    expect(modelCall).toHaveBeenCalledTimes(1);
    expect(result.knowledgeGraph?.semanticReview).toBeUndefined();
    expect(result.knowledgeGraph?.edges.length).toBeGreaterThan(0);
    expect(result.knowledgeGraph?.edges.every((edge) => (
      Boolean(edge.type && edge.strength && edge.rationale)
    ))).toBe(true);
    expect(result.knowledgeGraph?.edges.some((edge) => (
      (edge.type === "application" || edge.type === "transfer")
      && result.knowledgeGraph?.nodes.find((node) => node.id === edge.target)?.level === "core"
    ))).toBe(false);
  });

  it("derives a teacher-editable draft from objectives when the model omits knowledge points", async () => {
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify({
      knowledgePoints: [],
      knowledgeGraph: { nodes: [], edges: [] },
    }));

    const result = await generateKnowledgeStructureOnce(input, {}, { modelCall });

    expect(modelCall).toHaveBeenCalledTimes(1);
    expect(result.knowledgePoints.map((point) => point.name)).toEqual(input.learningObjectives);
    expect(result.knowledgeGraph?.nodes).toHaveLength(input.learningObjectives?.length ?? 0);
    expect(result.knowledgeGraph?.semanticReview).toBeUndefined();
  });

  it("asks an independent reviewer to separate lesson scope, prerequisites and necessity", () => {
    const messages = buildKnowledgeStructureAuditMessages(
      input,
      candidate.knowledgePoints as never,
      candidate.knowledgeGraph as never,
    );
    const content = messages.map((message) => message.content).join("\n");
    expect(content).toContain("本课目标边界");
    expect(content).toContain("课程体系先修");
    expect(content).toContain("训练/验证/测试集");
    expect(content).toContain("仅降低难度或帮助理解");
  });

  it("directly edits the current graph when review rejects a prerequisite", async () => {
    const modelCall = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(candidate))
      .mockResolvedValueOnce(JSON.stringify({
        status: "failed",
        summary: "先修依据不足",
        lessonDecisions: [
          { knowledgePointId: "kp-nlp", verdict: "accept", issues: [] },
          { knowledgePointId: "kp-project", verdict: "accept", issues: [] },
        ],
        prerequisiteDecisions: [{ nodeId: "prereq-ml", verdict: "reject", issues: ["不能只靠模型猜测既往课程"] }],
        relationshipDecisions: [
          { edgeId: "e-prereq", verdict: "accept", issues: [] },
          { edgeId: "e-lesson", verdict: "accept", issues: [] },
        ],
      }))
      .mockResolvedValueOnce(JSON.stringify(candidate))
      .mockResolvedValueOnce(JSON.stringify({
        status: "passed",
        summary: "目标、先修和递进关系均合理",
        lessonDecisions: [
          { knowledgePointId: "kp-nlp", verdict: "accept", issues: [] },
          { knowledgePointId: "kp-project", verdict: "accept", issues: [] },
        ],
        prerequisiteDecisions: [{ nodeId: "prereq-ml", verdict: "accept", issues: [] }],
        relationshipDecisions: [
          { edgeId: "e-prereq", verdict: "accept", issues: [] },
          { edgeId: "e-lesson", verdict: "accept", issues: [] },
        ],
      }));

    const result = await generateReviewedKnowledgeStructure(input, {}, { modelCall, maxAttempts: 2 });

    expect(result.revisionCount).toBe(1);
    expect(result.knowledgeGraph?.semanticReview?.status).toBe("passed");
    expect(modelCall.mock.calls[2][0][1].content).toContain("先修依据不足");
    expect(modelCall).toHaveBeenCalledTimes(4);
    expect(modelCall.mock.calls.map((call) => call[1]?.requestClass)).toEqual([
      "long-generation",
      "quality-review",
      "standard",
      "quality-review",
    ]);
    expect(modelCall.mock.calls.every((call) => (
      call[1]?.maxTransientRetries === DURABLE_GENERATION_TRANSIENT_RETRIES
    )))
      .toBe(true);
  });

  it("keeps failed semantic reviews inside the current Agent editing loop", async () => {
    const failedReview = {
      status: "failed",
      summary: "仍需定向修订",
      lessonDecisions: candidate.knowledgePoints.map((point) => ({
        knowledgePointId: point.id,
        verdict: point.id === "kp-nlp" ? "reject" : "accept",
        issues: point.id === "kp-nlp" ? ["掌握边界需要补充对比要求"] : [],
      })),
      prerequisiteDecisions: [{ nodeId: "prereq-ml", verdict: "accept", issues: [] }],
      relationshipDecisions: candidate.knowledgeGraph.edges.map((edge) => ({
        edgeId: edge.id,
        verdict: "accept",
        issues: [],
      })),
    };
    const passedReview = {
      ...failedReview,
      status: "passed",
      summary: "定向修订后通过",
      lessonDecisions: candidate.knowledgePoints.map((point) => ({
        knowledgePointId: point.id,
        verdict: "accept",
        issues: [],
      })),
    };
    const modelCall = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(candidate))
      .mockResolvedValueOnce(JSON.stringify(failedReview))
      .mockResolvedValueOnce(JSON.stringify(candidate))
      .mockResolvedValueOnce(JSON.stringify(failedReview))
      .mockResolvedValueOnce(JSON.stringify(candidate))
      .mockResolvedValueOnce(JSON.stringify(passedReview));

    const result = await generateReviewedKnowledgeStructure(input, {}, { modelCall, maxAttempts: 3 });

    expect(result.revisionCount).toBe(2);
    expect(result.knowledgeGraph?.semanticReview?.status).toBe("passed");
    expect(modelCall).toHaveBeenCalledTimes(6);
    expect(modelCall.mock.calls.map((call) => call[1]?.requestClass)).toEqual([
      "long-generation",
      "quality-review",
      "standard",
      "quality-review",
      "standard",
      "quality-review",
    ]);
  });

  it("directly edits a structurally invalid graph instead of asking the producer for a new draft", async () => {
    const withoutPrerequisites = {
      ...candidate,
      knowledgeGraph: {
        ...candidate.knowledgeGraph,
        nodes: candidate.knowledgeGraph.nodes.filter((node) => node.instructionalRole !== "prerequisite"),
        edges: candidate.knowledgeGraph.edges.filter((edge) => edge.source !== "prereq-ml"),
      },
    };
    const modelCall = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(withoutPrerequisites))
      .mockResolvedValueOnce(JSON.stringify(candidate))
      .mockResolvedValueOnce(JSON.stringify({
        status: "passed",
        summary: "直接编辑后通过",
        lessonDecisions: candidate.knowledgePoints.map((point) => ({ knowledgePointId: point.id, verdict: "accept", issues: [] })),
        prerequisiteDecisions: [{ nodeId: "prereq-ml", verdict: "accept", issues: [] }],
        relationshipDecisions: candidate.knowledgeGraph.edges.map((edge) => ({ edgeId: edge.id, verdict: "accept", issues: [] })),
      }));

    const result = await generateReviewedKnowledgeStructure(input, {}, { modelCall, maxAttempts: 2 });

    expect(result.knowledgeGraph!.nodes.some((node) => node.id === "prereq-ml")).toBe(true);
    expect(modelCall.mock.calls.map((call) => call[1]?.requestClass)).toEqual([
      "long-generation",
      "standard",
      "quality-review",
    ]);
  });

  it("repairs a malformed producer payload with the standard editor", async () => {
    const modelCall = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ knowledgePoints: "invalid", knowledgeGraph: null }))
      .mockResolvedValueOnce(JSON.stringify(candidate))
      .mockResolvedValueOnce(JSON.stringify({
        status: "passed",
        summary: "结构修复后通过",
        lessonDecisions: candidate.knowledgePoints.map((point) => ({ knowledgePointId: point.id, verdict: "accept", issues: [] })),
        prerequisiteDecisions: [{ nodeId: "prereq-ml", verdict: "accept", issues: [] }],
        relationshipDecisions: candidate.knowledgeGraph.edges.map((edge) => ({ edgeId: edge.id, verdict: "accept", issues: [] })),
      }));

    const result = await generateReviewedKnowledgeStructure(input, {}, { modelCall, maxAttempts: 2 });

    expect(result.knowledgeGraph?.semanticReview?.status).toBe("passed");
    expect(modelCall.mock.calls.map((call) => call[1]?.requestClass)).toEqual([
      "long-generation",
      "standard",
      "quality-review",
    ]);
    expect(modelCall.mock.calls[1][0][0].content).toContain("直接修复当前数据");
  });

  it("keeps unverifiable Agent concerns advisory after hard graph rules pass", async () => {
    const modelCall = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(candidate))
      .mockResolvedValueOnce(JSON.stringify({
        status: "failed",
        summary: "建议结合真实班级基础再确认案例难度",
        lessonDecisions: candidate.knowledgePoints.map((point) => ({ knowledgePointId: point.id, verdict: "accept", issues: [] })),
        prerequisiteDecisions: [{ nodeId: "prereq-ml", verdict: "reject", issues: ["无法确认学生是否已经掌握"] }],
        relationshipDecisions: candidate.knowledgeGraph.edges.map((edge) => ({ edgeId: edge.id, verdict: "accept", issues: [] })),
      }));

    const result = await generateReviewedKnowledgeStructure(input, {}, { modelCall, maxAttempts: 1 });

    expect(result.knowledgeGraph!.semanticReview?.status).toBe("passed");
    expect(result.knowledgeGraph!.semanticReview?.advisoryIssues).toContain("无法确认学生是否已经掌握");
  });

  it("asks the Agent to directly edit a rejected relationship before re-reviewing", () => {
    const review = {
      status: "failed" as const,
      summary: "边缘关系必要性不足，建议降级为 supports/helpful",
      sourceSignature: "kgs-test",
      lessonDecisions: candidate.knowledgePoints.map((point) => ({
        knowledgePointId: point.id,
        verdict: "accept" as const,
        issues: [],
      })),
      prerequisiteDecisions: [{ nodeId: "prereq-ml", verdict: "accept" as const, issues: [] }],
      relationshipDecisions: [
        {
          edgeId: "e-prereq",
          verdict: "reject" as const,
          issues: ["按步骤操作即可达成目标，建议降级为 supports/helpful"],
        },
        { edgeId: "e-lesson", verdict: "accept" as const, issues: [] },
      ],
    };

    const messages = buildKnowledgeStructureRepairMessages(
      input,
      candidate.knowledgePoints as never,
      candidate.knowledgeGraph as never,
      review,
    );
    const content = messages.map((message) => message.content).join("\n");

    expect(content).toContain("直接修订当前知识结构");
    expect(content).toContain("supports/helpful");
    expect(content).toContain("e-prereq");
    expect(content).toContain("按步骤操作即可达成目标");
  });
});
