import { ExperimentConfigSchema, type ExperimentConfig, type ExperimentQuestionGroup } from "./experiment";

/** Question wording from CoTeach_Posttest_CoI34_Social_Clarified.docx. */
export const COTEACH_ASSESSMENT_TEMPLATE = {
  id: "coteach-coi34-sus10",
  title: "CoTeach 教学理解与学习体验",
  description: "前测 9 道知识题；后测 9 道知识题、34 道 CoI 和 10 道系统使用体验题。",
  settings: "按文档顺序展示题目与选项，量表为 1–5 分，不设置建议时长。",
  answerKeyNote: "文档未提供知识题答案键；模板记录作答，教师补充参考答案后可自动计分。",
} as const;

export const COTEACH_TEACHER_REFERENCE = "题目中的“教师”指本次课堂中由真人教师与 AI 共同构成的教学团队。";
export const COTEACH_COMMUNITY_REFERENCE = "说明：本部分题目中的“课程参与者”“其他参与者”，均包括本次课堂中的 AI、人类教师和其他同学，他们共同构成课堂学习共同体。请根据你与这一共同体交流、互动和协作的真实感受作答。";
export const COTEACH_SYSTEM_REFERENCE = "下面的“这个系统／该系统”均指本次使用的CoTeach学生端。";

const knowledgeGroup: ExperimentQuestionGroup = {
  id: "coteach-knowledge",
  title: "知识测验（共9题）",
  instruction: "每题请选择一个最符合题意的选项；如确实不知道，请选择 E. 不知道，不必猜测。",
};
const coiInstruction = "本问卷涉及本次课程中的教学支持、社会互动与学习思考体验。请根据真实感受，在每行选择一个数；没有正确或错误答案。\n\n1＝非常不同意；5＝非常同意。2–4 表示两端之间的不同程度。";
const teachingGroup: ExperimentQuestionGroup = {
  id: "coteach-coi-teaching",
  title: "课程学习体验问卷（CoI）· 教学存在（第1—13题）",
  instruction: coiInstruction,
  referenceNote: COTEACH_TEACHER_REFERENCE,
};
const socialGroup: ExperimentQuestionGroup = {
  id: "coteach-coi-social",
  title: "课程学习体验问卷（CoI）· 社会性存在（第14—22题）",
  instruction: coiInstruction,
  referenceNote: COTEACH_COMMUNITY_REFERENCE,
};
const cognitiveGroup: ExperimentQuestionGroup = {
  id: "coteach-coi-cognitive",
  title: "课程学习体验问卷（CoI）· 认知存在（第23—34题）",
  instruction: coiInstruction,
};
const usabilityGroup: ExperimentQuestionGroup = {
  id: "coteach-sus",
  title: "系统使用体验问卷（C-SUS）",
  instruction: "请根据实际使用感受作答，而不是评价课程知识难度或自己的能力。每行选择一个数。\n\n1＝非常不同意；5＝非常同意。2–4表示两端之间的不同程度。\n\n量表：Chinese System Usability Scale（C-SUS），10题。中文题项完整采用最终发表版本；来源：[3] Wang, Y., Lei, T., & Liu, X. (2020). Chinese System Usability Scale: Translation, Revision, Psychological Measurement. International Journal of Human–Computer Interaction, 36(10), 953–963，表7。DOI: 10.1080/10447318.2019.1700644。",
  referenceNote: COTEACH_SYSTEM_REFERENCE,
};

