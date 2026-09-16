import { describe, expect, it, vi } from 'vitest';
import {
  requestAudioTranscription,
  TRANSCRIPTION_API_PATH,
} from './transcription-client';

describe('requestAudioTranscription', () => {
  it('posts recordings to the mounted OpenMAIC transcription route', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, text: '课堂发言' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const formData = new FormData();
    formData.append('audio', new Blob(['audio'], { type: 'audio/webm' }), 'recording.webm');

    await expect(requestAudioTranscription(formData, fetcher)).resolves.toBe('课堂发言');
    expect(TRANSCRIPTION_API_PATH).toBe('/api/openmaic/transcription');
    expect(fetcher).toHaveBeenCalledWith(TRANSCRIPTION_API_PATH, {
      method: 'POST',
      body: formData,
    });
  });

  it('surfaces the server detail when transcription fails', async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: false,
          error: 'Transcription failed',
          details: 'ASR provider unavailable',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    await expect(requestAudioTranscription(new FormData(), fetcher)).rejects.toThrow(
      'ASR provider unavailable',
    );
  });
});
