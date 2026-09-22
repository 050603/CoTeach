import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioPlayer } from './audio-player';

class FakeAudio extends EventTarget {
  src = '';
  volume = 1;
  defaultPlaybackRate = 1;
  playbackRate = 1;
  currentTime = 0;
  duration = 10;
  paused = true;
  play = vi.fn(async () => {
    this.paused = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  load = vi.fn();
}

describe('AudioPlayer playback warmup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('Audio', FakeAudio);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('prerolls quietly, rewinds, and then starts the first page clip audibly', async () => {
    const player = new AudioPlayer();
    player.setVolume(0.8);
    player.requestPlaybackWarmup();

    const playback = player.play('', '/narration.mp3');
    await vi.advanceTimersByTimeAsync(649);

    const audio = (player as unknown as { audio: FakeAudio }).audio;
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.volume).toBe(0.001);

    await vi.advanceTimersByTimeAsync(1);
    await expect(playback).resolves.toBe(true);
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(audio.currentTime).toBe(0);
    expect(audio.volume).toBe(0.8);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it('does not add a warmup before every narration segment', async () => {
    const player = new AudioPlayer();
    const firstPlayback = player.play('', '/first.mp3');
    await vi.advanceTimersByTimeAsync(650);
    await firstPlayback;

    await expect(player.play('', '/second.mp3')).resolves.toBe(true);
    const audio = (player as unknown as { audio: FakeAudio }).audio;
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it('rewinds and stays paused when the user pauses during warmup', async () => {
    const player = new AudioPlayer();
    const onEnded = vi.fn();
    player.onEnded(onEnded);

    const playback = player.play('', '/narration.mp3');
    await vi.advanceTimersByTimeAsync(100);
    const audio = (player as unknown as { audio: FakeAudio }).audio;
    player.pause();
    await vi.advanceTimersByTimeAsync(550);

    await expect(playback).resolves.toBe(false);
    expect(audio.paused).toBe(true);
    expect(audio.currentTime).toBe(0);
    expect(onEnded).not.toHaveBeenCalled();

    player.resume();
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(audio.volume).toBe(1);
  });

  it('ignores a late ended event from audio replaced by a seek or page change', async () => {
    const player = new AudioPlayer();
    const onEnded = vi.fn();
    player.onEnded(onEnded);

    const firstPlayback = player.play('', '/first.mp3');
    await vi.advanceTimersByTimeAsync(650);
    await firstPlayback;
    const firstAudio = (player as unknown as { audio: FakeAudio }).audio;

    await player.play('', '/second.mp3');
    const secondAudio = (player as unknown as { audio: FakeAudio }).audio;
    firstAudio.dispatchEvent(new Event('ended'));
    expect(onEnded).not.toHaveBeenCalled();

    secondAudio.dispatchEvent(new Event('ended'));
    expect(onEnded).toHaveBeenCalledOnce();
  });

  it('waits for the quiet pre-roll to seek back to zero before audible playback', async () => {
    const player = new AudioPlayer();
    const playback = player.play('', '/narration.mp3');
    await vi.advanceTimersByTimeAsync(649);

    const audio = (player as unknown as { audio: FakeAudio & { seeking: boolean } }).audio;
    let mediaTime = 0.65;
    audio.seeking = false;
    Object.defineProperty(audio, 'currentTime', {
      configurable: true,
      get: () => mediaTime,
      set: (value: number) => {
        if (value !== 0) {
          mediaTime = value;
          return;
        }
        audio.seeking = true;
        window.setTimeout(() => {
          mediaTime = 0;
          audio.seeking = false;
          audio.dispatchEvent(new Event('seeked'));
        }, 80);
      },
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.play).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(79);
    expect(audio.play).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(playback).resolves.toBe(true);
    expect(mediaTime).toBe(0);
    expect(audio.volume).toBe(1);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });
});