const knowledgeQuestions = [
  {
    "id": "K01",
    "type": "single-choice",
    "prompt": "K01　按照本课“教学理论—教学模式—教学方法”的划分，下列哪项是对“教学模式”的恰当界定？",
    "options": [
      "对教学现象及其规律的系统解释，为组织教学活动提供一般依据。",
      "为实现具体教学目标采取的活动方式，直接用于开展某项教学活动。",
      "在一定理论指导下形成的教学程序与要素关系，构成教学的组织框架。",
      "对一节课的目标、内容、活动和时间所作的安排，形成课堂实施方案。",
      "不知道"
    ],
    "category": "knowledge"
  },
  {
    "id": "K02",
    "type": "single-choice",
    "prompt": "K02　建构主义所强调的“主动建构”，主要指学习者进行哪一种活动？",
    "options": [
      "自主选择学习内容与进度，并按照个人偏好调整学习活动。",
      "依据已有经验解释新信息，通过比较与反思调整知识联系。",
      "独立发现尚未给出的知识结论，并按发现顺序整理所学内容。",
      "参与讨论形成小组共同结论，并依据共同表述统一个人的认识。",
      "不知道"
    ],
    "category": "knowledge"
  },
  {
    "id": "K03",
    "type": "single-choice",
    "prompt": "K03　按照本课的具身认知观点，身体经验与概念理解的关系主要是：",
    "options": [
      "身体经验提供感官材料，概念的组织由后续独立的符号加工完成。",
      "身体经验帮助巩固已有概念，概念形成后的动作再现促进记忆。",
      "身体经验促进动作程序熟练，概念理解随着操作程序自动化而形成。",
      "身体经验参与概念的形成与组织，感知和动作方式影响理解过程。",
      "不知道"
    ],
    "category": "knowledge"
  },
  {
    "id": "K04",
    "type": "single-choice",
    "prompt": "K04　项目式教学与一般的作品制作活动，最关键的区别在于：",
    "options": [
      "围绕驱动问题组织知识学习与持续探究，并据此形成和完善成果。",
      "围绕真实作品组织已学知识的综合应用，并通过成品检验掌握程度。",
      "围绕共同成果分解制作任务并分工实施，再将各部分合成为完整作品。",
      "围绕作品目标提供分阶段的制作范例，再依完成要求逐步形成成品。",
      "不知道"
    ],
    "category": "knowledge"
  },
  {
    "id": "K05",
    "type": "single-choice",
    "prompt": "K05　下列哪项最能体现探究式教学中“形成解释”的核心要求？",
    "options": [
      "按给定程序再现实验现象，用结果与教材结论的一致程度确认解释。",
      "比较证据对不同解释的支持程度，据此形成、检验或修订自己的解释。",
      "沿教师预设线索自行发现规律，用发现与预期答案的吻合程度确认解释。",
      "将资料中的多种观点归纳整合，用观点体系内部的一致程度确认解释。",
      "不知道"
    ],
    "category": "knowledge"
  },
  {
    "id": "K06",
    "type": "single-choice",
    "prompt": "K06　按照本课的区分，问题式教学最强调以下哪种组织关系？",
    "options": [
      "先系统学习相关知识，再选择复杂问题检验知识的综合运用。",
      "围绕待检验的假设选择资料或开展实验，以形成对规律的解释。",
      "以可交流成果及其持续完善为线索，组织相关的知识学习与探究。",
      "由复杂问题的分析明确学习需要，再用所学知识论证解决方案。",
      "不知道"
    ],
    "category": "knowledge"
  },
  {
    "id": "K07",
    "type": "single-choice",
    "prompt": "K07　任务驱动教学中的“任务”，区别于一般作业要求的主要作用是：",
    "options": [
      "使学习内容的选取和应用围绕完成任务的需要展开。",
      "使知识学习结束后的应用表现能够通过完成结果得到评价。",
      "使学习活动能够分解为连续步骤，并按完成清单检查进度。",
      "使不同成员分别承担一部分学习内容，再汇总各自的学习成果。",
      "不知道"
    ],
    "category": "knowledge"
  },
  {
    "id": "K08",
    "type": "single-choice",
    "prompt": "K08　决定是否进一步撤除学习支架时，下列哪项表现最能支持这一决定？",
    "options": [
      "保留原有步骤提示，能够稳定获得正确结果且完成速度逐步提高。",
      "不再查看步骤提示，能够准确复述步骤并解释各步骤的先后关系。",
      "无需原有步骤提示，能够选择解决办法并自行检查和修正错误。",
      "主动请求提示的次数减少，能够按时提交完整的任务成果。",
      "不知道"
    ],
    "category": "knowledge"
  },
  {
    "id": "K09",
    "type": "single-choice",
    "prompt": "K09　抛锚式教学中，情境作为“锚”的核心作用是：",
    "options": [
      "用典型案例呈现知识应用过程，使学习者依据既有原理解释案例。",
      "为问题界定、信息需求和方案评价提供共同依据，持续组织后续学习。",
      "用同一真实主题连接各个知识单元，使学习者形成连贯的知识图景。",
      "把抽象问题转化为直观演示，使学习者观察完整过程并总结解题步骤。",
      "不知道"
    ],
    "category": "knowledge"
  }
] as const;

const teachingItems = [
  [
    "01",
    "教师清楚地告知了重要的课程主题。"
  ],
  [
    "02",
    "教师清楚地告知了重要的课程目标。"
  ],
  [
    "03",
    "教师对如何参与课程学习活动给予明确说明。"
  ],
  [
    "04",
    "教师清楚地告知了重要学习活动的截止日期或时间范围。"
  ],
  [
    "05",
    "教师可以辨别课程主题中理解一致和分歧的部分，这能够帮助我学习。"
  ],
  [
    "06",
    "教师会引导我们理解课程主题，这能帮助我理清思路。"
  ],
  [
    "07",
    "教师帮助学生投入并参与到富有成效的对话中。"
  ],
  [
    "08",
    "教师帮助学生持续地参与课程任务，这能帮助我学习。"
  ],
  [
    "09",
    "教师鼓励课程参与者探索课程中的新概念。"
  ],
  [
    "10",
    "教师的行为有助于课程参与者形成社区感。"
  ],
  [
    "11",
    "教师能够帮助我们聚焦相关问题的讨论，这能帮助我学习。"
  ],
  [
    "12",
    "教师通过提供反馈来帮助我了解自己的优点和缺点。"
  ],
  [
    "13",
    "教师提供了及时的反馈意见。"
  ]
] as const;

