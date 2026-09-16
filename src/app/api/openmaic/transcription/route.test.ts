import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transcribeAudio: vi.fn(),
  resolveASRModel: vi.fn(),
}));

vi.mock('@openmaic/lib/audio/asr-providers', () => ({
  transcribeAudio: mocks.transcribeAudio,
}));

vi.mock('@openmaic/lib/server/provider-config', () => ({
  initializeServerProviderConfig: vi.fn(),
  isServerConfiguredProvider: () => true,
  resolveASRApiKey: () => 'server-key',
  resolveASRBaseUrl: () => 'https://dashscope.aliyuncs.com/api/v1',
  resolveASRModel: mocks.resolveASRModel,
}));

vi.mock('@openmaic/lib/server/ssrf-guard', () => ({
  validateUrlForSSRF: vi.fn(),
}));

import { POST } from './route';

describe('POST /api/openmaic/transcription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveASRModel.mockReturnValue('qwen-audio-3.0-asr-flash');
    mocks.transcribeAudio.mockResolvedValue({ text: '识别成功' });
  });

  it('uses the teacher-selected managed model instead of the client model', async () => {
    const audio = new Blob(['audio'], { type: 'audio/wav' });
    const values = new Map<string, FormDataEntryValue | Blob>([
      ['audio', audio],
      ['providerId', 'qwen-asr'],
      ['modelId', 'stale-browser-model'],
    ]);

    const response = await POST(
      {
        formData: async () => ({ get: (key: string) => values.get(key) ?? null }),
      } as never,
    );

    expect(response.status).toBe(200);
    expect(mocks.resolveASRModel).toHaveBeenCalledWith('qwen-asr', 'stale-browser-model');
    expect(mocks.transcribeAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'qwen-asr',
        modelId: 'qwen-audio-3.0-asr-flash',
        apiKey: 'server-key',
      }),
      audio,
    );
  });
});
