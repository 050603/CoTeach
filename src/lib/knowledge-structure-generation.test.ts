import { describe, expect, it, vi } from "vitest";
import { DURABLE_GENERATION_TRANSIENT_RETRIES } from "@/lib/llm/request-policy";
import {
  buildKnowledgeStructureAuditMessages,
  buildKnowledgeStructureRepairMessages,
  generateKnowledgeStructureOnce,
  generateReviewedKnowledgeStructure,
  KNOWLEDGE_STRUCTURE_POLICY_VERSION,
  parseKnowledgeStructureJson,
} from "@/lib/knowledge-structure-generation";
import type { GenerateInput } from "@/lib/llm/types";
import type { CourseEvidenceSnapshot } from "@/lib/textbook/course-evidence-types";

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

const orderedTextbookEvidence: CourseEvidenceSnapshot = {
  schemaVersion: 2, version: 1, fingerprint: "order", createdAt: "2026-01-01T00:00:00.000Z",
  retrievalMode: "hybrid", warnings: [], mappings: [],
  selections: [{ revisionId: "main", primary: true, sectionIds: [] }],
  items: [1, 2, 3].map((index) => ({
    id: `ev-${index}`, kind: "concept" as const, title: `知识${index}`, content: `正文${index}`,
    source: { textbookId: "book", textbookTitle: "主教材", revisionId: "main", revisionVersion: 1,
      sectionPath: ["第一章"], sectionPosition: 1, sourceBlockPosition: index * 10 },
  })),
};

