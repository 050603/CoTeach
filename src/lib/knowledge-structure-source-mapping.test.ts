import { describe, expect, it, vi } from "vitest";
import {
  generateKnowledgeStructureOnce,
  type KnowledgeStructureGenerationContext,
} from "@/lib/knowledge-structure-generation";
import type { GenerateInput } from "@/lib/llm/types";
import type { CourseEvidenceSnapshot } from "@/lib/textbook/course-evidence-types";

const input: GenerateInput = {
  name: "具身认知教学",
  subject: "信息技术",
  grade: "大学",
  hours: 1,
  summary: "理解身体和环境参与认知的机制。",
  drivingQuestion: "身体经验如何参与知识理解？",
  learningObjectives: ["解释具身认知的核心主张"],
  stages: [],
};

const evidence: CourseEvidenceSnapshot = {
  schemaVersion: 2,
  version: 1,
  fingerprint: "source-mapping-test",
  createdAt: new Date(0).toISOString(),
  retrievalMode: "hybrid",
  selections: [{ revisionId: "revision", primary: true, sectionIds: [] }],
  mappings: [],
  warnings: [],
  items: ["theory", "body", "environment"].map((name, index) => ({
    id: `evidence-${name}`,
    kind: "concept",
    title: name,
    content: `教材中的${name}概念与解释。`,
    source: {
      textbookId: "book",
      textbookTitle: "教学理论教材",
      revisionId: "revision",
      revisionVersion: 1,
      sectionPath: ["认知理论"],
      sectionPosition: 1,
      sourceBlockPosition: index,
    },
  })),
};

const context: KnowledgeStructureGenerationContext = {
  textbookEvidence: evidence,
  teacherKnowledgePoints: [
    {
      id: "source-theory",
      name: "具身认知",
      description: "认知与身体的感知、运动及环境互动相关。",
      teachingRole: "core-concept",
      groupId: "cognition",
      groupName: "认知理论",
    },
    {
      id: "source-body",
      name: "身体参与",
      description: "身体经验参与概念形成，不能把动作本身等同于理解。",
      teachingRole: "detail-concept",
      parentKnowledgePointId: "source-theory",
      groupId: "cognition",
      groupName: "认知理论",
    },
    {
      id: "source-environment",
      name: "环境互动",
      description: "认知活动受到环境条件影响。",
      teachingRole: "detail-concept",
      parentKnowledgePointId: "source-theory",
      groupId: "cognition",
      groupName: "认知理论",
    },
  ],
};

type Draft = {
  knowledgePoints: Array<Record<string, unknown>>;
  knowledgeGraph: {
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
  };
  knowledgeScopePlan: {
    rationale: string;
    decisions: Array<Record<string, unknown>>;
  };
};

function draft(): Draft {
  return {
    knowledgePoints: [
      {
        id: "target-theory",
        name: "理论的核心主张",
        description: "认知与身体和环境有关，不能把它简化为多做动作。",
        keyInfo: "身体与环境共同参与认知。",
        masteryBoundary: "能解释具身认知与单纯动作训练的差别。",
        evidenceItemIds: ["evidence-theory"],
        teachingDepth: "detailed",
      },
      {
        id: "target-body",
        name: "身体经验的作用",
        description: "用手势表示旋转帮助理解空间关系；动作需要与解释相结合。",
        keyInfo: "手势案例展示身体经验与概念理解的联系。",
        masteryBoundary: "能用手势案例解释身体经验的作用及适用条件。",
        evidenceItemIds: ["evidence-body"],
        parentKnowledgePointIds: ["target-theory"],
        teachingDepth: "detailed",
      },
      {
        id: "target-environment",
        name: "环境交互的作用",
        description: "比较不同任务环境中的认知活动，说明环境条件的作用。",
        evidenceItemIds: ["evidence-environment"],
        parentKnowledgePointIds: ["target-theory"],
        teachingDepth: "brief",
      },
    ],
    knowledgeGraph: {
      nodes: ["target-theory", "target-body", "target-environment"].map((id) => ({
        id,
        instructionalRole: "lesson",
      })),
      edges: [{
        id: "core-to-body",
        source: "target-theory",
        target: "target-body",
        type: "supports",
        strength: "required",
        label: "先建立理论主张，再解释身体经验的机制",
        rationale: "下位机制以核心理论为解释前提。",
      }],
    },
    knowledgeScopePlan: {
      rationale: "按理论与两个下位机制组织教材，同时保留全部资源包责任。",
      decisions: ["theory", "body", "environment"].map((name) => ({
        sourceKnowledgePointId: `source-${name}`,
        disposition: "mapped",
        targetKnowledgePointId: `target-${name}`,
        targetKnowledgePointIds: [`target-${name}`],
        rationale: `教材对应的${name}责任由该目标解释。`,
      })),
    },
  };
}

