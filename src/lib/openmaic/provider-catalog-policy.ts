import {
  DEFAULT_QWEN_AUDIO_TTS_SCENARIO_CONFIGS,
  QWEN_AUDIO_TTS_MODELS,
  normalizeQwenAudioTtsSelection,
} from './audio/qwen-audio-tts-catalog';
import {
  TTS_SCENARIO_IDS,
  type TtsScenarioConfigs,
} from './audio/tts-scenarios';
import {
  QWEN_IMAGE_MODELS,
  normalizeQwenImageModel,
} from './media/qwen-image-catalog';

type CatalogEntry = {
  models?: string[];
  defaultModel?: string;
  defaultVoice?: string;
  scenarioConfigs?: TtsScenarioConfigs;
  timingCalibrations?: Array<{ modelId: string; voiceId: string }>;
};

/**
 * Keep vendor-owned model and voice catalogs current even when the shared
 * ProviderCredential row was saved by an older deployment.
 */
export function normalizeManagedProviderCatalog<T extends CatalogEntry>(
  section: string,
  providerId: string,
  entry: T,
): T {
  if (section === 'tts' && providerId === 'qwen-tts') {
    const selection = normalizeQwenAudioTtsSelection(entry.defaultModel, entry.defaultVoice);
    const scenarioConfigs = Object.fromEntries(
      TTS_SCENARIO_IDS.map((scenario) => {
        const configured = entry.scenarioConfigs?.[scenario]
          ?? DEFAULT_QWEN_AUDIO_TTS_SCENARIO_CONFIGS[scenario]
          ?? selection;
        return [
          scenario,
          normalizeQwenAudioTtsSelection(configured.modelId, configured.voiceId),
        ];
      }),
    ) as TtsScenarioConfigs;
    const timingCalibrations = entry.timingCalibrations?.filter((calibration) => {
      const normalized = normalizeQwenAudioTtsSelection(
        calibration.modelId,
        calibration.voiceId,
      );
      return normalized.modelId === calibration.modelId && normalized.voiceId === calibration.voiceId;
    });
    return {
      ...entry,
      models: QWEN_AUDIO_TTS_MODELS.map((model) => model.id),
      defaultModel: selection.modelId,
      defaultVoice: selection.voiceId,
      scenarioConfigs,
      ...(timingCalibrations ? { timingCalibrations } : {}),
    };
  }

  if (section === 'image' && providerId === 'qwen-image') {
    return {
      ...entry,
      models: QWEN_IMAGE_MODELS.map((model) => model.id),
      defaultModel: normalizeQwenImageModel(entry.defaultModel),
    };
  }

  return entry;
}

export function normalizeManagedProviderCatalogSection<T extends CatalogEntry>(
  section: string,
  entries: Record<string, T>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(entries).map(([providerId, entry]) => [
      providerId,
      normalizeManagedProviderCatalog(section, providerId, entry),
    ]),
  );
}
