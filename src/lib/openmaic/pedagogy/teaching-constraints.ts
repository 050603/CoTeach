export type LearnerSupportLevel = 'high-scaffold' | 'balanced' | 'independent';
export type LearnerGradeBand = 'primary' | 'middle-school' | 'high-school' | 'vocational' | 'higher-education' | 'general';

export interface LearnerProfileInput {
  priorKnowledge?: string;
  learningNeeds?: string;
  familiarContexts?: string;
}

export interface TeachingConstraints {
  grade: string;
  subject: string;
  topic: string;
  courseHours: number;
  totalMinutes: number;
  recommendedKnowledgePointRange: { min: number; max: number };
  scopeRule: string;
  gradeBand: LearnerGradeBand;
  supportLevel: LearnerSupportLevel;
  learnerFoundation: string;
  learningNeeds: string[];
  familiarContexts: string[];
  learningObjectives: string[];
  allowedKnowledgePoints: Array<{ id: string; name: string; level?: string }>;
  terminologyRule: string;
  abstractionRule: string;
  exampleRule: string;
  progressionRule: string;
  assessmentRule: string;
}

export function deriveCourseScope(hours?: number): Pick<
  TeachingConstraints,
  'courseHours' | 'totalMinutes' | 'recommendedKnowledgePointRange' | 'scopeRule'
> {
  const courseHours = Number.isFinite(hours) ? Math.max(1 / 60, Number(hours)) : 1;
  const totalMinutes = Math.max(1, Math.round(courseHours * 60));
  if (courseHours <= 0.5) {
    return {
      courseHours,
      totalMinutes,
      recommendedKnowledgePointRange: { min: 2, max: 5 },
      scopeRule: 'Use the short lesson for a few essential learning targets with sufficient explanation. Embed supporting terms inside those targets and defer optional expansion rather than naming many shallow targets.',
    };
  }
  if (courseHours <= 1) {
    return {
      courseHours,
      totalMinutes,
      recommendedKnowledgePointRange: { min: 5, max: 8 },
      scopeRule: 'Keep a compact AI-literacy scope: use several fine-grained concepts to explain one coherent mechanism, include one guided application, and require one small verifiable outcome.',
    };
  }
  if (courseHours <= 2) {
    return {
      courseHours,
      totalMinutes,
      recommendedKnowledgePointRange: { min: 8, max: 12 },
      scopeRule: 'Use a focused AI-literacy scope: establish a fine-grained prerequisite chain, compare at least two examples or methods, provide guided practice, and complete one bounded application with evidence.',
    };
  }
  if (courseHours <= 3) {
    return {
      courseHours,
      totalMinutes,
      recommendedKnowledgePointRange: { min: 10, max: 15 },
      scopeRule: 'Use a moderate AI-literacy scope with foundations, mechanism explanation, comparison of methods, guided application, and one revision cycle. Depth must remain appropriate to the learner stage.',
    };
  }
  if (courseHours <= 4) {
    return {
      courseHours,
      totalMinutes,
      recommendedKnowledgePointRange: { min: 12, max: 18 },
      scopeRule: 'Use the available sessions for a complete fine-grained foundation-to-application progression, evidence collection, testing, and at least one meaningful revision.',
    };
  }
  return {
    courseHours,
    totalMinutes,
    recommendedKnowledgePointRange: { min: 15, max: 22 },
    scopeRule: 'Use the course for a complete AI-literacy project with fine-grained concepts, sustained inquiry, multiple evidence cycles, testing, feedback, and iteration; avoid repetition or superficial filler.',
  };
}

