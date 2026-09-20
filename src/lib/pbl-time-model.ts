import type { PblDetailKind, PblTtsPolicy } from '@openmaic/lib/types/generation';
import { estimateSpeechDurationSec } from '@openmaic/lib/audio/tts-timing';

export const PBL_STAGE_KEYS = [
  'launch',
  'ai-learning',
  'proposal',
  'make',
  'showcase',
  'reflection',
] as const;

export type PblStageKey = (typeof PBL_STAGE_KEYS)[number];

export type PblTimeActivityKind =
  | 'launch'
  | 'knowledge'
  | 'proposal'
  | 'practice'
  | 'showcase'
  | 'reflection'
  | 'other';

export type PblDifficultyLevel = 'introductory' | 'standard' | 'advanced';

export type PblKnowledgeComplexity = {
  id: string;
  name?: string;
  level?: 'foundation' | 'core' | 'application' | 'extension';
  relatedIds?: string[];
};

export type PblTimeModelContext = {
  topic?: string;
  subject?: string;
  summary?: string;
  grade?: string;
  difficulty?: PblDifficultyLevel;
  learningObjectives?: ReadonlyArray<string>;
  learnerProfile?: {
    priorKnowledge?: string;
    learningNeeds?: string;
    familiarContexts?: string;
  };
  knowledgePoints?: ReadonlyArray<PblKnowledgeComplexity>;
  knowledgeGraph?: {
    nodes?: ReadonlyArray<PblKnowledgeComplexity>;
    edges?: ReadonlyArray<{ source?: string; target?: string }>;
  };
};

export type PblTimeActivity = {
  id: string;
  title?: string;
  stageKey?: string;
  activityKind?: PblTimeActivityKind;
  durationMin: number;
  knowledgePointIds?: string[];
};

export type PblModuleTimingStatus = 'suggested' | 'confirmed';

export type PblModuleTimingAllocation = PblTimeActivity & {
  /** AI-recommended duration before teacher edits. */
  recommendedDurationMin: number;
};

export type PblTimingRecommendationSource =
  | 'llm'
  | 'deterministic-fallback'
  | 'teacher';

export type PblTimingRecommendationConfidence = 'low' | 'medium' | 'high';

export type PblTimingRecommendationAudit = {
  recommendationSource?: PblTimingRecommendationSource;
  confidence?: PblTimingRecommendationConfidence;
  rationaleByStage?: Partial<Record<PblStageKey, string>>;
  evidence?: string[];
  assumptions?: string[];
  /** Contract identity for specialized planning flows such as shared knowledge-cluster timing. */
  planningPolicyVersion?: string;
};

/** The only course-level timing state used by the teacher workflow. */
export type PblModuleTimingPlan = PblTimingRecommendationAudit & {
  schemaVersion: 1;
  totalMinutes: number;
  status: PblModuleTimingStatus;
  allocations: PblModuleTimingAllocation[];
  recommendedStageTotals: Record<PblTimeActivityKind, number>;
  generatedAt: string;
  confirmedAt?: string;
};

export type PblModelTimingRecommendation = {
  allocations: Array<{
    stageKey: string;
    durationMin: number;
    rationale?: string;
  }>;
  evidence?: string[];
  assumptions?: string[];
  confidence?: PblTimingRecommendationConfidence;
};

export type PblModuleDefinition = {
  stageKey: PblStageKey;
  kind: Exclude<PblTimeActivityKind, 'other'>;
  label: string;
  defaultTitle: string;
  resourcePlan: string;
};

export const PBL_MODULE_DEFINITIONS: readonly PblModuleDefinition[] = [
  {
    stageKey: 'launch',
    kind: 'launch',
    label: '项目启动',
    defaultTitle: '项目启动：情境、驱动问题与成果要求',
    resourcePlan: '教师 PPT 与讲稿，发布情境、驱动问题、成果结构和评价边界',
  },
  {
    stageKey: 'ai-learning',
    kind: 'knowledge',
    label: '知识讲授',
    defaultTitle: '知识讲授：分节建构核心知识与方法',
    resourcePlan: '学生 slide、quiz 或 interactive，按知识点难度递进',
  },
  {
    stageKey: 'proposal',
    kind: 'proposal',
    label: '方案构思与校准',
    defaultTitle: '方案构思与校准：形成个人项目方案',
    resourcePlan: '教师主持 PPT 与支架，学生提交构思、证据和修订记录',
  },
  {
    stageKey: 'make',
    kind: 'practice',
    label: '项目实践',
    defaultTitle: '项目实践：制作、测试与迭代',
    resourcePlan: '教师流程支架与伴学提示，学生独立制作并保留过程证据',
  },
  {
    stageKey: 'showcase',
    kind: 'showcase',
    label: '成果汇报与评价',
    defaultTitle: '成果汇报与评价：作品、表达与证据',
    resourcePlan: '教师汇报与评价 PPT、讲稿和答辩提示',
  },
  {
    stageKey: 'reflection',
    kind: 'reflection',
    label: '学习反思与迁移',
    defaultTitle: '学习反思与迁移：总结成长并规划下一步',
    resourcePlan: '教师反思引导 PPT 与讲稿，学生完成反思日志和迁移计划',
  },
];

