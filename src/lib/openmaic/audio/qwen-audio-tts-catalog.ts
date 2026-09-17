import type { TTSVoiceInfo } from './types';
import type { TtsScenarioConfigs } from './tts-scenarios';

export const QWEN_AUDIO_TTS_PLUS_MODEL_ID = 'qwen-audio-3.0-tts-plus';
export const QWEN_AUDIO_TTS_FLASH_MODEL_ID = 'qwen-audio-3.0-tts-flash';
export const DEFAULT_QWEN_AUDIO_TTS_MODEL_ID = QWEN_AUDIO_TTS_FLASH_MODEL_ID;

export const QWEN_AUDIO_TTS_MODELS = [
  { id: QWEN_AUDIO_TTS_PLUS_MODEL_ID, name: 'Qwen Audio 3.0 TTS Plus' },
  { id: QWEN_AUDIO_TTS_FLASH_MODEL_ID, name: 'Qwen Audio 3.0 TTS Flash' },
] as const;

export const QWEN_AUDIO_TTS_VOICES: TTSVoiceInfo[] = [
  {
    id: 'longanlingxin',
    name: '龙安灵心（知心温暖）',
    language: 'zh-CN,en',
    gender: 'female',
    compatibleModels: [QWEN_AUDIO_TTS_PLUS_MODEL_ID],
  },
  {
    id: 'longanlufeng',
    name: '龙安鲁风（明亮开朗）',
    language: 'zh-CN,en',
    gender: 'male',
    compatibleModels: [QWEN_AUDIO_TTS_PLUS_MODEL_ID],
  },
  {
    id: 'longanfengyue',
    name: '龙安风悦（自然亲切）',
    language: 'zh-CN,en',
    gender: 'female',
    compatibleModels: [QWEN_AUDIO_TTS_FLASH_MODEL_ID],
  },
  {
    id: 'longanyuanfei',
    name: '龙安元妃（高傲妃子）',
    language: 'zh-CN,en',
    gender: 'female',
    compatibleModels: [QWEN_AUDIO_TTS_FLASH_MODEL_ID],
  },
  {
    id: 'longanlingxi',
    name: '龙安灵希（可爱甜美）',
    language: 'zh-CN,en',
    gender: 'female',
    compatibleModels: [QWEN_AUDIO_TTS_FLASH_MODEL_ID],
  },
  {
    id: 'longanxiaoxin',
    name: '龙安小昕（亲切活泼）',
    language: 'zh-CN,en',
    gender: 'female',
    compatibleModels: [QWEN_AUDIO_TTS_FLASH_MODEL_ID],
  },
  {
    id: 'longanhuan_v3.6',
    name: '龙安欢',
    language: 'zh-CN,en',
    gender: 'female',
    compatibleModels: [QWEN_AUDIO_TTS_FLASH_MODEL_ID],
  },
  {
    id: 'longjielidou_v3.6',
    name: '龙杰力豆（童真男童）',
    language: 'zh-CN,en',
    gender: 'male',
    compatibleModels: [QWEN_AUDIO_TTS_FLASH_MODEL_ID],
  },
  {
    id: 'longpaopao_v3.6',
    name: '龙泡泡（软萌女童）',
    language: 'zh-CN,en',
    gender: 'female',
    compatibleModels: [QWEN_AUDIO_TTS_FLASH_MODEL_ID],
  },
  {
    id: 'longhuohuo_v3.6',
    name: '龙火火（顽皮男童）',
    language: 'zh-CN,en',
    gender: 'male',
    compatibleModels: [QWEN_AUDIO_TTS_FLASH_MODEL_ID],
  },
  {
    id: 'longchuanshu_v3.6',
    name: '龙川叔（四川口音）',
    language: 'zh-CN,en',
    gender: 'male',
    compatibleModels: [QWEN_AUDIO_TTS_FLASH_MODEL_ID],
  },
  {
    id: 'loongmary',
    name: 'Loong Mary（温暖英音）',
    language: 'en',
    gender: 'female',
    compatibleModels: [QWEN_AUDIO_TTS_FLASH_MODEL_ID],
  },
  {
    id: 'loongeva_v3.6',
    name: 'Loong Eva（知性美音）',
    language: 'en',
    gender: 'female',
    compatibleModels: [QWEN_AUDIO_TTS_FLASH_MODEL_ID],
  },
  {
    id: 'loongjohn',
    name: 'Loong John（沉稳美音）',
    language: 'en',
    gender: 'male',
    compatibleModels: [QWEN_AUDIO_TTS_FLASH_MODEL_ID],
  },
];

export const DEFAULT_QWEN_AUDIO_TTS_VOICE = 'longanfengyue';

export const DEFAULT_QWEN_AUDIO_TTS_SCENARIO_CONFIGS: TtsScenarioConfigs = {
  'course-generation': {
    modelId: QWEN_AUDIO_TTS_PLUS_MODEL_ID,
    voiceId: 'longanlingxin',
  },
  'realtime-interaction': {
    modelId: QWEN_AUDIO_TTS_FLASH_MODEL_ID,
    voiceId: DEFAULT_QWEN_AUDIO_TTS_VOICE,
  },
};

export function qwenAudioTtsModelForVoice(voiceId: string | undefined): string | undefined {
  return QWEN_AUDIO_TTS_VOICES.find((voice) => voice.id === voiceId)?.compatibleModels?.[0];
}

export function qwenAudioTtsVoiceForModel(
  modelId: string | undefined,
  preferredVoice?: string,
): string {
  const normalizedModel = QWEN_AUDIO_TTS_MODELS.find((model) => model.id === modelId)?.id
    ?? DEFAULT_QWEN_AUDIO_TTS_MODEL_ID;
  const preferred = QWEN_AUDIO_TTS_VOICES.find((voice) => voice.id === preferredVoice);
  if (preferred?.compatibleModels?.includes(normalizedModel)) return preferred.id;
  return QWEN_AUDIO_TTS_VOICES.find((voice) => voice.compatibleModels?.includes(normalizedModel))?.id
    ?? DEFAULT_QWEN_AUDIO_TTS_VOICE;
}

export function normalizeQwenAudioTtsSelection(
  modelId?: string,
  voiceId?: string,
): { modelId: string; voiceId: string } {
  const voiceModel = qwenAudioTtsModelForVoice(voiceId);
  const normalizedModel = QWEN_AUDIO_TTS_MODELS.some((model) => model.id === modelId)
    ? modelId!
    : voiceModel ?? DEFAULT_QWEN_AUDIO_TTS_MODEL_ID;
  return {
    modelId: normalizedModel,
    voiceId: qwenAudioTtsVoiceForModel(normalizedModel, voiceId),
  };
}
