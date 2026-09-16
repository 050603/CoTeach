import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('playback settings', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('enables continuous AI lecture playback by default', async () => {
    const { useSettingsStore } = await import('./settings');

    expect(useSettingsStore.getInitialState().autoPlayLecture).toBe(true);
  });

  it('applies the new default once to existing browser settings', async () => {
    localStorage.setItem(
      'settings-storage',
      JSON.stringify({ state: { autoPlayLecture: false }, version: 4 }),
    );
    const { useSettingsStore } = await import('./settings');

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().autoPlayLecture).toBe(true);
  });

  it('switches a student from browser ASR to a managed ASR provider after sync', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        providers: {},
        tts: {},
        asr: {
          'qwen-asr': {
            models: ['qwen-audio-3.0-asr-flash', 'qwen3-asr-flash'],
            defaultModel: 'qwen-audio-3.0-asr-flash',
          },
        },
        pdf: {},
        image: {},
        video: {},
        webSearch: {},
        generation: {},
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { useSettingsStore } = await import('./settings');
    useSettingsStore.setState({
      autoConfigApplied: true,
      asrProviderId: 'browser-native',
    });

    await useSettingsStore.getState().fetchServerProviders();

    expect(fetchMock).toHaveBeenCalledWith('/api/server-providers');
    expect(useSettingsStore.getState().asrProviderId).toBe('qwen-asr');
    expect(useSettingsStore.getState().asrProvidersConfig['qwen-asr'].isServerConfigured).toBe(
      true,
    );
    expect(useSettingsStore.getState().asrProvidersConfig['qwen-asr']).toMatchObject({
      modelId: 'qwen-audio-3.0-asr-flash',
      serverModels: ['qwen-audio-3.0-asr-flash', 'qwen3-asr-flash'],
    });
  });
});