/** Standard starting point for the new personal-project PBL classroom. */
export const PBL_TIME_RATIOS: Readonly<Record<PblTimeActivityKind, number>> = {
  launch: 0.1,
  knowledge: 0.2,
  proposal: 0.1,
  practice: 0.4,
  showcase: 0.15,
  reflection: 0.05,
  other: 0,
};

const STAGE_ALIASES: Record<string, PblStageKey> = {
  launch: 'launch',
  'project-launch': 'launch',
  'project-start': 'launch',
  start: 'launch',
  introduction: 'launch',
  引入: 'launch',
  项目启动: 'launch',
  'ai-learning': 'ai-learning',
  'ai-knowledge': 'ai-learning',
  knowledge: 'ai-learning',
  'knowledge-teaching': 'ai-learning',
  'ai授知': 'ai-learning',
  授知: 'ai-learning',
  proposal: 'proposal',
  'proposal-review': 'proposal',
  'project-proposal': 'proposal',
  design: 'proposal',
  方案构思: 'proposal',
  方案校准: 'proposal',
  make: 'make',
  practice: 'make',
  workspace: 'make',
  'project-making': 'make',
  'project-practice': 'make',
  项目实践: 'make',
  showcase: 'showcase',
  review: 'showcase',
  evaluation: 'showcase',
  'showcase-evaluation': 'showcase',
  '成果汇报': 'showcase',
  reflection: 'reflection',
  'reflection-transfer': 'reflection',
  'learning-reflection': 'reflection',
  transfer: 'reflection',
  学习反思: 'reflection',
  反思迁移: 'reflection',
};

