import { describe, expect, it, vi } from "vitest";
import {
  applyReviewedOutlinesToTeachingBlueprint,
  adaptTeachingBlueprintResourceCapabilities,
  buildTeachingBlueprintRepairPrompt,
  generateTeachingBlueprint,
  buildTeachingBlueprintPrompt,
  TEACHING_BLUEPRINT_COMPILED_BRIEF_VERSION,
  teachingBlueprintInputFingerprint,
  teachingBlueprintToOutlines,
  validateTeachingBlueprintBudget,
  type TeachingBlueprintInput,
} from "./teaching-blueprint";
import { deriveKnowledgeLectureSectionsFromOutlines } from "@/lib/knowledge-lecture";
import { deriveTeachingConstraints } from "@/lib/openmaic/pedagogy/teaching-constraints";
import { hasCurrentTeachingBrief } from "@/lib/openmaic/generation/teaching-enhancement";

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
  expect(prompt.system).toContain("概念辨析、因果机制、数学推导、操作技能、历史材料和综合应用");
  expect(prompt.system).toContain("introducesNodeIds、deepensNodeIds、referencesNodeIds");
  expect(prompt.system).toContain("不得把后页才出现的术语、案例、问题或任务伪装成上一页已经讲过");
  expect(prompt.system).toContain("entryPoint 写出实际开场对象");
  expect(prompt.system).toContain("即使前一教学阶段已经由教师导入，也不能省略这一资源内入口");
  expect(prompt.system).toContain("导入是否独立成页由总时长、知识难度和视觉价值动态决定");
  expect(prompt.system).toContain("正式致谢和告别");
  expect(prompt.system).toContain("案例首先按解释力、学习者熟悉度和学段适切性选择");
  expect(prompt.system).toContain("项目情境只规定用途和约束，不能自动变成知识目标或每页案例");
  expect(prompt.system).toContain("最终任务、驱动问题和成果物只是一种可选的迁移情境");
  expect(prompt.system).toContain("每页必须填写 taskConnection");
  expect(prompt.system).toContain("不能用教案、报告、PPT 等成果物中的几句话");
  expect(prompt.system).toContain("具体场景中的人物、物体、空间状态或可见差异本身是推理依据时");
  expect(prompt.system).toContain("构造案例、类比和示意数据");
  expect(prompt.system).toContain("教材案例采用双通道设计");
  expect(prompt.system).toContain("学生内容字段中直接写成连贯案例");
  expect(prompt.system).toContain("不出现‘教材原例’‘教学改编’‘AI 补充’");
  expect(prompt.system).toContain("preferredForm 是教学表达偏好");
  expect(prompt.system).toContain("没有每节必须使用几种形式的配额");
  expect(prompt.system).toContain("具有完整、可比较数值并需要看趋势");
  expect(prompt.system).toContain("不得考未讲内容");
  expect(prompt.system).toContain("条目数量不等于最终题数");
  expect(prompt.system).toContain("不要在其中指定选择、判断、填空等题型");
  expect(prompt.system).toContain("Constructed examples or data must not be given a fabricated institution");
  expect(prompt.system).toContain("未启用图片或视频时不得请求对应种类");
  expect(prompt.user).toContain('"sharedContext"');
  expect(prompt.user).toContain('"learningTask"');
  expect(prompt.user).toContain('"taskConnection"');
  expect(prompt.user).toContain("可选最终任务情境");
  expect(prompt.user).toContain("必须严格按以下 2 个小节及其顺序生成");
  expect(prompt.user).toContain("下限用于避免单页过载，必须满足");
  expect(prompt.user).not.toContain('"maxPages"');
  expect(prompt.system).toContain("可直接制作资源的小节内容设计");
  expect(prompt.system).toContain("禁止只写");
  expect(prompt.user).toContain('"understandingCriteria"');
  expect(prompt.system).toContain("概念名称 + 完整基本含义");
  expect(prompt.system).toContain("不得为了让页面简洁而把核心概念只留在讲稿");
  expect(prompt.system).toContain("一个知识点可以跨多页");
  expect(prompt.system).toContain("知识点、讲授单元和 PPT 页面不是一一对应关系");
  expect(prompt.system).toContain("每个 explanationNode 用 knowledgePointIds 声明");
  expect(prompt.user).toContain("机器结构验收合同");
  expect(prompt.user).toContain('"knowledgePointIds":["该节点实际解释的本单元知识点ID"]');
  expect(prompt.system).toContain("知识结论+完整案例+练习");
  expect(prompt.user).toContain("输入时间无法承载必需解释");
  expect(prompt.user).toContain("完整课程开场、必要解释、推理、例子、操作、短测和正式收束估时");
  expect(prompt.system).not.toContain("relative stability");
  expect(prompt.system).not.toContain("concretization");
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
            explanationNodes: [{
              id: "roles-concept",
              kind: "concept",
              content: "训练数据参与模型参数学习，测试数据在学习结束后提供独立表现证据，两者回答的问题不同。",
              knowledgePointIds: ["kp-train", "kp-test"],
              prerequisiteNodeIds: [],
              provenance: "course-source",
            }],
          },
        ],
        pages: [
          {
            id: "roles-page",
            title: "同一批数据不能同时教与考",
            type: "slide",
            unitIds: ["roles"],
            introducesNodeIds: ["roles-concept"],
            deepensNodeIds: [] as string[],
            referencesNodeIds: [] as string[],
            knowledgePointIds: ["kp-train", "kp-test"],
            description: "从两个集合回答的不同问题建立独立评估的必要性。",
            keyPoints: ["训练集参与参数学习", "测试集在学习结束后使用", "独立性决定评估可信度", "难度不是两者的定义差异"],
            teachingObjective: "说明训练集与测试集职责不同的原因",
            taskConnection: {
              mode: "helpful-context",
              rationale: "校园植物分类器与数据分工共享同一对象，且不需要额外解释项目流程。",
            },
            visualRelationship: {
              kind: "comparison",
              description: "沿相同维度比较训练集与测试集在流程中的位置和用途。",
              readingOrder: ["训练集", "测试集", "独立性结论"],
              preferredForm: "table",
              rationale: "共同维度逐项对齐比两个独立卡片更便于比较。",
            },
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
            explanationNodes: [{
              id: "split-concept",
              kind: "concept",
              content: "数据划分要先确定每份数据的用途，再保证同一对象的高度相似记录不会跨集合泄漏信息。",
              knowledgePointIds: ["kp-split", "kp-leak"],
              prerequisiteNodeIds: [],
              provenance: "general-knowledge",
            }],
          },
        ],
        pages: [
          {
            id: "split-page",
            title: "从随机划分到按对象划分",
            type: "slide",
            unitIds: ["split"],
            introducesNodeIds: ["split-concept"],
            deepensNodeIds: [] as string[],
            referencesNodeIds: [] as string[],
            knowledgePointIds: ["kp-split", "kp-leak"],
            description: "沿用校园植物案例演示近重复泄漏及修正步骤。",
            keyPoints: ["先确定泛化对象", "识别近重复记录", "按对象整体分组", "最后一次使用测试集"],
            teachingObjective: "判断并修正数据泄漏",
            taskConnection: {
              mode: "direct-application",
              rationale: "本页目标就是把划分原则应用到分类器的数据准备。",
            },
            visualRelationship: {
              kind: "process",
              description: "按识别对象、整体分组、划分集合和最终测试的顺序呈现修正过程。",
              readingOrder: ["识别泛化对象", "按对象分组", "划分集合", "最终测试"],
              preferredForm: "diagram",
              rationale: "连续步骤图能直接显示信息泄漏在哪一步被阻断。",
            },
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
        explanationNodes: [{
          id: "reliable-evaluation-concept",
          kind: "concept",
          content: "训练集提供模型学习规律所需的信息，测试集在训练结束后独立检查这些规律能否用于新对象，划分规则必须服务于这种独立性。",
          knowledgePointIds: ["kp-train", "kp-test", "kp-split", "kp-leak"],
          prerequisiteNodeIds: [],
          provenance: "general-knowledge",
        }],
      }],
      pages: [{
        id: "reliable-page",
        title: "为什么测试必须保持独立",
        type: "slide",
        unitIds: ["reliable-evaluation"],
        introducesNodeIds: ["reliable-evaluation-concept"],
        deepensNodeIds: [] as string[],
        referencesNodeIds: [] as string[],
        knowledgePointIds: ["kp-train", "kp-test", "kp-split", "kp-leak"],
        description: "用同一株植物连拍照片的案例串联数据分工、划分规则与泄漏后果。",
        keyPoints: ["训练集用于学习", "测试集用于独立检验", "按最终泛化对象划分", "近重复记录可能造成泄漏"],
        teachingObjective: "解释独立测试与可靠评估的因果关系",
        taskConnection: {
          mode: "none",
          rationale: "本页先建立通用评估机制，独立案例比提前展开最终任务更直接。",
        },
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
      teachingDurationSec: 1_440,
      assessmentDurationSec: 216,
      learnerActivityDurationSec: 144,
    });
    expect(outlines.reduce((sum, outline) => sum + (outline.targetDurationSec ?? 0), 0)).toBe(1_800);
    expect(outlines.filter((outline) => outline.type !== "quiz").reduce(
      (sum, outline) => sum + (outline.plannedTiming?.narrationSec ?? 0),
      0,
    )).toBe(1_440);
    expect(validateTeachingBlueprintBudget(blueprint, outlines)).toEqual([]);
    expect(outlines.every((outline) => outline.narrationMode === "standalone-course")).toBe(true);
    expect(outlines.filter((outline) => outline.type !== "quiz").flatMap((outline) => outline.teachingUnitIds ?? [])).toEqual([
      "teaching-section-1-unit-1",
      "teaching-section-2-unit-1",
    ]);
    expect(outlines[0]?.teachingBrief?.sharedContext?.caseId).toBe("campus-plant-classifier");
    expect(outlines[0]?.teachingBrief?.pageTask?.newContribution).toContain("用途差异");
    expect(outlines[0]?.teachingBrief?.teachingPlan?.taskConnection).toEqual({
      mode: "helpful-context",
      rationale: "校园植物分类器与数据分工共享同一对象，且不需要额外解释项目流程。",
    });
    expect(outlines[0]?.teachingBrief?.teachingPlan?.visualRelationship).toEqual({
      kind: "comparison",
      description: "沿相同维度比较训练集与测试集在流程中的位置和用途。",
      readingOrder: ["训练集", "测试集", "独立性结论"],
      preferredForm: "table",
      rationale: "共同维度逐项对齐比两个独立卡片更便于比较。",
    });
    expect(outlines.find((item) => item.type === "quiz")?.teachingBrief?.sharedContext?.fixedWording)
      .toEqual(["同一批数据不能同时教与考"]);
    const quizzes = outlines.filter((outline) => outline.type === "quiz");
    expect(quizzes[0]?.description).toContain("预定理解标准");
    expect(quizzes).toHaveLength(2);
    expect(quizzes.every((quiz) => (
      (quiz.quizConfig?.questionCount ?? 0) >= 2
      && (quiz.quizConfig?.questionCount ?? 0) <= 4
    ))).toBe(true);
    expect(quizzes.every((quiz) => (
      quiz.quizConfig?.minShortAnswerQuestions === 0
      && quiz.quizConfig?.maxShortAnswerQuestions === 0
      && !quiz.quizConfig?.questionTypes.includes("short_answer")
    ))).toBe(true);
    expect(quizzes.every((quiz) => (
      quiz.keyPoints.length === quiz.quizConfig?.questionCount
      && quiz.quizConfig.questionTypePlan?.length === quiz.quizConfig.questionCount
      && new Set(quiz.quizConfig.questionTypePlan).size === quiz.quizConfig.questionTypes.length
    ))).toBe(true);
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

  it("compiles assessment responsibilities into the timed question count and preserves an explicit fill-blank intent", async () => {
    const candidate = compactModelBlueprint();
    candidate.sections[0]!.assessmentFocus = [
      "判断新流程中的数据角色",
      "辨析错误的数据划分结论",
      "填空补全训练集与测试集的职责",
      "说明数据泄漏如何影响评估可信度",
    ];
    const blueprint = await generateTeachingBlueprint({ ...input(), totalDurationSec: 300 }, async () => JSON.stringify(candidate));
    const quiz = teachingBlueprintToOutlines(blueprint, "使用简体中文").find((outline) => outline.type === "quiz")!;

    expect(quiz.quizConfig?.questionCount).toBe(2);
    expect(quiz.keyPoints).toHaveLength(2);
    expect(quiz.keyPoints[0]).toContain("判断新流程中的数据角色；辨析错误的数据划分结论");
    expect(quiz.keyPoints[1]).toContain("填空补全训练集与测试集的职责；说明数据泄漏如何影响评估可信度");
    expect(quiz.quizConfig?.questionTypePlan).toEqual(["true_false", "fill_blank"]);
    expect(quiz.quizConfig?.questionTypes).toEqual(["true_false", "fill_blank"]);
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

  it("marks compiled blueprint briefs for the existing downstream enhancement call", async () => {
    const blueprint = await generateTeachingBlueprint(input(), async () => JSON.stringify(compactModelBlueprint()));
    const outline = teachingBlueprintToOutlines(blueprint, "使用简体中文")
      .find((item) => item.type === "slide")!;

    expect(outline.teachingBrief?.designVersion).toBe(TEACHING_BLUEPRINT_COMPILED_BRIEF_VERSION);
    expect(hasCurrentTeachingBrief(outline)).toBe(false);
    expect(outline.teachingBrief?.teachingPlan?.newContent).toContain("训练集提供模型学习规律所需的信息");
    expect(outline.teachingBrief?.teachingPlan?.visibleContent).toContain(
      "训练集提供模型学习规律所需的信息，测试集在训练结束后独立检查这些规律能否用于新对象，划分规则必须服务于这种独立性。",
    );
    expect(blueprint.sections[0]?.units[0]?.explanationNodes?.every((node) => (
      node.knowledgePointIds?.length === 4
    ))).toBe(true);
  });

  it("keeps an independent page answer out of the compiled visible projection", async () => {
    const candidate = compactModelBlueprint();
    const page = candidate.sections[0]!.pages[0]!;
    page.keyPoints = [
      "阅读两种划分流程并判断测试信息是否回流",
      "按照片随机划分会让同一植物的近重复信息跨集合",
      "因此第一种流程存在数据泄漏",
    ];
    page.learningTask = {
      learnerAction: "先独立比较两种划分流程。",
      newContribution: "把独立性原理迁移到新的划分材料。",
      reasoningFocus: "测试对象的信息是否曾进入训练。",
      caseUse: "independent",
      changedConditions: ["划分单位从照片改为植物个体"],
      preservedConditions: ["分类目标和照片内容保持不变"],
    };
    const blueprint = await generateTeachingBlueprint(input(), async () => JSON.stringify(candidate));
    const outline = teachingBlueprintToOutlines(blueprint, "使用简体中文")[0]!;

    expect(outline.teachingBrief?.teachingPlan?.visibleContent).toEqual([
      "阅读两种划分流程并判断测试信息是否回流",
      "先独立比较两种划分流程。",
      "划分单位从照片改为植物个体",
      "分类目标和照片内容保持不变",
    ]);
    expect(outline.teachingBrief?.teachingPlan?.visibleContent).not.toContain("因此第一种流程存在数据泄漏");
    expect(outline.teachingBrief?.teachingPlan?.narrationFocus).toContain("因此第一种流程存在数据泄漏");
  });

  it("converts unavailable generated media to a native diagram in the same blueprint pass", async () => {
    const candidate = compactModelBlueprint();
    (candidate.sections[0]!.pages[0]! as unknown as { resourceNeeds: Array<Record<string, unknown>> }).resourceNeeds = [{
      kind: "video",
      purpose: "展示动作和传感器数值的同步变化",
      required: true,
      prompt: "学生把手靠近传感器，数值同步变小",
      durationSec: 12,
    }];
    const blueprint = await generateTeachingBlueprint(
      input(),
      async () => JSON.stringify(candidate),
      { resourceCapabilities: { imageGenerationEnabled: true, videoGenerationEnabled: false } },
    );
    expect(blueprint.sections[0]?.pages[0]?.resourceNeeds).toEqual([{
      kind: "diagram",
      purpose: "展示动作和传感器数值的同步变化",
      required: true,
      prompt: "用可编辑的分步、状态对照或关系示意图表达以下动态过程：学生把手靠近传感器，数值同步变小",
    }]);
    expect(adaptTeachingBlueprintResourceCapabilities(blueprint, {
      imageGenerationEnabled: false,
      videoGenerationEnabled: false,
    })).toEqual(blueprint);
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

  it("rejects knowledge ids that are only attached to a unit without an explanation responsibility", async () => {
    const candidate = compactModelBlueprint();
    Object.assign(candidate.sections[0]!.units[0]!, {
      explanationNodes: [{
        id: "roles-only",
        kind: "concept",
        content: "训练集负责学习规律，测试集负责独立检验。",
        knowledgePointIds: ["kp-train", "kp-test"],
        prerequisiteNodeIds: [],
        provenance: "general-knowledge",
      }],
    });
    const ai = vi.fn(async () => JSON.stringify(candidate));
    const onValidation = vi.fn();

    await expect(generateTeachingBlueprint(input(), ai, {
      onValidation,
      retrySleep: async () => undefined,
    })).rejects.toThrow("教学蓝图缺少可用结构");
    expect(onValidation.mock.calls.at(-1)?.[0].issues.join("；"))
      .toContain("只挂载但未由解释节点承担的知识点：kp-split、kp-leak");
  });

  it("rejects child coverage when the substantive parent concept has no explicit definition", async () => {
    const coreInput = input();
    coreInput.knowledgePoints = coreInput.knowledgePoints.map((point) => point.id === "kp-train"
      ? { ...point, teachingRole: "core-concept" as const }
      : point.id === "kp-test"
        ? { ...point, teachingRole: "detail-concept" as const, parentKnowledgePointIds: ["kp-train"] }
        : point);
    const candidate = compactModelBlueprint();
    candidate.sections[0]!.units[0]!.explanationNodes[0]!.content = "训练数据参与模型学习，独立数据用于检查新对象表现。";
    const ai = vi.fn(async () => JSON.stringify(candidate));
    const onValidation = vi.fn();

    await expect(generateTeachingBlueprint(coreInput, ai, { onValidation, retrySleep: async () => undefined }))
      .rejects.toThrow("教学蓝图缺少可用结构");
    expect(onValidation.mock.calls.at(-1)?.[0].issues.join("；")).toContain("核心概念“训练集”缺少");
    expect(ai).toHaveBeenCalledTimes(3);
  });

  it("puts exact core concepts and prerequisite order into the first-draft acceptance contract", () => {
    const contractInput = input();
    contractInput.knowledgePoints = contractInput.knowledgePoints.map((point) => point.id === "kp-train"
      ? { ...point, teachingRole: "core-concept" as const }
      : point.id === "kp-test"
        ? { ...point, parentKnowledgePointIds: ["kp-train"] }
        : point);

    const prompt = buildTeachingBlueprintPrompt(contractInput);

    expect(prompt.user).toContain('"knowledgePointId":"kp-train","exactName":"训练集"');
    expect(prompt.user).toContain('"parentKnowledgePointId":"kp-train"');
    expect(prompt.user).toContain('"上位知识点必须在下位知识点之前或同页首次讲授"');
  });

  it("feeds deterministic audit findings and the current blueprint into a targeted repair", async () => {
    const repairInput = input();
    repairInput.knowledgePoints = repairInput.knowledgePoints.map((point) => point.id === "kp-train"
      ? { ...point, teachingRole: "core-concept" as const }
      : point);
    const invalid = compactModelBlueprint();
    invalid.sections[0]!.units[0]!.explanationNodes[0]!.content = "训练数据参与模型学习，独立数据用于检查新对象表现。";
    const repaired = structuredClone(invalid);
    repaired.sections[0]!.units[0]!.explanationNodes[0]!.content = "训练集是参与模型参数学习的数据，其核心作用是让模型从已知样本中学习规律。";
    const ai = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(invalid))
      .mockResolvedValueOnce(JSON.stringify(repaired));

    await expect(generateTeachingBlueprint(repairInput, ai, {
      retrySleep: async () => undefined,
    })).resolves.toMatchObject({ schemaVersion: 3 });

    expect(ai).toHaveBeenCalledTimes(2);
    expect(ai.mock.calls[1]?.[0]).toContain("教学蓝图结构修订 Agent");
    expect(ai.mock.calls[1]?.[0]).toContain("而不是重新构思整门课程");
    expect(ai.mock.calls[1]?.[1]).toContain("核心概念“训练集”缺少");
    expect(ai.mock.calls[1]?.[1]).toContain("训练数据参与模型学习");
  });

  it("re-audits a revision and sends only the latest findings to the final repair", async () => {
    const repairInput = input();
    repairInput.knowledgePoints = repairInput.knowledgePoints.map((point) => point.id === "kp-train"
      ? { ...point, teachingRole: "core-concept" as const }
      : point);
    const first = compactModelBlueprint();
    first.sections[0]!.units[0]!.explanationNodes[0]!.content = "训练数据参与模型学习。";
    const second = structuredClone(first);
    second.sections[0]!.units[0]!.explanationNodes[0]!.content = "训练集是用于学习模型参数的数据，核心主张是用已知样本形成可迁移规律。";
    delete (second.sections[0]!.pages[0]! as { taskConnection?: unknown }).taskConnection;
    const third = structuredClone(second);
    third.sections[0]!.pages[0]!.taskConnection = {
      mode: "none",
      rationale: "本页先建立通用数据分工，不引入额外项目背景更清楚。",
    };
    const ai = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(first))
      .mockResolvedValueOnce(JSON.stringify(second))
      .mockResolvedValueOnce(JSON.stringify(third));

    await expect(generateTeachingBlueprint(repairInput, ai, {
      retrySleep: async () => undefined,
    })).resolves.toMatchObject({ schemaVersion: 3 });

    expect(ai).toHaveBeenCalledTimes(3);
    expect(ai.mock.calls[2]?.[1]).toContain("缺少最终任务连接判定");
    expect(ai.mock.calls[2]?.[1]).not.toContain("核心概念“训练集”缺少");
  });

  it("resumes a persisted invalid blueprint directly as a bounded repair", async () => {
    const repairInput = input();
    repairInput.knowledgePoints = repairInput.knowledgePoints.map((point) => point.id === "kp-train"
      ? { ...point, teachingRole: "core-concept" as const }
      : point);
    const invalid = compactModelBlueprint();
    invalid.sections[0]!.units[0]!.explanationNodes[0]!.content = "训练数据参与模型学习。";
    const repaired = structuredClone(invalid);
    repaired.sections[0]!.units[0]!.explanationNodes[0]!.content = "训练集是用于学习模型参数的数据，核心主张是从已知样本中归纳可迁移规律。";
    const issue = "第 1 节核心概念“训练集”缺少 term/concept 解释节点";
    const ai = vi.fn().mockResolvedValue(JSON.stringify(repaired));

    await expect(generateTeachingBlueprint(repairInput, ai, {
      repairFrom: { response: JSON.stringify(invalid), issues: [issue] },
      retrySleep: async () => undefined,
    })).resolves.toMatchObject({ schemaVersion: 3 });

    expect(ai).toHaveBeenCalledTimes(1);
    expect(ai.mock.calls[0]?.[0]).toContain("教学蓝图结构修订 Agent");
    expect(ai.mock.calls[0]?.[1]).toContain(issue);
    expect(ai.mock.calls[0]?.[1]).toContain('"repairAttempt":1');
  });

  it("keeps repair instructions bounded to the audited draft and immutable contract", () => {
    const current = compactModelBlueprint();
    const prompt = buildTeachingBlueprintRepairPrompt(
      input(),
      current,
      ["第 1 节缺少完整的理解目标"],
      2,
    );

    expect(prompt.system).toContain("只修改问题字段及其必要关联");
    expect(prompt.system).toContain("返回与 current 相同外层结构的完整修订 JSON");
    expect(prompt.user).toContain('"repairAttempt":1');
    expect(prompt.user).toContain("第 1 节缺少完整的理解目标");
    expect(prompt.user).toContain("为什么测试必须保持独立");
  });

  it("traces teacher requirements and concrete difficulty strategies into page briefs", async () => {
    const requirementInput = input();
    requirementInput.knowledgePoints = requirementInput.knowledgePoints.map((point) => point.id === "kp-train"
      ? { ...point, sourceKnowledgePointIds: ["source-train"] }
      : point);
    requirementInput.teachingRequirements = {
      schemaVersion: 1,
      items: [
        { id: "teacher-case", kind: "teacher-directive", source: "teacher", text: "使用学生熟悉的例子。", sourceKnowledgePointIds: [] },
        { id: "highlight-role", kind: "highlight", source: "resource-package", text: "数据角色是重点。", sourceKnowledgePointIds: ["source-train"] },
        { id: "difficulty-role", kind: "difficulty", source: "resource-package", text: "容易混淆训练与测试。", sourceKnowledgePointIds: ["source-train"] },
      ],
      conflicts: [],
    };
    const candidate = compactModelBlueprint();
    Object.assign(candidate.sections[0]!.units[0]!, {
      requirementIds: ["teacher-case", "highlight-role", "difficulty-role"],
      difficultyStrategies: [{
        requirementId: "difficulty-role",
        learnerObstacle: "只按数据难易区分训练集与测试集",
        teachingApproach: "用同一批难度相同的数据对比是否参与参数学习",
        understandingEvidence: "能依据是否参与学习判断数据角色",
      }],
    });
    const blueprint = await generateTeachingBlueprint(requirementInput, async () => JSON.stringify(candidate));
    const outline = teachingBlueprintToOutlines(blueprint, "使用简体中文").find((item) => item.type === "slide")!;

    expect(blueprint.sections[0]?.units[0]).toMatchObject({
      requirementIds: ["teacher-case", "highlight-role", "difficulty-role"],
      difficultyStrategies: [expect.objectContaining({ requirementId: "difficulty-role" })],
    });
    expect(outline.teachingBrief).toMatchObject({
      requirementIds: ["teacher-case", "highlight-role", "difficulty-role"],
      difficultyStrategies: [expect.objectContaining({ requirementId: "difficulty-role" })],
    });
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

  it("uses exactly one comprehensive short answer per section when deep-response mode is enabled", async () => {
    const blueprint = await generateTeachingBlueprint(input("constructed-response"), async () => JSON.stringify(modelBlueprint()));
    const quizzes = teachingBlueprintToOutlines(blueprint, "使用简体中文").filter((outline) => outline.type === "quiz");
    expect(quizzes.every((quiz) => quiz.quizConfig?.questionTypes.join(",") === "short_answer")).toBe(true);
    expect(quizzes.every((quiz) => quiz.quizConfig?.questionCount === 1)).toBe(true);
    expect(quizzes.every((quiz) => quiz.quizConfig?.minShortAnswerQuestions === 1
      && quiz.quizConfig?.maxShortAnswerQuestions === 1)).toBe(true);
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
      explanationNodes: [{
        id: "roles-boundary-concept",
        kind: "concept",
        content: "测试集只在模型和参数确定后承担最终检查职责，提前查看结果并据此修改方案就会破坏独立性。",
        knowledgePointIds: ["kp-test"],
        prerequisiteNodeIds: [],
        provenance: "general-knowledge",
      }],
    });
    candidate.sections[0]!.pages.push({
      ...candidate.sections[0]!.pages[0]!,
      id: "roles-boundary-page",
      title: "什么时候测试不再独立",
      unitIds: ["roles-boundary"],
      introducesNodeIds: ["roles-boundary-concept"],
      deepensNodeIds: [],
      referencesNodeIds: [],
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
      explanationNodes: [{
        id: "second-unit-concept",
        kind: "concept",
        content: "独立评估要求测试信息不能参与模型选择、规则修改或参数调整，否则分数会偏离模型面对真正新数据时的表现。",
        knowledgePointIds: ["kp-train", "kp-test", "kp-split", "kp-leak"],
        prerequisiteNodeIds: [],
        provenance: "general-knowledge",
      }],
    });
    overloaded.sections[0]!.pages.push({
      ...overloaded.sections[0]!.pages[0]!,
      id: "second-page",
      title: "测试信息怎样回流",
      unitIds: ["second-unit"],
      introducesNodeIds: ["second-unit-concept"],
      deepensNodeIds: [],
      referencesNodeIds: [],
      description: "用流程对比辨析间接使用测试信息的风险。",
      keyPoints: ["冻结方案", "一次性测试", "反馈回流", "结果高估"],
      teachingObjective: "识别测试信息回流",
    });
    const shortInput = { ...input(), totalDurationSec: 300 };
    const ai = vi.fn(async () => JSON.stringify(overloaded));

    await expect(generateTeachingBlueprint(shortInput, ai)).resolves.toMatchObject({ schemaVersion: 3 });
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it("accepts a prerequisite taught in an earlier confirmed section without repair", async () => {
    const base = input();
    base.knowledgePoints = base.knowledgePoints.map((point) => point.id === "kp-split"
      ? { ...point, parentKnowledgePointIds: ["kp-train"] } : point);
    base.sectionPlans = modelBlueprint().sections.map((section) => ({
      title: section.title, knowledgePointIds: section.knowledgePointIds, maxPages: 2,
    }));
    const ai = vi.fn(async () => JSON.stringify(modelBlueprint()));
    await expect(generateTeachingBlueprint(base, ai, { retrySleep: async () => undefined }))
      .resolves.toMatchObject({ schemaVersion: 3 });
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it("rejects a prerequisite that is only taught in a later section", async () => {
    const base = input();
    base.knowledgePoints = base.knowledgePoints.map((point) => point.id === "kp-train"
      ? { ...point, parentKnowledgePointIds: ["kp-split"] } : point);
    const ai = vi.fn(async () => JSON.stringify(modelBlueprint()));
    await expect(generateTeachingBlueprint(base, ai, { retrySleep: async () => undefined }))
      .rejects.toThrow("尚未建立上位概念“数据划分”");
  });

  it("does not count a reference-only earlier page as teaching a prerequisite", async () => {
    const base = input();
    base.knowledgePoints = base.knowledgePoints.map((point) => point.id === "kp-split"
      ? { ...point, parentKnowledgePointIds: ["kp-train"] } : point);
    const candidate = modelBlueprint();
    candidate.sections[0]!.pages[0]!.introducesNodeIds = [];
    candidate.sections[0]!.pages[0]!.referencesNodeIds = ["roles-concept"];
    const ai = vi.fn(async () => JSON.stringify(candidate));
    await expect(generateTeachingBlueprint(base, ai, { retrySleep: async () => undefined }))
      .rejects.toThrow("尚未建立上位概念“训练集”");
  });

  it("accepts a prerequisite first taught on the same page", async () => {
    const base = input();
    base.knowledgePoints = base.knowledgePoints.map((point) => point.id === "kp-test"
      ? { ...point, parentKnowledgePointIds: ["kp-train"] } : point);
    const ai = vi.fn(async () => JSON.stringify(modelBlueprint()));
    await expect(generateTeachingBlueprint(base, ai, { retrySleep: async () => undefined }))
      .resolves.toMatchObject({ schemaVersion: 3 });
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

  it("rejects a structurally complete section that still overloads one slide", async () => {
    const ai = vi.fn(async () => JSON.stringify(compactModelBlueprint()));
    const onValidation = vi.fn();
    await expect(generateTeachingBlueprint({
      ...input(),
      sectionPlans: [{
        title: "训练、测试与可靠评估",
        knowledgePointIds: ["kp-train", "kp-test", "kp-split", "kp-leak"],
        teachingBudgetSec: 1_584,
        suggestedMinPages: 4,
        suggestedMaxPages: 8,
        maxPages: 20,
      }],
    }, ai, {
      onValidation,
      retrySleep: async () => undefined,
    })).rejects.toThrow("教学蓝图缺少可用结构");
    expect(ai).toHaveBeenCalledTimes(3);
    expect(onValidation.mock.calls.at(-1)?.[0].issues.join("；")).toContain("至少需要 4 个教学页面");
  });

  it("accepts the next complete result after a hard-output retry", async () => {
    const ai = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ sections: [] }))
      .mockResolvedValueOnce(JSON.stringify(modelBlueprint()));
    await expect(generateTeachingBlueprint(input(), ai, {
      retrySleep: async () => undefined,
    })).resolves.toMatchObject({ schemaVersion: 3 });
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
    expect(teachingBlueprintInputFingerprint({ ...base, teachingRequirements: { schemaVersion: 1, items: [{ id: "focus", kind: "highlight", source: "teacher", text: "重点比较数据角色", sourceKnowledgePointIds: ["kp-train"] }], conflicts: [] } })).not.toBe(fingerprint);
    expect(teachingBlueprintInputFingerprint({ ...base, knowledgePoints: base.knowledgePoints.map((point) => point.id === "kp-train" ? { ...point, teachingRole: "core-concept" as const } : point) })).not.toBe(fingerprint);
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
    expect(blueprint.budget.totalDurationSec).toBe(300);
    expect(blueprint.budget.assessmentDurationSec).toBe(assessmentMode === "adaptive" ? 36 : 54);
    expect(blueprint.budget.learnerActivityDurationSec).toBeGreaterThan(0);
    expect(blueprint.budget.teachingDurationSec
      + blueprint.budget.assessmentDurationSec
      + blueprint.budget.learnerActivityDurationSec).toBe(300);
    expect(validateTeachingBlueprintBudget(blueprint, outlines)).toEqual([]);
    if (assessmentMode === "adaptive") {
      expect(outlines.find((outline) => outline.type === "quiz")?.quizConfig?.questionCount).toBe(2);
    } else {
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
