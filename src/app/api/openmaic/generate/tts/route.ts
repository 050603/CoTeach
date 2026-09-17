/**
 * Single TTS Generation API
 *
 * Generates TTS audio for a single text string and returns base64-encoded audio.
 * Called by the client in parallel for each speech action after a scene is generated.
 *
 * POST /api/openmaic/generate/tts
 */

import { NextRequest } from 'next/server';
import { generateTTS, TTSRateLimitError } from '@openmaic/lib/audio/tts-providers';
import {
  isServerConfiguredProvider,
  isServerTTSProviderDisabled,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
  resolveTTSModel,
  resolveTTSVoice,
} from '@openmaic/lib/server/provider-config';
import type { TTSProviderId } from '@openmaic/lib/audio/types';
import {
  normalizeTtsScenarioId,
  type TtsScenarioId,
} from '@openmaic/lib/audio/tts-scenarios';
import { qwenAudioTtsModelForVoice } from '@openmaic/lib/audio/qwen-audio-tts-catalog';
import { createLogger } from '@openmaic/lib/logger';
import { apiError, apiSuccess } from '@openmaic/lib/server/api-response';
import { validateUrlForSSRF } from '@openmaic/lib/server/ssrf-guard';
import { VOXCPM_AUTO_VOICE_ID, VOXCPM_TTS_PROVIDER_ID } from '@openmaic/lib/audio/voxcpm';
import {
  ttsLimiter,
  getClientIp,
  rateLimitKey,
  rateLimitedResponse,
} from '@/lib/auth/rate-limit';
import { isAuthConfigured } from '@/lib/auth/session';

const log = createLogger('TTS API');

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  // Stage 3: rate limit TTS (30/min/user).
  if (isAuthConfigured()) {
    const ip = getClientIp(req);
    const rl = ttsLimiter.check(rateLimitKey(req, ip));
    if (!rl.allowed) return rateLimitedResponse(rl.retryAfterMs);
  }

  let ttsProviderId: string | undefined;
  let ttsVoice: string | undefined;
  let audioId: string | undefined;
  try {
    const body = await req.json();
    const { text, ttsModelId, ttsSpeed, ttsApiKey, ttsBaseUrl, ttsProviderOptions } = body as {
      text: string;
      audioId: string;
      ttsProviderId: TTSProviderId;
      ttsModelId?: string;
      ttsVoice: string;
      ttsSpeed?: number;
      ttsApiKey?: string;
      ttsBaseUrl?: string;
      ttsProviderOptions?: Record<string, unknown>;
      ttsScenario?: TtsScenarioId;
    };
    ttsProviderId = body.ttsProviderId;
    ttsVoice = body.ttsVoice;
    audioId = body.audioId;

    // Validate required fields
    if (!text || !audioId || !ttsProviderId || !ttsVoice) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'Missing required fields: text, audioId, ttsProviderId, ttsVoice',
      );
    }

    // Reject browser-native TTS — must be handled client-side
    if (ttsProviderId === 'browser-native-tts') {
      return apiError('INVALID_REQUEST', 400, 'browser-native-tts must be handled client-side');
    }

    // Enforce server precedence: a force-disabled provider is off for everyone,
    // regardless of any client key/selection (#665).
    if (isServerTTSProviderDisabled(ttsProviderId)) {
      return apiError('PROVIDER_DISABLED', 403, 'This TTS provider is disabled by the server');
    }

    const voxcpmVoicePrompt =
      typeof ttsProviderOptions?.voicePrompt === 'string' ? ttsProviderOptions.voicePrompt : '';
    const voxcpmRegisteredVoiceId =
      typeof ttsProviderOptions?.registeredVoiceId === 'string'
        ? ttsProviderOptions.registeredVoiceId
        : '';
    if (
      ttsProviderId === VOXCPM_TTS_PROVIDER_ID &&
      ttsVoice === VOXCPM_AUTO_VOICE_ID &&
      !voxcpmVoicePrompt.trim() &&
      !voxcpmRegisteredVoiceId.trim()
    ) {
      return apiError(
        'VOXCPM_AUTO_VOICE_REQUIRES_CONTEXT',
        400,
        'VoxCPM Auto Voice requires agent context',
      );
    }

    // Managed providers are admin-owned: ignore any client-sent key/baseUrl.
    const managed = isServerConfiguredProvider('tts', ttsProviderId);
    const clientBaseUrl = managed ? undefined : ttsBaseUrl || undefined;
    if (clientBaseUrl) {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const apiKey = resolveTTSApiKey(ttsProviderId, managed ? undefined : ttsApiKey || undefined);
    const baseUrl = resolveTTSBaseUrl(ttsProviderId, clientBaseUrl);
    const scenario = normalizeTtsScenarioId(body.ttsScenario);
    const modelId = resolveTTSModel(ttsProviderId, ttsModelId, scenario);
    const scenarioVoice = resolveTTSVoice(ttsProviderId, ttsVoice, scenario) || ttsVoice;
    // Keep feature/agent voice overrides when they work with the selected
    // scenario model. Qwen Audio 3.0 has disjoint Plus/Flash voice catalogs,
    // so an incompatible requested voice falls back to the teacher's scenario
    // voice instead of sending an invalid vendor request.
    const voice = managed
      && ttsProviderId === 'qwen-tts'
      && qwenAudioTtsModelForVoice(ttsVoice) !== modelId
        ? scenarioVoice
        : ttsVoice;

    // Build TTS config (managed providers pin the model by usage scenario).
    const config = {
      providerId: ttsProviderId as TTSProviderId,
      modelId,
      voice,
      speed: ttsSpeed ?? 1.0,
      apiKey,
      baseUrl,
      providerOptions: ttsProviderOptions,
    };

    log.info(
      `Generating TTS: provider=${ttsProviderId}, scenario=${scenario}, model=${config.modelId || 'default'}, voice=${voice}, ` +
        `registeredVoiceId=${voxcpmRegisteredVoiceId || 'none'}, audioId=${audioId}, textLen=${text.length}`,
    );

    // Generate audio
    const { audio, format } = await generateTTS(config, text);

    // Convert to base64
    const base64 = Buffer.from(audio).toString('base64');

    return apiSuccess({ audioId, base64, format });
  } catch (error) {
    log.error(
      `TTS generation failed [provider=${ttsProviderId ?? 'unknown'}, voice=${ttsVoice ?? 'unknown'}, audioId=${audioId ?? 'unknown'}]:`,
      error,
    );
    if (error instanceof TTSRateLimitError) {
      return apiError('RATE_LIMITED', 429, error.message);
    }
    return apiError(
      'GENERATION_FAILED',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }
}