const LEVEL_COMPLEXITY: Record<NonNullable<PblKnowledgeComplexity['level']>, number> = {
  foundation: 0.7,
  core: 1,
  application: 1.25,
  extension: 1.5,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Normalize view keys and common LLM aliases to the six canonical stages. */
export function normalizePblStageKey(stageKey?: string): PblStageKey | undefined {
  if (!stageKey) return undefined;
  const value = stageKey.trim().toLowerCase();
  return STAGE_ALIASES[value] ?? STAGE_ALIASES[stageKey.trim()];
}

function inferKindFromTitle(title?: string): PblTimeActivityKind {
  const value = title?.toLowerCase() ?? '';
  if (/引入|启动|情境|驱动问题|项目发布/.test(value)) return 'launch';
  if (/授知|知识|概念|讲解|学习|测验|基础方法/.test(value)) return 'knowledge';
  if (/方案|构思|设计|校准|计划|提案/.test(value)) return 'proposal';
  if (/实践|制作|实施|测试|迭代|调研|项目/.test(value)) return 'practice';
  if (/汇报|展示|答辩|成果|评价|反馈/.test(value)) return 'showcase';
  if (/反思|迁移|总结|复盘|下一步/.test(value)) return 'reflection';
  return 'other';
}

export function classifyPblActivityKind(activity: {
  stageKey?: string;
  activityKind?: PblTimeActivityKind;
  detailKind?: PblDetailKind;
  title?: string;
}): PblTimeActivityKind {
  if (activity.activityKind && activity.activityKind !== 'other') return activity.activityKind;

  const stageKey = normalizePblStageKey(activity.stageKey);
  if (stageKey) {
    const definition = PBL_MODULE_DEFINITIONS.find((item) => item.stageKey === stageKey);
    if (definition) return definition.kind;
  }

  if (activity.detailKind) {
    if (activity.detailKind === 'teacher-introduction') return 'launch';
    if (activity.detailKind === 'knowledge-explanation' || activity.detailKind === 'interactive-practice') {
      return 'knowledge';
    }
    if (activity.detailKind === 'project-scaffold') return 'proposal';
    if (activity.detailKind === 'project-practice') return 'practice';
    if (activity.detailKind === 'showcase-coaching') return 'showcase';
    if (activity.detailKind === 'reflection-transfer') return 'reflection';
  }

  return inferKindFromTitle(activity.title);
}

function emptyStageTotals(): Record<PblTimeActivityKind, number> {
  return {
    launch: 0,
    knowledge: 0,
    proposal: 0,
    practice: 0,
    showcase: 0,
    reflection: 0,
    other: 0,
  };
}

function parseGradeMaturity(grade?: string): number {
  const value = grade?.toLowerCase() ?? '';
  if (/幼儿|幼儿园|小班|中班|大班/.test(value)) return 0.1;
  if (/小学|一年级|二年级|三年级|四年级|五年级|六年级/.test(value)) return 0.28;
  if (/初一|初二|初三|七年级|八年级|九年级/.test(value)) return 0.52;
  if (/高中|高一|高二|高三|十年级|十一年级|十二年级/.test(value)) return 0.76;
  if (/大学|本科|成人/.test(value)) return 0.9;
  const match = value.match(/\d+/);
  if (!match) return 0.5;
  return clamp(Number(match[0]) / 12, 0.15, 0.9);
}

function inferDifficulty(context?: PblTimeModelContext): PblDifficultyLevel {
  if (context?.difficulty) return context.difficulty;
  const text = [context?.topic, context?.subject, context?.summary, context?.grade]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (/竞赛|高阶|综合实践|开放性|跨学科|研究性|复杂/.test(text)) return 'advanced';
  if (/入门|基础|启蒙|低年级|小学/.test(text)) return 'introductory';
  return 'standard';
}

function getKnowledgeComplexity(context?: PblTimeModelContext): number {
  const points = context?.knowledgePoints?.length
    ? context.knowledgePoints
    : context?.knowledgeGraph?.nodes ?? [];
  if (!points.length) return 1;

  const average =
    points.reduce((sum, point) => sum + (point.level ? LEVEL_COMPLEXITY[point.level] : 1), 0) /
    points.length;
  const breadthFactor = clamp(0.85 + points.length * 0.035, 0.85, 1.2);
  const edgeCount = context?.knowledgeGraph?.edges?.length ?? 0;
  const dependencyFactor = edgeCount > points.length ? clamp(1 + (edgeCount - points.length) * 0.01, 1, 1.15) : 1;
  return clamp(average * breadthFactor * dependencyFactor, 0.7, 1.45);
}

function getDifficultyScore(context?: PblTimeModelContext): number {
  switch (inferDifficulty(context)) {
    case 'introductory':
      return -1;
    case 'advanced':
      return 1;
    default:
      return 0;
  }
}

/**
 * Derive bounded ratios instead of renormalizing only the rows returned by an
 * LLM. With no context this returns the standard PBL starting point exactly.
 */
export function derivePblTimeRatios(
  context?: PblTimeModelContext,
): Readonly<Record<PblTimeActivityKind, number>> {
  const maturity = parseGradeMaturity(context?.grade);
  const complexityDemand = getKnowledgeComplexity(context) - 1;
  const difficultyScore = getDifficultyScore(context);
  const explicitSupportDemand = context?.learnerProfile?.learningNeeds?.trim() ? 1 : 0;
  const ratios = { ...PBL_TIME_RATIOS };

  ratios.launch += (0.5 - maturity) * 0.04;
  ratios.knowledge += complexityDemand * 0.045 + difficultyScore * 0.015 + explicitSupportDemand * 0.025;
  ratios.proposal += complexityDemand * 0.02 + explicitSupportDemand * 0.01;
  ratios.practice += complexityDemand * 0.065 + difficultyScore * 0.035;
  ratios.showcase += complexityDemand * 0.01;
  ratios.reflection += (0.5 - maturity) * 0.015 + difficultyScore * 0.005;

  const modeledKinds = PBL_MODULE_DEFINITIONS.map((item) => item.kind);
  modeledKinds.forEach((kind) => {
    ratios[kind] = clamp(ratios[kind], 0.04, 0.6);
  });
  ratios.practice = Math.max(ratios.practice, ratios.knowledge + 0.05);

  const sum = modeledKinds.reduce((total, kind) => total + ratios[kind], 0);
  const normalized = emptyStageTotals();
  modeledKinds.forEach((kind) => {
    normalized[kind] = ratios[kind] / Math.max(sum, Number.EPSILON);
  });
  return normalized;
}

function allocateIntegerByWeights(total: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const safeTotal = Math.max(0, Math.round(total));
  const safeWeights = weights.map((weight) => Math.max(0, Number(weight) || 0));
  const weightSum = safeWeights.reduce((sum, weight) => sum + weight, 0);
  if (weightSum <= 0) return allocateIntegerByWeights(safeTotal, weights.map(() => 1));

  const raw = safeWeights.map((weight) => (safeTotal * weight) / weightSum);
  const result = raw.map(Math.floor);
  let remainder = safeTotal - result.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const item of order) {
    if (remainder <= 0) break;
    result[item.index] += 1;
    remainder -= 1;
  }
  return result;
}

