import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionEngine } from '@openmaic/lib/action/engine';
import { PlaybackEngine } from '@openmaic/lib/playback/engine';
import type { Scene } from '@openmaic/lib/types/stage';
import { AudioPlayer } from './audio-player';

class FakeAudio extends EventTarget {
  src = '';
  volume = 1;
  defaultPlaybackRate = 1;
  playbackRate = 1;
  currentTime = 0;
  duration = 10;
  paused = true;
  ended = false;
  play = vi.fn(async () => {
    this.paused = false;
    this.ended = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  load = vi.fn();
}

describe('AudioPlayer playback', () => {
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

  it('does not resume a completed quiz introduction after the tutor modal closes', async () => {
    const player = new AudioPlayer();
    const onEnded = vi.fn();
    player.onEnded(onEnded);

    const playback = player.play('', '/quiz-introduction.mp3');
    await vi.advanceTimersByTimeAsync(650);
    await playback;
    const audio = (player as unknown as { audio: FakeAudio }).audio;
    expect(player.hasActiveAudio()).toBe(true);

    audio.ended = true;
    audio.paused = true;
    audio.dispatchEvent(new Event('ended'));
    expect(onEnded).toHaveBeenCalledOnce();

    player.pause();
    expect(player.hasActiveAudio()).toBe(false);
    player.resume();
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it('plays quiz feedback after confirmation without repeating the introduction', async () => {
    const scene = {
      id: 'quiz-1',
      type: 'quiz',
      actions: [
        { id: 'intro', type: 'speech', text: '请完成答题', audioUrl: '/intro.mp3' },
        { id: 'gate', type: 'speech', text: '', activityPauseSec: 60, activityPausePurpose: 'quiz' },
        { id: 'feedback', type: 'speech', text: '继续学习下一部分', audioUrl: '/feedback.mp3' },
      ],
    } as Scene;
    const player = new AudioPlayer();
    const onSpeechStart = vi.fn();
    const onActivityStart = vi.fn();
    const engine = new PlaybackEngine(
      [scene],
      { clearEffects: vi.fn(), execute: vi.fn().mockResolvedValue(undefined) } as unknown as ActionEngine,
      player,
      { onSpeechStart, onActivityStart },
    );

    engine.start();
    await vi.advanceTimersByTimeAsync(650);
    const intro = (player as unknown as { audio: FakeAudio }).audio;
    intro.ended = true;
    intro.paused = true;
    intro.dispatchEvent(new Event('ended'));
    expect(onActivityStart).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'quiz' }));

    engine.pause(); // Opening the tutor explanation pauses the course.
    expect(engine.completeActivity('quiz-1', 'quiz')).toBe(true);
    engine.resume(); // The learner closed the tutor and confirmed understanding.
    await Promise.resolve();

    expect(onSpeechStart.mock.calls.map(([text]) => text)).toEqual([
      '请完成答题',
      '继续学习下一部分',
    ]);
    expect(intro.play).toHaveBeenCalledTimes(2);
    expect((player as unknown as { audio: FakeAudio }).audio.src).toBe('/feedback.mp3');
    engine.stop();
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
