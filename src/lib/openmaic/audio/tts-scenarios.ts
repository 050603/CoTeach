export const TTS_SCENARIO_IDS = [
  'course-generation',
  'realtime-interaction',
] as const;

export type TtsScenarioId = (typeof TTS_SCENARIO_IDS)[number];

export type TtsScenarioConfig = {
  modelId: string;
  voiceId: string;
};

export type TtsScenarioConfigs = Partial<Record<TtsScenarioId, TtsScenarioConfig>>;

export const DEFAULT_TTS_SCENARIO: TtsScenarioId = 'realtime-interaction';

export const TTS_SCENARIOS: ReadonlyArray<{
  id: TtsScenarioId;
  label: string;
  badge: string;
  description: string;
}> = [
  {
    id: 'course-generation',
    label: '课程生成',
    badge: '质量优先',
    description: '用于批量生成课程讲稿音频，允许更长响应时间，优先保证音质与表现力。',
  },
  {
    id: 'realtime-interaction',
    label: '实时交互',
    badge: '速度优先',
    description: '用于 AI 讨论、习题讲解与助教朗读，优先降低首句等待时间。',
  },
];

export function isTtsScenarioId(value: unknown): value is TtsScenarioId {
  return typeof value === 'string' && TTS_SCENARIO_IDS.includes(value as TtsScenarioId);
}

export function normalizeTtsScenarioId(value: unknown): TtsScenarioId {
  return isTtsScenarioId(value) ? value : DEFAULT_TTS_SCENARIO;
}

export function resolveTtsScenarioConfig(
  configs: TtsScenarioConfigs | undefined,
  scenario: TtsScenarioId,
  fallback: TtsScenarioConfig,
): TtsScenarioConfig {
  const configured = configs?.[scenario];
  return {
    modelId: configured?.modelId || fallback.modelId,
    voiceId: configured?.voiceId || fallback.voiceId,
  };
}