function moduleTotalsFromRatios(
  totalMinutes: number,
  ratios: Readonly<Record<PblTimeActivityKind, number>>,
): Record<PblTimeActivityKind, number> {
  const kinds = PBL_MODULE_DEFINITIONS.map((item) => item.kind);
  const values = allocateIntegerByWeights(totalMinutes, kinds.map((kind) => ratios[kind]));
  const totals = emptyStageTotals();
  kinds.forEach((kind, index) => {
    totals[kind] = values[index] ?? 0;
  });
  return totals;
}

function activityWeight(activity: PblTimeActivity, context?: PblTimeModelContext): number {
  const ids = activity.knowledgePointIds ?? [];
  if (!ids.length) return 1;
  const pointMap = new Map(
    (context?.knowledgePoints ?? context?.knowledgeGraph?.nodes ?? []).map((point) => [point.id, point]),
  );
  const complexity = ids.reduce(
    (sum, id) => sum + (pointMap.get(id)?.level ? LEVEL_COMPLEXITY[pointMap.get(id)!.level!] : 1),
    0,
  ) / ids.length;
  return 1 + ids.length * 0.04 + complexity * 0.08;
}

function distributeActivityMinutes(
  totalMinutes: number,
  activities: readonly PblTimeActivity[],
  context?: PblTimeModelContext,
): number[] {
  return allocateIntegerByWeights(
    totalMinutes,
    activities.map((activity) => activityWeight(activity, context)),
  );
}

function distributeActivityMinutesWithMinimum(
  totalMinutes: number,
  activities: readonly PblTimeActivity[],
  context?: PblTimeModelContext,
): number[] {
  if (activities.length === 0) return [];
  const safeTotal = Math.max(0, Math.round(totalMinutes));
  if (safeTotal < activities.length) {
    return distributeActivityMinutes(safeTotal, activities, context);
  }
  return distributeActivityMinutes(
    safeTotal - activities.length,
    activities,
    context,
  ).map((minutes) => minutes + 1);
}

/** Recommend the six module totals independently of which rows an LLM returned. */
export function recommendPblStageTotals(
  totalMinutes: number,
  context?: PblTimeModelContext,
): Record<PblTimeActivityKind, number> {
  return moduleTotalsFromRatios(Math.max(0, Math.round(totalMinutes)), derivePblTimeRatios(context));
}

/** Suggest integer minutes for the supplied rows without changing their order. */
export function suggestPblTimeAllocation(
  totalMinutes: number,
  activities: ReadonlyArray<Omit<PblTimeActivity, 'durationMin'> & { durationMin?: number }>,
  context?: PblTimeModelContext,
): Record<string, number> {
  const suggestions: Record<string, number> = {};
  const safeTotal = Math.max(0, Math.round(totalMinutes));
  const groups = new Map<PblTimeActivityKind, PblTimeActivity[]>();

  for (const activity of activities) {
    const kind = classifyPblActivityKind(activity);
    const effectiveKind = kind === 'other' ? 'practice' : kind;
    const group = groups.get(effectiveKind) ?? [];
    group.push({ ...activity, durationMin: Number(activity.durationMin ?? 0) });
    groups.set(effectiveKind, group);
  }

  const stageTotals = recommendPblStageTotals(safeTotal, context);
  for (const definition of PBL_MODULE_DEFINITIONS) {
    const group = groups.get(definition.kind) ?? [];
    const distribution = distributeActivityMinutes(stageTotals[definition.kind], group, context);
    group.forEach((activity, index) => {
      suggestions[activity.id] = distribution[index] ?? 0;
    });
  }

  // A caller may still provide an incomplete outline. The UI normalizes the
  // six canonical modules before editing, but this fallback keeps the helper
  // total-preserving for programmatic callers and older drafts. Unrepresented
  // module minutes are assigned to project practice when it exists.
  const assigned = Object.values(suggestions).reduce((sum, value) => sum + value, 0);
  const unrepresentedMinutes = Math.max(0, safeTotal - assigned);
  if (unrepresentedMinutes > 0) {
    const fallbackKind = groups.has('practice')
      ? 'practice'
      : (Array.from(groups.keys()).find((kind) => kind !== 'other') ?? 'other');
    const fallbackActivity = groups.get(fallbackKind)?.[0];
    if (fallbackActivity) {
      suggestions[fallbackActivity.id] = (suggestions[fallbackActivity.id] ?? 0) + unrepresentedMinutes;
    }
  }

  return suggestions;
}

