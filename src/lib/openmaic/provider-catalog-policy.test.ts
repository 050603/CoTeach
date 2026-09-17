import { describe, expect, it } from 'vitest';
import {
  QWEN_AUDIO_TTS_FLASH_MODEL_ID,
  QWEN_AUDIO_TTS_PLUS_MODEL_ID,
  QWEN_AUDIO_TTS_VOICES,
  normalizeQwenAudioTtsSelection,
} from './audio/qwen-audio-tts-catalog';
import { QWEN_IMAGE_MODELS } from './media/qwen-image-catalog';
import { normalizeManagedProviderCatalog } from './provider-catalog-policy';

describe('managed Qwen provider catalogs', () => {
  it('keeps each Audio 3.0 voice attached to its supported model', () => {
    expect(QWEN_AUDIO_TTS_VOICES).toHaveLength(14);
    expect(normalizeQwenAudioTtsSelection(QWEN_AUDIO_TTS_PLUS_MODEL_ID, 'longanlingxin'))
      .toEqual({ modelId: QWEN_AUDIO_TTS_PLUS_MODEL_ID, voiceId: 'longanlingxin' });
    expect(normalizeQwenAudioTtsSelection(QWEN_AUDIO_TTS_FLASH_MODEL_ID, 'longanlingxin'))
      .toEqual({ modelId: QWEN_AUDIO_TTS_FLASH_MODEL_ID, voiceId: 'longanfengyue' });
  });

  it('migrates stale shared TTS metadata to the Audio 3.0 catalog', () => {
    expect(normalizeManagedProviderCatalog('tts', 'qwen-tts', {
      apiKey: 'secret',
      models: ['qwen3-tts-flash'],
      defaultModel: 'qwen3-tts-flash',
      defaultVoice: 'Cherry',
      timingCalibrations: [
        { modelId: 'qwen3-tts-flash', voiceId: 'Cherry' },
        { modelId: QWEN_AUDIO_TTS_FLASH_MODEL_ID, voiceId: 'longanfengyue' },
      ],
    })).toEqual({
      apiKey: 'secret',
      models: [QWEN_AUDIO_TTS_PLUS_MODEL_ID, QWEN_AUDIO_TTS_FLASH_MODEL_ID],
      defaultModel: QWEN_AUDIO_TTS_FLASH_MODEL_ID,
      defaultVoice: 'longanfengyue',
      scenarioConfigs: {
        'course-generation': {
          modelId: QWEN_AUDIO_TTS_PLUS_MODEL_ID,
          voiceId: 'longanlingxin',
        },
        'realtime-interaction': {
          modelId: QWEN_AUDIO_TTS_FLASH_MODEL_ID,
          voiceId: 'longanfengyue',
        },
      },
      timingCalibrations: [
        { modelId: QWEN_AUDIO_TTS_FLASH_MODEL_ID, voiceId: 'longanfengyue' },
      ],
    });
  });

  it('repairs each saved Qwen TTS scenario independently', () => {
    expect(normalizeManagedProviderCatalog('tts', 'qwen-tts', {
      scenarioConfigs: {
        'course-generation': {
          modelId: QWEN_AUDIO_TTS_PLUS_MODEL_ID,
          voiceId: 'longanfengyue',
        },
        'realtime-interaction': {
          modelId: QWEN_AUDIO_TTS_FLASH_MODEL_ID,
          voiceId: 'longanlingxin',
        },
      },
    }).scenarioConfigs).toEqual({
      'course-generation': {
        modelId: QWEN_AUDIO_TTS_PLUS_MODEL_ID,
        voiceId: 'longanlingxin',
      },
      'realtime-interaction': {
        modelId: QWEN_AUDIO_TTS_FLASH_MODEL_ID,
        voiceId: 'longanfengyue',
      },
    });
  });

  it('exposes only Qwen Image 3.0 and migrates stale image defaults to Pro', () => {
    expect(QWEN_IMAGE_MODELS.map((model) => model.id)).toEqual([
      'qwen-image-3.0-pro',
      'qwen-image-3.0',
    ]);
    expect(normalizeManagedProviderCatalog('image', 'qwen-image', {
      models: ['qwen-image-max'],
      defaultModel: 'qwen-image-max',
    })).toEqual({
      models: ['qwen-image-3.0-pro', 'qwen-image-3.0'],
      defaultModel: 'qwen-image-3.0-pro',
    });
  });
});
