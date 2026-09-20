import { describe, expect, it, vi } from "vitest";
import {
  applyReviewedOutlinesToTeachingBlueprint,
  generateTeachingBlueprint,
  buildTeachingBlueprintPrompt,
  teachingBlueprintInputFingerprint,
  teachingBlueprintToOutlines,
  validateTeachingBlueprintBudget,
  type TeachingBlueprintInput,
} from "./teaching-blueprint";
import { deriveKnowledgeLectureSectionsFromOutlines } from "@/lib/knowledge-lecture";
import { deriveTeachingConstraints } from "@/lib/openmaic/pedagogy/teaching-constraints";

it("uses confirmed class readiness in planning and invalidates cached plans when it changes", () => {
  const base = input();
  const teachingConstraints = deriveTeachingConstraints({
    grade: base.grade, subject: base.subject, topic: base.courseTitle, hours: 1,
    learnerProfile: { priorKnowledge: "会分类，还没接触训练集", learningNeeds: "需要图例支架", familiarContexts: "校园植物" },
    learningObjectives: [...base.learningObjectives], knowledgePoints: [...base.knowledgePoints],
  });
  const enriched = {
    ...base,
    teachingConstraints,
    sectionPlans: [
      { title: "数据角色", knowledgePointIds: ["kp-train", "kp-test"], maxPages: 2 },
      { title: "可靠划分", knowledgePointIds: ["kp-split", "kp-leak"], maxPages: 2 },
    ],
  };
  const prompt = buildTeachingBlueprintPrompt(enriched);
  expect(prompt.user).toContain("会分类，还没接触训练集");
  expect(prompt.user).toContain("需要图例支架");
  expect(prompt.user).toContain("校园植物");
  expect(prompt.system).toContain("同一材料再次出现时");
  expect(prompt.system).toContain("不得复写讲授案例里已经公布的题目和答案");
  expect(prompt.system).toContain("不得要求学生靠圈出某几个词");
  expect(prompt.system).toContain("Replacement, deletion, scope-of-effect");
  expect(prompt.user).toContain('"sharedContext"');
  expect(prompt.user).toContain('"learningTask"');
  expect(prompt.user).toContain("必须严格按以下 2 个小节及其顺序生成");
  expect(prompt.user).toContain('"maxPages":2');
  expect(prompt.system).toContain("可直接制作资源的小节内容设计");
  expect(prompt.system).toContain("禁止只写");
  expect(prompt.user).toContain('"understandingCriteria"');
  expect(prompt.user).not.toContain("4-6个完整");
  expect(prompt.user).not.toContain("至少三个实质要点");
  expect(teachingBlueprintInputFingerprint(enriched)).not.toBe(teachingBlueprintInputFingerprint(base));
  expect(teachingBlueprintInputFingerprint({ ...enriched, teachingConstraints: { ...teachingConstraints, learnerFoundation: "已能独立划分数据集" } })).not.toBe(teachingBlueprintInputFingerprint(enriched));
});

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
        sharedContext: {
          learningPurpose: "帮助学生判断一次分类器评估是否真正检验了新数据。",
          caseId: "campus-plant-classifier",
          caseFacts: ["同一批校园植物照片被分别用于训练和测试。"],
          fixedWording: ["同一批数据不能同时教与考"],
          stableTerms: ["训练集", "测试集", "独立检验"],
          conceptBoundaries: ["数据较难不是测试集的定义。"],
        },
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
            learningTask: {
              learnerAction: "比较两组照片分别在训练和评估中的用途。",
              newContribution: "从用途差异理解独立评估。",
              reasoningFocus: "数据是否参与过参数学习。",
              caseUse: "introduce",
              changedConditions: [] as string[],
              preservedConditions: [] as string[],
            },
          },
        ],
        assessmentFocus: ["识别训练数据和独立测试数据"],
        understandingCriteria: {
          goals: ["解释训练与测试各自回答的问题", "依据新材料判断数据角色"],
          answerEssentials: ["指出是否参与参数学习", "说明独立性为何影响可信度"],
          misconceptions: ["把难度当成训练集与测试集的定义差异"],
          supportingUnitIds: ["roles"],
        },
      },
      {
        title: "怎样划分并避免泄漏",
        learningObjective: "应用数据划分规则并识别泄漏",
        knowledgePointIds: ["kp-split", "kp-leak"],
        sharedContext: {
          learningPurpose: "帮助学生修正会让评估结果虚高的数据划分。",
          caseId: "plant-photo-split",
          caseFacts: ["同一株植物有多张连拍照片。"],
          fixedWording: ["按植物个体分组后再划分"],
          stableTerms: ["近重复记录", "数据泄漏"],
          conceptBoundaries: ["随机划分不必然阻止同一对象跨集合。"],
        },
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
            learningTask: {
              learnerAction: "比较随机按照片划分与按植物个体划分。",
              newContribution: "识别近重复记录造成的泄漏。",
              reasoningFocus: "同一对象的信息是否跨越集合。",
              caseUse: "variant",
              changedConditions: ["划分单位从照片改为植物个体"],
              preservedConditions: ["照片内容和分类目标不变"],
            },
          },
        ],
        assessmentFocus: ["判断划分方案是否造成泄漏", "说明修正原则"],
        understandingCriteria: {
          goals: ["依据新流程判断是否泄漏", "说明划分单位为什么要对应泛化对象"],
          answerEssentials: ["识别信息是否跨集合", "说明分数高估的原因"],
          misconceptions: ["认为随机划分必然安全"],
          supportingUnitIds: ["split"],
        },
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
      sharedContext: {
        learningPurpose: "判断校园植物分类器的评估结果是否可信。",
        caseId: "reliable-plant-evaluation",
        caseFacts: ["同一株植物的连拍照片可能被分到训练集和测试集。"],
        fixedWording: ["先按植物个体分组，再划分训练集与测试集"],
        stableTerms: ["训练集", "测试集", "近重复泄漏"],
        conceptBoundaries: ["随机按照片划分不必然安全。"],
      },
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
        learningTask: {
          learnerAction: "判断两种数据划分是否保持独立评估。",
          newContribution: "把数据用途与泄漏风险连起来。",
          reasoningFocus: "测试信息是否进入训练。",
          caseUse: "introduce",
          changedConditions: [] as string[],
          preservedConditions: [] as string[],
        },
      }],
      assessmentFocus: ["判断一个具体流程是否发生数据泄漏"],
      understandingCriteria: {
        goals: ["解释数据分工", "迁移判断一个新流程"],
        answerEssentials: ["指出测试信息是否进入训练", "说明对评估可信度的影响"],
        misconceptions: ["只背训练与测试名称而不说明独立性"],
        supportingUnitIds: ["reliable-evaluation"],
      },
    }],
  };
}