export function buildPblModuleTimingPlan(
  totalMinutes: number,
  activities: ReadonlyArray<PblTimeActivity>,
  context?: PblTimeModelContext,
  options: {
    status?: PblModuleTimingStatus;
    preserveCurrentDurations?: boolean;
    now?: string;
    recommendationMetadata?: PblTimingRecommendationAudit;
  } = {},
): PblModuleTimingPlan {
  const safeTotal = Math.max(0, Math.round(totalMinutes));
  const recommended = suggestPblTimeAllocation(safeTotal, activities, context);
  const preserveCurrentDurations = options.preserveCurrentDurations === true;
  const allocations = activities.map((activity) => ({
    ...activity,
    durationMin: preserveCurrentDurations
      ? Math.max(0, Math.round(Number(activity.durationMin) || 0))
      : recommended[activity.id] ?? Math.max(0, Math.round(Number(activity.durationMin) || 0)),
    recommendedDurationMin: recommended[activity.id] ?? 0,
  }));
  const status = options.status ?? 'suggested';
  const generatedAt = options.now ?? new Date().toISOString();
  return {
    schemaVersion: 1,
    totalMinutes: safeTotal,
    status,
    allocations,
    recommendedStageTotals: recommendPblStageTotals(safeTotal, context),
    generatedAt,
    ...(status === 'confirmed' ? { confirmedAt: generatedAt } : {}),
    ...options.recommendationMetadata,
  };
}

function allocateStageMinutesWithMinimum(
  totalMinutes: number,
  weights: readonly number[],
): number[] {
  const safeTotal = Math.max(0, Math.round(totalMinutes));
  if (weights.length === 0) return [];
  if (safeTotal < weights.length) {
    return allocateIntegerByWeights(safeTotal, weights);
  }
  return allocateIntegerByWeights(
    safeTotal - weights.length,
    weights,
  ).map((minutes) => minutes + 1);
}

/**
 * Turn an LLM's pedagogical timing judgment into the same deterministic,
 * fixed-total contract used everywhere else. The model supplies relative
 * emphasis and explanations; this function owns stage identity, integer
 * minutes, minimums, missing-stage fallback, and total preservation.
 */
export function buildPblModelTimingPlan(
  totalMinutes: number,
  activities: ReadonlyArray<PblTimeActivity>,
  recommendation: PblModelTimingRecommendation,
  context?: PblTimeModelContext,
  options: { now?: string } = {},
): PblModuleTimingPlan {
  const safeTotal = Math.max(0, Math.round(totalMinutes));
  const deterministicTotals = recommendPblStageTotals(safeTotal, context);
  const modelByStage = new Map<
    PblStageKey,
    { durationMin: number; rationale?: string }
  >();

  for (const allocation of recommendation.allocations ?? []) {
    const stageKey = normalizePblStageKey(allocation.stageKey);
    const durationMin = Number(allocation.durationMin);
    if (
      !stageKey ||
      !Number.isFinite(durationMin) ||
      durationMin <= 0 ||
      modelByStage.has(stageKey)
    ) {
      continue;
    }
    modelByStage.set(stageKey, {
      durationMin,
      ...(allocation.rationale?.trim()
        ? { rationale: allocation.rationale.trim() }
        : {}),
    });
  }

  const missingDefinitions = PBL_MODULE_DEFINITIONS.filter(
    (definition) => !modelByStage.has(definition.stageKey),
  );
  const weights = PBL_MODULE_DEFINITIONS.map((definition) => (
    modelByStage.get(definition.stageKey)?.durationMin ??
    deterministicTotals[definition.kind]
  ));
  const normalizedStageMinutes = allocateStageMinutesWithMinimum(
    safeTotal,
    weights,
  );
  const recommendedStageTotals = emptyStageTotals();
  const rationaleByStage: Partial<Record<PblStageKey, string>> = {};
  const allocations: PblModuleTimingAllocation[] = [];

  PBL_MODULE_DEFINITIONS.forEach((definition, definitionIndex) => {
    const stageMinutes = normalizedStageMinutes[definitionIndex] ?? 0;
    recommendedStageTotals[definition.kind] = stageMinutes;
    const modelStage = modelByStage.get(definition.stageKey);
    if (modelStage?.rationale) {
      rationaleByStage[definition.stageKey] = modelStage.rationale;
    }
    const matching = activities.filter(
      (activity) => classifyPblActivityKind(activity) === definition.kind,
    );
    const distributed = distributeActivityMinutesWithMinimum(
      stageMinutes,
      matching,
      context,
    );
    matching.forEach((activity, index) => {
      const durationMin = distributed[index] ?? 0;
      allocations.push({
        ...activity,
        stageKey: definition.stageKey,
        activityKind: definition.kind,
        durationMin,
        recommendedDurationMin: durationMin,
      });
    });
  });

  const assumptions = [
    ...(recommendation.assumptions ?? [])
      .map((item) => item.trim())
      .filter(Boolean),
    ...(missingDefinitions.length > 0
      ? [
          `模型缺失阶段：${missingDefinitions.map((item) => item.label).join('、')}；已使用课程上下文的确定性建议补齐。`,
        ]
      : []),
  ];
  const now = options.now ?? new Date().toISOString();
  return {
    schemaVersion: 1,
    totalMinutes: safeTotal,
    status: 'suggested',
    allocations,
    recommendedStageTotals,
    generatedAt: now,
    recommendationSource: 'llm',
    confidence:
      recommendation.confidence === 'low' ||
      recommendation.confidence === 'high'
        ? recommendation.confidence
        : 'medium',
    ...(Object.keys(rationaleByStage).length > 0 ? { rationaleByStage } : {}),
    evidence: (recommendation.evidence ?? [])
      .map((item) => item.trim())
      .filter(Boolean),
    ...(assumptions.length > 0 ? { assumptions } : {}),
  };
}

