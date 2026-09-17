import { describe, expect, it, vi } from "vitest";
import {
  generateTeachingBlueprint,
  teachingBlueprintInputFingerprint,
  teachingBlueprintToOutlines,
  validateTeachingBlueprintBudget,
  type TeachingBlueprintInput,
} from "./teaching-blueprint";
import { deriveKnowledgeLectureSectionsFromOutlines } from "@/lib/knowledge-lecture";

function input(assessmentMode: TeachingBlueprintInput["assessmentMode"] = "adaptive"): TeachingBlueprintInput {
  return {
    courseTitle: "可靠的分类器",
    subject: "信息科技",
    grade: "高中一年级",
    learningObjectives: ["解释训练集与测试集为什么必须分开"],
    projectContext: "为校园植物设计分类器",
    knowledgePoints: [
      { id: "kp-train", name: "训练集", description: "用于学习规律", level: "foundation" },
      { id: "kp-test", name: "测试集", description: "用于独立检验", level: "core" },
      { id: "kp-split", name: "数据划分", description: "保持用途分离", level: "application" },
      { id: "kp-leak", name: "数据泄漏", description: "测试信息进入训练过程", level: "core" },
    ],
    knowledgeGraph: {
      nodes: [],
      edges: [{ id: "e1", source: "kp-train", target: "kp-test", label: "先修", type: "required-prerequisite" }],
    },
    totalDurationSec: 1_800,
    assessmentMode,
    generationMode: "standard",
    sourceContext: "训练集用于学习模型参数。测试集只用于独立检验。",
  };
}

function modelBlueprint() {
  return {
    sections: [
      {
        title: "为什么必须分开数据",
        learningObjective: "解释训练与独立测试的不同职责",
        knowledgePointIds: ["kp-train", "kp-test"],
        units: [
          {
            id: "roles",
            title: "训练与测试的职责",
            knowledgePointIds: ["kp-train", "kp-test"],
            learningOutcome: "能根据数据是否参与参数学习判断其角色",
            explanation: "训练数据参与模型参数学习，测试数据在学习结束后提供独立表现证据，两者回答的问题不同。",
            mechanism: "如果测试数据影响训练，评估就不再独立，所得分数会混入已经见过答案的优势。",
            workedExample: "先用带标签的校园植物照片训练，再用从未参与调参的新照片测试，并逐步比较两个集合在流程中的位置与作用。",
            conditions: ["测试数据在最终评估前不能参与选模型或调参数"],
            misconceptions: ["把测试集理解为更难的训练题；关键差异是是否参与学习，而不是难度"],
            sourceKind: "course-source",
            evidenceQuotes: ["训练集用于学习模型参数。"],
          },
        ],
        pages: [
          {
            id: "roles-page",
            title: "同一批数据不能同时教与考",
            type: "slide",
            unitIds: ["roles"],
            knowledgePointIds: ["kp-train", "kp-test"],
            description: "从两个集合回答的不同问题建立独立评估的必要性。",
            keyPoints: ["训练集参与参数学习", "测试集在学习结束后使用", "独立性决定评估可信度", "难度不是两者的定义差异"],
            teachingObjective: "说明训练集与测试集职责不同的原因",
          },
        ],
        assessmentFocus: ["识别训练数据和独立测试数据"],
      },
      {
        title: "怎样划分并避免泄漏",
        learningObjective: "应用数据划分规则并识别泄漏",
        knowledgePointIds: ["kp-split", "kp-leak"],
        units: [
          {
            id: "split",
            title: "划分与泄漏",
            knowledgePointIds: ["kp-split", "kp-leak"],
            learningOutcome: "能判断一个流程是否让测试信息进入训练",
            explanation: "数据划分要先确定每份数据的用途，再保证同一对象的高度相似记录不会跨集合泄漏信息。",
            mechanism: "重复对象或测试标签进入训练会让模型记住局部线索，测试分数因此高估对新对象的泛化能力。",
            workedExample: "把同一株植物的连拍照片放入不同集合会造成近重复泄漏；按植物个体分组后再划分，可以逐步阻断这条信息通道。",
            conditions: ["划分单位应与最终需要泛化的新对象一致"],
            misconceptions: ["只要随机划分就一定安全；随机记录划分仍可能拆散同一对象的近重复样本"],
            sourceKind: "general-knowledge",
            evidenceQuotes: [],
          },
        ],
        pages: [
          {
            id: "split-page",
            title: "从随机划分到按对象划分",
            type: "slide",
            unitIds: ["split"],
            knowledgePointIds: ["kp-split", "kp-leak"],
            description: "沿用校园植物案例演示近重复泄漏及修正步骤。",
            keyPoints: ["先确定泛化对象", "识别近重复记录", "按对象整体分组", "最后一次使用测试集"],
            teachingObjective: "判断并修正数据泄漏",
          },
        ],
        assessmentFocus: ["判断划分方案是否造成泄漏", "说明修正原则"],
      },
    ],
  };
}

