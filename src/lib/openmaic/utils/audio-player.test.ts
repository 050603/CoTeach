import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import type { ActionEngine } from '@openmaic/lib/action/engine';
import { PlaybackEngine } from '@openmaic/lib/playback/engine';
import type { Scene } from '@openmaic/lib/types/stage';
import { AudioPlayer } from './audio-player';
import { db } from './database';

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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('downloads and retries a URL when the initial quiet preroll fails', async () => {
    const failure = new Error('Audio could not be decoded');
    class RetryAudio extends FakeAudio {
      override play = vi.fn(async () => {
        if (this.src === '/narration.wav') throw failure;
        this.paused = false;
      });
    }
    const fetchAudio = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new NodeBlob(['audio'], { type: 'audio/wav' }),
    });
    vi.stubGlobal('Audio', RetryAudio);
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('fetch', fetchAudio);
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:repaired'), revokeObjectURL: vi.fn() });

    const player = new AudioPlayer();
    const playback = player.play('', '/narration.wav');
    await vi.advanceTimersByTimeAsync(650);

    await expect(playback).resolves.toBe(true);
    expect(fetchAudio).toHaveBeenCalledWith('/narration.wav');
    const audio = (player as unknown as { audio: FakeAudio }).audio;
    expect(audio.src).toBe('blob:repaired');
    expect(audio.volume).toBe(1);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it.each(['URL fallback', 'IndexedDB'])('releases audio when the %s preroll fails', async (source) => {
    const failure = new Error('Audio could not be decoded');
    class FailedAudio extends FakeAudio {
      override play = vi.fn(async () => { throw failure; });
    }
    const blob = new NodeBlob(['audio'], { type: 'audio/wav' });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('Audio', FailedAudio);
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => blob }));
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:failed'), revokeObjectURL });
    vi.spyOn(db.audioFiles, 'get').mockResolvedValue({
      id: 'speech', blob, format: 'wav',
    } as unknown as Awaited<ReturnType<typeof db.audioFiles.get>>);

    const player = new AudioPlayer();
    await expect(player.play('speech', source === 'URL fallback' ? '/narration.wav' : undefined))
      .rejects.toBe(failure);

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:failed');
    expect(player.hasActiveAudio()).toBe(false);
    expect((player as unknown as { warmupAudio: FakeAudio | null }).warmupAudio).toBeNull();
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

  it('plays staged quiz audio in submission, review, and handoff order', async () => {
    const scene = {
      id: 'staged-quiz-audio',
      type: 'quiz',
      actions: [
        { id: 'intro', type: 'speech', text: '请独立作答', audioUrl: '/intro.mp3' },
        { id: 'submit', type: 'speech', text: '', activityPauseSec: 60, activityPausePurpose: 'quiz-submit' },
        { id: 'review', type: 'speech', text: '提交后请看解析', audioUrl: '/review.mp3' },
        { id: 'confirm', type: 'speech', text: '', activityPauseSec: 20, activityPausePurpose: 'quiz' },
        { id: 'handoff', type: 'speech', text: '接下来进入下一节', audioUrl: '/handoff.mp3' },
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
    expect(onActivityStart).toHaveBeenLastCalledWith(expect.objectContaining({ purpose: 'quiz-submit' }));

    expect(engine.completeActivity(scene.id, 'quiz-submit')).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    const review = (player as unknown as { audio: FakeAudio }).audio;
    expect(review.src).toBe('/review.mp3');
    expect(onSpeechStart.mock.calls.map(([speech]) => speech)).toEqual(['请独立作答', '提交后请看解析']);

    // The learner can confirm quickly, but the current guidance must finish.
    expect(engine.completeActivity(scene.id, 'quiz')).toBe(false);
    expect(review.paused).toBe(false);
    review.ended = true;
    review.paused = true;
    review.dispatchEvent(new Event('ended'));
    expect(onActivityStart).toHaveBeenLastCalledWith(expect.objectContaining({ purpose: 'quiz' }));
    expect(engine.completeActivity(scene.id, 'quiz')).toBe(true);
    await Promise.resolve();
    expect((player as unknown as { audio: FakeAudio }).audio.src).toBe('/handoff.mp3');
    expect(onSpeechStart.mock.calls.map(([speech]) => speech)).toEqual([
      '请独立作答', '提交后请看解析', '接下来进入下一节',
    ]);
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