async function generate(value: Draft, generationContext = context) {
  const modelCall = vi.fn().mockResolvedValue(JSON.stringify(value));
  const result = await generateKnowledgeStructureOnce(input, generationContext, {
    modelCall,
    retrySleep: async () => {},
  });
  return { result, modelCall };
}

describe("explicit textbook source mappings", () => {
  it("adopts scope-only mappings on the first draft without changing cases or ownership", async () => {
    const value = draft();
    const { result, modelCall } = await generate(value);

    expect(modelCall).toHaveBeenCalledOnce();
    expect(result.revisionCount).toBe(0);
    expect(result.knowledgePoints.map((point) => point.sourceKnowledgePointIds)).toEqual([
      ["source-theory"], ["source-body"], ["source-environment"],
    ]);
    expect(result.knowledgePoints.map((point) => point.teachingRole)).toEqual([
      "core-concept", "detail-concept", "detail-concept",
    ]);
    expect(result.knowledgePoints.map((point) => point.description))
      .toEqual(value.knowledgePoints.map((point) => point.description));
    expect(result.knowledgePoints[1]).toMatchObject({
      keyInfo: value.knowledgePoints[1]!.keyInfo,
      masteryBoundary: value.knowledgePoints[1]!.masteryBoundary,
      parentKnowledgePointIds: ["target-theory"],
      evidenceItemIds: ["evidence-body"],
      groupId: "cognition",
      groupName: "认知理论",
      teachingDepth: "detailed",
    });
    expect(result.knowledgeGraph!.edges).toEqual(value.knowledgeGraph.edges);
    expect(result.knowledgeScopePlan?.decisions.map((decision) => decision.targetKnowledgePointIds))
      .toEqual([["target-theory"], ["target-body"], ["target-environment"]]);
  });

  it("compiles many-to-many mappings without turning shared source parents into dependencies", async () => {
    const value = draft();
    value.knowledgePoints = value.knowledgePoints.slice(1);
    value.knowledgePoints.forEach((point) => { delete point.parentKnowledgePointIds; });
    value.knowledgeGraph = { nodes: [], edges: [] };
    value.knowledgeScopePlan.decisions[0] = {
      sourceKnowledgePointId: "source-theory",
      disposition: "mapped",
      targetKnowledgePointIds: ["target-body", "target-environment"],
      rationale: "核心理论分别在身体机制和环境机制中解释。",
    };
    const { result, modelCall } = await generate(value);

    expect(modelCall).toHaveBeenCalledOnce();
    expect(result.knowledgePoints.map((point) => point.sourceKnowledgePointIds)).toEqual([
      ["source-theory", "source-body"], ["source-theory", "source-environment"],
    ]);
    expect(result.knowledgePoints.every((point) => point.teachingRole === "core-concept")).toBe(true);
    expect(result.knowledgePoints.every((point) => !point.parentKnowledgePointIds?.length)).toBe(true);
    expect(result.knowledgeScopePlan?.decisions[0]).toMatchObject({
      sourceKnowledgePointId: "source-theory",
      targetKnowledgePointIds: ["target-body", "target-environment"],
    });
  });

  it("preserves canonical source IDs and remaps only the explicit model-ID parents and edges", async () => {
    const value = draft();
    value.knowledgePoints[0]!.name = "具身认知";
    value.knowledgePoints[1]!.name = "身体参与";
    const { result, modelCall } = await generate(value);

    expect(modelCall).toHaveBeenCalledOnce();
    expect(result.knowledgePoints.map((point) => point.id))
      .toEqual(["source-theory", "source-body", "target-environment"]);
    expect(result.knowledgePoints[1]!.parentKnowledgePointIds).toEqual(["source-theory"]);
    expect(result.knowledgePoints[2]!.parentKnowledgePointIds).toEqual(["source-theory"]);
    expect(result.knowledgeGraph!.edges).toEqual([{
      ...value.knowledgeGraph.edges[0], source: "source-theory", target: "source-body",
    }]);
    expect(result.knowledgeScopePlan?.decisions[0]!.targetKnowledgePointIds).toEqual(["source-theory"]);
    expect(result.knowledgePoints[1]!.description).toBe(value.knowledgePoints[1]!.description);
  });

  it("accepts consistent point and scope mappings while preserving rationale-only legacy decisions", async () => {
    const value = draft();
    value.knowledgePoints.forEach((point, index) => {
      point.sourceKnowledgePointIds = [context.teacherKnowledgePoints![index]!.id];
    });
    value.knowledgeScopePlan.decisions[2] = {
      sourceKnowledgePointId: "source-environment", rationale: "原缓存仅保存了映射理由。",
    };
    const { result, modelCall } = await generate(value);

    expect(modelCall).toHaveBeenCalledOnce();
    expect(result.knowledgePoints).toHaveLength(3);
    expect(result.knowledgeScopePlan?.decisions[2]).toMatchObject({
      disposition: "mapped",
      targetKnowledgePointIds: ["target-environment"],
      rationale: "原缓存仅保存了映射理由。",
    });
  });

  it("does not add a same-name source over an explicit mapping to a different source", async () => {
    const value = draft();
    value.knowledgePoints[0]!.name = "身体参与";
    value.knowledgePoints[0]!.sourceKnowledgePointIds = ["source-theory"];
    const { result } = await generate(value);

    expect(result.knowledgePoints[0]).toMatchObject({
      id: "target-theory", sourceKnowledgePointIds: ["source-theory"], teachingRole: "core-concept",
    });
    expect(result.knowledgePoints[1]!.sourceKnowledgePointIds).toEqual(["source-body"]);
  });

  const invalidMappings: Array<{
    name: string;
    change: (value: Draft) => void;
    issue: string;
  }> = [
    {
      name: "unknown scope source",
      change: (value) => { value.knowledgeScopePlan.decisions[0]!.sourceKnowledgePointId = "unknown-source"; },
      issue: "未知来源 unknown-source",
    },
    {
      name: "unknown point source",
      change: (value) => { value.knowledgePoints[0]!.sourceKnowledgePointIds = ["unknown-source"]; },
      issue: "未知来源 unknown-source",
    },
    {
      name: "unknown target",
      change: (value) => {
        value.knowledgeScopePlan.decisions[0]!.targetKnowledgePointId = "unknown-target";
        value.knowledgeScopePlan.decisions[0]!.targetKnowledgePointIds = ["unknown-target"];
      },
      issue: "未知的课程目标 unknown-target",
    },
    {
      name: "duplicate scope source",
      change: (value) => { value.knowledgeScopePlan.decisions.push({ ...value.knowledgeScopePlan.decisions[0] }); },
      issue: "重复给出决策",
    },
    {
      name: "duplicate scope target",
      change: (value) => { value.knowledgeScopePlan.decisions[0]!.targetKnowledgePointIds = ["target-theory", "target-theory"]; },
      issue: "目标 包含重复 ID",
    },
    {
      name: "duplicate point source",
      change: (value) => { value.knowledgePoints[0]!.sourceKnowledgePointIds = ["source-theory", "source-theory"]; },
      issue: "来源 包含重复 ID",
    },
    {
      name: "ambiguous duplicate model target ID",
      change: (value) => { value.knowledgePoints[1]!.id = "target-theory"; },
      issue: "身份重复的课程目标 target-theory",
    },
    {
      name: "primary target outside the target array",
      change: (value) => { value.knowledgeScopePlan.decisions[0]!.targetKnowledgePointId = "target-body"; },
      issue: "主要目标 target-body 不在其目标列表中",
    },
    {
      name: "explicit empty point source contradicts scope adoption",
      change: (value) => { value.knowledgePoints[0]!.sourceKnowledgePointIds = []; },
      issue: "该目标显式来源不包含它",
    },
    {
      name: "point adoption contradicts the declared scope target",
      change: (value) => { value.knowledgePoints[0]!.sourceKnowledgePointIds = ["source-body"]; },
      issue: "与 knowledgeScopePlan 目标冲突",
    },
    {
      name: "scope adoption adds a source excluded by the explicit point list",
      change: (value) => {
        value.knowledgePoints[0]!.sourceKnowledgePointIds = ["source-theory"];
        value.knowledgeScopePlan.decisions[1]!.targetKnowledgePointId = "target-theory";
        value.knowledgeScopePlan.decisions[1]!.targetKnowledgePointIds = ["target-theory"];
      },
      issue: "该目标显式来源不包含它",
    },
    {
      name: "embedded source exclusion",
      change: (value) => { value.knowledgeScopePlan.decisions[0]!.disposition = "embedded"; },
      issue: "embedded 决策不能替代必授映射",
    },
    {
      name: "deferred source exclusion",
      change: (value) => { value.knowledgeScopePlan.decisions[0]!.disposition = "deferred"; },
      issue: "deferred 决策不能替代必授映射",
    },
    {
      name: "mapped source without a target",
      change: (value) => {
        delete value.knowledgeScopePlan.decisions[0]!.targetKnowledgePointId;
        value.knowledgeScopePlan.decisions[0]!.targetKnowledgePointIds = [];
      },
      issue: "缺少实际课程目标",
    },
    {
      name: "source omitted from both mapping directions",
      change: (value) => { value.knowledgeScopePlan.decisions.splice(0, 1); },
      issue: "教材化知识结构缺少上游要求映射",
    },
  ];

  it.each(invalidMappings)("rejects $name without inventing or dropping source responsibilities", async ({ change, issue }) => {
    const value = draft();
    change(value);
    const modelCall = vi.fn().mockResolvedValue(JSON.stringify(value));

    await expect(generateKnowledgeStructureOnce(input, context, {
      modelCall, retrySleep: async () => {},
    })).rejects.toThrow(issue);
    expect(modelCall).toHaveBeenCalledTimes(1);
  });
});

