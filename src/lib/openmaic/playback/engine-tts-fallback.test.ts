import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaybackEngine, shouldUseBrowserNativeTtsFallback } from './engine';
import type { ActionEngine } from '@openmaic/lib/action/engine';
import type { AudioPlayer } from '@openmaic/lib/utils/audio-player';
import type { Scene } from '@openmaic/lib/types/stage';
import { useSettingsStore } from '@openmaic/lib/store/settings';

describe('shouldUseBrowserNativeTtsFallback', () => {
  it('uses the enabled browser voice when server audio is unavailable', () => {
    expect(shouldUseBrowserNativeTtsFallback({
      hasText: true,
      ttsEnabled: true,
      browserNativeEnabled: true,
      speechSynthesisAvailable: true,
    })).toBe(true);
  });

  it.each([
    ['empty speech', { hasText: false }],
    ['TTS disabled', { ttsEnabled: false }],
    ['browser provider disabled', { browserNativeEnabled: false }],
    ['browser API unavailable', { speechSynthesisAvailable: false }],
  ])('does not use browser fallback when %s', (_label, override) => {
    expect(shouldUseBrowserNativeTtsFallback({
      hasText: true,
      ttsEnabled: true,
      browserNativeEnabled: true,
      speechSynthesisAvailable: true,
      ...override,
    })).toBe(false);
  });
});

describe('PlaybackEngine failed narration recovery', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['missing audio', false, 0],
    ['rejected playback', new Error('Forbidden'), 0],
    ['rejected subtitle seek', new Error('Forbidden'), 0.4],
  ] as const)('retries the same speech after %s', async (_label, firstResult, startRatio) => {
    const settings = useSettingsStore.getState();
    vi.spyOn(useSettingsStore, 'getState').mockReturnValue({
      ...settings,
      ttsProvidersConfig: {
        ...settings.ttsProvidersConfig,
        'browser-native-tts': { apiKey: '', baseUrl: '', enabled: false },
      },
    });
    const play = vi.fn().mockResolvedValue(true);
    if (firstResult instanceof Error) play.mockRejectedValueOnce(firstResult);
    else play.mockResolvedValueOnce(firstResult);
    const audioPlayer = {
      play,
      onEnded: vi.fn(),
      stop: vi.fn(),
      hasActiveAudio: vi.fn().mockReturnValue(false),
    } as unknown as AudioPlayer;
    const actionEngine = {
      clearEffects: vi.fn(),
      restoreWhiteboard: vi.fn().mockResolvedValue(undefined),
    } as unknown as ActionEngine;
    const scene = {
      id: 'lesson',
      type: 'slide',
      ttsPolicy: 'target-duration',
      actions: [
        { id: 'first', type: 'speech', text: '第一句', audioUrl: '/first.wav' },
        { id: 'second', type: 'speech', text: '第二句', audioUrl: '/second.wav' },
      ],
    } as Scene;
    const onSpeechStart = vi.fn();
    const onError = vi.fn();
    const onComplete = vi.fn();
    const engine = new PlaybackEngine([scene], actionEngine, audioPlayer, {
      onSpeechStart, onError, onComplete,
    });

    if (startRatio > 0) engine.playSpeechAt(0, startRatio);
    else engine.start();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(engine.getMode()).toBe('idle');
    expect(engine.getSnapshot().actionIndex).toBe(0);

    engine.continuePlayback();
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(2));
    expect(play.mock.calls).toEqual([
      ['', '/first.wav', startRatio],
      ['', '/first.wav', startRatio],
    ]);
    expect(onSpeechStart.mock.calls.map(([text]) => text)).toEqual(['第一句', '第一句']);
    expect(onComplete).not.toHaveBeenCalled();
    engine.stop();
  });
});
