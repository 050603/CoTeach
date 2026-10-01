import { describe, expect, it, vi } from "vitest";
import {
  applyReviewedOutlinesToTeachingBlueprint,
  adaptTeachingBlueprintResourceCapabilities,
  buildTeachingBlueprintRepairPrompt,
  generateTeachingBlueprint,
  buildTeachingBlueprintPrompt,
  revalidateStoredTeachingBlueprint,
  TEACHING_BLUEPRINT_COMPILED_BRIEF_VERSION,
  teachingBlueprintInputFingerprint,
  teachingBlueprintToOutlines,
  validateTeachingBlueprintBudget,
  validateTeachingBlueprintDraft,
  type TeachingBlueprintInput,
} from "./teaching-blueprint";
import { deriveKnowledgeLectureSectionsFromOutlines } from "@/lib/knowledge-lecture";
import { deriveTeachingConstraints } from "@/lib/openmaic/pedagogy/teaching-constraints";
import { hasCurrentTeachingBrief } from "@/lib/openmaic/generation/teaching-enhancement";
import { compileDiagramComponent } from "@openmaic/generation";
import type { TeachingBlueprintUnit, TeachingExplanationNode } from "@/lib/session/types";
import { assertSourceSequencesInOutlines, bindRequiredTextbookFiguresToBlueprint } from "@/lib/textbook/course-visual-binding";

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
      { title: "数据角色", knowledgePointIds: ["kp-train", "kp-test"] },
      { title: "可靠划分", knowledgePointIds: ["kp-split", "kp-leak"] },
    ],
  };
  const prompt = buildTeachingBlueprintPrompt(enriched);
  expect(prompt.user).toContain("会分类，还没接触训练集");
  expect(prompt.user).toContain("需要图例支架");
  expect(prompt.user).toContain("校园植物");
  expect(prompt.system).toContain("同一材料再次出现时");
  expect(prompt.system).toContain("必须在一次 JSON 输出中完整结束");
  expect(prompt.system).toContain("JSON 字符串内的英文双引号必须转义");
  expect(prompt.system).toContain("概念辨析、因果机制、数学推导、操作技能、历史材料和综合应用");
  expect(prompt.system).toContain("从实际落页正文派生 unit.explanationNodes、page.unitIds、introducesNodeIds 和 referencesNodeIds");
  expect(prompt.system).toContain("不得把后页才出现的术语、案例、问题或任务伪装成上一页已经讲过");
  expect(prompt.system).toContain("entryPoint 写出实际开场对象");
  expect(prompt.system).toContain("Instructional Slide Title Contract");
  expect(prompt.system).toContain("Name a case, practice, comparison, or recap page by its actual subject and purpose");
  expect(prompt.system).toContain("不要把 entryPoint 的问题、口语化过渡、醒目结论句或 learningTask 的操作要求写成 slide 标题");
  expect(prompt.system).toContain("课程第一页应在简短问候和必要承接后，直接讲授本阶段的第一个新知识");
  expect(prompt.system).toContain("教师已制作并讲解的图片观察、课堂对比、提问和活动属于已完成的先前学习经历");
  expect(prompt.system).toContain("正式致谢和告别");
  expect(prompt.system).toContain("案例首先按解释力、学习者熟悉度和学段适切性选择");
  expect(prompt.system).toContain("项目情境只规定用途和约束，不能自动变成知识目标或每页案例");
  expect(prompt.system).toContain("最终任务、驱动问题和成果物只是一种可选的迁移情境");
  expect(prompt.system).toContain("每页必须填写 taskConnection");
  expect(prompt.system).toContain("不能用教案、报告、PPT 等成果物中的几句话");
  expect(prompt.system).toContain("人物、物体、空间状态、错误心象或现实与想象的可见差异");
  expect(prompt.system).toContain("关系图不能抵消案例配图");
  expect(prompt.system).toContain("没有每页配图或全课图片比例要求");
  expect(prompt.system).toContain("此前已经规划的教学图片在来源和知识目标未变时应继续落实");
  expect(prompt.system).toContain("把第二个决定写入 caseObservation");
  expect(prompt.system).toContain("不在图内绘制文字、标签、精确数值或关系箭头");
  expect(prompt.system).toContain("逐项保留可观察的身体结构、肢体数量、纹理和空间状态");
  expect(prompt.system).toContain("七步闭环就写七个实际步骤节点");
  expect(prompt.system).toContain("不能因为文字出现‘反馈’就强行画成循环");
  expect(prompt.user).toContain('"topology":"sequence|cycle|branch"');
  expect(prompt.system).toContain("branch 必须显式提供全部 edges");
  expect(prompt.system).toContain("不得把互斥结果或并列方法串成所有学习者必须依次完成的步骤");
  expect(prompt.system).toContain("构造案例、类比和示意数据");
  expect(prompt.system).toContain("教材案例采用双通道设计");
  expect(prompt.system).toContain("学生内容字段中直接写成连贯案例");
  expect(prompt.system).toContain("不出现‘教材原例’‘教学改编’‘AI 补充’");
  expect(prompt.system).toContain("preferredForm 是教学表达偏好");
  expect(prompt.system).toContain("没有每节必须使用几种形式的配额");
  expect(prompt.system).toContain("定义、并列原则与少量核心命题用 text 和分组说明");
  expect(prompt.system).toContain("仅需记住步骤顺序时可用编号列表");
  expect(prompt.system).toContain("概念层级不得默认包装成时间流程");
  expect(prompt.system).toContain("相邻页面重复同一流程时，须说明本页新增的教学作用");
  expect(prompt.system).toContain("preferredForm=text、table、chart 或 illustration 时省略 diagram");
  expect(prompt.system).not.toContain("步骤、因果、系统和概念关系通常优先 diagram");
  expect(prompt.system).not.toContain("抽象概念、因果或步骤怎样用可编辑关系图表达");
  const outputExample = JSON.parse(prompt.user.split("返回结构：\n")[1]!.split("\n\n按需字段示例")[0]!);
  expect(outputExample.sections[0].pages[0].visualRelationship).not.toHaveProperty("diagram");
  expect(outputExample.sections[0].pages[0].caseObservation.aspectRatio).toBe("image 可选 16:9|4:3|1:1|9:16");
  expect(prompt.user).toContain("仅在已决定 diagram 或含图示的 mixed 最能帮助理解时加入 visualRelationship");
  expect(prompt.system).toContain("具有完整、可比较数值并需要看趋势");
  expect(prompt.system).toContain("不得考未讲内容");
  expect(prompt.system).toContain("条目数量不等于最终题数");
  expect(prompt.system).toContain("也不要在其中指定题型");
  expect(prompt.system).toContain("Constructed examples or data must not be given a fabricated institution");
  expect(prompt.system).toContain("未启用图片或视频时不得请求对应种类");
  expect(prompt.user).toContain('"sharedContext"');
  expect(prompt.user).toContain('"learningTask"');
  expect(prompt.system).toContain('type=slide 的概念首次讲解页用其规范名称作正式 PPT 标题，如‘项目式学习’');
  expect(outputExample.sections[0].pages[0].title).toBe("slide 页用知识对象的正式标题，首次定义概念时用规范名称如项目式学习；interactive 页用具体任务名称");
  expect(prompt.user).not.toContain('"title":"学生可见标题"');
  expect(prompt.user).toContain('"taskConnection"');
  expect(prompt.user).toContain("可选最终任务情境");
  expect(prompt.user).toContain("必须严格按以下 2 个小节及其顺序生成");
  expect(prompt.user).toContain("每节页面数量由实际教学任务和可读性决定");
  expect(prompt.user).not.toContain('"maxPages"');
  expect(prompt.system).toContain("可直接制作资源的小节内容设计");
  expect(prompt.system).toContain("禁止只写");
  expect(prompt.user).toContain('"understandingCriteria"');
  expect(prompt.system).toContain("准确的核心含义及必要边界");
  expect(prompt.system).toContain("供讲稿直接依据原始来源展开");
  expect(prompt.system).toContain("不要求教材定义原文上屏");
  expect(prompt.system).toContain("讲稿采用原有自然授课风格");
  expect(prompt.system).toContain("type=slide 是讲授与示范页面，没有提交答案的入口");
  expect(prompt.system).toContain("用具体案例展示事实、判断依据、推理过程和结论");
  expect(prompt.user).toContain("learningTask 仅在具备实际作答控件的 interactive 页");
  expect(prompt.system).toContain("一个知识点可以跨多页");
  expect(prompt.system).toContain("知识点、讲授单元和 PPT 页面不是一一对应关系");
  expect(prompt.system).toContain("每个 explanationNode 用 knowledgePointIds 声明");
  expect(prompt.system).toContain("explanationNodes 必须写在实际讲授的 page 内");
  expect(prompt.user).toContain("机器结构验收合同");
  expect(outputExample.sections[0].pages[0].explanationNodes[0].knowledgePointIds).toEqual(["该节点实际解释的本单元知识点ID"]);
  expect(prompt.system).toContain("辅助案例优先嵌入相关知识页");
  expect(prompt.system).toContain("完整故事、原因与条件由该页实际拥有的 example 节点支持讲稿");
  expect(prompt.user).toContain("输入时间无法承载必需解释");
  expect(prompt.user).toContain("只为本次 AI 知识讲授的必要承接、新知识解释、推理、例子、操作、短测和正式收束估时");
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

it("starts AI teaching with new knowledge after a teacher-led launch", async () => {
  const priorStage = [{ stageKey: "launch", title: "教师导入", teacherActions: "展示两张课堂图片，让学生比较教师讲授和动手操作", studentRequirements: "观察并讨论两种课堂场景" }];
  const scoped = { ...input(), precedingStageActivities: priorStage };
  const prompt = buildTeachingBlueprintPrompt(scoped);
  expect(prompt.user).toContain("展示两张课堂图片");
  expect(prompt.user).toContain("只供承接，绝不能作为本次 PPT 的页面或讲解任务");
  expect(prompt.system).toContain("不得重做、重画或单独编成 PPT 页面");
  expect(teachingBlueprintInputFingerprint(scoped)).not.toBe(teachingBlueprintInputFingerprint(input()));
  await expect(generateTeachingBlueprint(scoped, async () => JSON.stringify(modelBlueprint())))
    .resolves.toMatchObject({ schemaVersion: 3 });

  const repeatedLaunch = modelBlueprint();
  (repeatedLaunch.sections[0]!.units[0]!.explanationNodes[0]! as { kind: string }).kind = "example";
  const onValidation = vi.fn();
  await expectBlueprintQualityIssue(generateTeachingBlueprint(scoped, async () => JSON.stringify(repeatedLaunch), {
    onValidation, retrySleep: async () => undefined,
  }), "AI 知识讲授第一页必须建立新概念");
  expect(onValidation.mock.calls[0]?.[0].issues).toContain(
    "AI 知识讲授第一页必须建立新概念、关系、机制或适用条件，不能只重复前一阶段教师已完成的导入或案例观察",
  );
});

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
            caseObservation: { imageWouldHelp: false, observableDifference: "", reason: "数据职责由可编辑关系说明即可。" },
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
            caseObservation: { imageWouldHelp: false, observableDifference: "", reason: "信息泄漏是流程关系而非外观差异。" },
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
        caseObservation: { imageWouldHelp: false, observableDifference: "", reason: "评估因果关系由可编辑流程说明即可。" },
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

function embodiedSourceRecoveryFixture() {
  const labels = [
    "发挥身体认知的主体性,让学生亲身参与学习活动",
    "让学生学习的思维和过程变得直观可视",
    "创设多维的物理环境和教学情境",
    "注重身心环境交互学习活动的设计",
    "注重教学目标、资源、交互过程的动态生成性",
  ];
  const complete = `具身认知的教学设计原则：${labels.join("；")}。`;
  const shortened = "具身认知的教学设计原则：发挥身体认知的主体性并引导反思，让学习的思维和过程直观可视，创设多维的物理环境和教学情境，注重身心环境交互学习活动的设计，注重教学目标、资源、交互过程的动态生成性。";
  const scoped: TeachingBlueprintInput = {
    ...input(), courseTitle: "具身认知教学设计", knowledgeGraph: undefined,
    knowledgePoints: [{ id: "kp-body-design", name: "具身认知的教学设计原则", description: "身体参与、环境交互与动态生成的五条设计原则。" }],
    sourceSequences: [{
      resourceId: "source-sequence:embodied-principles", required: true,
      knowledgePointIds: ["kp-body-design"], scope: "knowledge-point", sequenceSemantics: "enumerated-items",
      orderedSteps: labels.map((label, index) => ({ label, sourceBlockId: `body-principle-${index}` })),
    }],
  };
  const draft = compactModelBlueprint();
  const unit = draft.sections[0]!.units[0]!;
  unit.explanation = complete;
  unit.knowledgePointIds = ["kp-body-design"];
  unit.explanationNodes[0]!.content = shortened;
  unit.explanationNodes[0]!.knowledgePointIds = ["kp-body-design"];
  draft.sections[0]!.pages[0]!.keyPoints = [shortened];
  return { labels, complete, scoped, draft };
}

function acceptedEmbodiedPlanFixture(options: { adoptedComplete?: boolean; nodeComplete?: boolean } = {}) {
  const { labels, complete, scoped, draft } = embodiedSourceRecoveryFixture();
  const stored = validateTeachingBlueprintDraft(draft, { ...scoped, sourceSequences: [] }).blueprint!;
  const brief = teachingBlueprintToOutlines(stored, "使用简体中文")[0]!.teachingBrief!;
  const section = stored.sections[0]!;
  const unit = section.units[0]!;
  const node = unit.explanationNodes![0]!;
  const shortened = node.content;
  section.id = "confirmed-body-section";
  section.quizOutlineId = "replanned-body-quiz";
  section.reviewedQuizConfig = {
    questionCount: 2, questionCountRange: { min: 2, max: 2 }, difficulty: "hard", questionTypes: ["single"],
  };
  unit.id = "confirmed-body-unit";
  section.understandingCriteria.supportingUnitIds = [unit.id];
  node.id = "confirmed-body-node";
  if (options.nodeComplete) node.content = complete;
  const page = section.pages[0]!;
  page.id = "replanned-body-0";
  page.outlineId = page.id;
  page.unitIds = [unit.id];
  page.introducesNodeIds = [node.id];
  page.sourcePageIds = ["source-body-definition", "source-body-application"];
  page.sectionPlanVersion = "measured-section-v2";
  page.plannedTiming = {
    role: "teaching", narrationSec: section.teachingDurationSec,
    learnerActivitySec: section.learnerActivityDurationSec, transitionSec: 0,
  };
  page.targetDurationSec = section.teachingDurationSec + section.learnerActivityDurationSec;
  page.keyPoints = [node.content];
  const executed = options.adoptedComplete === false ? shortened : complete;
  page.teachingBrief = {
    ...brief, explanation: executed, understandingCriteria: structuredClone(section.understandingCriteria),
    teachingPlan: {
      ...brief.teachingPlan!, newContent: executed, reasoningSteps: [], visibleContent: [executed],
      narrationFocus: [executed], introduces: [node.id], deepens: [], references: [],
    },
  };
  return { labels, complete, scoped, stored };
}

