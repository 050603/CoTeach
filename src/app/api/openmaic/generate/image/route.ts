/**
 * Image Generation API
 *
 * Generates an image from a text prompt using the specified provider.
 * Called by the client during media generation after slides are produced.
 *
 * POST /api/openmaic/generate/image
 *
 * Headers:
 *   x-image-provider: ImageProviderId (optional; server-configured provider is
 *                     selected when omitted or when the requested provider has
 *                     no usable credentials)
 *   x-api-key / x-image-api-key: string (optional, server fallback)
 *   x-base-url / x-image-base-url: string (optional, server fallback)
 *
 * Body: { prompt, negativePrompt?, width?, height?, aspectRatio?, style? }
 * Response: { success: boolean, result?: ImageGenerationResult, error?: string }
 */

import { NextRequest } from 'next/server';
import {
  generateImage,
  aspectRatioToDimensions,
  IMAGE_PROVIDERS,
} from '@openmaic/lib/media/image-providers';
import {
  getServerImageProviders,
  isServerConfiguredProvider,
  resolveImageApiKey,
  resolveImageBaseUrl,
} from '@openmaic/lib/server/provider-config';
import type { ImageProviderId, ImageGenerationOptions } from '@openmaic/lib/media/types';
import { createLogger } from '@openmaic/lib/logger';
import { apiError, apiSuccess } from '@openmaic/lib/server/api-response';
import { validateUrlForSSRF } from '@openmaic/lib/server/ssrf-guard';
import {
  imageLimiter,
  getClientIp,
  rateLimitKey,
  rateLimitedResponse,
} from '@/lib/auth/rate-limit';
import { isAuthConfigured } from '@/lib/auth/session';
import { mediaGenerationErrorResponse } from '@openmaic/lib/server/media-generation-error';

const log = createLogger('ImageGeneration API');

export const maxDuration = 60;

function isKnownImageProvider(value: string): value is ImageProviderId {
  return Object.prototype.hasOwnProperty.call(IMAGE_PROVIDERS, value);
}

/**
 * Select a provider that can actually run on the server. The UI historically
 * defaulted to Seedream even when the server had configured another provider,
 * which made an otherwise valid cover-image request fail with 401 before the
 * provider adapter was reached.
 */
function resolveRequestProvider(
  requestedProvider: string | undefined,
  clientApiKey: string | undefined,
): ImageProviderId {
  const preferred = requestedProvider && isKnownImageProvider(requestedProvider)
    ? requestedProvider
    : undefined;

  if (preferred) {
    const managed = isServerConfiguredProvider('image', preferred);
    const apiKey = resolveImageApiKey(preferred, managed ? undefined : clientApiKey);
    if (!IMAGE_PROVIDERS[preferred].requiresApiKey || apiKey) return preferred;
  }

  const serverProviders = getServerImageProviders();
  const configuredProvider = Object.keys(serverProviders).find((providerId) => {
    const provider = isKnownImageProvider(providerId) ? IMAGE_PROVIDERS[providerId] : undefined;
    if (!provider) return false;
    return !provider.requiresApiKey || Boolean(resolveImageApiKey(providerId));
  });
  if (configuredProvider && isKnownImageProvider(configuredProvider)) {
    return configuredProvider;
  }

  // Preserve the normal 401 response when no configured provider is usable.
  return preferred ?? 'seedream';
}

export async function POST(request: NextRequest) {
  // Stage 3: rate limit (only enforced when auth configured).
  if (isAuthConfigured()) {
    const ip = getClientIp(request);
    const rl = imageLimiter.check(rateLimitKey(request, ip));
    if (!rl.allowed) return rateLimitedResponse(rl.retryAfterMs);
  }

  try {
    const body = (await request.json()) as ImageGenerationOptions;

    if (!body.prompt) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing prompt');
    }

    const requestedProvider = request.headers.get('x-image-provider')?.trim() || undefined;
    const rawClientApiKey =
      request.headers.get('x-api-key')?.trim() ||
      request.headers.get('x-image-api-key')?.trim() ||
      undefined;
    const providerId = resolveRequestProvider(requestedProvider, rawClientApiKey);
    // Managed providers are admin-owned: ignore any client-sent key/baseUrl.
    const managed = isServerConfiguredProvider('image', providerId);
    const clientApiKey = managed ? undefined : rawClientApiKey;
    const clientBaseUrl = managed
      ? undefined
      : request.headers.get('x-base-url')?.trim() ||
        request.headers.get('x-image-base-url')?.trim() ||
        undefined;
    const requestedModel = request.headers.get('x-image-model')?.trim() || undefined;
    const requestedModelBelongsToProvider = requestedProvider === providerId;
    const serverModel = getServerImageProviders()[providerId]?.defaultModel;
    const clientModel = requestedModelBelongsToProvider
      ? requestedModel
      : undefined;
    const model = clientModel || serverModel || IMAGE_PROVIDERS[providerId]?.models[0]?.id;

    if (requestedProvider && !isKnownImageProvider(requestedProvider)) {
      return apiError('INVALID_REQUEST', 400, `Unsupported image provider: ${requestedProvider}`);
    }

    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const apiKey = resolveImageApiKey(providerId, clientApiKey);
    const provider = IMAGE_PROVIDERS[providerId];
    if (provider?.requiresApiKey && !apiKey) {
      return apiError(
        'MISSING_API_KEY',
        401,
        `No API key configured for image provider: ${providerId}`,
      );
    }

    const baseUrl = resolveImageBaseUrl(providerId, clientBaseUrl);

    // Resolve dimensions from aspect ratio if not explicitly set
    if (!body.width && !body.height && body.aspectRatio) {
      const dims = aspectRatioToDimensions(body.aspectRatio);
      body.width = dims.width;
      body.height = dims.height;
    }

    log.info(
      `Generating image: provider=${providerId}, model=${model || 'default'}, ` +
        `prompt="${body.prompt.slice(0, 80)}...", size=${body.width ?? 'auto'}x${body.height ?? 'auto'}`,
    );

    const result = await generateImage({ providerId, apiKey, baseUrl, model }, body);

    return apiSuccess({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Detect content safety filter rejections (e.g. Seedream OutputImageSensitiveContentDetected)
    if (message.includes('SensitiveContent') || message.includes('sensitive information')) {
      log.warn(`Image blocked by content safety filter: ${message}`);
      return apiError('CONTENT_SENSITIVE', 400, message);
    }
    log.error(
      `Image generation failed [provider=${request.headers.get('x-image-provider') ?? 'seedream'}, model=${request.headers.get('x-image-model') ?? 'default'}]:`,
      error,
    );
    return mediaGenerationErrorResponse(error);
  }
}
