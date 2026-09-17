import { resolveAgentVoiceOptions, pickNarratorAgent } from '@openmaic/lib/audio/agent-voice';
import { isTTSProviderEnabled } from '@openmaic/lib/audio/provider-enablement';
import {
  withGenerationRetry,
  type GenerationRetryOptions,
} from '@openmaic/lib/generation/generation-retry';
import { createLogger } from '@openmaic/lib/logger';
import { useAgentRegistry } from '@openmaic/lib/orchestration/registry/store';
import { useSettingsStore } from '@openmaic/lib/store/settings';
import { db } from '@openmaic/lib/utils/database';

const log = createLogger('GenerateAndStoreTTS');

interface TTSApiResponse {
  success?: boolean;
  base64?: string;
  format?: string;
  error?: string;
  details?: string;
}

type ClientRetryOptions<T> = Partial<
  Omit<GenerationRetryOptions<T>, 'label' | 'shouldRetryResult' | 'signal'>
>;

async function readJsonResponse(response: Response): Promise<TTSApiResponse> {
  return response.json().catch(() => ({ error: response.statusText || 'Request failed' }));
}

function createHttpError(response: Response, data: TTSApiResponse): Error & { statusCode?: number } {
  const message = data.details || data.error || `TTS request failed: HTTP ${response.status}`;
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = response.status;
  return error;
}

/** Generate one managed-TTS clip and store it in the canonical IndexedDB cache. */
export async function generateAndStoreTTS(
  audioId: string,
  text: string,
  language?: string,
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<TTSApiResponse>,
): Promise<void> {
  const settings = useSettingsStore.getState();
  if (settings.ttsProviderId === 'browser-native-tts') return;
  if (!isTTSProviderEnabled(
    settings.ttsProviderId,
    settings.ttsProvidersConfig?.[settings.ttsProviderId],
  )) return;

  const ttsProviderConfig = settings.ttsProvidersConfig?.[settings.ttsProviderId];
  const teacher = pickNarratorAgent(useAgentRegistry.getState().listAgents());
  const providerOptions = await resolveAgentVoiceOptions(teacher, {
    providerId: settings.ttsProviderId,
    providerConfig: ttsProviderConfig,
    voiceId: settings.ttsVoice,
    language,
  });

  const data = await withGenerationRetry(
    async () => {
      const response = await fetch('/api/openmaic/generate/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          audioId,
          ttsProviderId: settings.ttsProviderId,
          ttsScenario: 'course-generation',
          ttsModelId: ttsProviderConfig?.modelId,
          ttsVoice: settings.ttsVoice,
          ttsSpeed: settings.ttsSpeed,
          ttsApiKey: ttsProviderConfig?.apiKey || undefined,
          ttsBaseUrl:
            ttsProviderConfig?.baseUrl || ttsProviderConfig?.customDefaultBaseUrl || undefined,
          ttsProviderOptions: providerOptions,
        }),
        signal,
      });
      const responseData = await readJsonResponse(response);
      if (!response.ok) throw createHttpError(response, responseData);
      return responseData;
    },
    {
      label: `tts "${audioId}"`,
      shouldRetryResult: (result) => !result.success || !result.base64 || !result.format,
      ...retryOptions,
      signal,
    },
  );

  if (!data.success || !data.base64 || !data.format) {
    const error = new Error(
      data.details || data.error || 'TTS request failed: invalid response payload',
    );
    log.warn('TTS failed for', audioId, ':', error);
    throw error;
  }

  const binary = atob(data.base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  await db.audioFiles.put({
    id: audioId,
    blob: new Blob([bytes], { type: `audio/${data.format}` }),
    format: data.format,
    text,
    createdAt: Date.now(),
  });
}
