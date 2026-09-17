/**
 * Static TTS timing profiles and content budgets.
 *
 * The TTS provider registry describes API capabilities. This registry describes
 * the timing characteristics needed by the course planner. Keeping the two
 * concerns separate means a new provider can be added to the timing model
 * without changing any generation or playback code.
 */

import offlineVoiceCalibrations from './tts-voice-calibrations.json';

export const TTS_TIMING_ALGORITHM_VERSION = 4;

export type TtsSpeechUnit = 'cjk-char' | 'latin-word' | 'mixed-unit';

export type TtsTimingProfile = {
  id: string;
  providerId: string;
  modelId: string;
  voiceId?: string;
  label: string;
  cjkCharsPerMinute: number;
  latinWordsPerMinute: number;
  punctuationPauseSec: number;
  fixedOverheadSec?: number;
  defaultSpeed: number;
  source: 'seed' | 'configured';
};

export type TtsCalibrationMeasurement = {
  cjkChars: number;
  latinWords: number;
  punctuation: number;
  durationSec: number;
};

export type TtsVoiceTimingCalibration = {
  /** Missing versions are legacy measurements and must be recalibrated. */
  algorithmVersion?: number;
  fixedOverheadSec?: number;
  punctuationPauseSec?: number;
  measurements?: TtsCalibrationMeasurement[];
  rateModel?: 'linear-v1' | 'relative-linear-v1';
  providerId: string;
  modelId: string;
  voiceId: string;
  language: string;
  cjkCharsPerMinute: number;
  latinWordsPerMinute: number;
  sampleUnits: number;
  measuredDurationSec: number;
  /** Natural playback speed used for this profile. Currently calibration is performed at 1.0. */
  speed?: number;
  /** Number of independent samples represented by this aggregate. */
  sampleCount?: number;
  /** Aggregate speech units used to compute the shared weighted rate. */
  totalSampleUnits?: number;
  /** Aggregate decoded audio duration used to compute the shared weighted rate. */
  totalMeasuredDurationSec?: number;
  calibratedAt: string;
};

export type TtsContentBudget = {
  unit: TtsSpeechUnit;
  targetUnits: number;
  minUnits: number;
  maxUnits: number;
  targetDurationSec: number;
  effectiveCharsPerMinute?: number;
  effectiveWordsPerMinute?: number;
  /** Chinese-equivalent units per English reference word (~1.5 syllables). */
  latinReferenceWordCjkUnits?: number;
};

export type TtsNarrationParagraphBudget = TtsContentBudget & {
  role: 'introduction' | 'explanation' | 'example' | 'feedback';
};

export type TtsTimingPlan = {
  algorithmVersion?: number;
  paragraphBudgets?: TtsNarrationParagraphBudget[];
  providerId: string;
  modelId: string;
  voiceId?: string;
  profileId: string;
  language: string;
  speed: number;
  contentType: string;
  pageKind?: 'slide' | 'interactive' | 'quiz';
  /** Whether duration fitting is forbidden from changing the natural 1.0 rate. */
  naturalSpeedLocked?: boolean;
  /** Exact voice calibration when available; otherwise a conservative seeded model profile. */
  calibrationSource?: TtsTimingProfile['source'];
  /** Effective rate after punctuation pauses, expressed in the plan's speech unit. */
  effectiveUnitsPerMinute?: number;
  latinReferenceWordCjkUnits?: number;
  /** Natural-speed speech guidance and explanation. */
  narrationSec?: number;
  /** Silent comprehension time before/during the learner task. */
  readingThinkingSec?: number;
  /** Silent manipulation, writing, coding, selection, and submission time. */
  operationSec?: number;
  /** Silent time reserved for reading, thinking, answering, coding, or manipulating a widget. */
  studentActivitySec?: number;
  /** Feedback or answer-analysis time included in narrationSec. */
  feedbackSec?: number;
  transitionSec?: number;
  /** Reserved playback time; excluded from narration and learner activity. */
  videoSec?: number;
  /** Total activity budget; targetDurationSec is the narration budget. */
  activityTargetDurationSec?: number;
  targetDurationSec: number;
  unit: TtsSpeechUnit;
  targetUnits: number;
  minUnits: number;
  maxUnits: number;
  taskComplexity?: 'low' | 'medium' | 'high';
  recommendedStudentActivitySec?: number;
  taskFitsBudget?: boolean;
  timingRationale?: string[];
};

export type TtsDurationAssessment = {
  targetSec: number;
  actualSec: number;
  errorRatio: number;
  absoluteErrorRatio: number;
  tolerance: number;
  withinTolerance: boolean;
  status: 'within' | 'under' | 'over';
  suggestions: string[];
};