describe("teaching blueprint compiler", () => {
  it("allocates a 30-minute lesson from actual explanation, activity, and short-check needs", async () => {
    const ai = vi.fn(async () => JSON.stringify(modelBlueprint()));
    const blueprint = await generateTeachingBlueprint(input(), ai);
    const outlines = teachingBlueprintToOutlines(blueprint, "使用简体中文");

    expect(blueprint.budget).toMatchObject({
      totalDurationSec: 1_800,
      teachingDurationSec: 1_554,
      assessmentDurationSec: 216,
      learnerActivityDurationSec: 30,
    });
    expect(outlines.reduce((sum, outline) => sum + (outline.targetDurationSec ?? 0), 0)).toBe(1_800);
    expect(outlines.filter((outline) => outline.type !== "quiz").reduce(
      (sum, outline) => sum + (outline.plannedTiming?.narrationSec ?? 0),
      0,
    )).toBe(1_554);
    expect(validateTeachingBlueprintBudget(blueprint, outlines)).toEqual([]);
    expect(outlines.filter((outline) => outline.type !== "quiz").flatMap((outline) => outline.teachingUnitIds ?? [])).toEqual([
      "teaching-section-1-unit-1",
      "teaching-section-2-unit-1",
    ]);
    expect(outlines[0]?.teachingBrief?.sharedContext?.caseId).toBe("campus-plant-classifier");
    expect(outlines[0]?.teachingBrief?.pageTask?.newContribution).toContain("用途差异");
    expect(outlines.find((item) => item.type === "quiz")?.teachingBrief?.sharedContext?.fixedWording)
      .toEqual(["同一批数据不能同时教与考"]);
    const quizzes = outlines.filter((outline) => outline.type === "quiz");
    expect(quizzes[0]?.description).toContain("预定理解标准");
    expect(quizzes).toHaveLength(2);
    expect(quizzes.map((quiz) => quiz.quizConfig?.questionCount)).toEqual([1, 1]);
    expect(quizzes.every((quiz) => quiz.quizConfig?.minShortAnswerQuestions === 1)).toBe(true);
    expect(quizzes.every((quiz) => quiz.quizConfig?.maxShortAnswerQuestions === 1)).toBe(true);
    expect(deriveKnowledgeLectureSectionsFromOutlines(outlines)).toHaveLength(2);
    expect(quizzes.every((quiz) => quiz.assessmentUnitIds?.length === 1 && quiz.assessmentUnitMap?.length === 1)).toBe(true);
    expect(quizzes.every((quiz) => quiz.quizConfig?.coveragePolicy === "section-synthesis")).toBe(true);
    expect(quizzes.flatMap((quiz) => quiz.assessmentTargets ?? []).map((target) =>
      `${target.unitId}/${target.knowledgePointId}`,
    )).toEqual([
      "teaching-section-1-unit-1/kp-train",
      "teaching-section-1-unit-1/kp-test",
      "teaching-section-2-unit-1/kp-split",
      "teaching-section-2-unit-1/kp-leak",
    ]);
  });

  it("accepts one substantive key point and preserves a changed-condition task without padding", async () => {
    const candidate = compactModelBlueprint();
    candidate.sections[0]!.pages[0]!.keyPoints = ["测试信息进入训练会破坏独立评估"];
    candidate.sections[0]!.pages[0]!.learningTask = {
      learnerAction: "比较只改动划分单位前后的评估流程。",
      newContribution: "判断改变划分单位如何阻断泄漏。",
      reasoningFocus: "测试对象是否曾以近重复形式进入训练。",
      caseUse: "variant",
      changedConditions: ["从按照片随机划分改为按植物个体划分"],
      preservedConditions: ["照片总量、分类目标与模型保持不变"],
    };
    const blueprint = await generateTeachingBlueprint(input(), async () => JSON.stringify(candidate));
    const outline = teachingBlueprintToOutlines(blueprint, "使用简体中文")[0]!;
    expect(outline.keyPoints).toEqual(["测试信息进入训练会破坏独立评估"]);
    expect(outline.teachingBrief?.pageTask).toMatchObject({
      caseUse: "variant",
      changedConditions: ["从按照片随机划分改为按植物个体划分"],
      preservedConditions: ["照片总量、分类目标与模型保持不变"],
    });
  });

  it("does not force a learner task onto a pure mechanism-explanation page", async () => {
    const candidate = compactModelBlueprint();
    delete (candidate.sections[0]!.pages[0]! as { learningTask?: unknown }).learningTask;
    candidate.sections[0]!.pages[0]!.description = "解释测试信息进入训练后，评估为何不再独立。";
    const blueprint = await generateTeachingBlueprint(input(), async () => JSON.stringify(candidate));
    const outline = teachingBlueprintToOutlines(blueprint, "使用简体中文")[0]!;
    expect(outline.teachingBrief?.pageTask).toBeUndefined();
    expect(outline.description).toContain("为何不再独立");
  });

  it("does not accept authoring tasks as completed explanatory content", async () => {
    const candidate = compactModelBlueprint();
    const unit = candidate.sections[0]!.units[0]!;
    candidate.sections[0]!.sharedContext.conceptBoundaries = ["注意不要混淆。"];
    unit.explanation = "说明教学模式与具体教案的区别。";
    unit.mechanism = "解释二者之间的联系。";
    unit.workedExample = "用例子说明三者联系。";
    unit.conditions = ["列出适用条件。"];
    unit.misconceptions = ["澄清常见误区。"];
    const ai = vi.fn(async () => JSON.stringify(candidate));

    await expect(generateTeachingBlueprint(input(), ai, { retrySleep: async () => undefined }))
      .rejects.toThrow("教学蓝图缺少可用结构");
    expect(ai).toHaveBeenCalledTimes(3);
  });

  it("applies bounded outline edits back to the design before recompiling resources", async () => {
    const blueprint = await generateTeachingBlueprint(input(), async () => JSON.stringify(compactModelBlueprint()));
    const outlines = teachingBlueprintToOutlines(blueprint, "使用简体中文");
    const first = outlines.find((outline) => outline.type === "slide")!;
    const reviewed = outlines.map((outline) => outline.id === first.id ? {
      ...outline,
      title: "教师修订后的解释页",
      description: "先说明数据是否参与学习，再解释这为什么影响评估可信度。",
      keyPoints: ["参与参数学习的数据用于训练", "未参与学习的新数据承担独立检验"],
      teachingBrief: {
        ...outline.teachingBrief!,
        teachingPlan: {
          ...outline.teachingBrief!.teachingPlan!,
          newContent: "训练数据参与模型学习；测试数据不参与学习，并在模型确定后检查它面对新对象的表现。",
          reasoningSteps: ["测试信息若反向影响模型选择，评估就不再独立。"],
          visibleContent: ["训练数据参与学习", "测试数据用于独立检验"],
          narrationFocus: ["解释是否参与学习为何决定评估独立性"],
        },
      },
    } : outline);

    const updated = applyReviewedOutlinesToTeachingBlueprint(blueprint, reviewed);
    const recompiled = teachingBlueprintToOutlines(updated, "使用简体中文");
    expect(updated.sections[0]?.units[0]?.explanation).toContain("测试数据不参与学习");
    expect(recompiled.find((outline) => outline.id === first.id)).toMatchObject({
      title: "教师修订后的解释页",
      description: "先说明数据是否参与学习，再解释这为什么影响评估可信度。",
      keyPoints: ["参与参数学习的数据用于训练", "未参与学习的新数据承担独立检验"],
    });
    expect(() => applyReviewedOutlinesToTeachingBlueprint(blueprint, reviewed.slice(1)))
      .toThrow("新增、删除或重复页面必须先回到内容设计");
  });

  it("uses one or two short answers only when deep-response mode is enabled", async () => {
    const blueprint = await generateTeachingBlueprint(input("constructed-response"), async () => JSON.stringify(modelBlueprint()));
    const quizzes = teachingBlueprintToOutlines(blueprint, "使用简体中文").filter((outline) => outline.type === "quiz");
    expect(quizzes.every((quiz) => quiz.quizConfig?.questionTypes.join(",") === "short_answer")).toBe(true);
    expect(quizzes.every((quiz) => (quiz.quizConfig?.questionCount ?? 0) >= 1 && (quiz.quizConfig?.questionCount ?? 0) <= 2)).toBe(true);
  });

  it("keeps a parseable first draft without semantic review or regeneration", async () => {
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

    const ai = vi.fn(async () => JSON.stringify(candidate));
    const blueprint = await generateTeachingBlueprint(input(), ai);
    const quiz = teachingBlueprintToOutlines(blueprint, "使用简体中文")
      .find((outline) => outline.id === "teaching-section-1-check");
    expect(quiz?.assessmentTargets?.filter((target) => target.knowledgePointId === "kp-test")).toHaveLength(2);
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it("does not regenerate a parseable draft because its semantic scope exceeds a quality preference", async () => {
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

    await expect(generateTeachingBlueprint(shortInput, ai)).resolves.toMatchObject({ schemaVersion: 2 });
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it("retries only when completed output has no usable structure", async () => {
    const ai = vi.fn(async () => JSON.stringify({ sections: [] }));
    const onValidation = vi.fn();
    await expect(generateTeachingBlueprint(input(), ai, {
      onValidation,
      retrySleep: async () => undefined,
    })).rejects.toThrow("教学蓝图缺少可用结构");
    expect(ai).toHaveBeenCalledTimes(3);
    expect(onValidation).toHaveBeenLastCalledWith({
      issues: ["没有返回 sections"],
      responseCharacters: expect.any(Number),
    });
  });

  it("accepts the next complete result after a hard-output retry", async () => {
    const ai = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ sections: [] }))
      .mockResolvedValueOnce(JSON.stringify(modelBlueprint()));
    await expect(generateTeachingBlueprint(input(), ai, {
      retrySleep: async () => undefined,
    })).resolves.toMatchObject({ schemaVersion: 2 });
    expect(ai).toHaveBeenCalledTimes(2);
  });

  it("derives declarative mappings locally and keeps only whitespace-normalized source quotes", async () => {
    const candidate = modelBlueprint();
    candidate.sections[0]!.knowledgePointIds = ["kp-leak"];
    candidate.sections[0]!.pages[0]!.knowledgePointIds = ["kp-leak"];
    candidate.sections[0]!.units[0]!.evidenceQuotes = ["训练集用于学习 模型参数。"];
    const ai = vi.fn(async () => JSON.stringify(candidate));
    const blueprint = await generateTeachingBlueprint({
      ...input(),
      sourceContext: "训练集用于学习\n模型参数。测试集只用于独立检验。",
    }, ai);
    expect(blueprint.sections[0]?.knowledgePointIds).toEqual(["kp-train", "kp-test"]);
    expect(blueprint.sections[0]?.pages[0]?.knowledgePointIds).toEqual(["kp-train", "kp-test"]);
    expect(blueprint.sections[0]?.units[0]?.sourceKind).toBe("course-source");
    expect(blueprint.sections[0]?.units[0]?.evidenceQuotes).toEqual(["训练集用于学习 模型参数。"]);
    expect(ai).toHaveBeenCalledTimes(1);
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
    expect(blueprint.budget).toMatchObject({ teachingDurationSec: 240, assessmentDurationSec: 45, learnerActivityDurationSec: 15 });
    expect(validateTeachingBlueprintBudget(blueprint, outlines)).toEqual([]);
    if (assessmentMode === "adaptive") {
      expect(outlines.find((outline) => outline.type === "quiz")?.quizConfig?.questionCount).toBe(1);
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