const socialItems = [
  [
    "14",
    "通过在课程中了解其他参与者的情况，我可以获得归属感。"
  ],
  [
    "15",
    "我能够对一些课程参与者形成清晰的印象。"
  ],
  [
    "16",
    "在线或基于网络的交流是参与社会交互的绝佳媒介。"
  ],
  [
    "17",
    "通过在线媒体开展对话让我感到很舒服。"
  ],
  [
    "18",
    "参与课程讨论让我觉得很舒服。"
  ],
  [
    "19",
    "和其他课程参与者交互，我感到舒服。"
  ],
  [
    "20",
    "即使与其他课程参与者意见不一致也让我感到舒服，我们仍然保持着信任感。"
  ],
  [
    "21",
    "我觉得我的观点能够得到其他课程参与者认可。"
  ],
  [
    "22",
    "在线讨论能帮助我发展协作感。"
  ]
] as const;

const cognitiveItems = [
  [
    "23",
    "课程中提出的问题增加了我对课程内容的兴趣。"
  ],
  [
    "24",
    "课程活动激发了我的好奇心。"
  ],
  [
    "25",
    "我感觉自己有积极性来探索与学习内容相关的问题。"
  ],
  [
    "26",
    "我利用各种信息资源来探索课程中提出的问题。"
  ],
  [
    "27",
    "进行头脑风暴并找到相关信息能够帮助我解决与课程内容相关的问题。"
  ],
  [
    "28",
    "在线讨论能够帮助我欣赏不同的观点。"
  ],
  [
    "29",
    "整合新信息能够帮助我回答课程活动中提出的问题。"
  ],
  [
    "30",
    "学习活动可以帮助我形成对问题的解释思路或解决方案。"
  ],
  [
    "31",
    "反思课程内容与讨论能够帮助我理解课堂所学的基本概念。"
  ],
  [
    "32",
    "我能够说出检验和应用课程中学到的知识的方法。"
  ],
  [
    "33",
    "我已经形成了课程中问题的解决方案，此方案可应用于实践。"
  ],
  [
    "34",
    "我能将课程中所学知识应用到我的工作或其他非课堂的相关活动中。"
  ]
] as const;

const usabilityItems = [
  [
    "S01",
    "我愿意经常使用这个系统。"
  ],
  [
    "S02",
    "我发现这个系统太复杂。"
  ],
  [
    "S03",
    "我认为这个系统使用起来很容易。"
  ],
  [
    "S04",
    "我认为我需要技术人员的帮助才能使用这个系统。"
  ],
  [
    "S05",
    "我发现这个系统很好地集成了各种功能。"
  ],
  [
    "S06",
    "在使用该系统的过程中，我发现很多操作结果和预想功能不一致。"
  ],
  [
    "S07",
    "我想大多数用户能很快学会使用该系统。"
  ],
  [
    "S08",
    "我发现这个系统使用起来很别扭。"
  ],
  [
    "S09",
    "我对熟练掌握这个系统很有信心。"
  ],
  [
    "S10",
    "在使用这个系统之前，我需要学习很多知识。"
  ]
] as const;

function scaleQuestions(items: readonly (readonly [string, string])[], group: ExperimentQuestionGroup, prefix: string) {
  return items.map(([number, prompt]) => ({
    id: `${prefix}${number}`,
    type: "scale" as const,
    prompt: `${prefix}${number}　${prompt}`,
    scale: { min: 1, max: 5, minLabel: "非常不同意", maxLabel: "非常同意" },
    group,
  }));
}

/** Each application returns an independent draft; editing it cannot change the template. */
export function createCoTeachAssessmentTemplate(): ExperimentConfig {
  return ExperimentConfigSchema.parse({
    enabled: true,
    sharedQuestions: knowledgeQuestions.map((question) => ({ ...question, group: knowledgeGroup })),
    pretest: [],
    posttest: [
      ...scaleQuestions(teachingItems, teachingGroup, "CoI"),
      ...scaleQuestions(socialItems, socialGroup, "CoI"),
      ...scaleQuestions(cognitiveItems, cognitiveGroup, "CoI"),
      ...scaleQuestions(usabilityItems, usabilityGroup, ""),
    ],
    pretestIntroduction: "本次前测包含 9 道知识题。请根据课前的知识理解独立作答；如确实不知道，请选择 E. 不知道，不必猜测。",
    posttestIntroduction: "本次后测包含 9 道知识题、34 道课程学习体验题（CoI）和 10 道系统使用体验题（C-SUS）。请先阅读各题组的作答说明与指代说明，再根据知识理解和真实体验作答。",
    randomizeQuestionOrder: false,
    randomizeOptionOrder: false,
  });
}
