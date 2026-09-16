/**
 * Frozen inputs for the course-quality comparison. Both variants consume the
 * same page briefs; the enhanced arm only receives the separately generated
 * teaching design.
 */
export interface LabPageFixture {
  title: string;
  purpose: string;
  keyPoints: string[];
}

export interface LabSectionFixture {
  id: string;
  scenario: "中小学人工智能通识课" | "大学《人工智能教育导论》";
  title: string;
  subject: string;
  grade: string;
  learningObjectives: string[];
  sources: Array<{ title: string; detail: string; url?: string }>;
  pages: LabPageFixture[];
  questionCount: number;
  targetPageDurationSec: number;
}

export const LAB_BATCHES = [1] as const;
export const LAB_LANGUAGE_DIRECTIVE =
  "全程使用自然、准确的简体中文讲授；仅保留必要的公式、代码、标准缩写和专有名词。";

export const LAB_SECTION_FIXTURES: readonly LabSectionFixture[] = [
  {
    id: "generative-ai-verification",
    scenario: "中小学人工智能通识课",
    title: "生成式AI：会表达不等于会求证",
    subject: "人工智能通识",
    grade: "初高中",
    learningObjectives: [
      "解释生成式人工智能根据数据模式生成内容，而不是从真相数据库中直接查找答案",
      "使用目标、背景、约束和输出要求改进任务表达，并对关键事实进行独立核验",
      "在作业情境中识别隐私、版权、虚假内容和替代独立思考的风险",
    ],
    sources: [
      {
        title: "《中小学人工智能通识教育指南（2025年版）》",
        detail:
          "中小学人工智能通识教育面向全体学生，系统覆盖基本概念、技术原理、应用场景、伦理安全和社会影响，发展知识、技能、思维和价值观。课程应分层递进，培养批判性思维、人机协作能力、人工智能素养和社会责任意识。",
        url: "https://www.cse.edu.cn/index/detail.html?category=31&id=4240",
      },
      {
        title: "《中小学生成式人工智能使用指南（2025年版）》相关要求",
        detail:
          "中小学使用生成式人工智能应以个人隐私和数据安全为前提，遵循适龄、教师指导和规范使用原则。学生不应在作业中简单复制生成内容，不应用其参加考试作弊，不应在未经核验时把生成结果当作事实，也不应输入个人敏感信息或未经授权传播他人作品。小学阶段不应由学生独自使用开放式内容生成功能。",
        url: "https://www.moe.gov.cn/jyb_xxgk/xxgk_jyta/jyta_jijiaosi/202512/t20251222_1424190.html",
      },
      {
        title: "UNESCO《学生人工智能能力框架》与《生成式人工智能教育与研究指南》",
        detail:
          "学生应理解人工智能技术与应用，形成以人为本和伦理意识，能够批判性评估人工智能输出。教育应用需要保护人的能动性、隐私、公平、包容和文化语言多样性；工具需要经过伦理和教学适切性验证，并保留人的事实判断与最终责任。",
        url: "https://www.unesco.org/en/articles/ai-competency-framework-students",
      },
      {
        title: "实验材料：校史介绍生成任务",
        detail:
          "学生让生成式人工智能撰写校史介绍，系统给出语言流畅但包含一个无法在校志和学校官网找到的获奖年份。生成模型根据输入与训练中学到的语言模式生成后续内容，流畅度不是事实性的保证。核验流程应先标记姓名、年份、数据和引文等高风险主张，再查阅校志、官方网站或原始文件，记录证据并改写；提示词改善只能提高任务匹配度，不能替代事实核验。",
      },
    ],
    pages: [
      {
        title: "为什么流畅回答也可能出错",
        purpose: "从校史介绍案例解释生成机制、事实错误和拟人化误区，区分表达质量与证据可靠性。",
        keyPoints: [
          "生成式人工智能依据数据模式生成内容，流畅不等于真实",
          "姓名、年份、数据、引文和来源属于优先核验对象",
          "不能把自信语气或详细表述当作证据",
        ],
      },
      {
        title: "把提示、核验与责任连成工作流",
        purpose: "推演目标—背景—约束—输出要求的提示结构，再用权威来源核验、标注修改并保留人的最终判断。",
        keyPoints: [
          "清晰提示帮助系统理解任务，但不能保证事实正确",
          "关键主张需要查阅独立、权威或原始来源交叉核验",
          "保护隐私、尊重版权、说明使用情况并保留独立思考和最终责任",
        ],
      },
    ],
    questionCount: 2,
    targetPageDurationSec: 90,
  },
  {
    id: "ai-education-introduction",
    scenario: "大学《人工智能教育导论》",
    title: "从育人目标到人机协同教学",
    subject: "人工智能教育导论",
    grade: "大学本科",
    learningObjectives: [
      "区分学习人工智能、利用人工智能学习和研究人工智能重塑教育三个层次",
      "按照学习目标、学习证据、学习活动和人工智能作用设计协同课堂",
      "根据任务性质划分教师、学生和人工智能职责，并设置核验、替代和反思机制",
    ],
    sources: [
      {
        title: "教育部等五部门《“人工智能+教育”行动计划》",
        detail:
          "人工智能与教育融合应坚持育人为本、素养为先、应用导向和智能向善，推动人工智能教育普及、人才培养、教育教学变革与治理能力提升。技术应用需要服务人的全面发展，促进知识传授与能力培养、技术应用与人文关怀相统一。",
        url: "https://www.moe.gov.cn/srcsite/A16/s3342/202604/t20260410_1433240.html",
      },
      {
        title: "UNESCO《教师人工智能能力框架》",
        detail:
          "教师人工智能能力包括以人为本、人工智能伦理、人工智能基础与应用、人工智能教学法、人工智能促进专业学习五个维度。人工智能教学法要求教师判断是否需要使用人工智能、选择合适工具，把学科教学法和教学设计结合起来，完成设计、实施、评价和反思循环。",
        url: "https://www.unesco.org/en/articles/ai-competency-framework-teachers",
      },
      {
        title: "UNESCO《生成式人工智能教育与研究指南》",
        detail:
          "教育中的生成式人工智能应用需要经过伦理与教学适切性验证，以人为本地设计人与智能体的互动。人工智能应增强学习者和教师的能力，不应取代学习目标、人的判断、师生关系与教育责任。",
        url: "https://www.unesco.org/en/articles/guidance-generative-ai-education-and-research",
      },
      {
        title: "设计案例：论证写作课中的AI反馈",
        detail:
          "课程目标是学生能够提出有证据支持的论点并回应反例。学生先独立提交论点和证据，人工智能根据教师提供的量规生成追问而不是代写文章；学生核验追问涉及的事实并记录采纳或拒绝理由，教师抽查证据链并评价最终论证。实施后比较初稿、修订说明和终稿，检查论证质量、认知投入、错误采纳与不同学生的可及性。若工具不可用或不适合，提供同等目标的同伴互评路径。",
      },
    ],
    pages: [
      {
        title: "先界定人工智能教育的目标与边界",
        purpose: "比较学习人工智能、利用人工智能学习和人工智能条件下的教育变革，并从育人目标判断是否需要使用人工智能。",
        keyPoints: [
          "学习人工智能关注知识、技能、思维和责任",
          "利用人工智能学习需要证明工具改善了具体学习过程",
          "先确定学习目标与证据，再决定是否以及怎样使用人工智能",
        ],
      },
      {
        title: "把人机分工设计成教学闭环",
        purpose: "用论证写作案例推演学生独立产出、AI追问、事实核验、教师评价和替代路径，形成设计—实施—评价—反思闭环。",
        keyPoints: [
          "人工智能承担限定任务，学生保留思考、证据选择和表达",
          "教师承担目标设计、过程监督、结果评价和教学责任",
          "设置核验记录、隐私保护、无法使用时的替代路径和课后反思",
        ],
      },
    ],
    questionCount: 2,
    targetPageDurationSec: 90,
  },
] as const;

export function getLabSectionFixture(id: string): LabSectionFixture {
  const fixture = LAB_SECTION_FIXTURES.find((item) => item.id === id);
  if (!fixture) throw new Error(`Unknown lab section: ${id}`);
  return fixture;
}