describe("teaching blueprint compiler", () => {
  it("keeps a mandatory original through an unrelated outline review and recompilation", async () => {
    const original = await generateTeachingBlueprint(input(), async () => JSON.stringify(modelBlueprint()));
    const resource = {
      id: "textbook_fig_project", figureId: "figure-project", pageNumber: 32,
      assetId: "asset-project", src: "/api/uploads/asset-project", status: "available" as const,
      relation: "direct" as const, required: true, evidenceItemIds: ["e-project"],
      knowledgePointIds: ["kp-train"], sourceTitle: "信息科技教材",
    };
    const bound = bindRequiredTextbookFiguresToBlueprint(original, [resource]);
    const compiled = teachingBlueprintToOutlines(bound, "使用简体中文");
    const edited = compiled.map((outline) => outline.type === "slide"
      ? { ...outline, title: `${outline.title}（修订）` } : outline);
    const reviewed = applyReviewedOutlinesToTeachingBlueprint(bound, edited);
    const rebuilt = teachingBlueprintToOutlines(bindRequiredTextbookFiguresToBlueprint(reviewed, [resource]), "使用简体中文");
    expect(rebuilt.find((outline) => outline.knowledgePointIds?.includes("kp-train"))?.visualIntent?.resourceRefs)
      .toContainEqual(expect.objectContaining({ resourceId: resource.id, required: true }));
    expect(reviewed.sections.flatMap((section) => section.pages).flatMap((page) => page.resourceNeeds ?? []))
      .toContainEqual(expect.objectContaining({ kind: "source-image", assetId: resource.id, required: true }));
  });

  it("allocates a 30-minute lesson from actual explanation, activity, and short-check needs", async () => {
    const ai = vi.fn(async () => JSON.stringify(modelBlueprint()));
    const blueprint = await generateTeachingBlueprint(input(), ai);
    const outlines = teachingBlueprintToOutlines(blueprint, "使用简体中文");

    expect(blueprint.budget).toMatchObject({
      totalDurationSec: 1_800,
      teachingDurationSec: 1_440,
      assessmentDurationSec: 360,
      learnerActivityDurationSec: 0,
    });
    expect(outlines.reduce((sum, outline) => sum + (outline.targetDurationSec ?? 0), 0)).toBe(1_800);
    expect(outlines.filter((outline) => outline.type !== "quiz").reduce(
      (sum, outline) => sum + (outline.plannedTiming?.narrationSec ?? 0),
      0,
    )).toBe(1_440);
    expect(outlines.filter((outline) => outline.type === "quiz").every((outline) =>
      (outline.plannedTiming?.narrationSec ?? 0) >= 45
      && (outline.plannedTiming?.learnerActivitySec ?? 0) >= 100,
    )).toBe(true);
    expect(validateTeachingBlueprintBudget(blueprint, outlines)).toEqual([]);
    expect(outlines.every((outline) => outline.narrationMode === "standalone-course")).toBe(true);
    expect(outlines.filter((outline) => outline.type !== "quiz").flatMap((outline) => outline.teachingUnitIds ?? [])).toEqual([
      "teaching-section-1-unit-1",
      "teaching-section-2-unit-1",
    ]);
    expect(outlines[0]?.teachingBrief?.sharedContext?.caseId).toBe("campus-plant-classifier");
    expect(outlines[0]?.teachingBrief?.pageTask).toBeUndefined();
    expect(outlines.filter((outline) => outline.type === "slide").every(
      (outline) => outline.plannedTiming?.learnerActivitySec === 0,
    )).toBe(true);
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
      && quiz.quizConfig?.questionCountRange?.min === 2
      && quiz.quizConfig?.questionCountRange?.max === 4
    ))).toBe(true);
    expect(quizzes.every((quiz) => (
      quiz.keyPoints.length >= 2
      && quiz.quizConfig?.questionTypePlan === undefined
      && quiz.quizConfig?.qualityContract === "grounded-v1"
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

  it("keeps assessment responsibilities separate from the estimated question count", async () => {
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
    expect(quiz.keyPoints).toEqual(expect.arrayContaining(candidate.sections[0]!.assessmentFocus));
    expect(quiz.keyPoints).not.toContain(expect.stringContaining("第 1 题"));
    expect(quiz.quizConfig?.questionTypePlan).toBeUndefined();
    expect(quiz.quizConfig?.questionTypes).toEqual(["single", "multiple", "true_false", "matching", "fill_blank"]);
    expect(quiz.keyPoints).toContain("填空补全训练集与测试集的职责");
    expect(quiz.keyPoints.join("\n")).not.toContain("客观作答转换");
  });

  it("preserves compound learning goals without forcing four complete candidate responses", async () => {
    const candidate = compactModelBlueprint();
    candidate.sections[0]!.assessmentFocus = [
      "能判断一个方案是否满足标准，并指出缺少条件会带来的后果",
      "能写出一个开放问题并分解为可探究的子问题",
    ];
    const blueprint = await generateTeachingBlueprint(
      { ...input(), totalDurationSec: 300 },
      async () => JSON.stringify(candidate),
    );
    const quiz = teachingBlueprintToOutlines(blueprint, "使用简体中文")
      .find((outline) => outline.type === "quiz")!;

    expect(quiz.quizConfig?.questionTypePlan).toBeUndefined();
    expect(quiz.keyPoints.length).toBeGreaterThanOrEqual(2);
    expect(quiz.keyPoints.every((point) => !point.includes("候选作答"))).toBe(true);
    expect(quiz.keyPoints.join("\n")).toContain("写出一个开放问题");
    expect(quiz.description).toContain("只有考查迁移或确实有助于判断时才使用简短新情境");
  });

  it("accepts one substantive key point and drops a slide-only changed-condition task", async () => {
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
    expect(outline.keyPoints).toEqual(outline.teachingBrief?.teachingPlan?.presentationContent);
    expect(outline.keyPoints).toContain("测试信息进入训练会破坏独立评估");
    expect(outline.teachingBrief?.teachingPlan?.visibleContent).toEqual(outline.keyPoints);
    expect(outline.teachingBrief?.explanation).toContain("训练集提供模型学习规律所需的信息");
    expect(outline.teachingBrief?.pageTask).toBeUndefined();
    expect(blueprint.sections[0]?.pages[0]?.learningTask).toBeUndefined();
  });

  it("keeps an answerable interactive task separate from the section quiz", async () => {
    const candidate = compactModelBlueprint();
    const page = candidate.sections[0]!.pages[0]!;
    page.type = "interactive";
    Object.assign(page, { widgetType: "simulation", widgetOutline: { controls: ["选择划分单位"] } });
    page.learningTask = {
      learnerAction: "选择划分单位并查看数据是否跨集合。",
      newContribution: "观察按植物个体划分如何阻断近重复泄漏。",
      reasoningFocus: "同一对象的信息是否跨集合。",
      caseUse: "variant",
      changedConditions: ["划分单位从照片改为植物个体"],
      preservedConditions: ["照片内容和分类目标不变"],
    };
    const blueprint = await generateTeachingBlueprint(input(), async () => JSON.stringify(candidate));
    const outline = teachingBlueprintToOutlines(blueprint, "使用简体中文")[0]!;

    expect(outline.type).toBe("interactive");
    expect(outline.teachingBrief?.pageTask?.learnerAction).toBe("选择划分单位并查看数据是否跨集合。");
    expect(outline.plannedTiming?.learnerActivitySec).toBeGreaterThan(0);
    expect(teachingBlueprintToOutlines(blueprint, "使用简体中文").at(-1)?.type).toBe("quiz");
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

  it("adopts complete compiled blueprint briefs without another teaching-design call", async () => {
    const blueprint = await generateTeachingBlueprint(input(), async () => JSON.stringify(compactModelBlueprint()));
    const outline = teachingBlueprintToOutlines(blueprint, "使用简体中文")
      .find((item) => item.type === "slide")!;

    expect(outline.teachingBrief?.designVersion).toBe(TEACHING_BLUEPRINT_COMPILED_BRIEF_VERSION);
    expect(hasCurrentTeachingBrief(outline)).toBe(true);
    expect(outline.teachingBrief?.teachingPlan?.newContent).toContain("训练集提供模型学习规律所需的信息");
    expect(outline.teachingBrief?.teachingPlan?.visibleContent).toEqual(outline.keyPoints);
    expect(outline.teachingBrief?.explanation).toContain(
      "训练集提供模型学习规律所需的信息，测试集在训练结束后独立检查这些规律能否用于新对象，划分规则必须服务于这种独立性。",
    );
    expect(blueprint.sections[0]?.units[0]?.explanationNodes?.every((node) => (
      node.knowledgePointIds?.length === 4
    ))).toBe(true);
  });

  it("projects only the explanation, mechanism, and example owned by the current page", async () => {
    const candidate = compactModelBlueprint();
    const section = candidate.sections[0]!;
    const unit = section.units[0]!;
    const firstPage = section.pages[0]!;
    unit.explanation = "教学理论、教学模式和教学方法是不同层次的课堂设计概念。";
    unit.mechanism = "建构主义强调学习者主动建构意义，因此项目式学习可以用真实任务支持主动探究。";
    unit.workedExample = "学生围绕校园节能问题收集证据并制作方案，这是项目式学习的完整案例。";
    (unit as unknown as TeachingBlueprintUnit).explanationNodes = [
      {
        id: "framework-concept",
        kind: "concept",
        content: unit.explanation,
        knowledgePointIds: ["kp-train", "kp-test", "kp-split", "kp-leak"],
        prerequisiteNodeIds: [],
        provenance: "general-knowledge",
      },
      {
        id: "constructivism-mechanism",
        kind: "mechanism",
        content: unit.mechanism,
        knowledgePointIds: ["kp-train", "kp-test", "kp-split", "kp-leak"],
        prerequisiteNodeIds: ["framework-concept"],
        provenance: "general-knowledge",
      },
      {
        id: "pbl-example",
        kind: "example",
        content: unit.workedExample,
        knowledgePointIds: ["kp-train", "kp-test", "kp-split", "kp-leak"],
        prerequisiteNodeIds: ["constructivism-mechanism"],
        provenance: "constructed",
      },
    ] satisfies TeachingExplanationNode[];
    Object.assign(firstPage, {
      title: "先看三个设计层次",
      introducesNodeIds: ["framework-concept"],
      deepensNodeIds: [],
      referencesNodeIds: [],
      description: "用学生熟悉的课堂安排区分理论、模式和方法。",
      keyPoints: ["教学理论解释学习观", "教学模式组织整体活动", "教学方法是具体做法"],
      teachingObjective: "根据具体课堂行为区分三个层次",
    });
    section.pages.push({
      ...firstPage,
      id: "future-concepts-page",
      title: "再认识建构主义与项目式学习",
      introducesNodeIds: ["constructivism-mechanism", "pbl-example"],
      referencesNodeIds: ["framework-concept"],
      description: "建立具体概念后，再完成命名归类与综合比较。",
      keyPoints: ["建构主义强调主动建构", "项目式学习围绕真实问题组织完整项目"],
      teachingObjective: "建立两个概念并进行综合比较",
    });

    const ai = vi.fn(async () => JSON.stringify(candidate));
    const blueprint = await generateTeachingBlueprint(input(), ai);
    const pages = teachingBlueprintToOutlines(blueprint, "使用简体中文")
      .filter((outline) => outline.type !== "quiz");
    const firstBrief = pages[0]!.teachingBrief!;
    const secondBrief = pages[1]!.teachingBrief!;

    expect(firstBrief.teachingPlan?.newContent).toContain("教学理论、教学模式和教学方法");
    expect(firstBrief.teachingPlan?.reasoningSteps.join("\n")).not.toContain("建构主义");
    expect(firstBrief.examples.join("\n")).not.toContain("项目式学习");
    expect(firstBrief.explanation).not.toContain("项目式学习");
    expect(secondBrief.teachingPlan?.reasoningSteps.join("\n")).toContain("建构主义");
    expect(secondBrief.examples.join("\n")).toContain("项目式学习");
    expect(ai).toHaveBeenCalledOnce();
  });

  it("carries the same learning boundary into page and section assessment briefs", async () => {
    const boundaryInput = input();
    boundaryInput.knowledgeGraph = {
      nodes: [
        {
          id: "pre-classification",
          label: "使用日常经验分类",
          description: "按可观察特征将对象分类",
          instructionalRole: "prerequisite",
          priorKnowledgeEvidence: "已有生活分类经验",
          diagnosticBoundary: "能说出一项分类依据",
        },
        ...boundaryInput.knowledgePoints.map((point) => ({
          id: point.id,
          label: point.name,
          description: point.description,
          instructionalRole: "lesson" as const,
        })),
      ],
      edges: [
        {
          id: "pre-train",
          source: "pre-classification",
          target: "kp-train",
          label: "提供分类经验",
          type: "required-prerequisite",
          strength: "required",
          rationale: "先能按特征分类，再理解模型如何学习分类规律",
        },
      ],
    };
    const ai = vi.fn(async () => JSON.stringify(modelBlueprint()));
    const blueprint = await generateTeachingBlueprint(boundaryInput, ai);
    const outlines = teachingBlueprintToOutlines(blueprint, "使用简体中文");
    const firstPage = outlines.find((outline) => outline.id === "teaching-section-1-page-1")!;
    const secondPage = outlines.find((outline) => outline.id === "teaching-section-2-page-1")!;
    const secondQuiz = outlines.find((outline) => outline.id === "teaching-section-2-check")!;

    expect(firstPage.teachingBrief?.learningBoundary).toEqual({
      prerequisiteKnowledge: [{
        id: "pre-classification",
        name: "使用日常经验分类",
        priorKnowledgeEvidence: "已有生活分类经验",
        diagnosticBoundary: "能说出一项分类依据",
      }],
      previouslyTaughtKnowledge: [],
      currentKnowledge: [
        { id: "kp-train", name: "训练集" },
        { id: "kp-test", name: "测试集" },
      ],
      futureKnowledge: [
        { id: "kp-split", name: "数据划分" },
        { id: "kp-leak", name: "数据泄漏" },
      ],
    });
    expect(secondPage.teachingBrief?.learningBoundary).toMatchObject({
      prerequisiteKnowledge: [],
      previouslyTaughtKnowledge: [
        { id: "kp-train", name: "训练集" },
        { id: "kp-test", name: "测试集" },
      ],
      currentKnowledge: [
        { id: "kp-split", name: "数据划分" },
        { id: "kp-leak", name: "数据泄漏" },
      ],
      futureKnowledge: [],
    });
    expect(secondQuiz.teachingBrief?.learningBoundary).toEqual({
      prerequisiteKnowledge: [],
      previouslyTaughtKnowledge: [
        { id: "kp-train", name: "训练集" },
        { id: "kp-test", name: "测试集" },
        { id: "kp-split", name: "数据划分" },
        { id: "kp-leak", name: "数据泄漏" },
      ],
      currentKnowledge: [],
      futureKnowledge: [],
    });
    expect(ai).toHaveBeenCalledOnce();
  });

  it("preserves a forward cross-unit prerequisite node reference with two-pass node resolution", async () => {
    const candidate = modelBlueprint();
    const section = candidate.sections[0]!;
    const roles = section.units[0]!;
    ((roles as unknown as TeachingBlueprintUnit).explanationNodes![0]!.prerequisiteNodeIds) = ["independence-boundary"];
    section.units.push({
      ...roles,
      id: "independence",
      title: "独立评估的边界",
      knowledgePointIds: ["kp-test"],
      learningOutcome: "能说明独立评估的最小条件",
      explanation: "独立评估要求承担最终检验的数据未参与模型或参数的确定。",
      mechanism: "如果先看测试结果再改模型，测试信息就进入了学习过程。",
      workedExample: "比较一次性测试和根据测试分数反复调参的两个流程。",
      explanationNodes: [{
        id: "independence-boundary",
        kind: "concept",
        content: "独立评估要求承担最终检验的数据未参与模型或参数的确定。",
        knowledgePointIds: ["kp-test"],
        prerequisiteNodeIds: [],
        provenance: "general-knowledge",
      }],
    });
    section.pages = [
      {
        ...section.pages[0]!,
        id: "independence-page",
        title: "先建立独立评估边界",
        unitIds: ["independence"],
        knowledgePointIds: ["kp-test"],
        introducesNodeIds: ["independence-boundary"],
        description: "明确测试数据不得参与模型确定。",
        keyPoints: ["测试数据不参与学习", "模型确定后才最终测试"],
        teachingObjective: "建立独立评估的条件",
      },
      {
        ...section.pages[0]!,
        id: "roles-page",
        title: "再解释训练与测试的职责",
        unitIds: ["roles"],
        introducesNodeIds: ["roles-concept"],
        referencesNodeIds: ["independence-boundary"],
        description: "依据已建立的独立边界解释两类数据的职责。",
        keyPoints: ["训练集参与学习", "测试集承担独立检验"],
        teachingObjective: "解释训练集与测试集的不同职责",
      },
    ];

    const ai = vi.fn(async () => JSON.stringify(candidate));
    const blueprint = await generateTeachingBlueprint(input(), ai);
    const firstUnit = blueprint.sections[0]!.units[0]!;
    const secondUnit = blueprint.sections[0]!.units[1]!;

    expect(firstUnit.explanationNodes?.[0]?.prerequisiteNodeIds)
      .toEqual([secondUnit.explanationNodes?.[0]?.id]);
    expect(firstUnit.explanationNodes?.[0]?.prerequisiteNodeIds[0]).toBe("teaching-section-1-unit-2-node-1");
    expect(ai).toHaveBeenCalledOnce();
  });

  it("keeps the worked conclusion visible when a model proposes an independent task on a slide", async () => {
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

    expect(outline.teachingBrief?.pageTask).toBeUndefined();
    expect(outline.teachingBrief?.teachingPlan?.visibleContent).toContain("因此第一种流程存在数据泄漏");
    expect(outline.plannedTiming?.learnerActivitySec).toBe(0);
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

  it("plans an available textbook original before layout and keeps it when AI image generation is disabled", async () => {
    const textbookFigure = {
      resourceId: "textbook_fig_123456789abc",
      figureId: "figure-1",
      description: "同一株植物的连拍照片与按植株分组示意",
      knowledgePointIds: ["kp-split", "kp-leak"],
      relation: "direct" as const,
      required: true,
      sourceTitle: "信息科技教材",
      relationReason: "教材证据直接关联到数据划分知识点",
    };
    const planInput = { ...input(), textbookFigures: [textbookFigure] };
    const candidate = compactModelBlueprint();
    (candidate.sections[0]!.pages[0]! as unknown as { resourceNeeds: Array<Record<string, unknown>> }).resourceNeeds = [{
      kind: "source-image",
      assetId: textbookFigure.resourceId,
      purpose: "观察同一对象的近重复照片为什么不能跨训练集和测试集",
      required: true,
    }];

    const prompt = buildTeachingBlueprintPrompt(planInput);
    expect(prompt.user).toContain(textbookFigure.resourceId);
    expect(prompt.user).toContain('"relation":"direct"');
    expect(prompt.system).toContain("首次完整讲解页使用");

    const blueprint = await generateTeachingBlueprint(
      planInput,
      async () => JSON.stringify(candidate),
      { resourceCapabilities: { imageGenerationEnabled: false, videoGenerationEnabled: false } },
    );
    const outline = teachingBlueprintToOutlines(blueprint, "使用简体中文")[0]!;

    expect(blueprint.sections[0]?.pages[0]?.resourceNeeds).toEqual([{
      kind: "source-image",
      assetId: textbookFigure.resourceId,
      purpose: "观察同一对象的近重复照片为什么不能跨训练集和测试集",
      required: true,
    }]);
    expect(outline.suggestedImageIds).toEqual([textbookFigure.resourceId]);
    expect(outline.visualIntent).toMatchObject({
      representation: "source-image",
      resourceRefs: [{
        resourceId: textbookFigure.resourceId,
        kind: "source-image",
        required: true,
      }],
    });
    expect(outline.mediaGenerations).toBeUndefined();
  });

  it("shares one stable generated asset across pages and leaves a clear text page image-free", async () => {
    const candidate = modelBlueprint();
    const sharedNeed = {
      kind: "image",
      purpose: "观察相同场景中的对象差异",
      required: true,
      prompt: "同一校园植物在训练照片和新测试照片中的可见差别",
    };
    (candidate.sections[0]!.pages[0]! as unknown as { resourceNeeds: Array<Record<string, unknown>> }).resourceNeeds = [sharedNeed];
    (candidate.sections[1]!.pages[0]! as unknown as { resourceNeeds: Array<Record<string, unknown>> }).resourceNeeds = [sharedNeed];
    const blueprint = await generateTeachingBlueprint(
      input(),
      async () => JSON.stringify(candidate),
      { resourceCapabilities: { imageGenerationEnabled: true, videoGenerationEnabled: false } },
    );
    const outlines = teachingBlueprintToOutlines(blueprint, "使用简体中文").filter((outline) => outline.type === "slide");
    const generatedIds = outlines.map((outline) => outline.mediaGenerations?.[0]?.elementId);

    expect(generatedIds[0]).toMatch(/^generated_[a-f0-9]{20}$/);
    expect(generatedIds[1]).toBe(generatedIds[0]);
    expect(outlines[0]?.visualIntent?.resourceRefs?.[0]?.resourceId).toBe(generatedIds[0]);

    const textCandidate = compactModelBlueprint();
    const textBlueprint = await generateTeachingBlueprint(input(), async () => JSON.stringify(textCandidate));
    const textOutline = teachingBlueprintToOutlines(textBlueprint, "使用简体中文")[0]!;
    expect(textOutline.visualIntent).toMatchObject({ representation: "text" });
    expect(textOutline.mediaGenerations).toBeUndefined();
  });

  it("keeps concept structure and two observation images together with their chosen framing", async () => {
    const candidate = compactModelBlueprint();
    const page = candidate.sections[0]!.pages[0]!;
    (page as unknown as { visualRelationship: Record<string, unknown> }).visualRelationship = {
      kind: "comparison",
      description: "先看同化与顺应的关系，再比较鱼想象的牛与真实牛。",
      readingOrder: ["关系图", "鱼想象的牛", "真实牛"],
      preferredForm: "mixed",
      rationale: "关系与具体可见差异都需要呈现。",
    };
    (page as unknown as { resourceNeeds: Array<Record<string, unknown>> }).resourceNeeds = [
      { kind: "diagram", purpose: "说明同化与顺应的概念关系", required: true },
      {
        kind: "image", purpose: "观察鱼如何按自身身体想象牛", required: true,
        prompt: "想象示意：鱼形身体带牛角、腿、花斑；与真实牛同视角对照，无文字标签",
        aspectRatio: "1:1",
      },
      {
        kind: "image", purpose: "观察真实牛的身体轮廓", required: true,
        prompt: "真实牛的完整身体轮廓，清晰可见牛角、四肢与花斑，无文字标签",
        aspectRatio: "4:3",
      },
    ];
    const blueprint = await generateTeachingBlueprint(input(), async () => JSON.stringify(candidate));
    const outline = teachingBlueprintToOutlines(blueprint, "使用简体中文")[0]!;

    expect(outline.visualIntent?.representation).toBe("mixed");
    expect(outline.mediaGenerations).toHaveLength(2);
    expect(outline.mediaGenerations?.map((request) => request.aspectRatio)).toEqual(["1:1", "4:3"]);
    expect(outline.visualIntent?.resourceRefs?.map((reference) => reference.resourceId))
      .toEqual(outline.mediaGenerations?.map((request) => request.elementId));
  });

  it("uses the same compact cycle and observational image rules for a different subject", async () => {
    const candidate = compactModelBlueprint();
    const page = candidate.sections[0]!.pages[0]!;
    page.title = "水循环中的蒸发、凝结与降水";
    (page as unknown as { visualRelationship: Record<string, unknown> }).visualRelationship = {
      kind: "process", description: "水在不同状态和位置之间循环。",
      readingOrder: ["蒸发", "凝结", "降水", "汇集"], preferredForm: "mixed",
      rationale: "环路说明关系，云与雨的外观帮助观察具体过程。",
      diagram: {
        topology: "cycle",
        nodes: ["蒸发", "凝结", "降水", "汇集"]
          .map((label, index) => ({ id: `water-${index + 1}`, label })),
        annotation: "水循环",
      },
    };
    (page as unknown as { resourceNeeds: Array<Record<string, unknown>> }).resourceNeeds = [{
      kind: "image", purpose: "观察云层与雨滴的真实空间状态", required: true,
      prompt: "剖面示意：湖面上方有云层与下落雨滴，表现可见外观，不含文字或箭头",
      aspectRatio: "4:3",
    }];
    const blueprint = await generateTeachingBlueprint({ ...input(), courseTitle: "水循环" }, async () => JSON.stringify(candidate));
    const outline = teachingBlueprintToOutlines(blueprint, "使用简体中文")[0]!;
    expect(outline.visualIntent?.representation).toBe("mixed");
    expect(outline.mediaGenerations?.[0]?.aspectRatio).toBe("4:3");
    expect(compileDiagramComponent({ ...outline.visualIntent!.diagram!, type: "diagram", id: "water-cycle",
      left: 50, top: 130, width: 900, height: 360 }).filter((element) => element.type === "line")).toHaveLength(4);
  });

  it("keeps a planned observation image on the page and grounds its generation in the entry scene", async () => {
    const candidate = compactModelBlueprint();
    const page = candidate.sections[0]!.pages[0]!;
    (page as unknown as { entryPoint: { kind: string; object: string; bridge: string } }).entryPoint = {
      kind: "familiar-experience", object: "学生第一次使用智能音箱。",
      bridge: "先观察学生如何理解新的对象。",
    };
    page.caseObservation = {
      imageWouldHelp: true,
      observableDifference: "想象中的动物保留鱼身、牛角、四条腿和花斑；右侧真实动物保持正常身体结构。",
      reason: "必须直接观察想象和真实外观的差异。",
    };
    (page as unknown as { resourceNeeds: Array<Record<string, unknown>> }).resourceNeeds = [{
      kind: "image", purpose: "比较想象动物和真实动物", required: false,
      prompt: "鱼形的想象动物与真实牛并排，无文字。",
    }];
    const blueprint = await generateTeachingBlueprint(input(), async () => JSON.stringify(candidate), {
      resourceCapabilities: { imageGenerationEnabled: true, videoGenerationEnabled: false },
    });
    const outline = teachingBlueprintToOutlines(blueprint, "使用简体中文")[0]!;
    expect(blueprint.sections[0]?.pages[0]?.resourceNeeds?.[0]?.required).toBe(true);
    expect(outline.visualIntent?.resourceRefs?.[0]?.required).toBe(true);
    expect(outline.mediaGenerations?.[0]?.observationContext).toContain("四条腿和花斑");
    expect(outline.visualIntent?.resourceRefs?.[0]?.observationGoal).toBe(page.caseObservation.observableDifference);
    expect(outline.visualIntent?.resourceRefs?.[0]?.reason).toBe("比较想象动物和真实动物");
  });

  it.each([
    ["菌落", "相同培养条件下两种菌落的边缘与颜色不同"],
    ["机器人", "有轮子与机械臂的机器和带翅膀的错误心象对照"],
    ["陶器", "不同时期陶器的口沿与纹样体现用途差异"],
  ])("derives required evidence for %s from one observation even beside a concept diagram", async (subject, difference) => {
    const candidate = compactModelBlueprint();
    const page = candidate.sections[0]!.pages[0]!;
    Object.assign(page, {
      caseObservation: { kind: "generated-image", subjects: [subject], observableDifference: difference,
        reason: "观察形态差异是本页判断依据", composition: "左右同视角并列对照", aspectRatio: "4:3" },
      resourceNeeds: [{ kind: "diagram", purpose: "说明概念关系", required: true }],
    });
    const ai = vi.fn(async () => JSON.stringify(candidate));
    const blueprint = await generateTeachingBlueprint(input(), ai, {
      resourceCapabilities: { imageGenerationEnabled: true, videoGenerationEnabled: false },
    });
    const outline = teachingBlueprintToOutlines(blueprint, "使用简体中文")[0]!;
    expect(ai).toHaveBeenCalledTimes(1);
    expect(blueprint.sections[0]?.pages[0]?.resourceNeeds?.map((need) => need.kind)).toEqual(["diagram", "image"]);
    expect(outline.mediaGenerations?.[0]).toMatchObject({ aspectRatio: "4:3", observationContext: difference });
    expect(outline.mediaGenerations?.[0]?.prompt).toContain(subject);
    expect(outline.mediaGenerations?.[0]?.prompt).toContain(difference);
    expect(outline.visualIntent?.resourceRefs?.[0]?.required).toBe(true);
    expect(outline.visualIntent?.resourceRefs?.[0]?.observationGoal).toBe(difference);
    expect(outline.visualIntent?.resourceRefs?.[0]?.reason).toBe("观察形态差异是本页判断依据");
  });

  it("keeps a no-image observation decision free of decorative legacy requests", async () => {
    const candidate = compactModelBlueprint();
    Object.assign(candidate.sections[0]!.pages[0]!, {
      caseObservation: { kind: "none", subjects: [], observableDifference: "", reason: "只需比较定义边界" },
      resourceNeeds: [{ kind: "image", purpose: "装饰", prompt: "装饰性背景", required: false }],
    });
    const blueprint = await generateTeachingBlueprint(input(), async () => JSON.stringify(candidate));
    expect(teachingBlueprintToOutlines(blueprint, "使用简体中文")[0]?.mediaGenerations).toBeUndefined();
  });

  it("does not reject teaching content using a fixed character-count layout proxy", async () => {
    const candidate = compactModelBlueprint();
    candidate.sections[0]!.pages[0]!.keyPoints = ["保留必要的定义、条件与推理。".repeat(30)];
    const ai = vi.fn(async () => JSON.stringify(candidate));
    await generateTeachingBlueprint(input(), ai);
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it.each([
    { topic: "definition", kind: "statement", preferredForm: "text", rationale: "完整定义用文字便于反复查读。", representation: "text" },
    { topic: "parallel principles", kind: "system", preferredForm: "text", rationale: "原则彼此并列，分组说明更清楚且不暗示先后。", representation: "text" },
    { topic: "comparison", kind: "comparison", preferredForm: "table", rationale: "用同一维度对齐训练集与测试集的用途。", representation: "table" },
    { topic: "ordinary steps", kind: "sequence", preferredForm: "text", rationale: "本页只需记住顺序，编号列表已经足够。", representation: "text" },
  ])("preserves a purposeful $preferredForm selection for $topic without inventing a diagram", async (selection) => {
    const candidate = compactModelBlueprint();
    Object.assign(candidate.sections[0]!.pages[0]!, { visualRelationship: {
      kind: selection.kind, description: selection.rationale, readingOrder: ["训练集", "测试集"],
      preferredForm: selection.preferredForm, rationale: selection.rationale,
    } });
    const ai = vi.fn(async () => JSON.stringify(candidate));
    const blueprint = await generateTeachingBlueprint(input(), ai);
    const outline = teachingBlueprintToOutlines(blueprint, "使用简体中文")[0]!;
    expect(ai).toHaveBeenCalledTimes(1);
    expect(outline.visualIntent).toMatchObject({ representation: selection.representation, rationale: selection.rationale });
    expect(outline.visualIntent?.diagram).toBeUndefined();
  });

  it.each(["text", "table", "chart", "illustration"])("records diagnostics without automatically repairing an explicit %s selection with an attached diagram only at the visual relationship", async (preferredForm) => {
    const candidate = compactModelBlueprint();
    const relationship = {
      kind: "process", description: "处理后复查，根据结果返回改进。", readingOrder: ["处理", "复查"],
      preferredForm, rationale: "先看步骤名称。",
      diagram: {
        topology: "sequence", nodes: [{ id: "process", label: "处理" }, { id: "review", label: "复查" }],
        edges: [{ from: "review", to: "process", label: "反馈" }],
      },
    };
    Object.assign(candidate.sections[0]!.pages[0]!, { visualRelationship: relationship });
    const correction = { ...relationship, preferredForm: "mixed", rationale: "文字解释复查依据，连线显示返回处理步骤的反馈关系。" };
    const ai = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(candidate))
      .mockImplementationOnce(async (_system: string, user: string) => JSON.stringify({
        baseFingerprint: JSON.parse(user).baseFingerprint,
        edits: [{ path: "sections.0.pages.0.visualRelationship", value: correction }],
      }));
    const audits = vi.fn();
    const firstPassValidation = vi.fn();
    await expectBlueprintQualityIssue(generateTeachingBlueprint(input(), ai, { ...({ onValidation: audits }), onValidation: firstPassValidation }));
    expect(ai).toHaveBeenCalledTimes(1);
    expect(firstPassValidation).toHaveBeenCalledOnce();
    expect(firstPassValidation.mock.calls[0]![0].issues.length).toBeGreaterThan(0);
    expect(firstPassValidation.mock.calls[0]![0].repairAttempts).toBe(0);
  });

  it("rejects diagram deletion in a selection repair and keeps the better draft for the next local patch", async () => {
    const candidate = compactModelBlueprint();
    const relationship = {
      kind: "process", description: "复查结果返回处理。", readingOrder: ["处理", "复查"],
      preferredForm: "text", rationale: "步骤名称可读。",
      diagram: { topology: "sequence", nodes: [{ id: "process", label: "处理" }, { id: "review", label: "复查" }],
        edges: [{ from: "review", to: "process", label: "反馈" }] },
    };
    Object.assign(candidate.sections[0]!.pages[0]!, { visualRelationship: relationship });
    const correction = { ...relationship, preferredForm: "diagram", rationale: "本页新增认识是复查后可以返回处理，连线显示这条反馈路径。" };
    const ai = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(candidate))
      .mockImplementationOnce(async (_system: string, user: string) => JSON.stringify({
        baseFingerprint: JSON.parse(user).baseFingerprint,
        edits: [{ path: "sections.0.pages.0.visualRelationship", value: { ...relationship, diagram: null } }],
      }))
      .mockImplementationOnce(async (_system: string, user: string) => JSON.stringify({
        baseFingerprint: JSON.parse(user).baseFingerprint,
        edits: [{ path: "sections.0.pages.0.visualRelationship", value: correction }],
      }));
    const audits = vi.fn();
    const firstPassValidation = vi.fn();
    await expectBlueprintQualityIssue(generateTeachingBlueprint(input(), ai, { ...({ onValidation: audits }), onValidation: firstPassValidation }));
    expect(ai).toHaveBeenCalledTimes(1);
    expect(firstPassValidation).toHaveBeenCalledOnce();
    expect(firstPassValidation.mock.calls[0]![0].issues.length).toBeGreaterThan(0);
    expect(firstPassValidation.mock.calls[0]![0].repairAttempts).toBe(0);
  });

  it("keeps capacity errors visible while a presentation conflict is repaired", () => {
    const candidate = compactModelBlueprint();
    const relationship = {
      kind: "process", description: "完整循环。", readingOrder: ["第一步"], preferredForm: "text", rationale: "先阅读说明。",
      diagram: { topology: "cycle", nodes: Array.from({ length: 7 }, (_, index) => ({
        id: `step-${index + 1}`, label: `第${index + 1}步${"必须另写正文说明的完整解释".repeat(15)}`,
      })) },
    };
    Object.assign(candidate.sections[0]!.pages[0]!, { visualRelationship: relationship });
    const validation = validateTeachingBlueprintDraft(candidate, input());
    const repair = JSON.parse(buildTeachingBlueprintRepairPrompt(input(), candidate, validation.issues, 2).user);
    expect(repair.issueDetails.map((issue: { code: string }) => issue.code)).toEqual(["diagram-capacity", "visual-form-conflict"]);
    expect(repair.allowedPaths).toContain("sections.0.pages");
    const corrected = structuredClone(candidate);
    Object.assign(corrected.sections[0]!.pages[0]!, { visualRelationship: { ...relationship, preferredForm: "diagram" } });
    const remaining = validateTeachingBlueprintDraft(corrected, input());
    expect(remaining.blueprint).toBeUndefined();
    expect(remaining.issues).toHaveLength(1);
    expect(remaining.issues[0]).toContain("图示节点、连接或说明无法在单页排下");
  });

  it("reads legacy diagrams without preferredForm and retains a confirmed historical visual contract", async () => {
    const candidate = compactModelBlueprint();
    const relationship = {
      kind: "process", description: "先处理再复查。", readingOrder: ["处理", "复查"],
      diagram: { topology: "sequence", nodes: [{ id: "process", label: "处理" }, { id: "review", label: "复查" }] },
    };
    Object.assign(candidate.sections[0]!.pages[0]!, { visualRelationship: relationship });
    const ai = vi.fn(async () => JSON.stringify(candidate));
    const blueprint = await generateTeachingBlueprint(input(), ai);
    expect(ai).toHaveBeenCalledTimes(1);
    expect(teachingBlueprintToOutlines(blueprint, "使用简体中文")[0]!.visualIntent?.diagram).toEqual(relationship.diagram);
    const stored = structuredClone(blueprint);
    stored.sections[0]!.pages[0]!.visualRelationship!.preferredForm = "table";
    expect(validateTeachingBlueprintDraft(stored, input()).issues.join("；")).toContain("视觉选型矛盾");
    const revalidated = revalidateStoredTeachingBlueprint(stored, input());
    expect(revalidated.issues).toEqual([]);
    expect(revalidated.blueprint?.sections).toEqual(stored.sections);
    expect(revalidated.blueprint?.sections[0]!.pages[0]!.visualRelationship?.diagram).toEqual(relationship.diagram);
  });

  it("carries a seven-step cycle with a separate annotation to the first slide pass", async () => {
    const candidate = compactModelBlueprint();
    const page = candidate.sections[0]!.pages[0]!;
    (page as unknown as { visualRelationship: Record<string, unknown> }).visualRelationship = {
      kind: "process",
      description: "七个实际教学步骤形成完整循环。",
      readingOrder: ["目标", "导入", "讲解", "示范", "练习", "反馈", "强化"],
      preferredForm: "diagram",
      rationale: "学生需要看清每一步的前后关系。",
      diagram: {
        topology: "cycle",
        nodes: ["目标", "导入", "讲解", "示范", "练习", "反馈", "强化"]
          .map((label, index) => ({ id: `step-${index + 1}`, label })),
        annotation: "教学闭环",
      },
    };
    const blueprint = await generateTeachingBlueprint(input(), async () => JSON.stringify(candidate));
    const outline = teachingBlueprintToOutlines(blueprint, "使用简体中文")[0]!;

    expect(outline.visualIntent?.representation).toBe("native-diagram");
    expect(outline.visualIntent?.diagram).toMatchObject({ topology: "cycle", annotation: "教学闭环" });
    expect(outline.visualIntent?.diagram?.nodes).toHaveLength(7);
    expect(outline.visualIntent?.diagram?.nodes.map((node) => node.label)).not.toContain("教学闭环");
  });

  it("keeps an ordinary process sequential even when it includes a feedback edge", async () => {
    const candidate = compactModelBlueprint();
    const page = candidate.sections[0]!.pages[0]!;
    (page as unknown as { visualRelationship: Record<string, unknown> }).visualRelationship = {
      kind: "process", description: "先处理再复查。", readingOrder: ["收集", "处理", "复查"],
      preferredForm: "diagram", rationale: "复查提供对处理步骤的反馈。",
      diagram: {
        topology: "sequence",
        nodes: [
          { id: "collect", label: "收集" },
          { id: "process", label: "处理" },
          { id: "review", label: "复查" },
        ],
        edges: [{ from: "review", to: "process", label: "反馈" }],
        annotation: "按结果改进处理方式",
      },
    };
    const blueprint = await generateTeachingBlueprint(input(), async () => JSON.stringify(candidate));
    const diagram = teachingBlueprintToOutlines(blueprint, "使用简体中文")[0]?.visualIntent?.diagram;
    expect(diagram?.topology).toBe("sequence");
    expect(diagram?.edges).toEqual([{ from: "review", to: "process", label: "反馈" }]);
    expect(diagram?.annotation).toBe("按结果改进处理方式");
  });

  it.each([false, true])("preserves independent ordered processes in one diagram (explicit groups: %s)", async (explicitGroups) => {
    const candidate = compactModelBlueprint();
    const groups = [
      { id: "process-a", label: "概念学习", nodeIds: ["a1", "a2", "a3"] },
      { id: "process-b", label: "项目实现", nodeIds: ["b1", "b2"] },
    ];
    const diagram = {
      topology: "sequence" as const,
      nodes: [
        { id: "a1", label: "回顾旧知" }, { id: "a2", label: "实践探究" }, { id: "a3", label: "课堂小结" },
        { id: "b1", label: "任务分析" }, { id: "b2", label: "反思总结" },
      ],
      edges: [{ from: "a1", to: "a2" }, { from: "a2", to: "a3" }, { from: "b1", to: "b2" }],
      ...(explicitGroups ? { sequenceGroups: groups } : {}),
    };
    Object.assign(candidate.sections[0]!.pages[0]!, { visualRelationship: {
      kind: "process", description: "两套不同用途的学习流程。", readingOrder: ["概念学习", "项目实现"],
      preferredForm: "diagram", rationale: "分别看清两套流程的步骤顺序，不能把它们串成一个过程。", diagram,
    } });
    const ai = vi.fn(async () => JSON.stringify(candidate));
    const blueprint = await generateTeachingBlueprint(input(), ai);
    expect(ai).toHaveBeenCalledTimes(1);
    const compiled = teachingBlueprintToOutlines(blueprint, "使用简体中文")[0]!.visualIntent!.diagram!;
    expect(compiled.nodes).toEqual(diagram.nodes);
    expect(compiled.edges).toEqual(diagram.edges);
    expect(compiled.sequenceGroups?.map((group) => group.nodeIds)).toEqual(groups.map((group) => group.nodeIds));
    if (explicitGroups) expect(compiled.sequenceGroups).toEqual(groups);
    const elements = compileDiagramComponent({ ...compiled, type: "diagram", id: "parallel-processes",
      left: 50, top: 112, width: 900, height: 394 });
    expect(elements.filter((element) => element.type === "shape")).toHaveLength(5);
    expect(elements.filter((element) => element.type === "line")).toHaveLength(3);
  });

  it("rejects parallel process groups that omit or share a teaching node", () => {
    const candidate = compactModelBlueprint();
    const diagram = { topology: "sequence", nodes: [
      { id: "a1", label: "回顾旧知" }, { id: "a2", label: "课堂小结" },
      { id: "b1", label: "任务分析" }, { id: "b2", label: "反思总结" },
    ], edges: [{ from: "a1", to: "a2" }, { from: "b1", to: "b2" }],
    sequenceGroups: [{ id: "process-a", nodeIds: ["a1", "a2"] }, { id: "process-b", nodeIds: ["a2", "b1"] }] };
    Object.assign(candidate.sections[0]!.pages[0]!, { visualRelationship: {
      kind: "process", description: "两套学习流程。", readingOrder: ["第一类", "第二类"],
      preferredForm: "diagram", rationale: "对照各自顺序。", diagram,
    } });
    const validation = validateTeachingBlueprintDraft(candidate, input());
    expect(validation.issues.some((issue) => issue.includes("图示拓扑或连接结构无效"))).toBe(true);
  });

  it("preserves parallel teaching methods as a branch in the first draft and compiled outline", async () => {
    const candidate = compactModelBlueprint();
    const relationship = {
      kind: "system", description: "从核心关系选择适合的教学方法。", readingOrder: ["核心关系", "正反例", "动画", "体验"],
      preferredForm: "diagram", rationale: "三种方法分别服务同一核心关系，并不要求依次执行。",
      diagram: {
        topology: "branch",
        nodes: [
          { id: "n1", label: "核心关系" }, { id: "n2", label: "正反例" },
          { id: "n3", label: "演示动画" }, { id: "n4", label: "具身体验" },
        ],
        edges: [{ from: "n1", to: "n2" }, { from: "n1", to: "n3" }, { from: "n1", to: "n4" }],
      },
    };
    Object.assign(candidate.sections[0]!.pages[0]!, { visualRelationship: relationship });
    const ai = vi.fn(async () => JSON.stringify(candidate));
    const blueprint = await generateTeachingBlueprint(input(), ai);
    expect(ai).toHaveBeenCalledTimes(1);
    const outline = teachingBlueprintToOutlines(blueprint, "使用简体中文")[0]!;
    expect(outline.visualIntent?.representation).toBe("native-diagram");
    expect(outline.visualIntent?.diagram).toEqual(relationship.diagram);
    const elements = compileDiagramComponent({ ...outline.visualIntent!.diagram!, type: "diagram", id: "teaching-methods",
      left: 50, top: 112, width: 900, height: 394 });
    expect(elements.filter((element) => element.type === "shape")).toHaveLength(4);
    expect(elements.filter((element) => element.type === "line")).toHaveLength(3);
  });

  it("rejects forward cross-links in a sequence and repairs only its topology to preserve the actual branch", async () => {
    const candidate = compactModelBlueprint();
    const relationship = {
      kind: "system", description: "从核心关系选择适合的教学方法。", readingOrder: ["核心关系", "正反例", "动画", "体验"],
      preferredForm: "diagram", rationale: "并列选择应保留真实分支关系。",
      diagram: {
        topology: "sequence",
        nodes: [
          { id: "n1", label: "核心关系" }, { id: "n2", label: "正反例" },
          { id: "n3", label: "演示动画" }, { id: "n4", label: "具身体验" },
        ],
        edges: [{ from: "n1", to: "n2" }, { from: "n1", to: "n3" }, { from: "n1", to: "n4" }],
      },
    };
    Object.assign(candidate.sections[0]!.pages[0]!, { visualRelationship: relationship });
    const invalid = validateTeachingBlueprintDraft(candidate, input());
    expect(invalid.blueprint).toBeUndefined();
    expect(invalid.issues.join("；")).toContain("sequence cross-links must point backward as feedback");
    expect(invalid.issues.join("；")).toContain("图示拓扑或连接结构无效");
    expect(invalid.issues.join("；")).not.toContain("无法在单页排下");
    const correction = { ...relationship, diagram: { ...relationship.diagram, topology: "branch" } };
    const corrected = structuredClone(candidate);
    Object.assign(corrected.sections[0]!.pages[0]!, { visualRelationship: correction });
    expect(validateTeachingBlueprintDraft(corrected, input()).blueprint).toBeDefined();
    const ai = vi.fn(async (_system: string, user: string) => JSON.stringify({
      baseFingerprint: JSON.parse(user).baseFingerprint,
      edits: [{ path: "sections.0.pages.0.visualRelationship", value: correction }],
    }));
    const firstPassValidation = vi.fn();
    await expectBlueprintQualityIssue(generateTeachingBlueprint(input(), ai, { ...({
      repairFrom: { candidate, issues: invalid.issues },
    }), onValidation: firstPassValidation }));
    expect(ai).toHaveBeenCalledTimes(0);
    expect(firstPassValidation).toHaveBeenCalledOnce();
    expect(firstPassValidation.mock.calls[0]![0].issues.length).toBeGreaterThan(0);
    expect(firstPassValidation.mock.calls[0]![0].repairAttempts).toBe(0);
  });

  it("rejects a diagram whose explanatory annotation was also made a step", async () => {
    const candidate = compactModelBlueprint();
    const page = candidate.sections[0]!.pages[0]!;
    (page as unknown as { visualRelationship: Record<string, unknown> }).visualRelationship = {
      kind: "process", description: "讲解和练习形成循环。", readingOrder: ["讲解", "练习"],
      preferredForm: "diagram", rationale: "需要看清环路。",
      diagram: {
        topology: "cycle",
        nodes: [
          { id: "teach", label: "讲解" },
          { id: "practice", label: "练习" },
          { id: "loop", label: "闭环" },
        ],
        annotation: "闭环",
      },
    };
    const validation = vi.fn();
    await expectBlueprintQualityIssue(generateTeachingBlueprint(input(), async () => JSON.stringify(candidate), {
      onValidation: validation,
      retrySleep: async () => undefined,
    }), "教学蓝图缺少可用结构");
    expect(validation.mock.calls[0]?.[0].issues).toContain("第 1 节第 1 页整体说明不能重复作为流程节点");
  });

  it("rejects a structurally valid diagram whose labels cannot fit on a slide", async () => {
    const candidate = compactModelBlueprint();
    const page = candidate.sections[0]!.pages[0]!;
    (page as unknown as { visualRelationship: Record<string, unknown> }).visualRelationship = {
      kind: "process", description: "七步流程", readingOrder: ["目标", "情境"],
      preferredForm: "diagram", rationale: "需要看到完整环路。",
      diagram: {
        topology: "cycle",
        nodes: Array.from({ length: 7 }, (_, index) => ({
          id: `step-${index + 1}`,
          label: `这是一个必须另写正文说明的第${index + 1}个流程节点的完整解释句`,
        })),
        annotation: "完整环路",
      },
    };
    const validation = vi.fn();
    await expectBlueprintQualityIssue(generateTeachingBlueprint(input(), async () => JSON.stringify(candidate), {
      onValidation: validation,
      retrySleep: async () => undefined,
    }), "教学蓝图缺少可用结构");
    expect(validation.mock.calls[0]?.[0].issues.join("；")).toContain("图示节点、连接或说明无法在单页排下");
    expect(validation.mock.calls[0]?.[0].details).toEqual([
      expect.objectContaining({ code: "diagram-capacity", sectionIndex: 0, pageIndex: 0 }),
    ]);
    const repair = JSON.parse(buildTeachingBlueprintRepairPrompt(input(), candidate, validation.mock.calls[0]![0].issues, 2).user);
    expect(repair.allowedPaths).toContain("sections.0.pages");
  });

  it("rejects an image request without an executable description on the first pass", async () => {
    const candidate = compactModelBlueprint();
    (candidate.sections[0]!.pages[0]! as unknown as { resourceNeeds: Array<Record<string, unknown>> }).resourceNeeds = [{
      kind: "image", purpose: "观察想象中的动物", required: true,
    }];
    const ai = vi.fn(async () => JSON.stringify(candidate));
    const validation = vi.fn();

    await expectBlueprintQualityIssue(generateTeachingBlueprint(input(), ai, {
      onValidation: validation,
      retrySleep: async () => undefined,
    }), "教学蓝图缺少可用结构");
    expect(ai).toHaveBeenCalledTimes(1);
    expect(validation.mock.calls[0]?.[0].issues).toContain("第 1 节第 1 页第 1 项图片需求缺少观察目的或可执行的生成描述");
  });

  it("uses the default 16:9 framing and keeps image-disabled lessons executable", async () => {
    const candidate = compactModelBlueprint();
    (candidate.sections[0]!.pages[0]! as unknown as { resourceNeeds: Array<Record<string, unknown>> }).resourceNeeds = [{
      kind: "image", purpose: "观察同一植物在晴天和雨天的外观", required: true,
      prompt: "同视角的校园植物晴天和雨天状态对照，无文字",
    }];
    const blueprint = await generateTeachingBlueprint(input(), async () => JSON.stringify(candidate));
    expect(teachingBlueprintToOutlines(blueprint, "使用简体中文")[0]?.mediaGenerations?.[0]?.aspectRatio).toBe("16:9");

    const disabled = adaptTeachingBlueprintResourceCapabilities(blueprint, {
      imageGenerationEnabled: false,
      videoGenerationEnabled: false,
    });
    const disabledOutline = teachingBlueprintToOutlines(disabled, "使用简体中文")[0]!;
    expect(disabledOutline.mediaGenerations).toBeUndefined();
    expect(disabledOutline.visualIntent?.representation).toBe("native-diagram");
  });

  it("keeps different crops of one example as distinct generated resources", async () => {
    const candidate = modelBlueprint();
    const sharedPrompt = "同一株校园植物的完整轮廓，浅色背景，无文字标签";
    const first = candidate.sections[0]!.pages[0]!;
    const second = candidate.sections[1]!.pages[0]!;
    (first as unknown as { resourceNeeds: Array<Record<string, unknown>> }).resourceNeeds = [{
      kind: "image", purpose: "观察植物整体形态", required: true,
      prompt: sharedPrompt, aspectRatio: "1:1",
    }];
    (second as unknown as { resourceNeeds: Array<Record<string, unknown>> }).resourceNeeds = [{
      kind: "image", purpose: "观察植物纵向结构", required: true,
      prompt: sharedPrompt, aspectRatio: "9:16",
    }];
    const blueprint = await generateTeachingBlueprint(input(), async () => JSON.stringify(candidate));
    const outlines = teachingBlueprintToOutlines(blueprint, "使用简体中文").filter((outline) => outline.type === "slide");
    expect(outlines[0]?.mediaGenerations?.[0]?.aspectRatio).toBe("1:1");
    expect(outlines[1]?.mediaGenerations?.[0]?.aspectRatio).toBe("9:16");
    expect(outlines[0]?.mediaGenerations?.[0]?.elementId).not.toBe(outlines[1]?.mediaGenerations?.[0]?.elementId);
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

    await expectBlueprintQualityIssue(generateTeachingBlueprint(input(), ai, { retrySleep: async () => undefined }), "教学蓝图缺少可用结构");
    expect(ai).toHaveBeenCalledTimes(1);
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

    await expectBlueprintQualityIssue(generateTeachingBlueprint(input(), ai, {
      onValidation,
      retrySleep: async () => undefined,
    }), "教学蓝图缺少可用结构");
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

    await expectBlueprintQualityIssue(generateTeachingBlueprint(coreInput, ai, { onValidation, retrySleep: async () => undefined }), "教学蓝图缺少可用结构");
    expect(onValidation.mock.calls.at(-1)?.[0].issues.join("；")).toContain("核心概念“训练集”缺少");
    expect(ai).toHaveBeenCalledTimes(1);
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

  it("reports deterministic audit findings without requesting a patch", async () => {
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
      .mockImplementationOnce(async (_system: string, user: string) => JSON.stringify({
        baseFingerprint: JSON.parse(user).baseFingerprint,
        edits: [{ path: "sections.0.units.0.explanationNodes", value: repaired.sections[0]!.units[0]!.explanationNodes }],
      }));

    const firstPassValidation = vi.fn();
    await expectBlueprintQualityIssue(generateTeachingBlueprint(repairInput, ai, { ...({
      retrySleep: async () => undefined,
    }), onValidation: firstPassValidation }));
    expect(ai).toHaveBeenCalledTimes(1);
    expect(firstPassValidation).toHaveBeenCalledOnce();
    expect(firstPassValidation.mock.calls[0]![0].issues.length).toBeGreaterThan(0);
    expect(firstPassValidation.mock.calls[0]![0].repairAttempts).toBe(0);
  });

  it("stops on JSON null without requesting a replacement", async () => {
    const onValidation = vi.fn();
    const ai = vi.fn()
      .mockResolvedValueOnce("{这份蓝图不是可解析的 JSON}")
      .mockResolvedValueOnce(JSON.stringify(compactModelBlueprint()));

    const firstPassValidation = vi.fn();
    await expect(generateTeachingBlueprint(input(), ai, { ...({
      onValidation,
      retrySleep: async () => undefined,
    }), onValidation: firstPassValidation })).rejects.toThrow();
    expect(ai).toHaveBeenCalledTimes(1);
    expect(firstPassValidation).toHaveBeenCalledOnce();
    expect(firstPassValidation.mock.calls[0]![0].issues.length).toBeGreaterThan(0);
    expect(firstPassValidation.mock.calls[0]![0].repairAttempts).toBe(0);
  });

  it("rejects an incompatible saved blueprint without another model call", async () => {
    const incompatible = {
      sections: [{
        title: "数据角色",
        understandingGoals: ["解释数据角色"],
        pages: [{
          title: "训练集",
          unitMappings: [{ knowledgePointIds: ["kp-train"] }],
          caseObservation: "案例观察：比较两组照片",
          finalTaskConnection: "最终任务连接判定：无",
        }],
      }],
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify(compactModelBlueprint()));

    const firstPassValidation = vi.fn();
    await expect(generateTeachingBlueprint(input(), ai, { ...({
      repairFrom: {
        response: JSON.stringify(incompatible),
        issues: ["第 1 节缺少教学单元或页面"],
      },
    }), onValidation: firstPassValidation })).rejects.toThrow();
    expect(ai).toHaveBeenCalledTimes(0);
    expect(firstPassValidation).toHaveBeenCalledOnce();
    expect(firstPassValidation.mock.calls[0]![0].issues.length).toBeGreaterThan(0);
    expect(firstPassValidation.mock.calls[0]![0].repairAttempts).toBe(0);
  });

  it("restores explicitly owned section nodes without another model call", async () => {
    const draft = compactModelBlueprint();
    const nodeId = "teaching-section-1-unit-1-node-1";
    const section = draft.sections[0]!;
    const misplaced = {
      sections: [{
        ...section,
        explanationNodes: [{ ...section.units[0]!.explanationNodes[0]!, id: nodeId }],
        units: section.units.map((unit) => ({ ...unit, explanationNodes: [] })),
        pages: section.pages.map((page) => ({ ...page, introducesNodeIds: [nodeId] })),
      }],
    };
    const ai = vi.fn();

    const blueprint = await generateTeachingBlueprint(input(), ai, {
      repairFrom: {
        response: JSON.stringify(misplaced),
        issues: ["第 1 节解释节点 teaching-section-1-unit-1-node-1 未分配给任何页面"],
      },
    });

    expect(ai).not.toHaveBeenCalled();
    expect(blueprint.sections[0]?.units[0]?.explanationNodes?.[0]?.id).toBe(nodeId);
    expect(blueprint.sections[0]?.pages[0]?.introducesNodeIds).toEqual([nodeId]);
  });

  it("does not assign section nodes when their declared unit does not exist", async () => {
    const draft = compactModelBlueprint();
    const section = draft.sections[0]!;
    const incompatible = {
      sections: [{
        ...section,
        explanationNodes: [{
          ...section.units[0]!.explanationNodes[0]!,
          id: "teaching-section-1-unit-2-node-1",
        }],
        units: section.units.map((unit) => ({ ...unit, explanationNodes: [] })),
      }],
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify(compactModelBlueprint()));

    const firstPassValidation = vi.fn();
    await expectBlueprintQualityIssue(generateTeachingBlueprint(input(), ai, { ...({
      repairFrom: {
        response: JSON.stringify(incompatible),
        issues: ["第 1 节解释节点未分配给页面"],
      },
    }), onValidation: firstPassValidation }));
    expect(ai).toHaveBeenCalledTimes(0);
    expect(firstPassValidation).toHaveBeenCalledOnce();
    expect(firstPassValidation.mock.calls[0]![0].issues.length).toBeGreaterThan(0);
    expect(firstPassValidation.mock.calls[0]![0].repairAttempts).toBe(0);
  });

  it("preserves an invalid first draft without attempting unrelated page edits", async () => {
    const repairInput = input();
    repairInput.knowledgePoints = repairInput.knowledgePoints.map((point) => point.id === "kp-train"
      ? { ...point, teachingRole: "core-concept" as const }
      : point);
    const first = compactModelBlueprint();
    first.sections[0]!.units[0]!.explanationNodes[0]!.content = "训练数据参与模型学习。";
    const corrected = structuredClone(first);
    corrected.sections[0]!.units[0]!.explanationNodes[0]!.content = "训练集是用于学习模型参数的数据，核心主张是用已知样本形成可迁移规律。";
    const ai = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(first))
      .mockImplementationOnce(async (_system: string, user: string) => JSON.stringify({
        baseFingerprint: JSON.parse(user).baseFingerprint,
        edits: [{ path: "sections.0.pages.0.taskConnection", value: { mode: "none", rationale: "无关修改" } }],
      }))
      .mockImplementationOnce(async (_system: string, user: string) => JSON.stringify({
        baseFingerprint: JSON.parse(user).baseFingerprint,
        edits: [{ path: "sections.0.units.0.explanationNodes", value: corrected.sections[0]!.units[0]!.explanationNodes }],
      }));

    const firstPassValidation = vi.fn();
    await expectBlueprintQualityIssue(generateTeachingBlueprint(repairInput, ai, { ...({
      retrySleep: async () => undefined,
    }), onValidation: firstPassValidation }));
    expect(ai).toHaveBeenCalledTimes(1);
    expect(firstPassValidation).toHaveBeenCalledOnce();
    expect(firstPassValidation.mock.calls[0]![0].issues.length).toBeGreaterThan(0);
    expect(firstPassValidation.mock.calls[0]![0].repairAttempts).toBe(0);
  });

  it("keeps a usable persisted blueprint with diagnostics and no model call", async () => {
    const repairInput = input();
    repairInput.knowledgePoints = repairInput.knowledgePoints.map((point) => point.id === "kp-train"
      ? { ...point, teachingRole: "core-concept" as const }
      : point);
    const invalid = compactModelBlueprint();
    invalid.sections[0]!.units[0]!.explanationNodes[0]!.content = "训练数据参与模型学习。";
    const repaired = structuredClone(invalid);
    repaired.sections[0]!.units[0]!.explanationNodes[0]!.content = "训练集是用于学习模型参数的数据，核心主张是从已知样本中归纳可迁移规律。";
    const issue = "第 1 节核心概念“训练集”缺少 term/concept 解释节点";
    const ai = vi.fn().mockImplementation(async (_system: string, user: string) => JSON.stringify({
      baseFingerprint: JSON.parse(user).baseFingerprint,
      edits: [{ path: "sections.0.units.0.explanationNodes", value: repaired.sections[0]!.units[0]!.explanationNodes }],
    }));

    const firstPassValidation = vi.fn();
    await expectBlueprintQualityIssue(generateTeachingBlueprint(repairInput, ai, { ...({
      repairFrom: { response: JSON.stringify(invalid), issues: [issue] },
      retrySleep: async () => undefined,
    }), onValidation: firstPassValidation }));
    expect(ai).toHaveBeenCalledTimes(0);
    expect(firstPassValidation).toHaveBeenCalledOnce();
    expect(firstPassValidation.mock.calls[0]![0].issues.length).toBeGreaterThan(0);
    expect(firstPassValidation.mock.calls[0]![0].repairAttempts).toBe(0);
  });

  it("preserves the saved candidate without requesting a replacement or patch", async () => {
    const scoped = input();
    scoped.knowledgePoints = scoped.knowledgePoints.map((point) => point.id === "kp-train"
      ? { ...point, teachingRole: "core-concept" as const } : point);
    const draft = compactModelBlueprint();
    draft.sections[0]!.units[0]!.explanationNodes[0]!.content = "训练数据参与模型学习。";
    const audits: Array<{ candidate?: unknown; repairAttempts?: number }> = [];
    const ai = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ sections: [] }))
      .mockResolvedValueOnce("{broken-json");
    const firstPassValidation = vi.fn();
    await expectBlueprintQualityIssue(generateTeachingBlueprint(scoped, ai, { ...({
      repairFrom: { candidate: draft, issues: ["saved issue"] },
      onValidation: (validation) => { audits.push(validation); },
    }), onValidation: firstPassValidation }));
    expect(ai).toHaveBeenCalledTimes(0);
    expect(firstPassValidation).toHaveBeenCalledOnce();
    expect(firstPassValidation.mock.calls[0]![0].issues.length).toBeGreaterThan(0);
    expect(firstPassValidation.mock.calls[0]![0].repairAttempts).toBe(0);
  });

  it("reports the original structural error without attempting content patches", async () => {
    const scoped = input();
    scoped.knowledgePoints = scoped.knowledgePoints.map((point) => point.id === "kp-train"
      ? { ...point, teachingRole: "core-concept" as const } : point);
    const draft = compactModelBlueprint();
    draft.sections[0]!.units[0]!.explanationNodes[0]!.content = "训练数据参与模型学习。";
    const corrected = structuredClone(draft);
    corrected.sections[0]!.units[0]!.explanationNodes[0]!.content = "训练集是用于学习模型参数的数据。";
    const audits: Array<{ candidate?: unknown }> = [];
    const ai = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(draft))
      .mockImplementationOnce(async (_system: string, user: string) => JSON.stringify({
        baseFingerprint: JSON.parse(user).baseFingerprint,
        edits: [{ path: "sections.0.units.0.explanationNodes", value: [{
          ...draft.sections[0]!.units[0]!.explanationNodes[0]!, content: "",
        }] }],
      }))
      .mockImplementationOnce(async (_system: string, user: string) => JSON.stringify({
        baseFingerprint: JSON.parse(user).baseFingerprint,
        edits: [{ path: "sections.0.units.0.explanationNodes", value: corrected.sections[0]!.units[0]!.explanationNodes }],
      }));
    const firstPassValidation = vi.fn();
    await expectBlueprintQualityIssue(generateTeachingBlueprint(scoped, ai, { ...({
      onValidation: (validation) => { audits.push(validation); },
    }), onValidation: firstPassValidation }));
    expect(ai).toHaveBeenCalledTimes(1);
    expect(firstPassValidation).toHaveBeenCalledOnce();
    expect(firstPassValidation.mock.calls[0]![0].issues.length).toBeGreaterThan(0);
    expect(firstPassValidation.mock.calls[0]![0].repairAttempts).toBe(0);
  });

  it("adopts a valid candidate saved between validation and final checkpoint", async () => {
    const ai = vi.fn();
    const blueprint = await generateTeachingBlueprint(input(), ai, {
      repairFrom: { candidate: modelBlueprint(), issues: [] },
    });
    expect(ai).not.toHaveBeenCalled();
    expect(blueprint.sections).toHaveLength(2);
  });

  it("keeps repair instructions bounded to the audited draft and immutable contract", () => {
    const current = compactModelBlueprint();
    const prompt = buildTeachingBlueprintRepairPrompt(
      input(),
      current,
      ["第 1 节缺少完整的理解目标"],
      2,
    );

    expect(prompt.system).toContain("每个 path 必须在 allowedPaths 中");
    expect(prompt.system).toContain("不得返回整份蓝图");
    expect(prompt.system).toContain("保持原有长度、节点顺序、每个 node.id 及 knowledgePointIds 逐项不变");
    expect(prompt.system).toContain("补入现有 owned node.content，不得新增节点");
    expect(prompt.user).toContain('"repairAttempt":1');
    expect(prompt.user).toContain("第 1 节缺少完整的理解目标");
    expect(prompt.user).toContain("为什么测试必须保持独立");
  });

  it("supplies complete source facts and source-topic ownership to a bounded repair", () => {
    const scoped = input();
    scoped.sourceContext = "教材说明：先分别建立训练和测试，再独立检验新样本。";
    scoped.knowledgePoints = scoped.knowledgePoints.map((point) => point.id === "kp-train"
      ? { ...point, sourceKnowledgePointIds: ["source-role"], evidenceItemIds: ["evidence-roles"] } : point);
    scoped.sourceSequences = [{
      resourceId: "source-sequence:roles", required: true, knowledgePointIds: ["kp-train"],
      scope: "knowledge-point", orderedSteps: [
        { label: "独立划分", sourceBlockId: "step-1" },
        { label: "拟合参数", sourceBlockId: "step-2" },
        { label: "检验新样本", sourceBlockId: "step-3" },
      ],
    }];
    scoped.textbookFigures = [{
      resourceId: "source-figure:roles", figureId: "figure-roles", relation: "direct", required: true,
      knowledgePointIds: ["kp-train"], sourceTitle: "数据角色", orderedSteps: scoped.sourceSequences[0]!.orderedSteps,
    }];
    scoped.teachingRequirements = {
      schemaVersion: 1, conflicts: [], items: [{
        id: "role-highlight", kind: "highlight", source: "resource-package",
        text: "独立测试不参与拟合。", sourceKnowledgePointIds: ["source-role"],
      }],
    };
    const current = compactModelBlueprint();
    const prompt = buildTeachingBlueprintRepairPrompt(scoped, current,
      ["教学要求未覆盖关联知识主题 source-role：独立测试不参与拟合。"], 2);
    const repair = JSON.parse(prompt.user);
    expect(repair.fixedConstraints.sourceContext).toBe(scoped.sourceContext);
    expect(repair.fixedConstraints.sourceSequences).toEqual(scoped.sourceSequences);
    expect(repair.fixedConstraints.textbookFigures).toEqual(scoped.textbookFigures);
    expect(repair.fixedConstraints.acceptanceContract.textbookSequenceCoverage.sequences).toEqual([
      expect.objectContaining({ resourceId: "source-figure:roles", scope: "single-page", requiredItemCount: 3, requiredItems: ["独立划分", "拟合参数", "检验新样本"] }),
      expect.objectContaining({ resourceId: "source-sequence:roles", scope: "knowledge-point", requiredItemCount: 3, requiredItems: ["独立划分", "拟合参数", "检验新样本"] }),
    ]);
    expect(repair.fixedConstraints.knowledgePoints[0]).toMatchObject({
      sourceKnowledgePointIds: ["source-role"], evidenceItemIds: ["evidence-roles"],
    });
    expect(repair.fixedConstraints.acceptanceContract.teachingRequirementIds[0].coverage[0])
      .toMatchObject({ sourceKnowledgePointId: "source-role", eligibleKnowledgePointIds: ["kp-train"] });
    expect(repair.allowedPaths).toContain("sections.0.units.0.explanationNodes");
    expect(repair.allowedPaths).toContain("sections.0.pages.0.keyPoints");
    expect(repair.current).toEqual(current);
  });

  it("records diagnostics without automatically repairing source facts in owned nodes when complete unit prose and a keypoint-only patch do not survive compilation", async () => {
    const { labels, complete, scoped, draft } = embodiedSourceRecoveryFixture();
    const unit = draft.sections[0]!.units[0]!;
    const before = validateTeachingBlueprintDraft(draft, scoped);
    expect(before.blueprint).toBeUndefined();
    expect(before.issues.join("；")).toContain(labels[0]);
    expect(before.issues.join("；")).toContain(labels[1]);
    expect(validateTeachingBlueprintDraft(draft, { ...scoped, sourceSequences: [] }).blueprint).toBeDefined();
    const repairedNodes = unit.explanationNodes.map((node) => ({ ...node, content: complete }));
    const audits: Array<{ candidate?: unknown; repairAttempts?: number }> = [];
    const ai = vi.fn()
      .mockImplementationOnce(async (_system: string, user: string) => JSON.stringify({
        baseFingerprint: JSON.parse(user).baseFingerprint,
        edits: [{ path: "sections.0.pages.0.keyPoints", value: [complete] }],
      }))
      .mockImplementationOnce(async (_system: string, user: string) => JSON.stringify({
        baseFingerprint: JSON.parse(user).baseFingerprint,
        edits: [{ path: "sections.0.units.0.explanationNodes", value: repairedNodes }],
      }));
    const firstPassValidation = vi.fn();
    await expectBlueprintQualityIssue(generateTeachingBlueprint(scoped, ai, { ...({
      repairFrom: { candidate: draft, issues: before.issues },
      onValidation: (validation) => { audits.push(validation); },
    }), onValidation: firstPassValidation }));
    expect(ai).toHaveBeenCalledTimes(0);
    expect(firstPassValidation).toHaveBeenCalledOnce();
    expect(firstPassValidation.mock.calls[0]![0].issues.length).toBeGreaterThan(0);
    expect(firstPassValidation.mock.calls[0]![0].repairAttempts).toBe(0);
  });

  it("records missing source facts and keeps the usable draft without another call", async () => {
    const { labels, complete, scoped, draft } = embodiedSourceRecoveryFixture();
    const before = validateTeachingBlueprintDraft(draft, scoped);
    expect(before.issues).toHaveLength(1);
    expect(before.issues[0]).toContain(scoped.sourceSequences![0]!.resourceId);
    const partial = structuredClone(draft);
    partial.sections[0]!.units[0]!.explanationNodes[0]!.content += ` ${labels[0]}。`;
    const partialIssues = validateTeachingBlueprintDraft(partial, scoped).issues;
    expect(partialIssues).toHaveLength(1);
    expect(partialIssues[0]).toContain(labels[1]);
    expect(partialIssues[0]).not.toContain(labels[0]);
    const audits: Array<{ candidate?: unknown; issues: readonly string[]; repairFailure?: unknown }> = [];
    const ai = vi.fn()
      .mockImplementationOnce(async (_system: string, user: string) => JSON.stringify({
        baseFingerprint: JSON.parse(user).baseFingerprint,
        edits: [{ path: "sections.0.units.0.explanationNodes", value: partial.sections[0]!.units[0]!.explanationNodes }],
      }))
      .mockImplementationOnce(async (_system: string, user: string) => JSON.stringify({
        baseFingerprint: JSON.parse(user).baseFingerprint,
        edits: [{ path: "sections.0.units.0.explanationNodes",
          value: partial.sections[0]!.units[0]!.explanationNodes.map((node) => ({ ...node, content: complete })) }],
      }));
    const firstPassValidation = vi.fn();
    await expectBlueprintQualityIssue(generateTeachingBlueprint(scoped, ai, { ...({
      repairFrom: { candidate: draft, issues: before.issues },
      onValidation: (validation) => { audits.push(validation); },
    }), onValidation: firstPassValidation }));
    expect(ai).toHaveBeenCalledTimes(0);
    expect(firstPassValidation).toHaveBeenCalledOnce();
    expect(firstPassValidation.mock.calls[0]![0].issues.length).toBeGreaterThan(0);
    expect(firstPassValidation.mock.calls[0]![0].repairAttempts).toBe(0);
  });

  it.each(["replacement-source-omission", "new-prerequisite-error"] as const)(
    "stops before source recovery could introduce %s", async (regression) => {
      const { labels, complete, scoped, draft } = embodiedSourceRecoveryFixture();
      const before = validateTeachingBlueprintDraft(draft, scoped);
      const nodes = draft.sections[0]!.units[0]!.explanationNodes;
      const badContent = regression === "replacement-source-omission"
        ? `具身认知的教学设计原则：${labels.filter((_, index) => index !== 2).join("；")}。`
        : complete;
      const badNodes = nodes.map((node) => ({
        ...node, content: badContent,
        prerequisiteNodeIds: regression === "new-prerequisite-error" ? ["not-taught"] : node.prerequisiteNodeIds,
      }));
      const audits: Array<{ candidate?: unknown; repairFailure?: unknown }> = [];
      const ai = vi.fn()
        .mockImplementationOnce(async (_system: string, user: string) => JSON.stringify({
          baseFingerprint: JSON.parse(user).baseFingerprint,
          edits: [
            { path: "sections.0.units.0.explanationNodes", value: badNodes },
            ...(regression === "replacement-source-omission"
              ? [{ path: "sections.0.pages.0.keyPoints", value: [badContent] }] : []),
          ],
        }))
        .mockImplementationOnce(async (_system: string, user: string) => JSON.stringify({
          baseFingerprint: JSON.parse(user).baseFingerprint,
          edits: [{ path: "sections.0.units.0.explanationNodes", value: nodes.map((node) => ({ ...node, content: complete })) }],
        }));
      const firstPassValidation = vi.fn();
    await expectBlueprintQualityIssue(generateTeachingBlueprint(scoped, ai, { ...({
        repairFrom: { candidate: draft, issues: before.issues },
        onValidation: (validation) => { audits.push(validation); },
      }), onValidation: firstPassValidation }));
    expect(ai).toHaveBeenCalledTimes(0);
    expect(firstPassValidation).toHaveBeenCalledOnce();
    expect(firstPassValidation.mock.calls[0]![0].issues.length).toBeGreaterThan(0);
    expect(firstPassValidation.mock.calls[0]![0].repairAttempts).toBe(0);
  },
  );

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
    expect(outlines.find((outline) => outline.type === "quiz")?.description).toContain("2–4 道题");
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
    const revised = recompiled.find((outline) => outline.id === first.id)!;
    expect(revised).toMatchObject({
      title: "教师修订后的解释页",
      description: "先说明数据是否参与学习，再解释这为什么影响评估可信度。",
    });
    expect(revised.keyPoints).toEqual(revised.teachingBrief?.teachingPlan?.presentationContent);
    expect(revised.keyPoints).toEqual(expect.arrayContaining([
      "参与参数学习的数据用于训练", "未参与学习的新数据承担独立检验",
    ]));
    expect(() => applyReviewedOutlinesToTeachingBlueprint(blueprint, reviewed.slice(1)))
      .toThrow("新增、删除或重复页面必须先回到内容设计");
  });

  it("preserves a teacher-confirmed quiz count and format selection when recompiling the outline", async () => {
    const blueprint = await generateTeachingBlueprint(input(), async () => JSON.stringify(compactModelBlueprint()));
    const outlines = teachingBlueprintToOutlines(blueprint, "使用简体中文");
    const reviewed = outlines.map((outline) => outline.type === "quiz" ? {
      ...outline,
      quizConfig: {
        ...outline.quizConfig!, questionCount: 3, questionCountRange: { min: 3, max: 3 },
        difficulty: "hard" as const, questionTypes: ["multiple" as const, "matching" as const],
      },
    } : outline);
    const updated = applyReviewedOutlinesToTeachingBlueprint(blueprint, reviewed);
    const recompiled = teachingBlueprintToOutlines(updated, "使用简体中文");
    expect(recompiled.find((outline) => outline.type === "quiz")?.quizConfig).toMatchObject({
      questionCount: 3, questionCountRange: { min: 3, max: 3 },
      difficulty: "hard", questionTypes: ["multiple", "matching"],
      qualityContract: "grounded-v1", coveragePolicy: "section-synthesis",
    });
    expect(recompiled.find((outline) => outline.type === "quiz")?.description).toContain("3 道题");
    expect(validateTeachingBlueprintBudget(updated, recompiled)).toEqual([]);
  });

  it.each(["short_answer", "scenario_task"] as const)("rejects %s selected for an ordinary section quiz", async (format) => {
    const blueprint = await generateTeachingBlueprint(input(), async () => JSON.stringify(compactModelBlueprint()));
    const outlines = teachingBlueprintToOutlines(blueprint, "使用简体中文");
    const reviewed = outlines.map((outline) => outline.type === "quiz" ? {
      ...outline, quizConfig: { ...outline.quizConfig!, questionTypes: ["single" as const, format] },
    } : outline);
    expect(() => applyReviewedOutlinesToTeachingBlueprint(blueprint, reviewed)).toThrow("测验题量或题型设置无效");
  });

  it("accepts a confirmed concept page without separate reasoning steps", async () => {
    const blueprint = await generateTeachingBlueprint(input(), async () => JSON.stringify(compactModelBlueprint()));
    const outlines = teachingBlueprintToOutlines(blueprint, "使用简体中文");
    const first = outlines.find((outline) => outline.type === "slide")!;
    const reviewed = outlines.map((outline) => outline.id === first.id ? {
      ...outline,
      teachingBrief: {
        ...outline.teachingBrief!,
        teachingPlan: {
          ...outline.teachingBrief!.teachingPlan!,
          reasoningSteps: [],
        },
      },
    } : outline);

    expect(() => applyReviewedOutlinesToTeachingBlueprint(blueprint, reviewed)).not.toThrow();
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
      title: section.title, knowledgePointIds: section.knowledgePointIds,
    }));
    const ai = vi.fn(async () => JSON.stringify(modelBlueprint()));
    await expect(generateTeachingBlueprint(base, ai, { retrySleep: async () => undefined }))
      .resolves.toMatchObject({ schemaVersion: 3 });
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it("revalidates a completed blueprint before adopting it under a new policy", async () => {
    const base = input();
    const stored = await generateTeachingBlueprint(base, async () => JSON.stringify(modelBlueprint()));
    expect(revalidateStoredTeachingBlueprint(stored, base).blueprint?.sections).toEqual(stored.sections);
    const changed = { ...base, sectionPlans: [{ title: "不匹配", knowledgePointIds: ["kp-train"] }] };
    expect(revalidateStoredTeachingBlueprint(stored, changed).blueprint).toBeUndefined();
    const completeSource = { ...base, sourceSequences: [{
      resourceId: 'source-sequence:project-flow', required: true as const,
      knowledgePointIds: ['kp-train'], scope: 'knowledge-point' as const,
      orderedSteps: ['选择项目', '制定计划', '活动探究', '制作作品', '成果交流', '活动评价']
        .map((label, index) => ({ label, sourceBlockId: `b-${index}` })),
    }] };
    expect(revalidateStoredTeachingBlueprint(stored, completeSource).issues.join('；'))
      .toContain('遗漏教材步骤');
  });

  it("revalidates and resumes the actual accepted page plan without renaming identities or rebuilding its timing", async () => {
    const { scoped, stored, complete } = acceptedEmbodiedPlanFixture();
    const original = structuredClone(stored);
    expect(revalidateStoredTeachingBlueprint(stored, scoped).blueprint?.sections).toEqual(stored.sections);
    const ai = vi.fn();
    const restored = await generateTeachingBlueprint(scoped, ai, {
      repairFrom: { candidate: stored, issues: [], preserveAcceptedPagePlans: true },
    });
    expect(ai).not.toHaveBeenCalled();
    expect(restored.budget).toEqual(original.budget);
    expect(restored.sections[0]!.units).toEqual(original.sections[0]!.units);
    expect(restored.sections[0]!.pages).toEqual(original.sections[0]!.pages);
    expect(restored.sections[0]!.reviewedQuizConfig).toEqual(original.sections[0]!.reviewedQuizConfig);
    const outlines = teachingBlueprintToOutlines(restored, "使用简体中文");
    expect(outlines.map((outline) => outline.id)).toEqual(["replanned-body-0", "replanned-body-quiz"]);
    expect(outlines[0]).toMatchObject({
      sourcePageIds: original.sections[0]!.pages[0]!.sourcePageIds,
      sectionPlanVersion: "measured-section-v2",
      plannedTiming: original.sections[0]!.pages[0]!.plannedTiming,
      targetDurationSec: original.sections[0]!.pages[0]!.targetDurationSec,
      teachingUnitIds: ["confirmed-body-unit"], knowledgePointIds: ["kp-body-design"],
      keyPoints: original.sections[0]!.pages[0]!.teachingBrief!.teachingPlan!.presentationContent,
      teachingBrief: original.sections[0]!.pages[0]!.teachingBrief,
    });
    expect(outlines[0]!.teachingBrief?.teachingPlan?.visibleContent).toEqual([complete]);
    expect(validateTeachingBlueprintBudget(restored, outlines)).toEqual([]);
    expect(() => assertSourceSequencesInOutlines(outlines, scoped.sourceSequences!)).not.toThrow();
    expect(stored).toEqual(original);
  });

  it("records diagnostics without automatically repairing the executed accepted brief while complete old nodes and raw keypoints cannot satisfy its source gate", async () => {
    const { scoped, stored, labels, complete } = acceptedEmbodiedPlanFixture({ adoptedComplete: false, nodeComplete: true });
    const before = revalidateStoredTeachingBlueprint(stored, scoped);
    expect(before.blueprint).toBeUndefined();
    expect(before.issues.join("；")).toContain(labels[0]);
    expect(before.issues.join("；")).toContain(labels[1]);
    const ai = vi.fn(async (_system: string, user: string) => JSON.stringify({
      baseFingerprint: JSON.parse(user).baseFingerprint,
      edits: [
        { path: "sections.0.pages.0.teachingBrief.explanation", value: complete },
        { path: "sections.0.pages.0.teachingBrief.teachingPlan.newContent", value: complete },
        { path: "sections.0.pages.0.teachingBrief.teachingPlan.visibleContent", value: [complete] },
      ],
    }));
    const firstPassValidation = vi.fn();
    await expectBlueprintQualityIssue(generateTeachingBlueprint(scoped, ai, { ...({
      repairFrom: { candidate: stored, issues: before.issues, preserveAcceptedPagePlans: true },
    }), onValidation: firstPassValidation }));
    expect(ai).toHaveBeenCalledTimes(0);
    expect(firstPassValidation).toHaveBeenCalledOnce();
    expect(firstPassValidation.mock.calls[0]![0].issues.length).toBeGreaterThan(0);
    expect(firstPassValidation.mock.calls[0]![0].repairAttempts).toBe(0);
  });

  it("ignores a first draft's claimed measured plan and requires its actual owned nodes to cover the source", async () => {
    const { scoped, stored, complete, labels } = acceptedEmbodiedPlanFixture();
    expect(validateTeachingBlueprintDraft(stored, scoped).issues.join("；")).toContain(labels[0]);
    const ai = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(stored))
      .mockImplementationOnce(async (_system: string, user: string) => JSON.stringify({
        baseFingerprint: JSON.parse(user).baseFingerprint,
        edits: [{ path: "sections.0.units.0.explanationNodes", value: stored.sections[0]!.units[0]!.explanationNodes!
          .map((node) => ({ ...node, content: complete })) }],
      }));
    const firstPassValidation = vi.fn();
    await expectBlueprintQualityIssue(generateTeachingBlueprint(scoped, ai, { ...({}), onValidation: firstPassValidation }));
    expect(ai).toHaveBeenCalledTimes(1);
    expect(firstPassValidation).toHaveBeenCalledOnce();
    expect(firstPassValidation.mock.calls[0]![0].issues.length).toBeGreaterThan(0);
    expect(firstPassValidation.mock.calls[0]![0].repairAttempts).toBe(0);
  });

  it("reports source and actual mixed-plan timing errors together without generating a patch", async () => {
    const { scoped, stored, complete } = acceptedEmbodiedPlanFixture({ adoptedComplete: false });
    const section = stored.sections[0]!;
    section.pages.push({
      ...section.pages[0]!, id: "unmeasured-body-page", outlineId: "unmeasured-body-page",
      sectionPlanVersion: undefined, sourcePageIds: undefined, plannedTiming: undefined,
      targetDurationSec: undefined, teachingBrief: undefined,
      introducesNodeIds: [], deepensNodeIds: ["confirmed-body-node"],
    });
    const before = revalidateStoredTeachingBlueprint(stored, scoped);
    expect(before.blueprint).toBeUndefined();
    expect(before.issues.join("；")).toContain("遗漏教材条目");
    expect(before.issues.join("；")).toContain("页面计时与蓝图预算不一致");
    const audits: Array<{ candidate?: unknown; issues: readonly string[]; repairFailure?: unknown }> = [];
    const ai = vi.fn(async (_system: string, user: string) => JSON.stringify({
      baseFingerprint: JSON.parse(user).baseFingerprint,
      edits: [
        { path: "sections.0.pages.0.teachingBrief.explanation", value: complete },
        { path: "sections.0.pages.0.teachingBrief.teachingPlan.visibleContent", value: [complete] },
      ],
    }));
    const firstPassValidation = vi.fn();
    await expectBlueprintQualityIssue(generateTeachingBlueprint(scoped, ai, { ...({
      repairFrom: { candidate: stored, issues: before.issues, preserveAcceptedPagePlans: true },
      onValidation: (validation) => { audits.push(validation); },
    }), onValidation: firstPassValidation }));
    expect(ai).toHaveBeenCalledTimes(0);
    expect(firstPassValidation).toHaveBeenCalledOnce();
    expect(firstPassValidation.mock.calls[0]![0].issues.length).toBeGreaterThan(0);
    expect(firstPassValidation.mock.calls[0]![0].repairAttempts).toBe(0);
  });

  it("resolves a node prerequisite from an earlier taught section but rejects absent or future nodes", async () => {
    const base = input();
    const candidate = modelBlueprint();
    Object.assign(candidate.sections[1]!.units[0]!.explanationNodes[0]!, { prerequisiteNodeIds: ["roles-concept"] });
    const accepted = await generateTeachingBlueprint(base, async () => JSON.stringify(candidate));
    expect(accepted.sections[1]!.units[0]!.explanationNodes![0]!.prerequisiteNodeIds)
      .toEqual(["teaching-section-1-unit-1-node-1"]);

    const future = modelBlueprint();
    Object.assign(future.sections[0]!.units[0]!.explanationNodes[0]!, { prerequisiteNodeIds: ["split-concept"] });
    await expectBlueprintQualityIssue(generateTeachingBlueprint(base, async () => JSON.stringify(future)), "尚未讲授的先备解释节点");

    const referenceOnly = structuredClone(candidate);
    referenceOnly.sections[0]!.pages[0]!.introducesNodeIds = [];
    referenceOnly.sections[0]!.pages[0]!.referencesNodeIds = ["roles-concept"];
    await expectBlueprintQualityIssue(generateTeachingBlueprint(base, async () => JSON.stringify(referenceOnly)), "尚未建立其先备解释");
  });

  it("covers a shared requirement once per source topic and requires a real difficulty strategy", async () => {
    const base = input();
    base.knowledgePoints = base.knowledgePoints.map((point) => ({
      ...point,
      sourceKnowledgePointIds: point.id === "kp-train" || point.id === "kp-test" ? ["source-a"] : ["source-b"],
    }));
    base.teachingRequirements = { schemaVersion: 1, conflicts: [], items: [{
      id: "difficulty-two-topics", kind: "difficulty", source: "resource-package",
      text: "把两个主题的抽象机制转为具体讲法。", appliesTo: "ai-learning", responsibility: "instruction",
      sourceKnowledgePointIds: ["source-a", "source-b"],
    }] };
    const candidate = modelBlueprint();
    Object.assign(candidate.sections[0]!.units[0]!, { requirementIds: ["difficulty-two-topics"], difficultyStrategies: [{
      requirementId: "difficulty-two-topics", learnerObstacle: "把用途与难度混为一谈",
      teachingApproach: "对比同一难度数据是否参与参数学习", understandingEvidence: "能依据用途区分训练与测试",
    }] });
    const findings = vi.fn();
    await expectBlueprintQualityIssue(generateTeachingBlueprint(base, async () => JSON.stringify(candidate), { onValidation: findings }), "source-b");
    expect(findings.mock.calls[0]?.[0].details).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "teaching-requirement", requirementId: "difficulty-two-topics" }),
    ]));

    Object.assign(candidate.sections[1]!.units[0]!, { requirementIds: ["difficulty-two-topics"] });
    await expectBlueprintQualityIssue(generateTeachingBlueprint(base, async () => JSON.stringify(candidate)), "未给教学难点写出具体障碍");
    Object.assign(candidate.sections[1]!.units[0]!, { difficultyStrategies: [{
      requirementId: "difficulty-two-topics", learnerObstacle: "只记随机划分规则",
      teachingApproach: "沿同一植物的连拍照片追踪数据跨集合的过程", understandingEvidence: "能指出信息泄漏路径",
    }] });
    await expect(generateTeachingBlueprint(base, async () => JSON.stringify(candidate)))
      .resolves.toMatchObject({ schemaVersion: 3 });
  });

  it("does not demand duplicate difficulty strategies from units sharing one source theme", async () => {
    const base = input();
    base.knowledgePoints = base.knowledgePoints.map((point) => ({ ...point,
      sourceKnowledgePointIds: point.id === "kp-train" || point.id === "kp-test" ? ["source-data-roles"] : [],
    }));
    base.teachingRequirements = { schemaVersion: 1, conflicts: [], items: [{
      id: "shared-difficulty", kind: "difficulty", source: "resource-package",
      text: "区分训练与测试的实际用途", appliesTo: "ai-learning", responsibility: "instruction",
      sourceKnowledgePointIds: ["source-data-roles"],
    }] };
    const candidate = modelBlueprint();
    const firstUnit = candidate.sections[0]!.units[0]!;
    const secondUnit = structuredClone(firstUnit);
    secondUnit.id = "roles-test";
    secondUnit.knowledgePointIds = ["kp-test"];
    secondUnit.explanationNodes[0]!.id = "roles-test-concept";
    secondUnit.explanationNodes[0]!.knowledgePointIds = ["kp-test"];
    firstUnit.knowledgePointIds = ["kp-train"];
    firstUnit.explanationNodes[0]!.knowledgePointIds = ["kp-train"];
    Object.assign(firstUnit, { requirementIds: ["shared-difficulty"], difficultyStrategies: [{
      requirementId: "shared-difficulty", learnerObstacle: "只看数据难易",
      teachingApproach: "比较数据是否参与参数学习", understandingEvidence: "能依据学习用途判断角色",
    }] });
    candidate.sections[0]!.units.push(secondUnit);
    candidate.sections[0]!.pages[0]!.unitIds.push("roles-test");
    candidate.sections[0]!.pages[0]!.introducesNodeIds.push("roles-test-concept");
    candidate.sections[0]!.understandingCriteria.supportingUnitIds.push("roles-test");
    await expect(generateTeachingBlueprint(base, async () => JSON.stringify(candidate)))
      .resolves.toMatchObject({ schemaVersion: 3 });
  });

  it("keeps learner activities without forcing a lecture-unit requirement ID", async () => {
    const base = input();
    base.teachingRequirements = { schemaVersion: 1, conflicts: [], items: [{
      id: "learner-record", kind: "stage-requirement", source: "resource-package",
      text: "记录关键定义并构思教案", appliesTo: "ai-learning", responsibility: "learner-activity",
      sourceKnowledgePointIds: [],
    }] };
    await expect(generateTeachingBlueprint(base, async () => JSON.stringify(modelBlueprint())))
      .resolves.toMatchObject({ schemaVersion: 3 });
  });

  it("checks first substantive teaching against the textbook order and allows same-page concepts", async () => {
    const base = input();
    base.teachingOrder = {
      primaryRevisionId: "main", baselineKnowledgePointIds: ["kp-train", "kp-test", "kp-split", "kp-leak"],
      knowledgePointIds: ["kp-train", "kp-test", "kp-split", "kp-leak"], anchors: [], adjustments: [],
    };
    const candidate = modelBlueprint();
    await expect(generateTeachingBlueprint(base, async () => JSON.stringify(candidate)))
      .resolves.toMatchObject({ schemaVersion: 3 });

    const reversed = { ...base, teachingOrder: {
      ...base.teachingOrder, knowledgePointIds: ["kp-split", "kp-leak", "kp-train", "kp-test"],
    } };
    const onValidation = vi.fn();
    await expectBlueprintQualityIssue(generateTeachingBlueprint(reversed, async () => JSON.stringify(candidate), {
      onValidation, retrySleep: async () => undefined,
    }), "教材教学顺序倒置");
    expect(onValidation.mock.calls.flatMap(([result]) => result.issues).join("；"))
      .toContain("教材教学顺序倒置");
    expect(buildTeachingBlueprintPrompt(base).user).toContain("已确认课程教学路径");
  });

  it("rejects a prerequisite that is only taught in a later section", async () => {
    const base = input();
    base.knowledgePoints = base.knowledgePoints.map((point) => point.id === "kp-train"
      ? { ...point, parentKnowledgePointIds: ["kp-split"] } : point);
    const ai = vi.fn(async () => JSON.stringify(modelBlueprint()));
    await expectBlueprintQualityIssue(generateTeachingBlueprint(base, ai, { retrySleep: async () => undefined }), "尚未建立上位概念“数据划分”");
  });

  it("does not count a reference-only earlier page as teaching a prerequisite", async () => {
    const base = input();
    base.knowledgePoints = base.knowledgePoints.map((point) => point.id === "kp-split"
      ? { ...point, parentKnowledgePointIds: ["kp-train"] } : point);
    const candidate = modelBlueprint();
    candidate.sections[0]!.pages[0]!.introducesNodeIds = [];
    candidate.sections[0]!.pages[0]!.referencesNodeIds = ["roles-concept"];
    const ai = vi.fn(async () => JSON.stringify(candidate));
    await expectBlueprintQualityIssue(generateTeachingBlueprint(base, ai, { retrySleep: async () => undefined }), "尚未建立上位概念“训练集”");
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

  it("stops when completed output has no usable structure", async () => {
    const ai = vi.fn(async () => JSON.stringify({ sections: [] }));
    const onValidation = vi.fn();
    await expect(generateTeachingBlueprint(input(), ai, {
      onValidation,
      retrySleep: async () => undefined,
    })).rejects.toThrow();
    expect(ai).toHaveBeenCalledTimes(1);
    expect(onValidation).toHaveBeenLastCalledWith(expect.objectContaining({
      issues: ["没有返回 sections"],
      responseCharacters: expect.any(Number),
    }));
  });

  it("accepts a coherent section without a formulaic minimum page count", async () => {
    const ai = vi.fn(async () => JSON.stringify(compactModelBlueprint()));
    const onValidation = vi.fn();
    await expect(generateTeachingBlueprint({
      ...input(),
      sectionPlans: [{
        title: "训练、测试与可靠评估",
        knowledgePointIds: ["kp-train", "kp-test", "kp-split", "kp-leak"],
        teachingBudgetSec: 1_584,
      }],
    }, ai, {
      onValidation,
      retrySleep: async () => undefined,
    })).resolves.toMatchObject({ schemaVersion: 3 });
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it("retains every section-level assessment responsibility beyond the old item limits", async () => {
    const draft = modelBlueprint();
    draft.sections[0]!.assessmentFocus = Array.from({ length: 8 }, (_, index) => `理解责任 ${index + 1}`);
    draft.sections[0]!.understandingCriteria.goals = Array.from({ length: 8 }, (_, index) => `达成目标 ${index + 1}`);
    const blueprint = await generateTeachingBlueprint(input(), async () => JSON.stringify(draft));
    expect(blueprint.sections[0]?.assessmentFocus).toHaveLength(8);
    expect(blueprint.sections[0]?.understandingCriteria.goals).toHaveLength(8);
  });

  it("stops after unusable output without requesting a replacement", async () => {
    const ai = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ sections: [] }))
      .mockResolvedValueOnce(JSON.stringify(modelBlueprint()));
    const firstPassValidation = vi.fn();
    await expect(generateTeachingBlueprint(input(), ai, { ...({
      retrySleep: async () => undefined,
    }), onValidation: firstPassValidation })).rejects.toThrow();
    expect(ai).toHaveBeenCalledTimes(1);
    expect(firstPassValidation).toHaveBeenCalledOnce();
    expect(firstPassValidation.mock.calls[0]![0].issues.length).toBeGreaterThan(0);
    expect(firstPassValidation.mock.calls[0]![0].repairAttempts).toBe(0);
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
    const priorSourceExamples = [{ knowledgePointIds: ["kp-train"], workedExample: "观察植物照片", sourceQuote: "训练集用于学习模型参数。", imagePlanned: true }];
    expect(teachingBlueprintInputFingerprint({ ...base, priorSourceExamples })).not.toBe(fingerprint);
    expect(buildTeachingBlueprintPrompt({ ...base, priorSourceExamples }).user).toContain("观察植物照片");
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
    expect(blueprint.budget.assessmentDurationSec).toBe(60);
    expect(blueprint.budget.learnerActivityDurationSec).toBe(0);
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

it("compiles the single authored node body into compatibility fields and the executed page", async () => {
  const legacy = compactModelBlueprint();
  const unit = legacy.sections[0]!.units[0]!;
  const nodes = [...unit.explanationNodes,
    ...([['mechanism', unit.mechanism], ['example', unit.workedExample], ['condition', unit.conditions[0]!], ['misconception', unit.misconceptions[0]!]] as const)
      .map(([kind, content]) => ({ id: `reliable-${kind}`, kind, content, knowledgePointIds: unit.knowledgePointIds,
        prerequisiteNodeIds: [unit.explanationNodes[0]!.id], provenance: "general-knowledge" })),
  ];
  const authoredUnit: Record<string, unknown> = { ...unit, explanationNodes: nodes };
  for (const field of ['explanation', 'mechanism', 'workedExample', 'conditions', 'misconceptions']) delete authoredUnit[field];
  const candidate = { authoringContract: "blueprint-v1", sections: [{ ...legacy.sections[0], units: [authoredUnit],
    pages: [{ ...legacy.sections[0]!.pages[0], introducesNodeIds: nodes.map((node) => node.id) }],
  }] };
  const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
  const blueprint = await generateTeachingBlueprint(input(), ai);
  expect(ai).toHaveBeenCalledOnce();
  const unmarked = validateTeachingBlueprintDraft({ ...candidate, authoringContract: undefined }, input());
  expect(unmarked.issues).toEqual([]);
  expect(unmarked.blueprint?.sections).toEqual(blueprint.sections);
  expect(blueprint.sections[0]!.units[0]).toMatchObject({ explanation: unit.explanation, mechanism: unit.mechanism,
    workedExample: unit.workedExample, conditions: unit.conditions, misconceptions: unit.misconceptions });
  const outline = teachingBlueprintToOutlines(blueprint, "使用简体中文")[0]!;
  expect(outline.teachingBrief?.teachingPlan?.reasoningSteps).toContain(unit.workedExample);
  expect(outline.teachingBrief?.teachingPlan?.presentationContent).toEqual(legacy.sections[0]!.pages[0]!.keyPoints);
  const prompt = buildTeachingBlueprintPrompt(input());
  expect(prompt.system).toContain('完整讲授的 explanationNodes 不是逐项上屏目录');
  expect(prompt.system).toContain('role 不能只是给完整解释段落换一个名字');
  expect(prompt.system).toContain('所选展示命题仍须准确');
  const example = JSON.parse(prompt.user.split("返回结构：\n")[1]!.split("\n\n按需字段示例")[0]!);
  expect(example.authoringContract).toBe("blueprint-v5");
  expect(example.sections[0].pages[0]).toHaveProperty("presentationItems");
  expect(example.sections[0].pages[0]).not.toHaveProperty("keyPointRefs");
  expect(example.sections[0].pages[0]).not.toHaveProperty("keyPoints");
  expect(example.sections[0].units[0]).not.toHaveProperty("explanation");
});

it("requires independently authored page fields at their executable ownership location on the first request", async () => {
  const candidate = compactModelBlueprint();
  const prompt = buildTeachingBlueprintPrompt(input());
  const exampleText = prompt.user.split("返回结构：\n")[1]!.split("\n\n按需字段示例")[0]!;
  const example = JSON.parse(exampleText);
  const examplePage = example.sections[0].pages[0];
  expect(exampleText).toMatch(/\n\s+"taskConnection": \{/u);
  expect(Object.keys(examplePage.taskConnection)).toEqual(["mode", "rationale"]);
  for (const field of ["entryPoint", "caseObservation", "visualRelationship"]) {
    expect(examplePage).toHaveProperty(field);
    expect(examplePage.taskConnection).not.toHaveProperty(field);
  }
  const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
  await generateTeachingBlueprint(input(), ai);
  expect(ai).toHaveBeenCalledOnce();
  expect(ai.mock.calls[0]![0]).toContain("taskConnection、entryPoint、caseObservation、visualRelationship 都是 page 的同级字段");
  expect(ai.mock.calls[0]![0]).toContain("区别特征不能成为否定另一机制作用的理由");
  expect(ai.mock.calls[0]![0]).toContain("A是否发生决定B是否发生");
  expect(ai.mock.calls[0]![1]).toContain('"invalidConversions":["A是否发生决定B是否发生","A才可能B","没有A便不能B"]');
  const malformed = structuredClone(candidate);
  const page = malformed.sections[0]!.pages[0] as unknown as Record<string, unknown>;
  const taskConnection = page.taskConnection as Record<string, unknown>;
  for (const field of ["entryPoint", "caseObservation", "visualRelationship"]) {
    taskConnection[field] = page[field];
    delete page[field];
  }
  expect(validateTeachingBlueprintDraft(malformed, input()).issues.join("；")).toContain("缺少独立的案例观察与配图判定");
});

it("keeps source item names consistent between first-pass explanations and their native sequence diagram", async () => {
  const labels = ["确认记录的实际用途", "核对证据的原始来源", "检查对象的完整标注"];
  const base = compactModelBlueprint();
  const unit = base.sections[0]!.units[0]!;
  const node = { id: "source-process", kind: "mechanism", content: `流程依次为${labels.join("、")}，每步依据已核对的记录。`,
    knowledgePointIds: unit.knowledgePointIds, prerequisiteNodeIds: [unit.explanationNodes[0]!.id], provenance: "course-source" };
  const page = { ...base.sections[0]!.pages[0], introducesNodeIds: [...base.sections[0]!.pages[0]!.introducesNodeIds, node.id],
    visualRelationship: { kind: "sequence", description: "证据记录核对流程", preferredForm: "diagram", rationale: "保留各检查责任及先后关系。",
      diagram: { topology: "sequence", nodes: labels.map((label, index) => ({ id: `s${index}`, label })),
        edges: [{ from: "s0", to: "s1" }, { from: "s1", to: "s2" }], annotation: "逐项检查后再给出结论。" } } };
  const candidate = { authoringContract: "blueprint-v1", sections: [{ ...base.sections[0],
    units: [{ ...unit, explanationNodes: [...unit.explanationNodes, node] }], pages: [page] }] };
  const scoped: TeachingBlueprintInput = { ...input(), sourceSequences: [{ resourceId: "source-sequence:evidence-check",
    required: true, knowledgePointIds: ["kp-train"], scope: "knowledge-point", sequenceSemantics: "ordered-steps",
    orderedSteps: labels.map((label, index) => ({ label, sourceBlockId: `record-${index}` })) }] };
  const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
  const blueprint = await generateTeachingBlueprint(scoped, ai);
  expect(ai).toHaveBeenCalledOnce();
  expect(ai.mock.calls[0]![0]).toContain("引用教材 orderedSteps 的节点 label 必须保留对应条目的原始名称");
  expect(ai.mock.calls[0]![0]).toContain("所选条目进入页面实际拥有的解释节点");
  expect(ai.mock.calls[0]![0]).toContain("PPT 可准确精炼、解释可自然转述");
  const outlines = teachingBlueprintToOutlines(blueprint, "使用简体中文");
  expect(outlines[0]!.visualIntent?.diagram?.nodes.map((item) => item.label)).toEqual(labels);
  expect(() => assertSourceSequencesInOutlines(outlines, scoped.sourceSequences!)).not.toThrow();
  const shortened = structuredClone(candidate);
  shortened.sections[0]!.pages[0]!.visualRelationship.diagram.nodes[1]!.label = "核对来源";
  expect(validateTeachingBlueprintDraft(shortened, scoped).issues.join("；")).toContain("辅助顺序图未完整保留教材的 3 个步骤");
});

it("authors one complete source list across separate units without presenting a page subset as its total", async () => {
  const labels = ["明确评估对象", "分离训练与检验", "保持数据来源独立", "冻结选择规则", "检查近重复记录"];
  const base = compactModelBlueprint();
  const section = base.sections[0]!;
  const originalUnit = section.units[0]!;
  const firstIds = ["kp-train", "kp-test", "kp-split"];
  const firstUnit = { ...originalUnit, knowledgePointIds: firstIds, explanationNodes: [
    { ...originalUnit.explanationNodes[0]!, knowledgePointIds: firstIds,
      content: `${originalUnit.explanationNodes[0]!.content}本清单共有五条原则，本页讲前四条原则：${labels.slice(0, 4).join("、")}。` },
    { ...originalUnit.explanationNodes[0]!, id: "independent-evaluation-reasoning", kind: "mechanism",
      knowledgePointIds: firstIds, prerequisiteNodeIds: [originalUnit.explanationNodes[0]!.id],
      content: originalUnit.mechanism },
  ] };
  const secondUnit = { ...originalUnit, id: "duplicate-records", knowledgePointIds: ["kp-leak"], explanationNodes: [
    { ...originalUnit.explanationNodes[0]!, id: "duplicate-record-concept", knowledgePointIds: ["kp-leak"],
      content: `第五条原则是${labels[4]}。数据泄漏是测试对象或其近重复记录参与训练，使评估结果混入已见信息的影响。` },
    { ...originalUnit.explanationNodes[0]!, id: "duplicate-record-reasoning", kind: "mechanism",
      knowledgePointIds: ["kp-leak"], prerequisiteNodeIds: ["duplicate-record-concept"],
      content: "同一株植物的连续拍摄记录若跨越两个数据集合，模型就可能利用已经见过的线索，所以必须先识别近重复记录再划分数据。" },
  ] };
  const firstPage = { ...section.pages[0]!, knowledgePointIds: firstIds,
    introducesNodeIds: firstUnit.explanationNodes.map((node) => node.id),
    description: "本清单共有五条原则，本页先讲前四条原则，下一页继续第五条。", keyPoints: labels.slice(0, 4) };
  const secondPage = { ...section.pages[0]!, id: "duplicate-record-page", title: "近重复记录与数据泄漏",
    knowledgePointIds: ["kp-leak"], unitIds: [secondUnit.id],
    introducesNodeIds: secondUnit.explanationNodes.map((node) => node.id),
    description: "继续展开同一清单第五条原则，并说明近重复记录为何破坏独立性。", keyPoints: [labels[4]!] };
  const candidate = { authoringContract: "blueprint-v1", sections: [{ ...section,
    units: [firstUnit, secondUnit], pages: [firstPage, secondPage] }] };
  const scoped: TeachingBlueprintInput = { ...input(), sourceSequences: [{
    resourceId: "source-sequence:independent-evaluation", required: true,
    knowledgePointIds: ["kp-train", "kp-leak"], scope: "knowledge-point", sequenceSemantics: "enumerated-items",
    orderedSteps: labels.map((label, index) => ({ label, sourceBlockId: `evaluation-principle-${index}` })),
  }] };
  const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
  const blueprint = await generateTeachingBlueprint(scoped, ai);
  expect(ai).toHaveBeenCalledOnce();
  expect(ai.mock.calls[0]![1]).toContain('"requiredItemCount":5');
  expect(ai.mock.calls[0]![1]).toContain('"knowledgePointIds":["kp-train","kp-leak"]');
  const outlines = teachingBlueprintToOutlines(blueprint, "使用简体中文");
  expect(outlines).toHaveLength(3); // Two teaching pages and the existing section quiz.
  expect(() => assertSourceSequencesInOutlines(outlines, scoped.sourceSequences!)).not.toThrow();
  expect(revalidateStoredTeachingBlueprint(blueprint, scoped).issues).toEqual([]);
  const falseTotal = structuredClone(candidate);
  falseTotal.sections[0]!.pages[0]!.description = "本清单共有四条原则。";
  expect(validateTeachingBlueprintDraft(falseTotal, scoped).issues.join("；")).toContain("写成 4 条，教材正文清单为 5 条");
  const missingLast = structuredClone(candidate);
  missingLast.sections[0]!.units[1]!.explanationNodes[0]!.content = "数据泄漏是测试对象参与训练，使评估结果混入已见信息的影响。";
  missingLast.sections[0]!.pages[1]!.keyPoints = ["数据泄漏影响独立性"];
  expect(validateTeachingBlueprintDraft(missingLast, scoped).issues.join("；")).toContain(`遗漏教材条目：${labels[4]}`);
});

it("keeps the complete adopted source sequence in a long authored node and its executed lecture", async () => {
  const labels = ["确认用途", "检查来源", "核对标注", "处理缺失", "记录变更", "复核结果"];
  const sourceDetail = "每项记录都要保留原始对象、采集条件和检查依据，区分观察事实与后续判断；遇到证据不足时说明缺口，不能用未经核对的推测代替原始事实。".repeat(90);
  const complete = `${labels[0]}：${sourceDetail}${labels.slice(1).map((label) => `${label}：保留该环节的具体依据及必要条件。`).join("")}`;
  expect(complete.length).toBeGreaterThan(4_000);
  expect(complete.indexOf(labels.at(-1)!)).toBeGreaterThan(4_000);
  const base = compactModelBlueprint();
  const unit = base.sections[0]!.units[0]!;
  const nodes = [...unit.explanationNodes, {
    id: "complete-source-process", kind: "mechanism", content: complete,
    knowledgePointIds: unit.knowledgePointIds, prerequisiteNodeIds: [unit.explanationNodes[0]!.id],
    provenance: "course-source",
  }];
  const authoredUnit: Record<string, unknown> = { ...unit, explanationNodes: nodes,
    evidenceQuotes: [complete.slice(0, 120)] };
  for (const field of ["explanation", "mechanism", "workedExample", "conditions", "misconceptions"]) delete authoredUnit[field];
  const candidate = { authoringContract: "blueprint-v1", sections: [{ ...base.sections[0], units: [authoredUnit],
    pages: [{ ...base.sections[0]!.pages[0], introducesNodeIds: nodes.map((node) => node.id) }],
  }] };
  const original = structuredClone(candidate);
  const scoped: TeachingBlueprintInput = { ...input(), sourceContext: complete,
    sourceSequences: [{ resourceId: "source-sequence:data-review", required: true,
      knowledgePointIds: ["kp-train"], scope: "knowledge-point", sequenceSemantics: "ordered-steps",
      orderedSteps: labels.map((label, index) => ({ label, sourceBlockId: `data-review-${index}` })),
    }],
  };
  const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
  const blueprint = await generateTeachingBlueprint(scoped, ai);
  expect(ai).toHaveBeenCalledOnce();
  expect(candidate).toEqual(original);
  expect(blueprint.sections[0]!.units[0]!.explanationNodes?.[1]?.content).toBe(complete);
  const outlines = teachingBlueprintToOutlines(blueprint, "使用简体中文");
  expect(outlines[0]!.teachingBrief?.explanation).toContain(complete);
  expect(outlines[0]!.teachingBrief?.teachingPlan?.reasoningSteps).toContain(complete);
  expect(outlines[0]!.teachingBrief?.teachingPlan?.narrationFocus).toContain(complete);
  expect(outlines[0]!.teachingBrief?.teachingPlan?.presentationContent).toEqual(base.sections[0]!.pages[0]!.keyPoints);
  expect(() => assertSourceSequencesInOutlines(outlines, scoped.sourceSequences!)).not.toThrow();
  expect(revalidateStoredTeachingBlueprint(blueprint, scoped).blueprint?.sections).toEqual(blueprint.sections);

  const incomplete = structuredClone(candidate);
  incomplete.sections[0]!.units[0]!.explanationNodes = nodes.map((node) => node.id === "complete-source-process"
    ? { ...node, content: complete.slice(0, complete.indexOf(labels.at(-1)!)) } : node);
  expect(validateTeachingBlueprintDraft(incomplete, scoped).issues.join("；")).toContain("遗漏教材步骤：复核结果");
});

it("preserves complete legacy teaching prose while keeping its page summaries bounded", async () => {
  const candidate = compactModelBlueprint();
  const unit = candidate.sections[0]!.units[0]!;
  const detail = "数据用途、检查依据和适用条件应分别说明，评价结论只能建立在已经核对的事实之上。".repeat(120);
  unit.explanation += detail;
  unit.mechanism += `${detail}最终测试必须在冻结模型和参数后进行。`;
  unit.workedExample += `${detail}测试照片不能参与训练或调参。`;
  unit.conditions = Array.from({ length: 12 }, (_, index) => `${detail}第${index + 1}项条件必须单独核对。`);
  unit.misconceptions = [`${detail}不能把已经见过的数据当作独立的新数据。`];
  const page = candidate.sections[0]!.pages[0]!;
  page.description += detail;
  const blueprint = await generateTeachingBlueprint(input(), async () => JSON.stringify(candidate));
  expect(blueprint.sections[0]!.units[0]).toMatchObject({ explanation: unit.explanation, mechanism: unit.mechanism,
    workedExample: unit.workedExample, conditions: unit.conditions, misconceptions: unit.misconceptions });
  expect(blueprint.sections[0]!.pages[0]!.description).toHaveLength(1_600);
});


it("does not turn an incomplete saved recovery envelope into a new authoring request", async () => {
  const ai = vi.fn();
  const onValidation = vi.fn();
  await expect(generateTeachingBlueprint(input(), ai, { repairFrom: { issues: ["原稿无效"] }, onValidation }))
    .rejects.toThrow("缺少可校验正文");
  expect(ai).not.toHaveBeenCalled();
  expect(onValidation).toHaveBeenCalledWith(expect.objectContaining({ repairAttempts: 0, responseCharacters: 0 }));
});

it("keeps a first draft with content gaps intact for final teacher review in one authoring call", async () => {
  const { scoped, draft } = embodiedSourceRecoveryFixture();
  const unit = draft.sections[0]!.units[0]!;
  unit.learningOutcome = "";
  Object.assign(unit.explanationNodes[0]!, { prerequisiteNodeIds: [unit.explanationNodes[0]!.id] });
  const raw = JSON.stringify(draft);
  const author = vi.fn(async () => raw);
  const onValidation = vi.fn();
  const blueprint = await generateTeachingBlueprint({ ...scoped, contentReviewMode: "teacher-final" }, author, { onValidation });
  expect(author).toHaveBeenCalledOnce();
  expect(blueprint.sections[0]!.units[0]!.explanationNodes![0]!.content).toBe(unit.explanationNodes[0]!.content);
  expect(blueprint.sections[0]!.units[0]!.learningOutcome).toBe("");
  expect(blueprint.sections[0]!.units[0]!.explanationNodes![0]!.prerequisiteNodeIds)
    .toEqual([blueprint.sections[0]!.units[0]!.explanationNodes![0]!.id]);
  expect(onValidation).toHaveBeenCalledWith(expect.objectContaining({ issues: [], repairAttempts: 0 }));
  expect(blueprint.sections[0]!.pages[0]!.sourceSequenceUses).toEqual([]);
  expect(validateTeachingBlueprintDraft(draft, scoped).issues.length).toBeGreaterThan(0);
  expect(JSON.stringify(draft)).toBe(raw);
});

it.each(["not JSON", JSON.stringify({ sections: [] })])("keeps unreadable or empty technical output as a single-call failure", async (raw) => {
  const author = vi.fn(async () => raw);
  await expect(generateTeachingBlueprint({ ...input(), contentReviewMode: "teacher-final" }, author)).rejects.toThrow();
  expect(author).toHaveBeenCalledOnce();
});

it("checks executable page timing without automatically reviewing quiz pedagogy", async () => {
  const blueprint = await generateTeachingBlueprint({ ...input(), contentReviewMode: "teacher-final" },
    async () => JSON.stringify(modelBlueprint()));
  const outlines = teachingBlueprintToOutlines(blueprint, "使用简体中文");
  const quiz = outlines.find((page) => page.type === "quiz")!;
  quiz.quizConfig = { ...quiz.quizConfig!, questionCount: 1, questionTypes: ["short_answer"] };
  expect(validateTeachingBlueprintBudget(blueprint, outlines, { reviewContent: false })).toEqual([]);
  expect(validateTeachingBlueprintBudget(blueprint, outlines).length).toBeGreaterThan(0);
  quiz.targetDurationSec = (quiz.targetDurationSec ?? 0) + 1;
  expect(validateTeachingBlueprintBudget(blueprint, outlines, { reviewContent: false }).join("；")).toContain("不守恒");
});

async function expectBlueprintQualityIssue(result: ReturnType<typeof generateTeachingBlueprint>, issue?: string | RegExp) {
  const blueprint = await result;
  expect(blueprint.qualityDiagnostics?.length).toBeGreaterThan(0);
  if (issue && issue !== '教学蓝图缺少可用结构') expect(blueprint.qualityDiagnostics!.join('；')).toMatch(issue);
  return blueprint;
}
