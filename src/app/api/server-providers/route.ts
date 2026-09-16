import {
  getServerProviders,
  getServerTTSProviders,
  getServerASRProviders,
  getServerPDFProviders,
  getServerImageProviders,
  getServerVideoProviders,
  getServerWebSearchProviders,
  getClassroomSceneConcurrency,
  getParallelSceneConcurrency,
  initializeServerProviderConfig,
} from '@openmaic/lib/server/provider-config';
import { apiError, apiSuccess } from '@openmaic/lib/server/api-response';
import { createLogger } from '@openmaic/lib/logger';
import { authenticateRequest } from '@/lib/auth/request-guards';

const log = createLogger('ServerProviders');

export async function GET(request: Request) {
  // Students need the same redacted capability metadata to select the managed
  // ASR/TTS providers used by the classroom. These getters never expose API
  // keys or managed base URLs.
  const auth = await authenticateRequest(request);
  if ('response' in auth) return auth.response;
  try {
    await initializeServerProviderConfig();
    return apiSuccess({
      providers: getServerProviders(),
      tts: getServerTTSProviders(),
      asr: getServerASRProviders(),
      pdf: getServerPDFProviders(),
      image: getServerImageProviders(),
      video: getServerVideoProviders(),
      webSearch: getServerWebSearchProviders(),
      generation: {
        parallelSceneConcurrency: getParallelSceneConcurrency(),
        classroomSceneConcurrency: getClassroomSceneConcurrency(),
      },
    });
  } catch (error) {
    log.error('Error fetching server providers:', error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