it("derives both the reverse source mapping and lesson graph nodes from one authoritative authored mapping", async () => {
  const legacy = draft();
  const value = { ...legacy, authoringContract: "knowledge-v1", knowledgeScopePlan: { rationale: legacy.knowledgeScopePlan.rationale },
    knowledgePoints: legacy.knowledgePoints.map((point, index) => ({ ...point,
      sourceKnowledgePointIds: [context.teacherKnowledgePoints![index]!.id],
    })), knowledgeGraph: { nodes: [], edges: [] } };
  const aiCall = vi.fn().mockResolvedValue(JSON.stringify(value));
  const result = await generateKnowledgeStructureOnce(input, context, { aiCall });
  expect(aiCall).toHaveBeenCalledOnce();
  expect(result.knowledgeScopePlan?.decisions.map((decision) => decision.targetKnowledgePointIds)).toEqual([
    ["target-theory"], ["target-body"], ["target-environment"],
  ]);
  expect(result.knowledgeGraph?.nodes.filter((node) => node.instructionalRole === "lesson").map((node) => node.id))
    .toEqual(result.knowledgePoints.map((point) => point.id));
  expect(result.knowledgePoints[1]?.description).toBe(legacy.knowledgePoints[1]?.description);
});

it("does not recover missing modern source mappings from names or the legacy reverse field", async () => {
  const legacy = draft();
  const aiCall = vi.fn().mockResolvedValue(JSON.stringify({ ...legacy, authoringContract: "knowledge-v1" }));
  await expect(generateKnowledgeStructureOnce(input, context, { aiCall })).rejects.toThrow("缺少显式 sourceKnowledgePointIds");
  expect(aiCall).toHaveBeenCalledOnce();
});