function compactModelBlueprint() {
  return {
    sections: [{
      title: "训练、测试与可靠评估",
      learningObjective: "解释数据分工并识别会高估效果的泄漏",
      knowledgePointIds: ["kp-train", "kp-test", "kp-split", "kp-leak"],
      units: [{
        id: "reliable-evaluation",
        title: "从数据分工到可靠评估",
        knowledgePointIds: ["kp-train", "kp-test", "kp-split", "kp-leak"],
        learningOutcome: "能判断一个数据划分和评估流程是否可靠",
        explanation: "训练集提供模型学习规律所需的信息，测试集在训练结束后独立检查这些规律能否用于新对象，划分规则必须服务于这种独立性。",
        mechanism: "一旦测试对象或其近重复记录参与训练，模型就可能利用已经见过的线索，使测试分数不再代表面对新对象的能力。",
        workedExample: "校园植物分类中，先按植物个体分组，再把不同个体分入训练集与测试集；若把同一株植物的连拍照片拆到两边，就会形成近重复泄漏。",
        conditions: ["测试集不得用于选模型或调参数"],
        misconceptions: ["随机按照片划分并不必然安全，因为同一对象的近重复照片可能跨集合"],
        sourceKind: "general-knowledge",
        evidenceQuotes: [],
      }],
      pages: [{
        id: "reliable-page",
        title: "为什么测试必须保持独立",
        type: "slide",
        unitIds: ["reliable-evaluation"],
        knowledgePointIds: ["kp-train", "kp-test", "kp-split", "kp-leak"],
        description: "用同一株植物连拍照片的案例串联数据分工、划分规则与泄漏后果。",
        keyPoints: ["训练集用于学习", "测试集用于独立检验", "按最终泛化对象划分", "近重复记录可能造成泄漏"],
        teachingObjective: "解释独立测试与可靠评估的因果关系",
      }],
      assessmentFocus: ["判断一个具体流程是否发生数据泄漏"],
    }],
  };
}

