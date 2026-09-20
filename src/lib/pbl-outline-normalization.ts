import type {
  KnowledgeGraph,
  KnowledgePoint,
  TeachingOutlineSection,
} from '@/lib/session/types';
import {
  classifyPblActivityKind,
  PBL_MODULE_DEFINITIONS,
  normalizePblStageKey,
  suggestPblTimeAllocation,
  type PblModuleTimingPlan,
  type PblTimeModelContext,
} from '@/lib/pbl-time-model';

type NormalizePblTeachingOutlineOptions = Omit<PblTimeModelContext, 'knowledgePoints' | 'knowledgeGraph'> & {
  totalMinutes: number;
  applyTimeModel?: boolean;
  knowledgePoints?: ReadonlyArray<KnowledgePoint>;
  knowledgeGraph?: KnowledgeGraph;
};

const AI_LEARNING_RESOURCE_TYPES = [
  'ppt',
  'interactive-demo',
  'code-interactive',
] as const satisfies NonNullable<TeachingOutlineSection['resourceTypes']>;

/**
 * Keep the first-level module contract aligned with the fixed six-stage
 * generation routes. Ordinary stages always produce teacher presentation
 * support, while the AI-learning stage always produces all three supported
 * student scene types.
 */
export function normalizeTeachingModuleResourceTypes(
  activity: Pick<TeachingOutlineSection, 'stageKey' | 'resourceTypes'>,
): NonNullable<TeachingOutlineSection['resourceTypes']> {
  if (activity.stageKey !== 'ai-learning') return ['ppt', 'script'];
  return [...AI_LEARNING_RESOURCE_TYPES];
}

export type PblOutlineStructureIssue = {
  code: 'missing-stage' | 'duplicate-stage' | 'invalid-order' | 'unexpected-stage';
  stageKey?: string;
  message: string;
};

const KIND_TO_DEFINITION = new Map(
  PBL_MODULE_DEFINITIONS.map((definition) => [definition.kind, definition]),
);

function defaultTeachingActivity(
  definition: (typeof PBL_MODULE_DEFINITIONS)[number],
  index: number,
  knowledgePointIds: string[],
): TeachingOutlineSection {
  const isKnowledge = definition.stageKey === 'ai-learning';
  return {
    id: `pbl-module-${definition.stageKey}`,
    stageKey: definition.stageKey,
    title: definition.defaultTitle,
    durationMin: 1,
    teachingGoal:
      isKnowledge
        ? '按知识图谱的先修关系建构核心知识，并通过短练习检查理解。'
        : `完成${definition.label}的关键课堂任务，并为下一模块留下可追溯证据。`,
    teacherRole:
      isKnowledge
        ? '根据学生理解情况进行点拨和必要的全班讲解。'
        : `主持${definition.label}，明确过程要求并根据真实证据追问。`,
    platformRole: isKnowledge
      ? '展示知识图谱、分发学习内容并记录学习结果。'
      : '展示教师支架、收集学生提交物并沉淀过程证据。',
    aiRole: isKnowledge
      ? '生成知识讲解、测验或互动练习，并根据作答提供解释。'
      : '提供伴学提示、记录证据和提出澄清问题，不替学生完成项目。',
    studentActivity: isKnowledge
      ? '学习核心知识并完成必要的互动或测验；只在有助于理解或迁移时连接驱动问题。'
      : `围绕${definition.label}完成个人项目任务，保存相应过程证据。`,
    activityKind: definition.kind,
    knowledgePointIds,
    openMaicUse: isKnowledge ? 'student-ai-learning' : 'none',
    resourceTypes: isKnowledge ? ['ppt'] : ['ppt', 'script'],
    notes: `课程模块 ${index + 1}：${definition.resourcePlan}`,
  };
}

function knowledgeContext(
  options: NormalizePblTeachingOutlineOptions,
): PblTimeModelContext {
  return {
    topic: options.topic,
    subject: options.subject,
    summary: options.summary,
    grade: options.grade,
    difficulty: options.difficulty,
    knowledgePoints: options.knowledgePoints,
    knowledgeGraph: options.knowledgeGraph,
  };
}

function uniqueText(values: Array<string | undefined>): string {
  return Array.from(new Set(values.map((value) => value?.trim()).filter(Boolean))).join('；');
}

