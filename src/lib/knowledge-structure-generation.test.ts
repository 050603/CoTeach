import { describe, expect, it, vi } from "vitest";
import { DURABLE_GENERATION_TRANSIENT_RETRIES } from "@/lib/llm/request-policy";
import {
  buildKnowledgeStructureAuditMessages,
  buildKnowledgeStructureRepairMessages,
  generateKnowledgeStructureOnce,
  generateReviewedKnowledgeStructure,
  findKnowledgeSourceSequenceIssues,
  KNOWLEDGE_STRUCTURE_POLICY_VERSION,
  parseKnowledgeStructureJson,
} from "@/lib/knowledge-structure-generation";
import type { GenerateInput } from "@/lib/llm/types";
import { buildKnowledgeGraphPrompt } from "@/lib/llm/prompts";
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
  it('rejects a five-stage knowledge description when the adopted source contains six', () => {
    const evidence: CourseEvidenceSnapshot = { ...orderedTextbookEvidence, items: [{
      ...orderedTextbookEvidence.items[0]!, id: 'project-evidence',
      sourceSequences: [{ anchorSourceBlockId: 'block-1', kind: 'ordered-steps',
        steps: ['选择项目', '制定计划', '活动探究', '制作作品', '成果交流', '活动评价']
          .map((label, index) => ({ label, sourceBlockId: `block-${index + 1}` })) }],
    }] };
    const point = { id: 'project', name: '项目式教学', keyInfo: '',
      evidenceItemIds: ['project-evidence'], description: '基本流程是选择项目、制定计划、活动探究、制作作品、成果交流等环节。' };
    expect(findKnowledgeSourceSequenceIssues([point], evidence)).toContain(
      '知识点“项目式教学”与教材完整步骤不一致：遗漏教材步骤：活动评价');
    expect(findKnowledgeSourceSequenceIssues([{ ...point,
      description: '基本流程是选择项目、制定计划、活动探究、制作作品、成果交流、活动评价。' }], evidence)).toEqual([]);
  });

  it('adopts complete canonical source identities on the first draft while keeping an accurate concise summary', async () => {
    const labels = ['教学目标分析', '情境创设', '信息资源设计', '自主学习设计', '协作学习环境设计', '学习效果评价设计', '强化练习设计'];
    const evidence: CourseEvidenceSnapshot = { ...orderedTextbookEvidence, version: 5, fingerprint: 'seven-step-source',
      items: [{ ...orderedTextbookEvidence.items[0], id: 'design-evidence',
        sourceSequences: [{ anchorSourceBlockId: 'seven', kind: 'ordered-steps',
          steps: labels.map((label, index) => ({ label, sourceBlockId: `step-${index}` })) }],
      }],
    };
    const summary = '教材给出目标分析、情境创设、信息资源设计、自主学习、协作环境、效果评价和强化练习七个设计步骤。';
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify({
      knowledgePoints: [{ id: 'design', name: '七步设计流程', description: summary,
        keyInfo: '将理论原则转成可操作的教案骨架。', evidenceItemIds: ['design-evidence'],
        sourceSequenceReferences: [{ resourceId: 'invented', orderedSteps: [{ label: '只有一步' }] }],
      }], knowledgeGraph: { nodes: [], edges: [] },
    }));
    const result = await generateKnowledgeStructureOnce(input, { textbookEvidence: evidence }, { modelCall });

    expect(modelCall).toHaveBeenCalledTimes(1);
    expect(result.knowledgePoints[0].description).toBe(summary);
    expect(result.knowledgePoints[0].sourceSequenceReferences).toEqual([{
      resourceId: 'source-sequence:seven', sourceEvidenceFingerprint: evidence.fingerprint,
      sourceEvidenceVersion: evidence.version, evidenceItemIds: ['design-evidence'],
      sequenceSemantics: 'ordered-steps', orderedSteps: evidence.items[0].sourceSequences![0].steps,
    }]);
    expect(findKnowledgeSourceSequenceIssues(result.knowledgePoints, evidence)).toEqual([]);
    expect(modelCall.mock.calls[0][0][1].content).toContain('description 和 keyInfo 是准确的课程知识摘要');
  });

  it.each([
    ['wrong count', '流程有两个步骤：确定目标、设计活动、评价效果。'],
    ['false complete list', '基本流程是确定目标、设计活动等环节。'],
    ['reversed sequence', '基本流程是评价效果、设计活动、确定目标。'],
  ])("preserves a %s first draft for final teacher review without another request", async (_kind, description) => {
    const evidence: CourseEvidenceSnapshot = { ...orderedTextbookEvidence, items: [{
      ...orderedTextbookEvidence.items[0], id: 'design-evidence',
      sourceSequences: [{ anchorSourceBlockId: 'three', kind: 'ordered-steps',
        steps: ['确定目标', '设计活动', '评价效果'].map((label, index) => ({ label, sourceBlockId: `s-${index}` })) }],
    }] };
    const draft = (text: string) => JSON.stringify({ knowledgePoints: [{
      id: 'design', name: '教学设计', description: text, keyInfo: '理解教学设计流程',
      evidenceItemIds: ['design-evidence'],
    }], knowledgeGraph: { nodes: [], edges: [] } });
    const modelCall = vi.fn().mockResolvedValueOnce(draft(description))
      .mockResolvedValueOnce(draft('基本流程是确定目标、设计活动、评价效果。'));
    const onCandidate = vi.fn();
    const onRejected = vi.fn();
    const result = await generateKnowledgeStructureOnce(input, { textbookEvidence: evidence }, {
      modelCall, retrySleep: async () => {}, onCandidate, onRejected,
    });
    expect(result.knowledgePoints[0]!.description).toBe(description);
    expect(result.knowledgePoints[0]!.sourceSequenceReferences![0]!.orderedSteps).toHaveLength(3);
    expect(onCandidate).toHaveBeenCalledWith({ rawResponse: draft(description), attempt: 1 });
    expect(onRejected).not.toHaveBeenCalled();
    expect(result.knowledgeGraph?.semanticReview).toBeUndefined();
    expect(modelCall).toHaveBeenCalledTimes(1);
  });
  it("passes the primary textbook's chapter hierarchy and evidence mapping to section planning", () => {
    const snapshot: CourseEvidenceSnapshot = {
      ...orderedTextbookEvidence,
      mappings: [{ sourceKnowledgePointId: "source-theory", sourceKnowledgePointName: "建构主义",
        status: "direct", evidenceItemIds: ["ev-1"], rationale: "教材正文支持" }],
      items: [{ ...orderedTextbookEvidence.items[0]!, source: {
        ...orderedTextbookEvidence.items[0]!.source,
        sectionId: "section-principles",
        sectionPath: ["学习理论", "建构主义", "基本原理"],
        sectionHierarchy: [
          { id: "chapter-theory", title: "学习理论", kind: "CHAPTER", level: 1 },
          { id: "section-constructivism", title: "建构主义", kind: "SECTION", level: 2 },
          { id: "section-principles", title: "基本原理", kind: "SUBSECTION", level: 3 },
        ],
      } }],
    };
    const prompt = buildKnowledgeGraphPrompt(input, { textbookEvidence: snapshot });
    expect(prompt.user).toContain('"primaryRevisionId":"main"');
    expect(prompt.user).toContain('"id":"section-constructivism","title":"建构主义"');
    expect(prompt.user).toContain('"sourceKnowledgePointId":"source-theory"');
    expect(prompt.user).toContain("教材末级标题仅列出原理、机制或步骤时，不机械地各立一节");
    expect(prompt.user).toContain("整体概念须有完整权威语境");
    expect(prompt.user).not.toContain("约 10 分钟以上");
  });

  it("preserves the planned teaching path and groups while keeping the textbook order only for provenance", async () => {
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify({
      knowledgePoints: [
        { id: "third", name: "知识3", evidenceItemIds: ["ev-3"], groupId: "C", groupName: "组C" },
        { id: "second", name: "知识2", evidenceItemIds: ["ev-2"], groupId: "B", groupName: "组B" },
        { id: "first", name: "知识1", evidenceItemIds: ["ev-1"], groupId: "A", groupName: "组A" },
      ], knowledgeGraph: { nodes: [], edges: [] },
    }));
    const result = await generateKnowledgeStructureOnce(input, { textbookEvidence: orderedTextbookEvidence }, { modelCall });
    expect(result.knowledgePoints.map((point) => point.id)).toEqual(["third", "second", "first"]);
    expect(result.knowledgePoints.map((point) => [point.groupId, point.groupName]))
      .toEqual([["C", "组C"], ["B", "组B"], ["A", "组A"]]);
    expect(result.knowledgeScopePlan?.teachingOrder?.baselineKnowledgePointIds).toEqual(["first", "second", "third"]);
    expect(result.knowledgeScopePlan?.teachingOrder?.knowledgePointIds).toEqual(["third", "second", "first"]);
    expect(result.knowledgeScopePlan?.teachingOrder?.adjustments).toEqual([]);
    expect(modelCall).toHaveBeenCalledOnce();
  });

  it("moves a declared parent before its dependent concept while preserving unrelated planned topics", async () => {
    const source = orderedTextbookEvidence.items[0]!.source;
    const evidence: CourseEvidenceSnapshot = { ...orderedTextbookEvidence, items: [
      { id: "intro", kind: "source-block", title: "教学理论与方法",
        content: "教学理论、教学模式、教学方法的基本含义及关系。",
        source: { ...source, sectionPosition: 0, sourceBlockPosition: 1 } },
      { id: "theory", kind: "concept", title: "建构主义", content: "学习理论。",
        source: { ...source, sectionPosition: 1, sourceBlockPosition: 10 } },
      { id: "mode", kind: "concept", title: "项目式教学模式", content: "教学模式。",
        source: { ...source, sectionPosition: 2, sourceBlockPosition: 20 } },
      { id: "method", kind: "concept", title: "任务驱动式教学法", content: "教学方法。",
        source: { ...source, sectionPosition: 3, sourceBlockPosition: 30 } },
    ] };
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify({
      knowledgePoints: [
        { id: "theory-point", name: "建构主义", evidenceItemIds: ["theory"], groupId: "theory" },
        { id: "mode-point", name: "项目式教学模式", evidenceItemIds: ["mode"], groupId: "mode",
          parentKnowledgePointIds: ["overview"] },
        { id: "method-point", name: "任务驱动式教学法", evidenceItemIds: ["method"], groupId: "method" },
        { id: "overview", name: "教学理论、教学模式与教学方法的概念界定",
          evidenceItemIds: ["method", "intro"], groupId: "overview" },
      ], knowledgeGraph: { nodes: [], edges: [] },
    }));
    const result = await generateKnowledgeStructureOnce(input, { textbookEvidence: evidence }, { modelCall });
    expect(result.knowledgePoints.map((point) => point.id))
      .toEqual(["theory-point", "method-point", "overview", "mode-point"]);
    expect(result.knowledgeScopePlan?.teachingOrder?.anchors.find((anchor) => anchor.knowledgePointId === "overview"))
      .toMatchObject({ evidenceItemId: "intro", sectionPosition: 0 });
  });

  it("does not turn legacy textbook-order comments into prerequisite constraints on the actual plan", async () => {
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
    expect(result.knowledgePoints.map((point) => point.id)).toEqual(["first", "second", "third"]);
    expect(result.knowledgeScopePlan?.teachingOrder?.adjustments).toEqual([]);
    expect(modelCall).toHaveBeenCalledOnce();
  });

  it.each(["main", "alternative"])("keeps the same teacher-goal plan when %s is primary and textbooks explain topics in opposite orders", async (primaryRevisionId) => {
    const evidence: CourseEvidenceSnapshot = {
      ...orderedTextbookEvidence,
      selections: ["main", "alternative"].map((revisionId) => ({ revisionId, primary: revisionId === primaryRevisionId, sectionIds: [] })),
      items: [...orderedTextbookEvidence.items, ...orderedTextbookEvidence.items.map((item, index) => ({
        ...item, id: `alternative-${index + 1}`, content: `另一教材用不同的情境解释知识${index + 1}`,
        source: { ...item.source, textbookId: "alternative-book", textbookTitle: "另一教材", revisionId: "alternative",
          sourceBlockPosition: (3 - index) * 10 },
      }))],
    };
    const points = [3, 1, 2].map((index) => ({ id: `point-${index}`, name: `知识${index}`,
      description: `依据课程目标解释知识${index}`, evidenceItemIds: [`ev-${index}`, `alternative-${index}`],
      groupId: `planned-group-${index}`, groupName: `计划主题${index}` }));
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify({ authoringContract: "knowledge-v1",
      knowledgePoints: points, knowledgeScopePlan: { rationale: "依据教师目标先比较熟悉情境，再建立概念和检验依据。" },
      knowledgeGraph: { nodes: [], edges: [] } }));
    const original = structuredClone(evidence);
    const result = await generateKnowledgeStructureOnce(input, { textbookEvidence: evidence }, { modelCall });

    expect(result.knowledgePoints.map((point) => point.id)).toEqual(["point-3", "point-1", "point-2"]);
    expect(result.knowledgePoints.map((point) => point.groupId)).toEqual(points.map((point) => point.groupId));
    expect(result.knowledgePoints.map((point) => point.evidenceItemIds)).toEqual(points.map((point) => point.evidenceItemIds));
    expect(result.knowledgeScopePlan?.teachingOrder).toMatchObject({ primaryRevisionId,
      baselineKnowledgePointIds: primaryRevisionId === "main"
        ? ["point-1", "point-2", "point-3"] : ["point-3", "point-2", "point-1"],
      knowledgePointIds: ["point-3", "point-1", "point-2"], adjustments: [] });
    expect(evidence).toEqual(original);
    expect(modelCall).toHaveBeenCalledOnce();
  });

  it("keeps a coherent authored path and group identities without any textbook", async () => {
    const points = [3, 1, 2].map((index) => ({ id: `point-${index}`, name: `知识${index}`,
      description: `解释知识${index}`, groupId: `planned-${index}`, groupName: `计划主题${index}` }));
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify({ authoringContract: "knowledge-v1",
      knowledgePoints: points, knowledgeGraph: { nodes: [], edges: [] } }));
    const result = await generateKnowledgeStructureOnce(input, {}, { modelCall });
    expect(result.knowledgePoints.map((point) => point.id)).toEqual(points.map((point) => point.id));
    expect(result.knowledgePoints.map((point) => [point.groupId, point.groupName]))
      .toEqual(points.map((point) => [point.groupId, point.groupName]));
    expect(result.knowledgeGraph?.nodes.filter((node) => node.instructionalRole === "lesson").map((node) => node.id))
      .toEqual(points.map((point) => point.id));
    expect(modelCall).toHaveBeenCalledOnce();
  });

  it.each(["required-prerequisite", "supports", "application", "transfer"])("keeps a declared required %s dependency before its application with and without textbooks", async (type) => {
    for (const textbookEvidence of [undefined, orderedTextbookEvidence]) {
      const modelCall = vi.fn().mockResolvedValue(JSON.stringify({
        knowledgePoints: [
          { id: "application", name: "应用判断", description: "用已建立的概念作判断", evidenceItemIds: ["ev-1"], groupId: "application" },
          { id: "foundation", name: "操作对象", description: "先认识判断对象", evidenceItemIds: ["ev-3"], groupId: "foundation" },
        ], knowledgeGraph: { nodes: [], edges: [{ source: "foundation", target: "application",
          type, strength: "required", label: "构成必要基础", rationale: "没有认识操作对象就无法判断应用条件。" }] },
      }));
      const result = await generateKnowledgeStructureOnce(input, { textbookEvidence }, { modelCall });
      expect(result.knowledgePoints.map((point) => point.id)).toEqual(["foundation", "application"]);
      expect(modelCall).toHaveBeenCalledOnce();
    }
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
    expect(new Set(result.knowledgePoints.map((point) => point.groupId))).toEqual(new Set(["section-unplanned"]));
    expect(result.knowledgePoints.every((point) => point.groupName === "本课核心知识")).toBe(true);
  });

  it("keeps source identity and every authored graph node without a scope correction", async () => {
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify({ ...candidate, knowledgeGraph: { ...candidate.knowledgeGraph, nodes: [...candidate.knowledgeGraph.nodes, { id: "group", label: "语言理解", instructionalRole: "lesson" }] } }));
    const result = await generateKnowledgeStructureOnce(input, { teacherKnowledgePoints: [{ id: "stable-leaf", name: "自然语言处理基本任务", description: "原文说明", groupId: "group", groupName: "语言理解" }] }, { modelCall });
    expect(result.knowledgePoints).toHaveLength(2);
    expect(result.knowledgePoints[0]).toMatchObject({ id: "stable-leaf", groupId: "group", groupName: "语言理解" });
    expect(result.knowledgeGraph?.nodes.find((node) => node.id === "group"))
      .toMatchObject({ label: "语言理解", instructionalRole: "lesson" });
    expect(result.knowledgeGraph?.nodes.find((node) => node.id === "stable-leaf")?.groupName).toBe("语言理解");
  });

  it("keeps source identities while using the model's coherent teaching group", async () => {
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify({
      ...candidate,
      knowledgePoints: candidate.knowledgePoints.map((point) => ({
        ...point, groupId: "constructivism", groupName: "建构主义",
      })),
    }));
    const result = await generateKnowledgeStructureOnce(input, {
      teacherKnowledgePoints: candidate.knowledgePoints.map((point, index) => ({
        id: point.id, name: point.name, description: point.description,
        groupId: `source-${index + 1}`, groupName: `来源目录${index + 1}`,
      })),
    }, { modelCall });
    expect(result.knowledgePoints.map((point) => point.sourceKnowledgePointIds)).toEqual([["kp-nlp"], ["kp-project"]]);
    expect(result.knowledgePoints.map((point) => point.groupId)).toEqual(["constructivism", "constructivism"]);
    expect(result.knowledgePoints.map((point) => point.groupName)).toEqual(["建构主义", "建构主义"]);
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

  it("does not turn a shared textbook parent mapping into reciprocal prerequisites", async () => {
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify({
      knowledgePoints: [
        { id: "target-a", name: "概念的第一种机制", sourceKnowledgePointIds: ["source-parent", "source-a"], evidenceItemIds: ["ev-1"] },
        { id: "target-b", name: "概念的第二种机制", sourceKnowledgePointIds: ["source-parent", "source-b"],
          parentKnowledgePointIds: ["target-a"], evidenceItemIds: ["ev-2"] },
      ],
      knowledgeGraph: { nodes: [], edges: [] },
    }));
    const result = await generateKnowledgeStructureOnce(input, {
      textbookEvidence: orderedTextbookEvidence,
      teacherKnowledgePoints: [
        { id: "source-parent", name: "上位概念", description: "有独立教学含义的上位概念", teachingRole: "core-concept" },
        { id: "source-a", name: "第一种机制", description: "第一种机制", parentKnowledgePointId: "source-parent" },
        { id: "source-b", name: "第二种机制", description: "第二种机制", parentKnowledgePointId: "source-parent" },
      ],
    }, { modelCall });

    expect(result.knowledgePoints.map((point) => point.id)).toEqual(["target-a", "target-b"]);
    expect(result.knowledgePoints[0]?.parentKnowledgePointIds).toBeUndefined();
    expect(result.knowledgePoints[1]?.parentKnowledgePointIds).toEqual(["target-a"]);
    expect(result.knowledgePoints.every((point) => point.sourceKnowledgePointIds?.includes("source-parent"))).toBe(true);
    expect(modelCall).toHaveBeenCalledOnce();
  });

  it("does not treat a reorganized source parent as a prerequisite of its own foundations", async () => {
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify({
      knowledgePoints: [
        { id: "target-a", name: "理论的含义", sourceKnowledgePointIds: ["source-a"], evidenceItemIds: ["ev-1"] },
        { id: "target-b", name: "模式的含义", sourceKnowledgePointIds: ["source-b"], evidenceItemIds: ["ev-2"] },
        { id: "target-c", name: "理论与模式的辨析", sourceKnowledgePointIds: ["source-parent"], evidenceItemIds: ["ev-3"] },
      ],
      knowledgeGraph: { nodes: [], edges: [
        { source: "target-a", target: "target-b", type: "supports", strength: "required" },
        { source: "target-b", target: "target-c", type: "supports", strength: "required" },
      ] },
    }));
    const result = await generateKnowledgeStructureOnce(input, {
      textbookEvidence: orderedTextbookEvidence,
      teacherKnowledgePoints: [
        { id: "source-parent", name: "教学概念体系", description: "理论与模式的关系", teachingRole: "core-concept" },
        { id: "source-a", name: "教学理论", description: "理论的含义", parentKnowledgePointId: "source-parent" },
        { id: "source-b", name: "教学模式", description: "模式的含义", parentKnowledgePointId: "source-parent" },
      ],
    }, { modelCall });

    expect(result.knowledgePoints.map((point) => point.id)).toEqual(["target-a", "target-b", "target-c"]);
    expect(result.knowledgePoints.every((point) => !point.parentKnowledgePointIds?.length)).toBe(true);
    expect(result.knowledgeGraph!.edges.map((edge) => [edge.source, edge.target]))
      .toEqual([["target-a", "target-b"], ["target-b", "target-c"]]);
    expect(modelCall).toHaveBeenCalledOnce();
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

  it("preserves a necessary parent cycle and the complete authored path for final review", async () => {
    const cyclic = {
      knowledgePoints: [
        { id: "a", name: "概念 A", description: "A", parentKnowledgePointIds: ["b"] },
        { id: "b", name: "概念 B", description: "B", parentKnowledgePointIds: ["a"] },
      ],
      knowledgeGraph: { nodes: [], edges: [] },
    };
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify(cyclic));

    const onRejected = vi.fn();
    const result = await generateKnowledgeStructureOnce(input, {}, {
      modelCall,
      retrySleep: async () => undefined,
      onRejected,
    });
    expect(result.knowledgePoints.map((point) => [point.id, point.parentKnowledgePointIds]))
      .toEqual([["a", ["b"]], ["b", ["a"]]]);
    expect(result.knowledgeGraph?.nodes.map((node) => node.id)).toEqual(["a", "b"]);
    expect(onRejected).not.toHaveBeenCalled();
    expect(modelCall).toHaveBeenCalledTimes(1);
  });

  it("keeps every edge of a required prerequisite cycle without deleting content or regenerating", async () => {
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

    const onCandidate = vi.fn();
    const result = await generateKnowledgeStructureOnce(input, {}, {
      modelCall,
      retrySleep: async () => undefined,
      onCandidate,
    });
    expect(result.knowledgeGraph?.nodes.map((node) => node.id)).toEqual(["lesson", "prereq-a", "prereq-b"]);
    expect(result.knowledgeGraph?.edges).toEqual(cyclic.knowledgeGraph.edges.map((edge) => ({
      ...edge, label: "关系待核对", rationale: "关系依据未提供，请教师核对，不能由节点顺序推断必要性。",
    })));
    expect(onCandidate).toHaveBeenCalledWith({ rawResponse: JSON.stringify(cyclic), attempt: 1 });
    expect(modelCall).toHaveBeenCalledTimes(1);
  });

  it("retains the original path and group identities when necessary group dependencies conflict", async () => {
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

    const result = await generateKnowledgeStructureOnce(input, {}, {
      modelCall,
      retrySleep: async () => undefined,
    });
    expect(result.knowledgePoints.map((point) => [point.id, point.groupId, point.parentKnowledgePointIds]))
      .toEqual(cyclicGroups.knowledgePoints.map((point) => [point.id, point.groupId, point.parentKnowledgePointIds]));
    expect(modelCall).toHaveBeenCalledOnce();
  });

  it('preserves every authored relationship including cycles, self relations, reverse levels and distinct claims on one pair', async () => {
    const knowledgePoints = [
      { id: 'application', name: '实际应用', description: '应用正文保持原样。', level: 'application', groupId: 'a' },
      { id: 'foundation', name: '基础概念', description: '基础正文保持原样。', level: 'foundation', groupId: 'b' },
    ];
    const edges = [
      { id: 'application-foundation', source: 'application', target: 'foundation', type: 'application', strength: 'required', label: '原稿的逆层级应用关系' },
      { id: 'foundation-application', source: 'foundation', target: 'application', type: 'supports', strength: 'required', label: '原稿的必要支撑关系' },
      { id: 'self', source: 'application', target: 'application', type: 'supports', strength: 'required', label: '原稿自关系' },
      { id: 'parallel-contrast', source: 'application', target: 'foundation', type: 'contrast', strength: 'helpful', label: '同端点另一种辨析关系' },
      { id: 'reverse-prerequisite', source: 'foundation', target: 'prerequisite', type: 'required-prerequisite', strength: 'required', label: '原稿反向先修关系' },
      { id: 'prerequisite-application', source: 'prerequisite', target: 'application', type: 'required-prerequisite', strength: 'required', label: '原稿先修关系' },
      { id: 'extra-transfer', source: 'application', target: 'foundation', type: 'transfer', strength: 'helpful', label: '额外迁移关系' },
    ];
    const rawResponse = JSON.stringify({ authoringContract: 'knowledge-v1', knowledgePoints,
      knowledgeGraph: { nodes: [{ id: 'prerequisite', label: '既有基础', instructionalRole: 'prerequisite' }], edges } });
    const aiCall = vi.fn().mockResolvedValue(rawResponse);
    const onCandidate = vi.fn();
    const onRejected = vi.fn();
    const result = await generateKnowledgeStructureOnce(input, {}, { aiCall, onCandidate, onRejected });

    expect(result.knowledgePoints.map((point) => [point.id, point.name, point.description, point.groupId]))
      .toEqual(knowledgePoints.map((point) => [point.id, point.name, point.description, point.groupId]));
    expect(result.knowledgeGraph?.edges.map(({ rationale, ...edge }) => {
      expect(rationale).toContain('关系依据未提供');
      return edge;
    })).toEqual(edges);
    expect(result.knowledgeGraph?.semanticReview).toBeUndefined();
    expect(aiCall).toHaveBeenCalledOnce();
    expect(onCandidate).toHaveBeenCalledWith({ rawResponse, attempt: 1 });
    expect(onRejected).not.toHaveBeenCalled();
  });

  it('keeps distinct authored nodes with identical names and does not auto-fill an omitted teacher target', async () => {
    const rawResponse = JSON.stringify({ authoringContract: 'knowledge-v1', knowledgePoints: [
      { id: 'first-context', name: '模型解释', description: '第一种情境中的完整解释。', sourceKnowledgePointIds: [] },
      { id: 'second-context', name: '模型解释', description: '第二种情境中的完整解释。', sourceKnowledgePointIds: [] },
    ], knowledgeGraph: { nodes: [], edges: [] } });
    const aiCall = vi.fn().mockResolvedValue(rawResponse);
    const result = await generateKnowledgeStructureOnce(input, { teacherRequiredKnowledgePoints: ['教师指定目标'],
      teacherKnowledgePoints: [{ id: 'required-source', name: '教师指定目标', description: '明确教学责任' }] }, { aiCall });
    expect(result.knowledgePoints.map((point) => [point.id, point.name, point.description])).toEqual([
      ['first-context', '模型解释', '第一种情境中的完整解释。'],
      ['second-context', '模型解释', '第二种情境中的完整解释。'],
    ]);
    expect(result.knowledgeGraph?.nodes.map((node) => node.id)).toEqual(['first-context', 'second-context']);
    expect(result.knowledgeScopePlan?.decisions[0]).toMatchObject({ disposition: 'deferred', targetKnowledgePointIds: [] });
    expect(aiCall).toHaveBeenCalledOnce();
  });

  it("keeps actual authored composite targets and source references without replacing them with generated leaf placeholders", async () => {
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

    expect(result.knowledgePoints).toHaveLength(4);
    expect(result.knowledgePoints.map((point) => point.id)).toEqual(
      compiledPoints.map((point) => point.id),
    );
    expect(result.knowledgePoints.map((point) => point.name)).toEqual(
      compiledPoints.map((point) => point.name),
    );
    expect(result.knowledgePoints.every((point) => point.sourceKnowledgePointIds?.length === 5)).toBe(true);
    expect(result.knowledgePoints.map((point) => point.keyInfo)).toEqual(
      compiledPoints.map((point) => point.keyInfo),
    );
    expect(result.knowledgePoints.flatMap((point) => point.sourceKnowledgePointIds ?? []))
      .toEqual(teacherKnowledgePoints.map((point) => point.id));
    expect(result.knowledgeScopePlan).toMatchObject({
      policyVersion: KNOWLEDGE_STRUCTURE_POLICY_VERSION,
      planningDurationMin: 30,
      assessmentReserveMin: 4,
      explanationAndActivityMin: 26,
      sourcePointCount: 20,
      targetPointCount: 4,
    });
    expect(result.knowledgeScopePlan?.decisions).toHaveLength(20);
    expect(result.knowledgeScopePlan?.decisions.every((decision) => (
      decision.disposition === "mapped"
      && compiledPoints.some((point) => point.id === decision.targetKnowledgePointId)
    ))).toBe(true);
    expect(result.knowledgeScopePlan?.rationale).toContain("30分钟只独立建立四个核心目标");
    expect(modelCall).toHaveBeenCalledOnce();
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
  it("preserves an unmapped first draft without inventing a source target or blocking generation", async () => {
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
    expect(result.knowledgePoints.map((point) => point.id)).toEqual(["textbook-target"]);
    expect(result.knowledgePoints[0]!.sourceKnowledgePointIds).toBeUndefined();
    expect(result.knowledgeScopePlan?.decisions[0]).toMatchObject({ disposition: "deferred", targetKnowledgePointIds: [] });
    expect(result.knowledgeScopePlan?.decisions[0]!.targetKnowledgePointId).toBeUndefined();
    expect(modelCall).toHaveBeenCalledTimes(1);
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

    expect(aiCall).toHaveBeenCalledTimes(1);
  });

  it("keeps relationship types and labels even when their content merits final teacher review", async () => {
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
    expect(result.knowledgeGraph?.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target,
      label: edge.label, type: edge.type }))).toEqual(malformed.knowledgeGraph.edges);
  });

  it("rejects empty authored knowledge rather than turning objectives into a successful placeholder", async () => {
    const rawResponse = JSON.stringify({ knowledgePoints: [], knowledgeGraph: { nodes: [], edges: [] } });
    const modelCall = vi.fn().mockResolvedValue(rawResponse);
    const onRejected = vi.fn();
    await expect(generateKnowledgeStructureOnce(input, {}, { modelCall, onRejected })).rejects.toThrow("缺少模型实际生成的知识点");
    expect(modelCall).toHaveBeenCalledOnce();
    expect(onRejected).toHaveBeenCalledWith(expect.objectContaining({ rawResponse }));
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
