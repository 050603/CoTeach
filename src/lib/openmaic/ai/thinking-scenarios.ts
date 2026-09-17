import type { ThinkingConfig, ThinkingEffort } from '@openmaic/lib/types/provider';

export const LLM_THINKING_SCENARIOS = [
  {
    id: 'course-planning',
    label: '课程规划',
    description: '课程结构、课堂方案与智能体角色规划',
  },
  {
    id: 'content-generation',
    label: '课件内容生成',
    description: '页面、讲稿、互动内容与封面策划',
  },
  {
    id: 'learning-assessment',
    label: '学习评价',
    description: '测验判定、学习表现与任务完成度评价',
  },
  {
    id: 'classroom-interaction',
    label: '课堂实时互动',
    description: 'PBL 对话、开放任务与课堂模拟',
  },
  {
    id: 'ai-copilot',
    label: 'AI 协作与编辑',
    description: 'AI 组员、页面编辑和教师智能助手',
  },
  {
    id: 'search-understanding',
    label: '搜索意图理解',
    description: '联网搜索前的查询分析与改写',
  },
] as const;

export type LlmThinkingScenarioId = (typeof LLM_THINKING_SCENARIOS)[number]['id'];
export type ThinkingScenarioPreset = 'baseline' | ThinkingEffort;
export type LlmThinkingScenarioConfigs = Partial<
  Record<LlmThinkingScenarioId, ThinkingScenarioPreset>
>;

const VALID_PRESETS = new Set<ThinkingScenarioPreset>([
  'baseline',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

const STAGE_SCENARIOS: Record<string, LlmThinkingScenarioId> = {
  'scene-outlines-stream': 'course-planning',
  'generate-classroom': 'course-planning',
  'agent-profiles': 'course-planning',
  'scene-content': 'content-generation',
  'scene-actions': 'content-generation',
  'course-cover-plan': 'content-generation',
  'course-cover-review': 'content-generation',
  'quiz-grade': 'learning-assessment',
  'pbl-v2-runtime:evaluate': 'learning-assessment',
  'pbl-chat': 'classroom-interaction',
  'pbl-v2-runtime': 'classroom-interaction',
  'chat-adapter': 'ai-copilot',
  'maic-agent': 'ai-copilot',
  'web-search-query-rewrite': 'search-understanding',
};

/** Maps a technical model stage to the teacher-facing application scenario. */
export function getThinkingScenarioForStage(
  stage?: string,
): LlmThinkingScenarioId | undefined {
  if (!stage) return undefined;
  let key: string | undefined = stage;
  while (key) {
    const scenario = STAGE_SCENARIOS[key];
    if (scenario) return scenario;
    const lastColon = key.lastIndexOf(':');
    key = lastColon > 0 ? key.slice(0, lastColon) : undefined;
  }
  return undefined;
}

/**
 * Baseline deliberately resolves to undefined: the provider/model keeps the
 * exact behavior it had before scenario overrides were introduced.
 */
export function thinkingConfigFromPreset(
  preset?: ThinkingScenarioPreset,
): ThinkingConfig | undefined {
  if (!preset || !VALID_PRESETS.has(preset) || preset === 'baseline') return undefined;
  if (preset === 'none') {
    return { mode: 'disabled', enabled: false, effort: 'none' };
  }
  return { mode: 'enabled', enabled: true, effort: preset };
}

export function resolveScenarioThinkingConfig(
  configs: LlmThinkingScenarioConfigs | undefined,
  stage?: string,
): ThinkingConfig | undefined {
  const scenario = getThinkingScenarioForStage(stage);
  return scenario ? thinkingConfigFromPreset(configs?.[scenario]) : undefined;
}