function mergeStageActivities(
  definition: (typeof PBL_MODULE_DEFINITIONS)[number],
  activities: TeachingOutlineSection[],
  index: number,
  allKnowledgePointIds: string[],
): TeachingOutlineSection {
  const fallback = defaultTeachingActivity(
    definition,
    index,
    definition.kind === 'knowledge' ? allKnowledgePointIds : [],
  );
  if (activities.length === 0) return fallback;
  const first = activities[0]!;
  const isKnowledge = definition.kind === 'knowledge';
  return {
    ...fallback,
    ...first,
    id: first.id || fallback.id,
    stageKey: definition.stageKey,
    activityKind: definition.kind,
    durationMin: activities.reduce(
      (sum, activity) => sum + Math.max(1, Math.round(Number(activity.durationMin) || 1)),
      0,
    ),
    title: first.title?.trim() || fallback.title,
    teachingGoal: uniqueText(activities.map((activity) => activity.teachingGoal)) || fallback.teachingGoal,
    teacherRole: uniqueText(activities.map((activity) => activity.teacherRole)) || fallback.teacherRole,
    platformRole: uniqueText(activities.map((activity) => activity.platformRole)) || fallback.platformRole,
    aiRole: uniqueText(activities.map((activity) => activity.aiRole)) || fallback.aiRole,
    studentActivity: uniqueText(activities.map((activity) => activity.studentActivity)) || fallback.studentActivity,
    knowledgePointIds: isKnowledge
      ? Array.from(new Set([
          ...allKnowledgePointIds,
          ...activities.flatMap((activity) => activity.knowledgePointIds ?? []),
        ]))
      : Array.from(new Set(activities.flatMap((activity) => activity.knowledgePointIds ?? []))),
    openMaicUse: isKnowledge ? 'student-ai-learning' : 'none',
    resourceTypes: normalizeTeachingModuleResourceTypes({
      stageKey: definition.stageKey,
      resourceTypes: isKnowledge
        ? Array.from(new Set(activities.flatMap((activity) => activity.resourceTypes ?? ['ppt'])))
        : first.resourceTypes,
    }),
    notes: uniqueText(activities.map((activity) => activity.notes)) || fallback.notes,
  };
}

/** Create the six neutral modules used only for the teacher's timing decision. */
export function createPblTimingSkeleton(
  options: NormalizePblTeachingOutlineOptions,
): TeachingOutlineSection[] {
  const knowledgePointIds = (options.knowledgePoints ?? []).map((point) => point.id).filter(Boolean);
  const skeleton = PBL_MODULE_DEFINITIONS.map((definition, index) =>
    defaultTeachingActivity(definition, index, definition.kind === 'knowledge' ? knowledgePointIds : []),
  );
  const suggestions = suggestPblTimeAllocation(
    options.totalMinutes,
    skeleton,
    knowledgeContext(options),
  );
  return skeleton.map((activity) => ({
    ...activity,
    durationMin: suggestions[activity.id] ?? activity.durationMin,
  }));
}

export function assessPblTeachingOutlineStructure(
  activities: ReadonlyArray<TeachingOutlineSection>,
): PblOutlineStructureIssue[] {
  const issues: PblOutlineStructureIssue[] = [];
  const normalizedKeys = activities.map((activity) => normalizePblStageKey(activity.stageKey));
  PBL_MODULE_DEFINITIONS.forEach((definition, expectedIndex) => {
    const matches = normalizedKeys.flatMap((key, index) => key === definition.stageKey ? [index] : []);
    if (matches.length === 0) {
      issues.push({ code: 'missing-stage', stageKey: definition.stageKey, message: `缺少顶级阶段 ${definition.label}` });
    } else if (matches.length > 1) {
      issues.push({ code: 'duplicate-stage', stageKey: definition.stageKey, message: `顶级阶段 ${definition.label} 重复出现` });
    }
    if (matches.length === 1 && matches[0] !== expectedIndex) {
      issues.push({ code: 'invalid-order', stageKey: definition.stageKey, message: `顶级阶段 ${definition.label} 顺序错误` });
    }
  });
  normalizedKeys.forEach((key, index) => {
    if (!key) issues.push({ code: 'unexpected-stage', stageKey: activities[index]?.stageKey, message: '存在无法识别的顶级阶段' });
  });
  return issues;
}