export function isPblModuleTimingPlanConfirmed(
  plan: Pick<PblModuleTimingPlan, 'totalMinutes' | 'allocations' | 'status'> | undefined,
): boolean {
  if (!plan || plan.status !== 'confirmed') return false;
  const kinds = new Set(plan.allocations.map((activity) => classifyPblActivityKind(activity)));
  if (PBL_MODULE_DEFINITIONS.some((definition) => !kinds.has(definition.kind))) return false;
  const allocated = plan.allocations.reduce(
    (sum, activity) => sum + Math.max(0, Math.round(Number(activity.durationMin) || 0)),
    0,
  );
  return allocated === Math.max(0, Math.round(plan.totalMinutes));
}

/**
 * Reallocate a fixed course duration after a teacher changes one canonical
 * module total. The requested module receives the requested time; all other
 * represented modules share the remainder in proportion to their current
 * allocation (falling back to the modeled ratios for empty drafts). Child
 * activities within each module are then distributed by their knowledge load.
 */
export function reallocatePblStageDurations<T extends PblTimeActivity>(
  totalMinutes: number,
  activities: ReadonlyArray<T>,
  targetKind: Exclude<PblTimeActivityKind, 'other'>,
  targetMinutes: number,
  context?: PblTimeModelContext,
): T[] {
  const safeTotal = Math.max(0, Math.round(totalMinutes));
  const groups = new Map<PblTimeActivityKind, Array<{ activity: PblTimeActivity; index: number }>>();

  activities.forEach((activity, index) => {
    const kind = classifyPblActivityKind(activity);
    const effectiveKind = kind === 'other' ? 'practice' : kind;
    const group = groups.get(effectiveKind) ?? [];
    group.push({ activity: { ...activity }, index });
    groups.set(effectiveKind, group);
  });

  const targetGroup = groups.get(targetKind) ?? [];
  if (targetGroup.length === 0) return activities.map((activity) => ({ ...activity }));

  const currentTotals = emptyStageTotals();
  for (const [kind, group] of groups) {
    currentTotals[kind] = group.reduce(
      (sum, entry) => sum + Math.max(0, Math.round(Number(entry.activity.durationMin) || 0)),
      0,
    );
  }

  const modeledKinds = PBL_MODULE_DEFINITIONS.map((definition) => definition.kind);
  const otherKinds = modeledKinds.filter((kind) => kind !== targetKind && groups.has(kind));
  const minimumOtherMinutes = otherKinds.reduce(
    (sum, kind) => sum + (groups.get(kind)?.length ?? 0),
    0,
  );
  const minimumTargetMinutes = safeTotal >= targetGroup.length + minimumOtherMinutes
    ? targetGroup.length
    : 0;
  const maximumTargetMinutes = Math.max(minimumTargetMinutes, safeTotal - minimumOtherMinutes);
  const boundedTargetMinutes = clamp(
    Math.round(Number(targetMinutes) || 0),
    minimumTargetMinutes,
    maximumTargetMinutes,
  );

  const recommended = recommendPblStageTotals(safeTotal, context);
  const remainder = Math.max(0, safeTotal - boundedTargetMinutes);
  const otherStageTotals = new Map<PblTimeActivityKind, number>();
  const otherAllocations = allocateIntegerByWeights(
    remainder,
    otherKinds.map((kind) => currentTotals[kind] > 0 ? currentTotals[kind] : recommended[kind]),
  );
  otherKinds.forEach((kind, index) => {
    otherStageTotals.set(kind, otherAllocations[index] ?? 0);
  });

  const next = activities.map((activity) => ({ ...activity }));
  const stageTotals = new Map<PblTimeActivityKind, number>([
    [targetKind, boundedTargetMinutes],
    ...otherKinds.map((kind) => [kind, otherStageTotals.get(kind) ?? 0] as const),
  ]);

  for (const kind of modeledKinds) {
    const group = groups.get(kind) ?? [];
    if (group.length === 0) continue;
    const stageTotal = stageTotals.get(kind) ?? currentTotals[kind];
    const distributed = distributeActivityMinutesWithMinimum(stageTotal, group.map((entry) => entry.activity), context);
    group.forEach((entry, index) => {
      next[entry.index] = {
        ...next[entry.index],
        durationMin: distributed[index] ?? 0,
      };
    });
  }

  return next;
}