describe("reviewed knowledge structure generation", () => {
  it("restores the primary textbook order even when the model returns interleaved groups in reverse", async () => {
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify({
      knowledgePoints: [
        { id: "third", name: "知识3", evidenceItemIds: ["ev-3"], groupId: "A", groupName: "组A" },
        { id: "second", name: "知识2", evidenceItemIds: ["ev-2"], groupId: "B", groupName: "组B" },
        { id: "first", name: "知识1", evidenceItemIds: ["ev-1"], groupId: "A", groupName: "组A" },
      ], knowledgeGraph: { nodes: [], edges: [] },
    }));
    const result = await generateKnowledgeStructureOnce(input, { textbookEvidence: orderedTextbookEvidence }, { modelCall });
    expect(result.knowledgePoints.map((point) => point.id)).toEqual(["first", "second", "third"]);
    expect(result.knowledgeScopePlan?.teachingOrder?.baselineKnowledgePointIds).toEqual(["first", "second", "third"]);
    expect(result.knowledgeScopePlan?.teachingOrder?.adjustments).toEqual([]);
  });

  it("records a justified local adjustment and ignores a vague one", async () => {
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify({
      knowledgePoints: [
        { id: "first", name: "知识1", evidenceItemIds: ["ev-1"] },
        { id: "second", name: "知识2", evidenceItemIds: ["ev-2"] },
        { id: "third", name: "知识3", evidenceItemIds: ["ev-3"] },
      ],
      knowledgeScopePlan: { teachingOrderAdjustments: [
        { knowledgePointId: "second", beforeKnowledgePointId: "first", obstacle: "更合理", basis: "教材内容" },
        { knowledgePointId: "third", beforeKnowledgePointId: "second",
          obstacle: "学生尚不能辨认第三步的观察对象，先看第三步的具体现象才能理解第二步的抽象比较",
          basis: "主教材第一章相关示例给出了可先观察的具体现象，适合本学段学生" },
      ] },
      knowledgeGraph: { nodes: [], edges: [] },
    }));
    const result = await generateKnowledgeStructureOnce(input, { textbookEvidence: orderedTextbookEvidence }, { modelCall });
    expect(result.knowledgePoints.map((point) => point.id)).toEqual(["first", "third", "second"]);
    expect(result.knowledgeScopePlan?.teachingOrder?.adjustments).toEqual([
      expect.objectContaining({ knowledgePointId: "third", beforeKnowledgePointId: "second", kind: "learner-obstacle" }),
    ]);
  });

  it("moves a required cross-group dependency ahead of its textbook location and records why", async () => {
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify({
      knowledgePoints: [
        { id: "application", name: "知识1", evidenceItemIds: ["ev-1"], groupId: "application", groupName: "应用" },
        { id: "foundation", name: "知识3", evidenceItemIds: ["ev-3"], groupId: "foundation", groupName: "基础" },
      ],
      knowledgeGraph: { nodes: [], edges: [{ source: "foundation", target: "application",
        type: "supports", strength: "required", label: "构成必要基础",
        rationale: "没有先理解知识3的操作对象，就无法判断知识1的适用条件" }] },
    }));
    const result = await generateKnowledgeStructureOnce(input, { textbookEvidence: orderedTextbookEvidence }, { modelCall });
    expect(result.knowledgePoints.map((point) => point.id)).toEqual(["foundation", "application"]);
    expect(result.knowledgeScopePlan?.teachingOrder?.adjustments).toEqual([
      expect.objectContaining({ knowledgePointId: "foundation", beforeKnowledgePointId: "application",
        kind: "necessary-dependency", basis: "没有先理解知识3的操作对象，就无法判断知识1的适用条件" }),
    ]);
  });
  it("accepts a complete knowledge structure with a minor JSON syntax error on the first response", async () => {
    const raw = '{"knowledgePoints":[{"id":"kp","name":"概念","description":"具体说明"}],"knowledgeGraph":{"nodes":[{"id":"kp","instructionalRole":"lesson"}],"edges":[],}}';
    const aiCall = vi.fn().mockResolvedValue(raw);

    const result = await generateKnowledgeStructureOnce(input, {}, { aiCall });

    expect(result.knowledgePoints[0]?.name).toBe("概念");
    expect(aiCall).toHaveBeenCalledOnce();
  });

  it("does not turn a truncated response into a plausible structure", () => {
    expect(() => parseKnowledgeStructureJson('{"knowledgePoints":[')).toThrow("LLM 返回非 JSON");
    expect(() => parseKnowledgeStructureJson('{"knowledgePoints":[}')).toThrow("LLM 返回非 JSON");
  });

  it("does not repeat the source catalog in the knowledge structure request", async () => {
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify(candidate));
    await generateKnowledgeStructureOnce(input, {
      teacherKnowledgePoints: [{ id: "source-1", name: "自然语言处理基本任务", description: "唯一来源说明" }],
    }, { aiCall });
    const prompt = aiCall.mock.calls[0]?.[1] as string;
    expect(prompt.split("唯一来源说明")).toHaveLength(2);
  });

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

  it("preserves a substantive parent concept and its prerequisite relation to detail concepts", async () => {
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify({
      knowledgePoints: [
        { id: "constructivism", name: "建构主义学习理论", description: "学习者主动建构意义。" },
        { id: "assimilation", name: "同化与顺应", description: "认知结构通过同化和顺应发生变化。" },
      ],
      knowledgeGraph: { nodes: [], edges: [] },
    }));
    const result = await generateKnowledgeStructureOnce(input, {
      teacherKnowledgePoints: [
        { id: "constructivism", name: "建构主义学习理论", description: "学习者主动建构意义。", groupId: "constructivism", groupName: "建构主义学习理论", teachingRole: "core-concept" },
        { id: "assimilation", name: "同化与顺应", description: "认知结构的变化机制。", groupId: "constructivism", groupName: "建构主义学习理论", teachingRole: "detail-concept", parentKnowledgePointId: "constructivism" },
      ],
    }, { modelCall });

    expect(result.knowledgePoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "constructivism", teachingRole: "core-concept" }),
      expect.objectContaining({ id: "assimilation", teachingRole: "detail-concept", parentKnowledgePointIds: ["constructivism"] }),
    ]));
    expect(result.knowledgeGraph?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "constructivism", teachingRole: "core-concept" }),
      expect.objectContaining({ id: "assimilation", parentKnowledgePointIds: ["constructivism"] }),
    ]));
    expect(modelCall.mock.calls[0][0][0].content).toContain("core-concept");
  });

  it("stably orders parent concepts before their children while preserving group boundaries", async () => {
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify({
      knowledgePoints: [
        { id: "independent", name: "独立分支", description: "独立内容", groupId: "independent-group", groupName: "独立分支" },
        { id: "child", name: "下位机制", description: "依赖上位概念", parentKnowledgePointIds: ["parent"], groupId: "child-group", groupName: "机制" },
        { id: "child-peer", name: "机制边界", description: "同组独立内容", groupId: "child-group", groupName: "机制" },
        { id: "parent", name: "上位概念", description: "先建立基本含义", groupId: "parent-group", groupName: "概念" },
        { id: "parent-peer", name: "概念背景", description: "同组独立内容", groupId: "parent-group", groupName: "概念" },
      ],
      knowledgeGraph: { nodes: [], edges: [] },
    }));

    const result = await generateKnowledgeStructureOnce(input, {}, { modelCall });

    expect(result.knowledgePoints.map((point) => point.id)).toEqual([
      "independent",
      "parent",
      "parent-peer",
      "child",
      "child-peer",
    ]);
    expect(result.knowledgeGraph?.nodes
      .filter((node) => node.instructionalRole === "lesson")
      .map((node) => node.id)).toEqual(result.knowledgePoints.map((point) => point.id));
    expect(result.knowledgePoints.find((point) => point.id === "child")?.parentKnowledgePointIds)
      .toEqual(["parent"]);
  });

  it("keeps the original order for helpful relationships", async () => {
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify({
      knowledgePoints: [
        { id: "application", name: "应用", description: "应用练习", groupId: "application", groupName: "应用" },
        { id: "concept", name: "概念", description: "概念说明", groupId: "concept", groupName: "概念" },
      ],
      knowledgeGraph: {
        nodes: [],
        edges: [{
          id: "helpful",
          source: "concept",
          target: "application",
          label: "有助于理解",
          type: "supports",
          strength: "helpful",
          rationale: "仅提供辅助说明",
        }],
      },
    }));

    const result = await generateKnowledgeStructureOnce(input, {}, { modelCall });

    expect(result.knowledgePoints.map((point) => point.id)).toEqual(["application", "concept"]);
  });

  it("rejects a necessary parent cycle through the existing invalid-output path", async () => {
    const cyclic = {
      knowledgePoints: [
        { id: "a", name: "概念 A", description: "A", parentKnowledgePointIds: ["b"] },
        { id: "b", name: "概念 B", description: "B", parentKnowledgePointIds: ["a"] },
      ],
      knowledgeGraph: { nodes: [], edges: [] },
    };
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify(cyclic));

    await expect(generateKnowledgeStructureOnce(input, {}, {
      modelCall,
      retrySleep: async () => undefined,
    })).rejects.toThrow("知识结构存在必要依赖循环");
    expect(modelCall).toHaveBeenCalledTimes(3);
  });

  it("rejects a cycle made entirely of required prerequisite edges", async () => {
    const cyclic = {
      knowledgePoints: [{ id: "lesson", name: "本课概念", description: "本课内容" }],
      knowledgeGraph: {
        nodes: [
          { id: "lesson", label: "本课概念", instructionalRole: "lesson" },
          { id: "prereq-a", label: "先修 A", instructionalRole: "prerequisite" },
          { id: "prereq-b", label: "先修 B", instructionalRole: "prerequisite" },
        ],
        edges: [
          { id: "a-b", source: "prereq-a", target: "prereq-b", type: "required-prerequisite", strength: "required" },
          { id: "b-a", source: "prereq-b", target: "prereq-a", type: "required-prerequisite", strength: "required" },
        ],
      },
    };
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify(cyclic));

    await expect(generateKnowledgeStructureOnce(input, {}, {
      modelCall,
      retrySleep: async () => undefined,
    })).rejects.toThrow("知识图谱存在必要先修循环");
    expect(modelCall).toHaveBeenCalledTimes(3);
  });

  it("rejects dependencies that make contiguous knowledge groups cyclic", async () => {
    const cyclicGroups = {
      knowledgePoints: [
        { id: "a-parent", name: "A 上位概念", description: "A", groupId: "group-a", groupName: "A" },
        { id: "a-child", name: "A 下位概念", description: "A2", parentKnowledgePointIds: ["b-parent"], groupId: "group-a", groupName: "A" },
        { id: "b-parent", name: "B 上位概念", description: "B", groupId: "group-b", groupName: "B" },
        { id: "b-child", name: "B 下位概念", description: "B2", parentKnowledgePointIds: ["a-parent"], groupId: "group-b", groupName: "B" },
      ],
      knowledgeGraph: { nodes: [], edges: [] },
    };
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify(cyclicGroups));

    await expect(generateKnowledgeStructureOnce(input, {}, {
      modelCall,
      retrySleep: async () => undefined,
    })).rejects.toThrow("知识结构的必要依赖与知识分组边界冲突");
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
        schemaVersion: 2, version: 1, fingerprint: "f", createdAt: new Date(0).toISOString(), retrievalMode: "hybrid",
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
  it("retries instead of silently restoring an unmapped upstream node in textbook mode", async () => {
    const incomplete = {
      knowledgePoints: [{ id: "textbook-target", name: "教材概念", description: "教材解释", evidenceItemIds: ["evidence-1"] }],
      knowledgeGraph: { nodes: [], edges: [] },
    };
    const complete = {
      ...incomplete,
      knowledgePoints: [{ ...incomplete.knowledgePoints[0], sourceKnowledgePointIds: ["source-requirement"] }],
    };
    const modelCall = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(incomplete))
      .mockResolvedValueOnce(JSON.stringify(complete));
    const result = await generateKnowledgeStructureOnce(input, {
      teacherKnowledgePoints: [{ id: "source-requirement", name: "教师要求", description: "需要实质覆盖" }],
      textbookEvidence: {
        schemaVersion: 2, version: 1, fingerprint: "f", createdAt: new Date(0).toISOString(), retrievalMode: "hybrid",
        selections: [], warnings: [], mappings: [], items: [
          { id: "evidence-1", kind: "concept", title: "教材概念", content: "教材解释", source: { textbookId: "book", textbookTitle: "教材", revisionId: "revision", revisionVersion: 1, sectionPath: [] } },
        ],
      },
    }, { modelCall, retrySleep: async () => undefined });
    expect(modelCall).toHaveBeenCalledTimes(2);
    expect(result.knowledgePoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "textbook-target", sourceKnowledgePointIds: ["source-requirement"] }),
    ]));
    expect(result.knowledgePoints.some((point) => point.id === "source-requirement")).toBe(false);
  });
  it("does not create a self dependency when a textbook target merges a parent and its child", async () => {
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify({
      knowledgePoints: [{
        id: "kp-concept-system",
        name: "教学概念体系",
        description: "统一解释理论、模式与方法的层级关系。",
        sourceKnowledgePointIds: ["source-parent", "source-child"],
        evidenceItemIds: ["evidence-1"],
      }],
      knowledgeGraph: { nodes: [], edges: [] },
    }));
    const result = await generateKnowledgeStructureOnce(input, {
      teacherKnowledgePoints: [
        { id: "source-parent", name: "教学概念体系", description: "上位概念" },
        { id: "source-child", name: "教学方法", description: "下位概念", parentKnowledgePointId: "source-parent" },
      ],
      textbookEvidence: {
        schemaVersion: 2, version: 1, fingerprint: "f", createdAt: new Date(0).toISOString(), retrievalMode: "hybrid",
        selections: [], warnings: [], mappings: [], items: [
          { id: "evidence-1", kind: "concept", title: "概念体系", content: "理论、模式与方法构成层级关系。", source: { textbookId: "book", textbookTitle: "教材", revisionId: "revision", revisionVersion: 1, sectionPath: [] } },
        ],
      },
    }, { modelCall });

    expect(modelCall).toHaveBeenCalledOnce();
    expect(result.knowledgePoints).toHaveLength(1);
    expect(result.knowledgePoints[0]).toMatchObject({ id: "kp-concept-system" });
    expect(result.knowledgePoints[0]?.parentKnowledgePointIds).toBeUndefined();
    expect(result.knowledgeGraph!.nodes[0]).toMatchObject({ id: "kp-concept-system" });
    expect(result.knowledgeGraph!.nodes[0]?.parentKnowledgePointIds).toBeUndefined();
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
    expect(aiCall.mock.calls[0]?.[0]).toContain("masteryBoundary 表示学生完成本课后");
    expect(aiCall.mock.calls[0]?.[0]).toContain("跨概念综合判断只能安排在相关概念均已建立之后");
    expect(aiCall.mock.calls[0]?.[1]).toContain("讲解、例子、比较、练习不得依赖尚未讲授的后续概念");
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