const DEFAULT_PROFILE: TtsTimingProfile = {
  id: 'default:zh-CN',
  providerId: 'default',
  modelId: 'default',
  label: '默认普通话 TTS',
  // Static defaults are intentionally conservative and can be replaced by an
  // explicitly configured model profile.
  cjkCharsPerMinute: 270,
  latinWordsPerMinute: 150,
  punctuationPauseSec: 0.18,
  defaultSpeed: 1,
  source: 'seed',
};

const PROFILE_SEEDS: readonly Omit<TtsTimingProfile, 'source'>[] = [
  { id: 'openai-tts:gpt-4o-mini-tts', providerId: 'openai-tts', modelId: 'gpt-4o-mini-tts', label: 'OpenAI GPT-4o Mini TTS', cjkCharsPerMinute: 270, latinWordsPerMinute: 155, punctuationPauseSec: 0.18, defaultSpeed: 1 },
  { id: 'openai-tts:tts-1', providerId: 'openai-tts', modelId: 'tts-1', label: 'OpenAI TTS-1', cjkCharsPerMinute: 265, latinWordsPerMinute: 150, punctuationPauseSec: 0.18, defaultSpeed: 1 },
  { id: 'openai-tts:tts-1-hd', providerId: 'openai-tts', modelId: 'tts-1-hd', label: 'OpenAI TTS-1 HD', cjkCharsPerMinute: 260, latinWordsPerMinute: 145, punctuationPauseSec: 0.18, defaultSpeed: 1 },
  { id: 'azure-tts:default', providerId: 'azure-tts', modelId: '', label: 'Azure Neural TTS', cjkCharsPerMinute: 255, latinWordsPerMinute: 145, punctuationPauseSec: 0.2, defaultSpeed: 1 },
  { id: 'glm-tts:glm-tts', providerId: 'glm-tts', modelId: 'glm-tts', label: 'GLM TTS', cjkCharsPerMinute: 270, latinWordsPerMinute: 150, punctuationPauseSec: 0.18, defaultSpeed: 1 },
  { id: 'qwen-tts:qwen-audio-3.0-tts-plus', providerId: 'qwen-tts', modelId: 'qwen-audio-3.0-tts-plus', label: 'Qwen Audio 3.0 TTS Plus', cjkCharsPerMinute: 270, latinWordsPerMinute: 150, punctuationPauseSec: 0.18, defaultSpeed: 1 },
  { id: 'qwen-tts:qwen-audio-3.0-tts-flash', providerId: 'qwen-tts', modelId: 'qwen-audio-3.0-tts-flash', label: 'Qwen Audio 3.0 TTS Flash', cjkCharsPerMinute: 275, latinWordsPerMinute: 155, punctuationPauseSec: 0.17, defaultSpeed: 1 },
  { id: 'minimax-tts:speech-2.8-hd', providerId: 'minimax-tts', modelId: 'speech-2.8-hd', label: 'MiniMax Speech 2.8 HD', cjkCharsPerMinute: 285, latinWordsPerMinute: 160, punctuationPauseSec: 0.16, defaultSpeed: 1 },
  { id: 'minimax-tts:speech-2.8-turbo', providerId: 'minimax-tts', modelId: 'speech-2.8-turbo', label: 'MiniMax Speech 2.8 Turbo', cjkCharsPerMinute: 300, latinWordsPerMinute: 170, punctuationPauseSec: 0.15, defaultSpeed: 1 },
  { id: 'minimax-tts:speech-2.6-hd', providerId: 'minimax-tts', modelId: 'speech-2.6-hd', label: 'MiniMax Speech 2.6 HD', cjkCharsPerMinute: 280, latinWordsPerMinute: 155, punctuationPauseSec: 0.17, defaultSpeed: 1 },
  { id: 'doubao-tts:default', providerId: 'doubao-tts', modelId: '', label: '豆包 TTS 2.0', cjkCharsPerMinute: 285, latinWordsPerMinute: 160, punctuationPauseSec: 0.16, defaultSpeed: 1 },
  { id: 'elevenlabs-tts:eleven_multilingual_v2', providerId: 'elevenlabs-tts', modelId: 'eleven_multilingual_v2', label: 'ElevenLabs Multilingual v2', cjkCharsPerMinute: 250, latinWordsPerMinute: 145, punctuationPauseSec: 0.2, defaultSpeed: 1 },
  { id: 'lemonade-tts:kokoro-v1', providerId: 'lemonade-tts', modelId: 'kokoro-v1', label: 'Lemonade Kokoro', cjkCharsPerMinute: 260, latinWordsPerMinute: 150, punctuationPauseSec: 0.18, defaultSpeed: 1 },
  { id: 'voxcpm-tts:voxcpm2', providerId: 'voxcpm-tts', modelId: 'voxcpm2', label: 'VoxCPM2', cjkCharsPerMinute: 240, latinWordsPerMinute: 135, punctuationPauseSec: 0.22, defaultSpeed: 1 },
  { id: 'browser-native-tts:default', providerId: 'browser-native-tts', modelId: '', label: '浏览器原生 TTS', cjkCharsPerMinute: 245, latinWordsPerMinute: 135, punctuationPauseSec: 0.22, defaultSpeed: 1 },
];