export type PblTimeWarningSeverity = 'warning' | 'error';

export type PblTimeWarning = {
  code:
    | 'allocation-total-mismatch'
    | 'knowledge-exceeds-practice'
    | 'practice-too-short'
    | 'launch-too-short'
    | 'reflection-too-short'
    | 'invalid-activity-duration'
    | 'missing-module'
    | 'practice-not-largest'
    | 'unrecognized-stage';
  severity: PblTimeWarningSeverity;
  message: string;
  activityIds?: string[];
};

export type PblTimeAssessment = {
  totalMinutes: number;
  allocatedMinutes: number;
  deltaMinutes: number;
  stageTotals: Record<PblTimeActivityKind, number>;
  recommendedStageTotals: Record<PblTimeActivityKind, number>;
  recommendedRatios: Readonly<Record<PblTimeActivityKind, number>>;
  warnings: PblTimeWarning[];
};

export function assessPblTimeAllocation(
  totalMinutes: number,
  activities: ReadonlyArray<PblTimeActivity>,
  context?: PblTimeModelContext,
): PblTimeAssessment {
  const safeTotal = Math.max(0, Math.round(totalMinutes));
  const stageTotals = emptyStageTotals();
  const invalidActivityIds: string[] = [];
  const unrecognizedActivityIds: string[] = [];

  for (const activity of activities) {
    const duration = Number(activity.durationMin);
    if (!Number.isFinite(duration) || duration < 0) {
      invalidActivityIds.push(activity.id);
      continue;
    }
    const kind = classifyPblActivityKind(activity);
    if (kind === 'other') unrecognizedActivityIds.push(activity.id);
    stageTotals[kind] += duration;
  }

  const recommendedRatios = derivePblTimeRatios(context);
  const recommended = recommendPblStageTotals(safeTotal, context);
  const allocatedMinutes = Object.values(stageTotals).reduce((sum, value) => sum + value, 0);
  const deltaMinutes = allocatedMinutes - safeTotal;
  const warnings: PblTimeWarning[] = [];

  if (invalidActivityIds.length > 0) {
    warnings.push({
      code: 'invalid-activity-duration',
      severity: 'error',
      message: '存在无效的活动时长，请输入不小于 0 的分钟数。',
      activityIds: invalidActivityIds,
    });
  }
  if (unrecognizedActivityIds.length > 0) {
    warnings.push({
      code: 'unrecognized-stage',
      severity: 'warning',
      message: '存在未识别的阶段标记，建议改为六个标准课程模块之一。',
      activityIds: unrecognizedActivityIds,
    });
  }
  if (Math.abs(deltaMinutes) > 2) {
    warnings.push({
      code: 'allocation-total-mismatch',
      severity: 'warning',
      message: `各模块合计 ${allocatedMinutes} 分钟，与课程总时长 ${safeTotal} 分钟相差 ${Math.abs(deltaMinutes)} 分钟。`,
    });
  }

  const missingModules = PBL_MODULE_DEFINITIONS
    .filter((definition) => !activities.some((activity) => classifyPblActivityKind(activity) === definition.kind))
    .map((definition) => definition.label);
  if (missingModules.length > 0) {
    warnings.push({
      code: 'missing-module',
      severity: 'warning',
      message: `当前课程模块缺少：${missingModules.join('、')}。系统会在应用标准建议时补齐六个模块。`,
    });
  }
  if (stageTotals.knowledge > stageTotals.practice) {
    warnings.push({
      code: 'knowledge-exceeds-practice',
      severity: 'warning',
      message: `知识讲解 ${stageTotals.knowledge} 分钟超过项目实践 ${stageTotals.practice} 分钟，建议把更多时间留给制作、测试与迭代。`,
    });
  }
  const largestOther = PBL_MODULE_DEFINITIONS
    .map((definition) => stageTotals[definition.kind])
    .filter((value) => value > 0)
    .every((value) => stageTotals.practice >= value);
  if (safeTotal >= 30 && !largestOther) {
    warnings.push({
      code: 'practice-not-largest',
      severity: 'warning',
      message: '项目实践应是六个课程模块中时间最长的模块，请检查当前分配。',
    });
  }
  if (safeTotal >= 60 && stageTotals.practice < safeTotal * 0.25) {
    warnings.push({
      code: 'practice-too-short',
      severity: 'warning',
      message: `项目实践仅占 ${Math.round((stageTotals.practice / safeTotal) * 100)}%，建议至少保留课程总时长的 25%。`,
    });
  }
  if (stageTotals.launch > 0 && stageTotals.launch < 5) {
    warnings.push({
      code: 'launch-too-short',
      severity: 'warning',
      message: '项目启动少于 5 分钟，可能不足以完整发布驱动问题、成果要求和评价边界。',
    });
  }
  if (stageTotals.reflection > 0 && stageTotals.reflection < 5) {
    warnings.push({
      code: 'reflection-too-short',
      severity: 'warning',
      message: '学习反思少于 5 分钟，建议为成长总结和迁移计划留出完整时间。',
    });
  }

  return {
    totalMinutes: safeTotal,
    allocatedMinutes,
    deltaMinutes,
    stageTotals,
    recommendedStageTotals: recommended,
    recommendedRatios,
    warnings,
  };
}

