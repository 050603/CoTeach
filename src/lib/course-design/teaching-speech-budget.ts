import {
  calculateTtsContentBudget,
  getTtsTimingProfile,
  type TtsTimingProfile,
} from '@/lib/openmaic/audio/tts-timing';

export type TeachingSpeechTiming = {
  providerId?: string;
  modelId?: string;
  voiceId?: string;
  language?: string;
};

/** First-authoring guidance using the same natural-speed model as real TTS. */
export function buildTeachingSpeechBudget(input: TeachingSpeechTiming & {
  targetDurationSec: number;
  narrationDurationSec?: number;
  profile?: TtsTimingProfile;
  speed?: 1;
  pageHints?: readonly { pageId: string; narrationDurationSec: number }[];
}) {
  const targetDurationSec = Math.max(0, Number(input.targetDurationSec) || 0);
  const narrationDurationSec = Math.max(0, Math.min(targetDurationSec,
    input.narrationDurationSec ?? targetDurationSec));
  const language = input.language ?? 'zh-CN';
  const profile = input.profile ?? getTtsTimingProfile(input.providerId, input.modelId, input.voiceId, language, 1);
  const budgetFor = (seconds: number) => {
    const budget = calculateTtsContentBudget(Math.max(1, seconds), { profile, language, speed: 1 });
    return seconds > 0 ? budget : { ...budget, targetDurationSec: 0, targetUnits: 0, minUnits: 0, maxUnits: 0 };
  };
  return {
    ...budgetFor(narrationDurationSec),
    targetDurationSec,
    narrationDurationSec,
    reservedDurationSec: targetDurationSec - narrationDurationSec,
    naturalSpeed: 1 as const,
    profile: { id: profile.id, providerId: input.providerId ?? profile.providerId,
      modelId: input.modelId ?? profile.modelId, voiceId: input.voiceId ?? profile.voiceId,
      source: profile.source },
    allocation: 'section-total-with-soft-page-hints' as const,
    enforcement: 'reference-only' as const,
    priority: 'clear-and-complete-explanation' as const,
    referenceTolerance: 0.1,
    quoteExpansionIncluded: true,
    pageHints: (input.pageHints ?? []).map((page) => ({ pageId: page.pageId,
      narrationDurationSec: Math.max(0, page.narrationDurationSec),
      ...budgetFor(Math.max(0, page.narrationDurationSec)),
    })),
    guidance: '时长和文字量仅用于安排节奏、定位重复，不作为质量通过或失败的条件。各页份额与全节时长均可按解释需要调整，必要超时允许；优先把应教知识、案例前提和推理讲清楚。单位数计入完整引句展开与估计标点停顿；阅读、操作、视频及切换时间另行保留，不重复计入朗读。自然语速固定1.0，不靠加速、重复、填充或删减必需教学内容凑预算。',
  };
}