describe("teaching blueprint compiler", () => {
  it("allocates a 30-minute lesson to 68% substantive teaching and at most 20% assessment", async () => {
    const ai = vi.fn(async () => JSON.stringify(modelBlueprint()));
    const blueprint = await generateTeachingBlueprint(input(), ai);
    const outlines = teachingBlueprintToOutlines(blueprint, "使用简体中文");

    expect(blueprint.budget).toMatchObject({
      totalDurationSec: 1_800,
      teachingDurationSec: 1_224,
      assessmentDurationSec: 360,
      learnerActivityDurationSec: 216,
    });
    expect(outlines.reduce((sum, outline) => sum + (outline.targetDurationSec ?? 0), 0)).toBe(1_800);
    expect(outlines.filter((outline) => outline.type !== "quiz").reduce(
      (sum, outline) => sum + (outline.plannedTiming?.narrationSec ?? 0),
      0,
    )).toBe(1_224);
    expect(validateTeachingBlueprintBudget(blueprint, outlines)).toEqual([]);
    expect(outlines.filter((outline) => outline.type !== "quiz").flatMap((outline) => outline.teachingUnitIds ?? [])).toEqual([
      "teaching-section-1-unit-1",
      "teaching-section-2-unit-1",
    ]);
    const quizzes = outlines.filter((outline) => outline.type === "quiz");
    expect(quizzes).toHaveLength(2);
    expect(quizzes.map((quiz) => quiz.quizConfig?.questionCount)).toEqual([2, 2]);
    expect(quizzes.reduce((sum, quiz) => sum + (quiz.quizConfig?.maxShortAnswerQuestions ?? 0), 0)).toBeLessThanOrEqual(1);
    expect(deriveKnowledgeLectureSectionsFromOutlines(outlines)).toHaveLength(2);
    expect(quizzes.every((quiz) => quiz.assessmentUnitIds?.length === 1 && quiz.assessmentUnitMap?.length === 1)).toBe(true);
    expect(quizzes.every((quiz) => quiz.quizConfig?.coveragePolicy === "each-target")).toBe(true);
    expect(quizzes.flatMap((quiz) => quiz.assessmentTargets ?? []).map((target) =>
      `${target.unitId}/${target.knowledgePointId}`,
    )).toEqual([
      "teaching-section-1-unit-1/kp-train",
      "teaching-section-1-unit-1/kp-test",
      "teaching-section-2-unit-1/kp-split",
      "teaching-section-2-unit-1/kp-leak",
    ]);
  });

  it("uses one or two short answers only when deep-response mode is enabled", async () => {
    const blueprint = await generateTeachingBlueprint(input("constructed-response"), async () => JSON.stringify(modelBlueprint()));
    const quizzes = teachingBlueprintToOutlines(blueprint, "使用简体中文").filter((outline) => outline.type === "quiz");
    expect(quizzes.every((quiz) => quiz.quizConfig?.questionTypes.join(",") === "short_answer")).toBe(true);
    expect(quizzes.every((quiz) => (quiz.quizConfig?.questionCount ?? 0) >= 1 && (quiz.quizConfig?.questionCount ?? 0) <= 2)).toBe(true);
  });

  it("creates separate adaptive checks when one knowledge point is taught through multiple units", async () => {
    const candidate = modelBlueprint();
    candidate.sections[0]!.units.push({
      ...candidate.sections[0]!.units[0]!,
      id: "roles-boundary",
      title: "数据角色的使用边界",
      knowledgePointIds: ["kp-test"],
      learningOutcome: "能判断测试集在流程中是否被提前使用",
      explanation: "测试集只在模型和参数确定后承担最终检查职责，提前查看结果并据此修改方案就会破坏独立性。",
      mechanism: "测试结果一旦反向影响模型选择，评估信息就进入了开发过程。",
      workedExample: "比较一次最终测试与反复查看测试分数后调参的两个流程，逐步判断第二个流程为何高估效果。",
      conditions: ["最终测试前必须冻结模型和参数"],
      misconceptions: ["没有直接复制测试标签就不算使用测试信息"],
      sourceKind: "general-knowledge",
      evidenceQuotes: [],
    });
    candidate.sections[0]!.pages.push({
      ...candidate.sections[0]!.pages[0]!,
      id: "roles-boundary-page",
      title: "什么时候测试不再独立",
      unitIds: ["roles-boundary"],
      knowledgePointIds: ["kp-test"],
      description: "通过反复查看测试分数的反例解释评估信息如何泄漏。",
      keyPoints: ["先冻结模型", "只做最终测试", "测试反馈不能用于调参", "反复查看会形成间接泄漏"],
      teachingObjective: "识别测试信息被提前使用的流程",
    });

    const blueprint = await generateTeachingBlueprint(input(), async () => JSON.stringify(candidate));
    const quiz = teachingBlueprintToOutlines(blueprint, "使用简体中文")
      .find((outline) => outline.id === "teaching-section-1-check");

    expect(quiz?.quizConfig?.questionCount).toBe(3);
    expect(quiz?.assessmentTargets?.filter((target) => target.knowledgePointId === "kp-test")).toHaveLength(2);
    expect(validateTeachingBlueprintBudget(blueprint, teachingBlueprintToOutlines(blueprint, "使用简体中文"))).toEqual([]);
  });

  it("reports a concrete conflict instead of dropping adaptive coverage when the quiz budget is too small", async () => {
    const overloaded = compactModelBlueprint();
    overloaded.sections[0]!.units.push({
      ...overloaded.sections[0]!.units[0]!,
      id: "second-unit",
      title: "独立评估的边界辨析",
      learningOutcome: "能逐项辨析评估流程中的信息泄漏",
      explanation: "独立评估要求测试信息不能参与模型选择、规则修改或参数调整，否则分数会偏离模型面对真正新数据时的表现。",
      mechanism: "每次依据测试结果修改方案，都会把测试信息间接编码进最终模型，使测试集合逐渐失去独立性。",
      workedExample: "对比一次性评估与每轮查看测试分数后调参的流程，逐步标出信息从测试环节回流到训练环节的位置。",
      conditions: ["模型和参数必须在最终测试前冻结"],
      misconceptions: ["只要不复制测试标签，就可以反复看测试分数"],
    });
    overloaded.sections[0]!.pages.push({
      ...overloaded.sections[0]!.pages[0]!,
      id: "second-page",
      title: "测试信息怎样回流",
      unitIds: ["second-unit"],
      description: "用流程对比辨析间接使用测试信息的风险。",
      keyPoints: ["冻结方案", "一次性测试", "反馈回流", "结果高估"],
      teachingObjective: "识别测试信息回流",
    });
    const shortInput = { ...input(), totalDurationSec: 300 };
    const ai = vi.fn(async () => JSON.stringify(overloaded));

    await expect(generateTeachingBlueprint(shortInput, ai)).rejects.toThrow("小测预算冲突");
    expect(ai).toHaveBeenCalledTimes(3);
  });

  it("repairs an invalid shallow blueprint before accepting it", async () => {
    const ai = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ sections: [] }))
      .mockResolvedValueOnce(JSON.stringify(modelBlueprint()));
    const blueprint = await generateTeachingBlueprint(input(), ai);
    expect(blueprint.sections).toHaveLength(2);
    expect(ai).toHaveBeenCalledTimes(2);
    expect(ai.mock.calls[1]?.[1]).toContain("没有返回 sections");
  });

  it("downgrades an incomplete optional interaction to a slide in standard mode", async () => {
    const candidate = modelBlueprint();
    candidate.sections[0]!.pages[0]!.type = "interactive";
    const ai = vi.fn(async () => JSON.stringify(candidate));

    const blueprint = await generateTeachingBlueprint(input(), ai);

    expect(blueprint.sections[0]!.pages[0]!.type).toBe("slide");
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it("invalidates blueprint caches when assessment mode, time, or model-owned source input changes", () => {
    const base = input();
    const fingerprint = teachingBlueprintInputFingerprint(base);
    expect(teachingBlueprintInputFingerprint({ ...base, assessmentMode: "constructed-response" })).not.toBe(fingerprint);
    expect(teachingBlueprintInputFingerprint({ ...base, totalDurationSec: 1_740 })).not.toBe(fingerprint);
    expect(teachingBlueprintInputFingerprint({ ...base, sourceContext: `${base.sourceContext}\n新增材料` })).not.toBe(fingerprint);
    expect(teachingBlueprintInputFingerprint({ ...base, generationModelFingerprint: "another:model" })).not.toBe(fingerprint);
  });

  it.each(["adaptive", "constructed-response"] as const)("keeps a five-minute deep-interaction lesson budget exact in %s mode", async (assessmentMode) => {
    const shortInput = {
      ...input(assessmentMode),
      totalDurationSec: 300,
      generationMode: "deep-interaction" as const,
    };
    const blueprint = await generateTeachingBlueprint(shortInput, async () => JSON.stringify(compactModelBlueprint()));
    const outlines = teachingBlueprintToOutlines(blueprint, "使用简体中文");
    expect(outlines.reduce((sum, outline) => sum + (outline.targetDurationSec ?? 0), 0)).toBe(300);
    expect(blueprint.budget).toMatchObject({ teachingDurationSec: 204, assessmentDurationSec: 60, learnerActivityDurationSec: 36 });
    expect(validateTeachingBlueprintBudget(blueprint, outlines)).toEqual([]);
    if (assessmentMode === "adaptive") {
      expect(outlines.find((outline) => outline.type === "quiz")?.quizConfig?.questionCount).toBe(4);
    }
  });

  it("rejects arbitrary knowledge and unit mappings introduced after blueprint approval", async () => {
    const blueprint = await generateTeachingBlueprint(input(), async () => JSON.stringify(modelBlueprint()));
    const outlines = teachingBlueprintToOutlines(blueprint, "使用简体中文");
    const corrupted = outlines.map((outline, index) => index === 0
      ? { ...outline, knowledgePointIds: ["kp-leak"], teachingUnitIds: ["invented-unit"] }
      : outline);
    expect(validateTeachingBlueprintBudget(blueprint, corrupted).join("；")).toContain("映射与蓝图不一致");
  });
});