function splitItems(value?: string): string[] {
  return (value ?? '')
    .split(/[\n；;，,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function inferGradeBand(grade: string): LearnerGradeBand {
  const value = grade.trim().toLowerCase();
  // Match explicit education stages before bare year numbers. Otherwise
  // "本科一年级" is incorrectly classified as primary school because it
  // contains "一年级", which then corrupts examples, terminology and depth.
  if (/职高|中职|高职|技校|vocational/.test(value)) return 'vocational';
  if (/大学|本科|研究生|硕士|博士|college|university|higher/.test(value)) return 'higher-education';
  if (/高中|高一|高二|高三|high school|senior/.test(value)) return 'high-school';
  if (/初中|七年级|八年级|九年级|初一|初二|初三|middle|junior/.test(value)) return 'middle-school';
  if (/小学|一年级|二年级|三年级|四年级|五年级|六年级|primary|elementary/.test(value)) return 'primary';
  return 'general';
}

function gradeDefaults(gradeBand: LearnerGradeBand): Pick<TeachingConstraints, 'supportLevel' | 'learnerFoundation' | 'terminologyRule' | 'abstractionRule' | 'exampleRule'> {
  switch (gradeBand) {
    case 'primary':
      return {
        supportLevel: 'high-scaffold',
        learnerFoundation: 'Assume concrete everyday experience but little formal disciplinary vocabulary.',
        terminologyRule: 'Use one new term at a time. Explain it immediately in plain language and pair it with a concrete example or visual.',
        abstractionRule: 'Prefer observation, comparison, and concrete cause-and-effect; avoid unexplained symbolic or multi-step abstraction.',
        exampleRule: 'Use home, school, games, nature, and familiar objects; keep scenarios short and observable.',
      };
    case 'middle-school':
      return {
        supportLevel: 'high-scaffold',
        learnerFoundation: 'Assume basic school-subject knowledge but no specialist or university-level background.',
        terminologyRule: 'Define every specialist term before using it for reasoning; connect it to already familiar school concepts.',
        abstractionRule: 'Move from concrete examples to one abstraction at a time, with worked examples and checks for understanding.',
        exampleRule: 'Use school life, common apps, sports, media, public transport, and simple experiments.',
      };
    case 'high-school':
      return {
        supportLevel: 'balanced',
        learnerFoundation: 'Assume general high-school literacy and subject basics, but no university-level specialist knowledge unless explicitly listed.',
        terminologyRule: 'Do not use specialist concepts such as named architectures, advanced theories, or implementation jargon as if already known. Define, scaffold, or replace them first.',
        abstractionRule: 'Use intuitive mechanisms and simple models before formal detail; include only depth required by the confirmed objectives.',
        exampleRule: 'Use familiar digital products, communication, campus life, social issues, and small data examples tied to the lesson goal.',
      };
    case 'vocational':
      return {
        supportLevel: 'balanced',
        learnerFoundation: 'Assume practical experience may be stronger than formal theory; do not assume unlisted specialist terminology.',
        terminologyRule: 'Introduce terminology through its job purpose, observable effect, and safe operating context before formal definition.',
        abstractionRule: 'Prioritize task steps, decisions, evidence, and troubleshooting, then explain the minimum supporting principle.',
        exampleRule: 'Use authentic workplace tasks, tools, records, safety decisions, and quality checks appropriate to the course.',
      };
    case 'higher-education':
      return {
        supportLevel: 'independent',
        learnerFoundation: 'Assume general academic study skills and stated prerequisites, but not specialist concepts outside the confirmed boundary.',
        terminologyRule: 'Define domain terms on first use unless they are explicitly listed as prior knowledge; distinguish foundational and extension concepts.',
        abstractionRule: 'Permit formal models and multi-step reasoning only when they serve the confirmed objectives and prerequisites are established.',
        exampleRule: 'Use authentic disciplinary cases and data while explaining assumptions and limitations.',
      };
    default:
      return {
        supportLevel: 'balanced',
        learnerFoundation: 'Assume only general literacy and the explicitly stated prior knowledge.',
        terminologyRule: 'Define every non-common term on first use and never assume knowledge outside the confirmed boundary.',
        abstractionRule: 'Progress from concrete example to explanation to application, adding abstraction only when required.',
        exampleRule: 'Use accessible real-life contexts directly related to the teaching objective.',
      };
  }
}

export function deriveTeachingConstraints(input: {
  grade?: string;
  subject?: string;
  topic?: string;
  hours?: number;
  difficulty?: 'introductory' | 'standard' | 'advanced';
  learnerProfile?: LearnerProfileInput;
  learningObjectives?: string[];
  knowledgePoints?: Array<{ id: string; name?: string; level?: string }>;
}): TeachingConstraints {
  const grade = input.grade?.trim() || '未指定学段';
  const gradeBand = inferGradeBand(grade);
  const defaults = gradeDefaults(gradeBand);
  const scope = deriveCourseScope(input.hours);
  const explicitPrior = input.learnerProfile?.priorKnowledge?.trim();
  const difficulty = input.difficulty ?? 'standard';
  const supportLevel: LearnerSupportLevel = difficulty === 'introductory'
    ? 'high-scaffold'
    : difficulty === 'advanced' && gradeBand === 'higher-education'
      ? 'independent'
      : defaults.supportLevel;

  return {
    grade,
    subject: input.subject?.trim() || '综合课程',
    topic: input.topic?.trim() || '当前课程主题',
    ...scope,
    gradeBand,
    supportLevel,
    learnerFoundation: explicitPrior || defaults.learnerFoundation,
    learningNeeds: splitItems(input.learnerProfile?.learningNeeds),
    familiarContexts: splitItems(input.learnerProfile?.familiarContexts),
    learningObjectives: (input.learningObjectives ?? []).map((item) => item.trim()).filter(Boolean),
    allowedKnowledgePoints: (input.knowledgePoints ?? [])
      .filter((point) => Boolean(point.id))
      .map((point) => ({ id: point.id, name: point.name?.trim() || "未命名知识点", level: point.level })),
    terminologyRule: defaults.terminologyRule,
    abstractionRule: defaults.abstractionRule,
    exampleRule: defaults.exampleRule,
    progressionRule: 'Choose progression from confirmed prior knowledge, learning goals, and the missing reasoning bridge. Use examples, mechanism explanation, supported application, checks, or synthesis only where they advance understanding; do not require a fixed cycle on every page. Do not increase difficulty merely to fill time.',
    assessmentRule: 'Assess only the current objective and confirmed knowledge points. Progress from recognition to explanation and then application; distractors must reflect plausible misconceptions, and every analysis must explain the reasoning.',
  };
}

export function formatTeachingConstraintsForPrompt(constraints?: TeachingConstraints): string {
  if (!constraints) return '';
  const allowed = constraints.allowedKnowledgePoints.length
    ? constraints.allowedKnowledgePoints.map((point) => `${point.id}: ${point.name}${point.level ? ` (${point.level})` : ''}`).join('\n')
    : 'No explicit catalog was supplied. Stay strictly within the stated page objective and course topic.';
  return [
    '## Student Profile and Teaching Boundary (authoritative)',
    `Grade/stage: ${constraints.grade} (${constraints.gradeBand})`,
    `Subject/topic: ${constraints.subject} / ${constraints.topic}`,
    `Course capacity: ${constraints.courseHours} hours / ${constraints.totalMinutes} minutes`,
    `Recommended knowledge-point range: ${constraints.recommendedKnowledgePointRange.min}-${constraints.recommendedKnowledgePointRange.max}`,
    `Scope rule: ${constraints.scopeRule}`,
    `Scaffolding level: ${constraints.supportLevel}`,
    `Assumed prior knowledge: ${constraints.learnerFoundation}`,
    constraints.learningNeeds.length ? `Learning needs: ${constraints.learningNeeds.join('；')}` : '',
    constraints.familiarContexts.length ? `Familiar contexts: ${constraints.familiarContexts.join('；')}` : '',
    constraints.learningObjectives.length ? `Learning objectives: ${constraints.learningObjectives.join('；')}` : '',
    'Confirmed knowledge boundary:',
    allowed,
    `Terminology rule: ${constraints.terminologyRule}`,
    `Abstraction/depth rule: ${constraints.abstractionRule}`,
    `Example rule: ${constraints.exampleRule}`,
    `Progression rule: ${constraints.progressionRule}`,
    `Assessment rule: ${constraints.assessmentRule}`,
    'Hard rule: A concept outside the confirmed boundary may appear only as a brief analogy or context. It must be explained before use and must never become a hidden prerequisite, assessment target, or tangential extension.',
  ].filter(Boolean).join('\n');
}

export function formatTeachingConstraintsForChinesePrompt(constraints?: TeachingConstraints): string {
  if (!constraints) return '';
  const foundation = constraints.learnerFoundation && !/^(Assume|No explicit)/i.test(constraints.learnerFoundation)
    ? constraints.learnerFoundation
    : constraints.gradeBand === 'primary'
      ? '具有具体生活经验，但不预设掌握正式学科术语'
      : constraints.gradeBand === 'middle-school'
        ? '具有本学段基础知识，但不预设专业或大学层次背景'
        : constraints.gradeBand === 'high-school'
          ? '具有高中通识与学科基础，但不预设未明确列出的大学专业知识'
          : '只预设一般学习能力和已明确给出的前置知识';
  const supportLevel = constraints.supportLevel === 'high-scaffold'
    ? '高支架：先给具体例子，再逐步抽象，并设置理解检查'
    : constraints.supportLevel === 'independent'
      ? '自主探究：允许多步推理，但仍须说明假设和知识边界'
      : '平衡支架：提供必要示例、步骤提示和自主应用空间';
  const allowed = constraints.allowedKnowledgePoints.length
    ? constraints.allowedKnowledgePoints.map((point) => `- ${point.name}`).join('\n')
    : '未提供明确知识点清单，只能围绕课程主题与课程目标组织内容。';
  return [
    '学生画像与教学边界（必须遵守）',
    `学段：${constraints.grade}`,
    `学科与主题：${constraints.subject} / ${constraints.topic}`,
    `课程容量：${constraints.courseHours} 课时，共 ${constraints.totalMinutes} 分钟`,
    `建议知识点数量：${constraints.recommendedKnowledgePointRange.min}-${constraints.recommendedKnowledgePointRange.max} 个`,
    `学习支架：${supportLevel}`,
    `可假定的已有基础：${foundation}`,
    constraints.learningNeeds.length ? `已知学习需要：${constraints.learningNeeds.join('；')}` : '学习需要：未填写，不得据此推断学生不存在学习困难。',
    constraints.familiarContexts.length ? `熟悉情境：${constraints.familiarContexts.join('；')}` : '熟悉情境：未填写，选择案例时使用本学段常见生活情境。',
    constraints.learningObjectives.length ? `课程目标：${constraints.learningObjectives.join('；')}` : '课程目标：未填写，只能依据课程主题给出候选，不得宣称目标已确定。',
    '已确认的知识边界：',
    allowed,
    '术语与深度：专业术语首次出现时必须用中文准确解释；先从具体例子进入机制，再进行有限应用，不得把未列出的专业知识当作前置条件。',
    '内容组织：根据知识类型和当前理解障碍选择进入方式与推进顺序。抽象或陌生内容通常先建立学生能感知的对象、现象或问题，再命名并解释；已经熟悉或适合直接定义的内容可以直接进入。不得把同一套讲授步骤复制到每页，也不得仅为填满课时而增加难度或重复内容。',
    '案例选择：案例首先服务当前知识点的理解，优先使用实际学习者在其学段、专业和生活经验中能够理解的对象。与项目任务的关联只在确实帮助理解或迁移时使用，不能为了贯穿任务而放弃更清楚、更熟悉的例子。资料中出现的儿童、教师、客户或其他人物是案例角色，不自动等于实际学习者。',
    '评价边界：只评价当前课程目标和已确认知识点；空值表示未知或未填写，不表示学生不会、内容不存在或任务已经完成。',
  ].filter(Boolean).join('\n');
}