export type PblProjectMainlineModule = {
  stageKey: PblStageKey;
  label: string;
  activityIds: string[];
  durationMin: number;
  startMin: number;
  endMin: number;
  knowledgePointIds: string[];
  resourcePlan: string;
};

export type PblProjectMainline = {
  totalMinutes: number;
  allocatedMinutes: number;
  modules: PblProjectMainlineModule[];
  generatedAt?: string;
};

/** Build a strict six-module timeline from the final teacher allocation. */
export function buildPblProjectMainline(
  totalMinutes: number,
  activities: ReadonlyArray<PblTimeActivity>,
): PblProjectMainline {
  const safeTotal = Math.max(0, Math.round(totalMinutes));
  if (activities.length === 0) {
    return {
      totalMinutes: safeTotal,
      allocatedMinutes: 0,
      modules: [],
    };
  }
  let cursor = 0;
  const modules = PBL_MODULE_DEFINITIONS.map((definition) => {
    const matching = activities.filter((activity) => classifyPblActivityKind(activity) === definition.kind);
    const durationMin = matching.reduce((sum, activity) => {
      const duration = Number(activity.durationMin);
      return sum + (Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0);
    }, 0);
    const timelineModule = {
      stageKey: definition.stageKey,
      label: definition.label,
      activityIds: matching.map((activity) => activity.id),
      durationMin,
      startMin: cursor,
      endMin: cursor + durationMin,
      knowledgePointIds: Array.from(
        new Set(matching.flatMap((activity) => activity.knowledgePointIds ?? [])),
      ),
      resourcePlan: definition.resourcePlan,
    } satisfies PblProjectMainlineModule;
    cursor += durationMin;
    return timelineModule;
  });

  return {
    totalMinutes: safeTotal,
    allocatedMinutes: cursor,
    modules,
  };
}

export function formatPblProjectMainline(mainline: PblProjectMainline): string {
  const lines = mainline.modules.map(
    (module, index) =>
      `${index + 1}. ${module.label}：${module.startMin}-${module.endMin} 分钟（${module.durationMin} 分钟）——${module.resourcePlan}`,
  );
  return [
    `项目主线（课程总时长 ${mainline.totalMinutes} 分钟，当前分配 ${mainline.allocatedMinutes} 分钟）`,
    ...lines,
  ].join('\n');
}

export type PblTimedDetail = {
  parentActivityId?: string;
  durationMin?: number;
  targetDurationSec?: number;
  ttsPolicy?: PblTtsPolicy;
};

/** Keep child resource targets aligned with a changed parent module duration. */
export function rescalePblDetailDurations<T extends PblTimedDetail>(
  details: ReadonlyArray<T>,
  activities: ReadonlyArray<PblTimeActivity>,
): T[] {
  const activityDurations = new Map(activities.map((activity) => [activity.id, Math.max(0, Math.round(activity.durationMin))]));
  const groups = new Map<string, Array<{ detail: T; index: number }>>();
  details.forEach((detail, index) => {
    if (!detail.parentActivityId || !activityDurations.has(detail.parentActivityId)) return;
    const group = groups.get(detail.parentActivityId) ?? [];
    group.push({ detail, index });
    groups.set(detail.parentActivityId, group);
  });

  const next = details.map((detail) => ({ ...detail }));
  for (const [parentId, group] of groups) {
    const targetSeconds = Math.max(0, (activityDurations.get(parentId) ?? 0) * 60);
    const allocations = allocateIntegerByWeights(
      targetSeconds,
      group.map(({ detail }) => Math.max(1, detail.targetDurationSec ?? (detail.durationMin ?? 1) * 60)),
    );
    group.forEach(({ index }, childIndex) => {
      const seconds = allocations[childIndex] ?? 0;
      next[index] = {
        ...next[index],
        targetDurationSec: seconds,
        durationMin: Math.max(1, Math.round(seconds / 60)),
      };
    });
  }
  return next;
}

export function estimateTtsDurationSec(
  text: string,
  options: {
    speed?: number;
    minSeconds?: number;
    providerId?: string;
    modelId?: string;
  } = {},
): number {
  return estimateSpeechDurationSec(text, {
    speed: options.speed,
    minSeconds: options.minSeconds,
    providerId: options.providerId,
    modelId: options.modelId,
  });
}