export const TTS_TIMING_PROFILES: readonly TtsTimingProfile[] = PROFILE_SEEDS.map((profile) => ({
  ...profile,
  source: 'seed' as const,
}));

const runtimeProfiles = new Map<string, TtsTimingProfile>();
const calibratedProfiles = new Map<string, TtsTimingProfile>();

/** Register a new model without changing the provider implementation. */
export function registerTtsTimingProfile(
  profile: Omit<TtsTimingProfile, 'source'> & { source?: TtsTimingProfile['source'] },
): TtsTimingProfile {
  const normalized: TtsTimingProfile = {
    ...profile,
    providerId: profile.providerId.trim(),
    modelId: profile.modelId.trim(),
    id: profile.id.trim() || `${profile.providerId}:${profile.modelId || 'default'}`,
    cjkCharsPerMinute: Math.max(1, profile.cjkCharsPerMinute),
    latinWordsPerMinute: Math.max(1, profile.latinWordsPerMinute),
    punctuationPauseSec: Math.max(0, profile.punctuationPauseSec),
    defaultSpeed: clamp(profile.defaultSpeed || 1, 0.25, 4),
    source: profile.source ?? 'configured',
  };
  runtimeProfiles.set(`${normalized.providerId}:${normalized.modelId}:${normalized.voiceId ?? ''}`, normalized);
  return normalized;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeModelId(modelId?: string): string {
  return modelId?.trim() || '';
}

export function getTtsTimingProfile(providerId?: string, modelId?: string, voiceId?: string, language = 'zh-CN', speed = 1): TtsTimingProfile {
  const provider = providerId?.trim() || DEFAULT_PROFILE.providerId;
  const model = normalizeModelId(modelId);
  const voice = voiceId?.trim() || '';
  const calibrated = calibratedProfiles.get(getTtsCalibrationKey({
    providerId: provider, modelId: model, voiceId: voice || 'default', language, speed,
    algorithmVersion: TTS_TIMING_ALGORITHM_VERSION,
  }));
  if (calibrated) return calibrated;
  const offline = (offlineVoiceCalibrations.profiles as TtsVoiceTimingCalibration[]).find((profile) =>
    profile.algorithmVersion === TTS_TIMING_ALGORITHM_VERSION
    && getTtsCalibrationKey(profile) === getTtsCalibrationKey({
      providerId: provider, modelId: model, voiceId: voice || 'default', language, speed,
      algorithmVersion: TTS_TIMING_ALGORITHM_VERSION,
    }),
  );
  if (offline) return registerTtsVoiceTimingCalibration(offline as TtsVoiceTimingCalibration);
  const runtimeExact = runtimeProfiles.get(`${provider}:${model}:${voice}`)
    ?? runtimeProfiles.get(`${provider}:${model}:`);
  if (runtimeExact) return runtimeExact;
  const runtimeDefault = runtimeProfiles.get(`${provider}::${voice}`)
    ?? runtimeProfiles.get(`${provider}::`);
  if (runtimeDefault && !model) return runtimeDefault;
  const exact = TTS_TIMING_PROFILES.find(
    (profile) => profile.providerId === provider && profile.modelId === model,
  );
  if (exact) return exact;

  const providerDefault = TTS_TIMING_PROFILES.find(
    (profile) => profile.providerId === provider && (!profile.modelId || profile.id.endsWith(':default')),
  );
  if (providerDefault) {
    return model && providerDefault.modelId !== model
      ? { ...providerDefault, id: `${provider}:${model}`, modelId: model, label: `${providerDefault.label} (${model})` }
      : providerDefault;
  }

  const providerProfile = TTS_TIMING_PROFILES.find((profile) => profile.providerId === provider);
  if (providerProfile) {
    return model && providerProfile.modelId !== model
      ? { ...providerProfile, id: `${provider}:${model}`, modelId: model, label: `${providerProfile.label} (${model})` }
      : providerProfile;
  }
  if (provider !== DEFAULT_PROFILE.providerId || model) {
    return {
      ...DEFAULT_PROFILE,
      id: `${provider}:${model || 'default'}`,
      providerId: provider,
      modelId: model,
      label: `${provider}${model ? ` (${model})` : ''}`,
    };
  }
  return DEFAULT_PROFILE;
}

/** English articulation estimate in reference words of 1.5 syllables. */
export function countLatinArticulationUnits(text: string): number {
  const words = text.normalize('NFKC').replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu, ' ').match(/\p{L}+(?:['’]\p{L}+)?|\d+(?:\.\d+)?/gu) ?? [];
  const syllables = words.reduce((total, word) => {
    if (/^[A-Z]{2,6}$/.test(word)) return total + word.length + (word.match(/W/g)?.length ?? 0) * 2;
    if (/^\d/.test(word)) return total + word.replace('.', '').length + (word.includes('.') ? 1 : 0);
    if (/[^A-Za-z'’]/.test(word)) return total + 1.5;
    const lower = word.toLowerCase().replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
    return total + Math.max(1, lower.match(/[aeiouy]{1,2}/g)?.length ?? 1);
  }, 0);
  return syllables / 1.5;
}

export function countSpeechUnits(text: string): {
  cjkChars: number;
  latinWords: number;
  otherChars: number;
  punctuation: number;
} {
  let remaining = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const cjkPattern = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu;
  const cjkChars = (remaining.match(cjkPattern) ?? []).length;
  remaining = remaining.replace(cjkPattern, ' ');
  const wordPattern = /\p{L}+(?:['’]\p{L}+)?|\d+(?:\.\d+)?/gu;
  const latinWords = (remaining.match(wordPattern) ?? []).length;
  // Remove the entire matched word, not one character per word. Otherwise
  // "hello" contributes both one word and four phantom CJK units.
  remaining = remaining.replace(wordPattern, '');
  const punctuationPattern = /[，。！？；：、,.!?;:]/gu;
  const punctuation = (remaining.match(punctuationPattern) ?? []).length;
  const otherChars = [...remaining.replace(/[\p{P}\p{Z}\s]/gu, '')].length;
  return { cjkChars, latinWords, otherChars, punctuation };
}

/** Build an explicit provider/model/voice profile from one normal-speed sample. */
export function createTtsVoiceTimingCalibration(options: {
  providerId: string;
  modelId?: string;
  voiceId?: string;
  language?: string;
  text: string;
  measuredDurationSec: number;
  speed?: number;
  calibratedAt?: string;
}): TtsVoiceTimingCalibration {
  const duration = Math.max(0.1, Number(options.measuredDurationSec) || 0.1);
  const units = countSpeechUnits(options.text);
  const latinArticulationUnits = countLatinArticulationUnits(options.text);
  const seed = getTtsTimingProfile(options.providerId, options.modelId);
  // Express mixed samples in one seed-equivalent unit so English words are
  // represented exactly once and repeated mixed calibrations aggregate safely.
  const cjkUnits = units.cjkChars + units.otherChars
    + latinArticulationUnits * seed.cjkCharsPerMinute / seed.latinWordsPerMinute;
  const measuredCjk = (Math.max(1, cjkUnits) * 60) / duration;
  const measuredLatin = measuredCjk * seed.latinWordsPerMinute / seed.cjkCharsPerMinute;
  return {
    algorithmVersion: TTS_TIMING_ALGORITHM_VERSION,
    measurements: [{ cjkChars: units.cjkChars + units.otherChars, latinWords: latinArticulationUnits, punctuation: units.punctuation, durationSec: duration }],
    providerId: options.providerId.trim(),
    modelId: options.modelId?.trim() || '',
    voiceId: options.voiceId?.trim() || 'default',
    language: options.language || 'zh-CN',
    cjkCharsPerMinute: Math.round(Math.max(1, measuredCjk) * 10) / 10,
    latinWordsPerMinute: Math.round(Math.max(1, measuredLatin) * 10) / 10,
    sampleUnits: Math.max(1, cjkUnits || units.latinWords),
    measuredDurationSec: Math.round(duration * 100) / 100,
    speed: clamp(Number(options.speed ?? 1) || 1, 0.25, 4),
    sampleCount: 1,
    totalSampleUnits: Math.max(1, cjkUnits || units.latinWords),
    totalMeasuredDurationSec: Math.round(duration * 100) / 100,
    calibratedAt: options.calibratedAt || new Date().toISOString(),
  };
}

export function getTtsCalibrationKey(
  calibration: Pick<TtsVoiceTimingCalibration, 'providerId' | 'modelId' | 'voiceId' | 'language' | 'speed' | 'algorithmVersion'>,
): string {
  return [
    String(calibration.algorithmVersion ?? 1),
    calibration.providerId.trim(),
    calibration.modelId.trim(),
    calibration.voiceId.trim() || 'default',
    calibration.language.trim().toLowerCase() || 'zh-cn',
    String(clamp(Number(calibration.speed ?? 1) || 1, 0.25, 4)),
  ].join('::');
}

/**
 * A small nonnegative ridge regression separates articulation, punctuation and
 * fixed segment overhead. Priors keep sparse or correlated mixed-language
 * samples from producing implausible rates. Relative-error weighting keeps long
 * clips from dominating the ±10% timing objective. Only independent calibration audio
 * is fitted; runtime narration never enters a correction loop.
 */
function fitCalibrationTimingModel(
  measurements: TtsCalibrationMeasurement[],
  seed: TtsTimingProfile,
  speed: number,
): Pick<TtsVoiceTimingCalibration, 'cjkCharsPerMinute' | 'latinWordsPerMinute' | 'fixedOverheadSec' | 'punctuationPauseSec' | 'rateModel'> {
  const priors = [0.2, 60 / seed.cjkCharsPerMinute, 60 / seed.latinWordsPerMinute, seed.punctuationPauseSec];
  const coefficients = [...priors];
  const penalties = [2, 600, 150, 30];
  const bounds = [[0, 1.5], [0.06, 0.6], [0.12, 1.2], [0, 0.8]];
  const durations = measurements.map((sample) => sample.durationSec).sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const medianDuration = durations.length % 2
    ? durations[middle]
    : (durations[middle - 1] + durations[middle]) / 2;
  const rows = measurements.map((sample) => ({
    x: [1, sample.cjkChars / speed, sample.latinWords / speed, sample.punctuation / speed],
    y: sample.durationSec,
    // Scaling by the median preserves the existing prior's units and strength.
    weight: (medianDuration / Math.max(0.1, sample.durationSec)) ** 2,
  }));
  for (let iteration = 0; iteration < 300; iteration++) {
    for (let feature = 0; feature < coefficients.length; feature++) {
      let numerator = penalties[feature] * priors[feature];
      let denominator = penalties[feature];
      for (const row of rows) {
        const residual = row.y - row.x.reduce((sum, value, index) => index === feature ? sum : sum + value * coefficients[index], 0);
        numerator += row.weight * row.x[feature] * residual;
        denominator += row.weight * row.x[feature] ** 2;
      }
      coefficients[feature] = clamp(numerator / denominator, bounds[feature][0], bounds[feature][1]);
    }
  }
  return {
    fixedOverheadSec: coefficients[0],
    cjkCharsPerMinute: 60 / coefficients[1] * speed,
    latinWordsPerMinute: 60 / coefficients[2] * speed,
    punctuationPauseSec: coefficients[3],
    rateModel: 'relative-linear-v1',
  };
}

/** Merge repeated measurements into one duration-weighted shared profile. */
export function mergeTtsVoiceTimingCalibrations(
  current: TtsVoiceTimingCalibration | undefined,
  sample: TtsVoiceTimingCalibration,
): TtsVoiceTimingCalibration {
  if (!current || getTtsCalibrationKey(current) !== getTtsCalibrationKey(sample)) return sample;
  const currentUnits = Math.max(1, current.totalSampleUnits ?? current.sampleUnits);
  const sampleUnits = Math.max(1, sample.totalSampleUnits ?? sample.sampleUnits);
  const currentDuration = Math.max(0.1, current.totalMeasuredDurationSec ?? current.measuredDurationSec);
  const sampleDuration = Math.max(0.1, sample.totalMeasuredDurationSec ?? sample.measuredDurationSec);
  const totalUnits = currentUnits + sampleUnits;
  const totalDuration = currentDuration + sampleDuration;
  const cjkCharsPerMinute = (totalUnits * 60) / totalDuration;
  const latinRatio = sample.cjkCharsPerMinute > 0
    ? sample.latinWordsPerMinute / sample.cjkCharsPerMinute
    : 1;
  const measurements = [...(current.measurements ?? []), ...(sample.measurements ?? [])].slice(-48);
  const fitted = measurements.length >= 6
    ? fitCalibrationTimingModel(measurements, getTtsTimingProfile(sample.providerId, sample.modelId), sample.speed ?? 1)
    : undefined;
  return {
    ...sample,
    measurements,
    cjkCharsPerMinute: Math.round(cjkCharsPerMinute * 10) / 10,
    latinWordsPerMinute: Math.round(cjkCharsPerMinute * latinRatio * 10) / 10,
    sampleUnits: totalUnits,
    measuredDurationSec: Math.round((totalDuration / ((current.sampleCount ?? 1) + (sample.sampleCount ?? 1))) * 100) / 100,
    sampleCount: (current.sampleCount ?? 1) + (sample.sampleCount ?? 1),
    totalSampleUnits: totalUnits,
    totalMeasuredDurationSec: Math.round(totalDuration * 100) / 100,
    ...fitted,
  };
}

export function registerTtsVoiceTimingCalibration(
  calibration: TtsVoiceTimingCalibration,
): TtsTimingProfile {
  if (calibration.algorithmVersion !== TTS_TIMING_ALGORITHM_VERSION) {
    return getTtsTimingProfile(calibration.providerId, calibration.modelId);
  }
  const calibratedSpeed = clamp(Number(calibration.speed ?? 1) || 1, 0.25, 4);
  const profile: TtsTimingProfile = {
    id: getTtsCalibrationKey(calibration),
    providerId: calibration.providerId,
    modelId: calibration.modelId,
    voiceId: calibration.voiceId,
    label: `${calibration.providerId}/${calibration.modelId || 'default'}/${calibration.voiceId}`,
    cjkCharsPerMinute: calibration.cjkCharsPerMinute / calibratedSpeed,
    latinWordsPerMinute: calibration.latinWordsPerMinute / calibratedSpeed,
    punctuationPauseSec: calibration.punctuationPauseSec ?? 0,
    fixedOverheadSec: calibration.fixedOverheadSec ?? 0,
    defaultSpeed: calibratedSpeed,
    source: 'configured',
  };
  calibratedProfiles.set(getTtsCalibrationKey(calibration), profile);
  return profile;
}

export function estimateSpeechDurationSec(
  text: string,
  options: {
    profile?: TtsTimingProfile;
    providerId?: string;
    modelId?: string;
    voiceId?: string;
    language?: string;
    speed?: number;
    minSeconds?: number;
  } = {},
): number {
  const profile = options.profile ?? getTtsTimingProfile(options.providerId, options.modelId, options.voiceId, options.language, options.speed);
  const speed = clamp(Number(options.speed ?? profile.defaultSpeed) || profile.defaultSpeed, 0.25, 4);
  const units = countSpeechUnits(text);
  if (units.cjkChars + units.latinWords + units.otherChars === 0) return options.minSeconds ?? 1;

  const cjkSeconds = units.cjkChars / Math.max(1, (profile.cjkCharsPerMinute * speed) / 60);
  const latinSeconds = countLatinArticulationUnits(text) / Math.max(1, (profile.latinWordsPerMinute * speed) / 60);
  const otherSeconds = units.otherChars > 0
    ? units.otherChars / Math.max(1, (profile.cjkCharsPerMinute * speed) / 60)
    : 0;
  const pauseSeconds = (units.punctuation * profile.punctuationPauseSec) / speed;
  return Math.max(
    options.minSeconds ?? 1,
    Math.round((cjkSeconds + latinSeconds + otherSeconds + pauseSeconds + (profile.fixedOverheadSec ?? 0)) * 10) / 10,
  );
}

export function calculateTtsContentBudget(
  targetDurationSec: number,
  options: {
    profile?: TtsTimingProfile;
    providerId?: string;
    modelId?: string;
    speed?: number;
    language?: string;
    tolerance?: number;
    punctuationRatio?: number;
  } = {},
): TtsContentBudget {
  const profile = options.profile ?? getTtsTimingProfile(options.providerId, options.modelId);
  const target = Math.max(1, Number(targetDurationSec) || 1);
  const availableSpeechSec = Math.max(0, target - (profile.fixedOverheadSec ?? 0));
  const speed = clamp(Number(options.speed ?? profile.defaultSpeed) || profile.defaultSpeed, 0.25, 4);
  const tolerance = clamp(Number(options.tolerance ?? 0.1) || 0.1, 0.02, 0.25);
  const language = options.language?.toLowerCase() ?? 'zh-cn';
  const punctuationRatio = clamp(Number(options.punctuationRatio ?? (language.startsWith('zh') ? 1 / 28 : 1 / 18)) || 0, 0, 0.2);
  const isCjk = /^(zh|ja|ko)/.test(language);

  if (isCjk) {
    const charsPerSec = Math.max(1, (profile.cjkCharsPerMinute * speed) / 60);
    const secondsPerChar = 1 / charsPerSec + (punctuationRatio * profile.punctuationPauseSec) / speed;
    const targetUnits = Math.max(1, Math.round(availableSpeechSec / secondsPerChar));
    return {
      unit: 'cjk-char',
      targetUnits,
      minUnits: Math.max(1, Math.floor(targetUnits * (1 - tolerance))),
      maxUnits: Math.ceil(targetUnits * (1 + tolerance)),
      targetDurationSec: target,
      effectiveCharsPerMinute: 60 / secondsPerChar,
    };
  }

  if (/^(en|fr|de|es|it|pt|ru)/.test(language)) {
    const wordsPerSec = Math.max(1, (profile.latinWordsPerMinute * speed) / 60);
    const secondsPerWord = 1 / wordsPerSec + (punctuationRatio * profile.punctuationPauseSec) / speed;
    const targetUnits = Math.max(1, Math.round(availableSpeechSec / secondsPerWord));
    return {
      unit: 'latin-word',
      targetUnits,
      minUnits: Math.max(1, Math.floor(targetUnits * (1 - tolerance))),
      maxUnits: Math.ceil(targetUnits * (1 + tolerance)),
      targetDurationSec: target,
      effectiveWordsPerMinute: 60 / secondsPerWord,
    };
  }

  const cjkBudget = calculateTtsContentBudget(target, {
    profile,
    speed,
    language: 'zh-CN',
    tolerance,
    punctuationRatio,
  });
  return {
    ...cjkBudget, unit: 'mixed-unit',
    latinReferenceWordCjkUnits: profile.cjkCharsPerMinute / profile.latinWordsPerMinute,
  };
}

export function buildTtsTimingPlan(options: {
  targetDurationSec: number;
  activityTargetDurationSec?: number;
  providerId?: string;
  modelId?: string;
  voiceId?: string;
  speed?: number;
  language?: string;
  contentType?: string;
  pageKind?: 'slide' | 'interactive' | 'quiz';
  naturalSpeedLocked?: boolean;
  readingThinkingSec?: number;
  operationSec?: number;
  studentActivitySec?: number;
  feedbackSec?: number;
  transitionSec?: number;
  videoSec?: number;
  taskComplexity?: 'low' | 'medium' | 'high';
  recommendedStudentActivitySec?: number;
  taskFitsBudget?: boolean;
  timingRationale?: string[];
}): TtsTimingPlan {
  const language = options.language || 'zh-CN';
  const naturalSpeedLocked = Boolean(options.naturalSpeedLocked);
  const requestedSpeed = naturalSpeedLocked ? 1 : options.speed;
  const profile = getTtsTimingProfile(options.providerId, options.modelId, options.voiceId, language, requestedSpeed);
  const budget = calculateTtsContentBudget(options.targetDurationSec, {
    profile,
    speed: requestedSpeed,
    language,
  });
  const speed = clamp(
    Number(requestedSpeed ?? profile.defaultSpeed) || profile.defaultSpeed,
    0.25,
    4,
  );
  const effectiveUnitsPerMinute = (
    budget.effectiveCharsPerMinute ?? budget.effectiveWordsPerMinute
  );
  const feedback = Math.min(budget.targetDurationSec, Math.max(0, options.feedbackSec ?? 0));
  const main = budget.targetDurationSec - feedback;
  const introduction = Math.floor(main * 0.1);
  const example = Math.floor(main * 0.3);
  const paragraphDurations: Array<[TtsNarrationParagraphBudget['role'], number]> = [
    ['introduction', introduction], ['explanation', main - introduction - example],
    ['example', example], ['feedback', feedback],
  ];
  // Allocate units by cumulative rounding, preserving both total seconds and units.
  let allocatedUnits = 0;
  let elapsed = 0;
  const paragraphBudgets = paragraphDurations.filter(([, seconds]) => seconds > 0).map(([role, seconds]) => {
    elapsed += seconds;
    const cumulativeUnits = Math.round(budget.targetUnits * elapsed / budget.targetDurationSec);
    const targetUnits = cumulativeUnits - allocatedUnits;
    allocatedUnits = cumulativeUnits;
    return {
      role, unit: budget.unit, targetDurationSec: seconds, targetUnits,
      minUnits: Math.floor(targetUnits * 0.9), maxUnits: Math.ceil(targetUnits * 1.1),
    };
  });
  return {
    algorithmVersion: TTS_TIMING_ALGORITHM_VERSION,
    paragraphBudgets,
    providerId: profile.providerId,
    modelId: profile.modelId,
    voiceId: options.voiceId || profile.voiceId,
    profileId: profile.id,
    language,
    speed,
    contentType: options.contentType || 'other',
    ...(options.pageKind ? { pageKind: options.pageKind } : {}),
    naturalSpeedLocked,
    calibrationSource: profile.source,
    ...(effectiveUnitsPerMinute !== undefined
      ? { effectiveUnitsPerMinute: Math.round(effectiveUnitsPerMinute * 10) / 10 }
      : {}),
    narrationSec: budget.targetDurationSec,
    readingThinkingSec: Math.max(0, Math.round(options.readingThinkingSec ?? 0)),
    operationSec: Math.max(0, Math.round(options.operationSec ?? 0)),
    studentActivitySec: Math.max(0, Math.round(options.studentActivitySec ?? 0)),
    feedbackSec: Math.max(0, Math.round(options.feedbackSec ?? 0)),
    transitionSec: Math.max(0, Math.round(options.transitionSec ?? 0)),
    videoSec: Math.max(0, options.videoSec ?? 0),
    ...(options.activityTargetDurationSec !== undefined
      ? { activityTargetDurationSec: Math.max(1, Math.round(options.activityTargetDurationSec)) }
      : {}),
    targetDurationSec: budget.targetDurationSec,
    unit: budget.unit,
    targetUnits: budget.targetUnits,
    minUnits: budget.minUnits,
    maxUnits: budget.maxUnits,
    ...(budget.latinReferenceWordCjkUnits !== undefined
      ? { latinReferenceWordCjkUnits: budget.latinReferenceWordCjkUnits } : {}),
    ...(options.taskComplexity ? { taskComplexity: options.taskComplexity } : {}),
    ...(options.recommendedStudentActivitySec !== undefined
      ? {
          recommendedStudentActivitySec: Math.max(
            0,
            Math.round(options.recommendedStudentActivitySec),
          ),
        }
      : {}),
    ...(options.taskFitsBudget !== undefined
      ? { taskFitsBudget: options.taskFitsBudget }
      : {}),
    ...(options.timingRationale?.length
      ? { timingRationale: [...options.timingRationale] }
      : {}),
  };
}

export function assessTtsDurationError(options: {
  targetSec: number;
  actualSec: number;
  tolerance?: number;
}): TtsDurationAssessment {
  const targetSec = Math.max(1, Number(options.targetSec) || 1);
  const actualSec = Math.max(0, Number(options.actualSec) || 0);
  const tolerance = clamp(Number(options.tolerance ?? 0.1) || 0.1, 0.02, 0.25);
  const errorRatio = (actualSec - targetSec) / targetSec;
  const absoluteErrorRatio = Math.abs(errorRatio);
  const withinTolerance = absoluteErrorRatio <= tolerance;
  const status = withinTolerance ? 'within' : errorRatio < 0 ? 'under' : 'over';
  const suggestions = withinTolerance
    ? ['当前估算在允许误差范围内，无需调整内容结构。']
    : status === 'under'
      ? [
          `讲授内容明显不足，建议增加 ${Math.max(1, Math.round((targetSec - actualSec) / 60))} 分钟的内容点。`,
          '优先补充一个可验证的案例、反例或分步解释，不要只放慢播放速度。',
        ]
      : [
          `讲授内容超出目标，建议减少 ${Math.max(1, Math.round((actualSec - targetSec) / 60))} 分钟的重复说明。`,
          '合并相近内容点，保留定义、关键依据和一个代表性例子。',
        ];
  return {
    targetSec,
    actualSec,
    errorRatio,
    absoluteErrorRatio,
    tolerance,
    withinTolerance,
    status,
    suggestions,
  };
}

/**
 * Compare both drafts against the full classroom activity target. This keeps
 * narration, student wait time, and transitions on one consistent time axis.
 */
export function isActivityTimingCorrectionCloser(options: {
  activityTargetSec: number;
  reservedActivitySec: number;
  firstNarrationSec: number;
  correctedNarrationSec: number;
}): boolean {
  const activityTargetSec = Math.max(1, Math.round(options.activityTargetSec));
  const reservedActivitySec = Math.max(0, Math.round(options.reservedActivitySec));
  const firstTotalSec =
    Math.max(0, Math.round(options.firstNarrationSec)) + reservedActivitySec;
  const correctedTotalSec =
    Math.max(0, Math.round(options.correctedNarrationSec)) + reservedActivitySec;
  return Math.abs(correctedTotalSec - activityTargetSec)
    < Math.abs(firstTotalSec - activityTargetSec);
}

/** Compact first-draft guidance; never used to request a corrected narration. */
export function formatTtsParagraphBudgets(plan: TtsTimingPlan): string {
  const labels = { introduction: '引入', explanation: '解释', example: '例子', feedback: '反馈' };
  return '以下是首次讲稿的内容分配参考，可按教学内容量灵活调整段落时长与文字量，不要求各段分别落在±10%内；知识讲授阶段总时长才是最终时长约束。'
    + (plan.paragraphBudgets ?? []).map((part) =>
    `${labels[part.role]}：${part.targetDurationSec} 秒，参考 ${part.targetUnits} ${part.unit}`,
  ).join('；') + (plan.unit === 'latin-word' ? '。英文参考词按约1.5音节/单位折算，技术长词与字母缩写应预留更多时长。' : '')
    + (plan.unit === 'mixed-unit' && plan.latinReferenceWordCjkUnits !== undefined
      ? `。mixed-unit 为中文等价单位：每个中文或其他可发音字符计1单位；每个英文参考词（约1.5音节）计${plan.latinReferenceWordCjkUnits.toFixed(3)}单位，长词按音节折算。将中英文等价单位相加后遵守同一总量预算，不能把英文词直接当作1个中文字。`
      : '');
}
