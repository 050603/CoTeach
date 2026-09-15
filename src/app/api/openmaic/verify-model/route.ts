import { NextRequest } from 'next/server';
import { createLogger } from '@openmaic/lib/logger';
import { apiError, apiSuccess } from '@openmaic/lib/server/api-response';
import { resolveModel } from '@openmaic/lib/server/resolve-model';
import { callLLM } from '@openmaic/lib/ai/llm';
import { isAbortError } from '@openmaic/lib/generation/generation-retry';
import {
  getProviderCredentialError,
  getProviderModelError,
} from '@/lib/teacher/ai-service-settings';
const log = createLogger('Verify Model');

export async function POST(req: NextRequest) {
  let model: string | undefined;
  let resolvedProviderId: string | undefined;
  let resolvedModelId: string | undefined;
  let resolvedBaseUrl: string | undefined;
  try {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    const body = await req.json();
    const { apiKey, baseUrl, providerType } = body;
    model = body.model;

    if (!model) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Model name is required');
    }

    // Parse model string and resolve server-side fallback
    let languageModel;
    try {
      const result = await resolveModel({
        modelString: model,
        apiKey: apiKey || '',
        baseUrl: baseUrl || undefined,
        providerType,
      });
      languageModel = result.model;
      resolvedProviderId = result.providerId;
      resolvedModelId = result.modelId;
      resolvedBaseUrl = result.baseUrl;
    } catch (error) {
      return apiError(
        'INVALID_REQUEST',
        401,
        error instanceof Error ? error.message : String(error),
      );
    }

    // Send a minimal test message. Use the unified wrapper so compatible
    // providers can receive provider-specific request options.
    const { text } = await callLLM(
      {
        model: languageModel,
        abortSignal: req.signal,
        prompt: 'Say "OK" if you can hear me.',
        maxOutputTokens: 64,
      },
      'verify-model',
      undefined,
      { mode: 'disabled', enabled: false },
    );

    return apiSuccess({
      message: 'Connection successful',
      response: text,
    });
  } catch (error) {
    if (req.signal.aborted || isAbortError(error)) {
      return new Response(null, { status: 499 });
    }
    log.error(`Model verification failed [model="${model ?? 'unknown'}"]:`, error);

    let errorMessage = 'Connection failed';
    if (error instanceof Error) {
      const credentialError = getProviderCredentialError({
        providerId: resolvedProviderId,
        baseUrl: resolvedBaseUrl,
        errorMessage: error.message,
      });
      if (credentialError) {
        return apiError('INVALID_REQUEST', 401, credentialError.message, credentialError.details);
      }
      const modelError = getProviderModelError({
        providerId: resolvedProviderId,
        baseUrl: resolvedBaseUrl,
        modelId: resolvedModelId,
        errorMessage: error.message,
      });
      if (modelError) {
        return apiError('INVALID_REQUEST', 400, modelError.message, modelError.details);
      }
      // Parse common error messages
      if (error.message.includes('401') || error.message.includes('Unauthorized')) {
        errorMessage = 'API key is invalid or expired';
      } else if (error.message.includes('404') || error.message.includes('not found')) {
        errorMessage = 'Model not found or API endpoint error';
      } else if (error.message.includes('429')) {
        errorMessage = 'API rate limit exceeded, please try again later';
      } else if (error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
        errorMessage = 'Cannot connect to API server, please check the Base URL';
      } else if (error.message.includes('timeout')) {
        errorMessage = 'Connection timed out, please check your network';
      } else {
        errorMessage = error.message;
      }
    }

    return apiError('INTERNAL_ERROR', 500, errorMessage);
  }
}
