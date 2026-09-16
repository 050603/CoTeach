export const TRANSCRIPTION_API_PATH = '/api/openmaic/transcription';

interface TranscriptionApiResponse {
  text?: unknown;
  error?: unknown;
  details?: unknown;
}

function responseMessage(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export async function requestAudioTranscription(
  formData: FormData,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const response = await fetcher(TRANSCRIPTION_API_PATH, {
    method: 'POST',
    body: formData,
  });

  let result: TranscriptionApiResponse | undefined;
  try {
    result = (await response.json()) as TranscriptionApiResponse;
  } catch {
    // A proxy or unexpected route may return a non-JSON error page.
  }

  if (!response.ok) {
    throw new Error(
      responseMessage(result?.details) ||
        responseMessage(result?.error) ||
        response.statusText ||
        'Transcription failed',
    );
  }

  if (typeof result?.text !== 'string') {
    throw new Error('Transcription response is invalid');
  }

  return result.text;
}