/** Overlay the teacher-confirmed identity and duration onto generated content. */
export function applyConfirmedPblTimingPlan(
  activities: ReadonlyArray<TeachingOutlineSection>,
  timingPlan: PblModuleTimingPlan,
  options: NormalizePblTeachingOutlineOptions,
): TeachingOutlineSection[] {
  const sourceKinds = activities.map((activity) => classifyPblActivityKind(activity));
  const missingDefinition = PBL_MODULE_DEFINITIONS.find(
    (definition) => !sourceKinds.includes(definition.kind),
  );
  if (missingDefinition) {
    throw new Error(`课程模块结构不完整：AI 未生成 ${missingDefinition.label}`);
  }
  if (sourceKinds.includes('other')) {
    throw new Error('课程模块结构不完整：AI 返回了无法归入六阶段的顶级模块');
  }
  const normalized = normalizePblTeachingOutline(activities, {
    ...options,
    applyTimeModel: false,
  });
  return PBL_MODULE_DEFINITIONS.map((definition) => {
    const generated = normalized.find(
      (activity) => classifyPblActivityKind(activity) === definition.kind,
    );
    const confirmed = timingPlan.allocations.find(
      (activity) => classifyPblActivityKind(activity) === definition.kind,
    );
    if (!generated || !confirmed) {
      throw new Error(`课程模块结构不完整：缺少 ${definition.label}`);
    }
    return {
      ...generated,
      id: confirmed.id,
      stageKey: definition.stageKey,
      activityKind: definition.kind,
      durationMin: confirmed.durationMin,
    };
  });
}

/**
 * Normalize a generated first-level outline into a six-module timeline.
 * Model variations are merged into the matching canonical stage. Top-level
 * output is always exactly six modules; detail variation belongs downstream.
 */
export function normalizePblTeachingOutline(
  activities: ReadonlyArray<TeachingOutlineSection>,
  options: NormalizePblTeachingOutlineOptions,
): TeachingOutlineSection[] {
  if (activities.length === 0) return [];

  const knownIds = new Set(
    (options.knowledgePoints ?? []).map((point) => point.id).filter(Boolean),
  );
  const source = activities.map((activity, index) => {
    const kind = classifyPblActivityKind(activity);
    const definition = kind === 'other' ? undefined : KIND_TO_DEFINITION.get(kind);
    const stageKey = definition?.stageKey ?? normalizePblStageKey(activity.stageKey) ?? 'make';
    const validKnowledgePointIds = (activity.knowledgePointIds ?? []).filter((id) =>
      knownIds.size === 0 ? Boolean(id) : knownIds.has(id),
    );
    return {
      ...activity,
      id: activity.id || `to-${index + 1}`,
      stageKey,
      activityKind: definition?.kind ?? 'practice',
      durationMin: Number.isFinite(Number(activity.durationMin))
        ? Math.max(1, Math.round(Number(activity.durationMin)))
        : 1,
      knowledgePointIds: validKnowledgePointIds,
      openMaicUse: stageKey === 'ai-learning' ? 'student-ai-learning' : 'none',
      resourceTypes: normalizeTeachingModuleResourceTypes({
        stageKey,
        resourceTypes: activity.resourceTypes,
      }),
    } satisfies TeachingOutlineSection;
  });

  const byKind = new Map<string, TeachingOutlineSection[]>();
  for (const activity of source) {
    const kind = classifyPblActivityKind(activity);
    const group = byKind.get(kind) ?? [];
    group.push(activity);
    byKind.set(kind, group);
  }

  const normalized = PBL_MODULE_DEFINITIONS.map((definition, index) =>
    mergeStageActivities(
      definition,
      byKind.get(definition.kind) ?? [],
      index,
      Array.from(knownIds),
    ),
  );
  const suggestions = options.applyTimeModel === false
    ? {}
    : suggestPblTimeAllocation(
        options.totalMinutes,
        normalized,
        knowledgeContext(options),
      );

  return normalized.map((activity) => ({
    ...activity,
    durationMin: suggestions[activity.id] ?? activity.durationMin,
  }));
}
