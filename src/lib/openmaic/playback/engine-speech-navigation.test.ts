import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaybackEngine } from './engine';
import type { Scene } from '@openmaic/lib/types/stage';
import type { Action } from '@openmaic/lib/types/action';
import type { ActionEngine } from '@openmaic/lib/action/engine';
import type { AudioPlayer } from '@openmaic/lib/utils/audio-player';

describe('PlaybackEngine speech navigation', () => {
  afterEach(() => vi.useRealTimers());
  it('restores the whiteboard and restarts audio at the selected subtitle position', async () => {
    const onSpeechStart = vi.fn();
    const onSpeechProgress = vi.fn();
    const actionEngine = {
      clearEffects: vi.fn(),
      execute: vi.fn().mockResolvedValue(undefined),
      restoreWhiteboard: vi.fn().mockResolvedValue(undefined),
    } as unknown as ActionEngine;
    const audioPlayer = {
      play: vi.fn().mockResolvedValue(true),
      onEnded: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      isPlaying: vi.fn().mockReturnValue(false),
      hasActiveAudio: vi.fn().mockReturnValue(false),
    } as unknown as AudioPlayer;
    const scene = {
      id: 'lesson',
      stageId: 'stage',
      order: 0,
      title: 'Lesson',
      type: 'slide',
      content: { type: 'slide', elements: [] },
      actions: [
        { id: 'speech-1', type: 'speech', text: '第一句', audioUrl: '/first.mp3' },
        { id: 'focus', type: 'spotlight', elementId: 'title' },
        { id: 'speech-2', type: 'speech', text: '第二句', audioUrl: '/second.mp3' },
      ] as Action[],
    } as unknown as Scene;
    const engine = new PlaybackEngine([scene], actionEngine, audioPlayer, {
      onSpeechStart,
      onSpeechProgress,
    });

    expect(engine.playSpeechAt(2, 0.4)).toBe(true);
    expect(audioPlayer.stop).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(onSpeechStart).toHaveBeenCalled());
    expect(actionEngine.restoreWhiteboard).toHaveBeenCalledWith((scene.actions ?? []).slice(0, 2));
    expect(actionEngine.execute).toHaveBeenCalledWith(scene.actions?.[1]);
    expect(onSpeechStart).toHaveBeenCalledWith('第二句', {
      sceneId: 'lesson',
      actionIndex: 2,
    });
    expect(onSpeechProgress).toHaveBeenCalledWith(0.4);
    expect(audioPlayer.play).toHaveBeenCalledWith('', '/second.mp3', 0.4);
  });

  it('rejects a non-speech action', () => {
    const scene = {
      id: 'lesson',
      stageId: 'stage',
      order: 0,
      title: 'Lesson',
      type: 'slide',
      content: { type: 'slide', elements: [] },
      actions: [{ id: 'focus', type: 'spotlight', elementId: 'title' }] as Action[],
    } as unknown as Scene;
    const engine = new PlaybackEngine(
      [scene],
      { clearEffects: vi.fn() } as unknown as ActionEngine,
      {} as AudioPlayer,
    );

    expect(engine.playSpeechAt(0)).toBe(false);
  });

  it('keeps a bound cue through pause and clears it when its narration ends', async () => {
    let onEnded: (() => void) | undefined;
    const actionEngine = {
      clearEffects: vi.fn(),
      pauseEffects: vi.fn(),
      resumeEffects: vi.fn(),
      execute: vi.fn().mockResolvedValue(undefined),
      restoreWhiteboard: vi.fn().mockResolvedValue(undefined),
    } as unknown as ActionEngine;
    const audioPlayer = {
      play: vi.fn().mockResolvedValue(true),
      onEnded: vi.fn((callback: () => void) => { onEnded = callback; }),
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      isPlaying: vi.fn().mockReturnValue(true),
      hasActiveAudio: vi.fn().mockReturnValue(true),
    } as unknown as AudioPlayer;
    const scene = {
      id: 'lesson', stageId: 'stage', order: 0, title: 'Lesson', type: 'slide',
      content: { type: 'slide', elements: [] },
      actions: [
        {
          id: 'focus', type: 'spotlight', elementId: 'table',
          selector: { cellId: 'r3c2' }, speechId: 'speech-1',
        },
        { id: 'speech-1', type: 'speech', text: '小学阶段使用低代码工具。', audioUrl: '/speech.mp3' },
      ] as Action[],
    } as unknown as Scene;
    const engine = new PlaybackEngine([scene], actionEngine, audioPlayer);

    engine.start();
    await vi.waitFor(() => expect(audioPlayer.play).toHaveBeenCalled());
    engine.pause();
    expect(actionEngine.pauseEffects).toHaveBeenCalledTimes(1);
    engine.resume();
    expect(actionEngine.resumeEffects).toHaveBeenCalledTimes(1);
    onEnded?.();
    expect(actionEngine.clearEffects).toHaveBeenCalled();
  });

  it('keeps one spotlight stable through its bound narration interval', async () => {
    let onEnded: (() => void) | undefined;
    const clearEffects = vi.fn();
    const actionEngine = {
      clearEffects,
      execute: vi.fn().mockResolvedValue(undefined),
      restoreWhiteboard: vi.fn().mockResolvedValue(undefined),
    } as unknown as ActionEngine;
    const audioPlayer = {
      play: vi.fn().mockResolvedValue(true),
      onEnded: vi.fn((callback: () => void) => { onEnded = callback; }),
      pause: vi.fn(), resume: vi.fn(), stop: vi.fn(),
      isPlaying: vi.fn().mockReturnValue(false),
      hasActiveAudio: vi.fn().mockReturnValue(false),
    } as unknown as AudioPlayer;
    const scene = {
      id: 'lesson', stageId: 'stage', order: 0, title: 'Lesson', type: 'slide',
      content: { type: 'slide', elements: [] },
      actions: [
        {
          id: 'focus', type: 'spotlight', elementId: 'table',
          selector: { cellId: 'r3c2' }, speechId: 'speech-1', endSpeechId: 'speech-2',
        },
        { id: 'speech-1', type: 'speech', text: '先解释这个单元格。', audioUrl: '/first.mp3' },
        { id: 'speech-2', type: 'speech', text: '继续说明同一个概念。', audioUrl: '/second.mp3' },
      ] as Action[],
    } as unknown as Scene;
    const engine = new PlaybackEngine([scene], actionEngine, audioPlayer);

    engine.start();
    await vi.waitFor(() => expect(audioPlayer.play).toHaveBeenCalledTimes(1));
    clearEffects.mockClear();
    onEnded?.();
    await vi.waitFor(() => expect(audioPlayer.play).toHaveBeenCalledTimes(2));
    expect(clearEffects).not.toHaveBeenCalled();
    onEnded?.();
    expect(clearEffects).toHaveBeenCalled();
  });

  it('restores a ranged spotlight when seeking to a speech inside the interval', async () => {
    const actionEngine = {
      clearEffects: vi.fn(),
      execute: vi.fn().mockResolvedValue(undefined),
      restoreWhiteboard: vi.fn().mockResolvedValue(undefined),
    } as unknown as ActionEngine;
    const audioPlayer = {
      play: vi.fn().mockResolvedValue(true), onEnded: vi.fn(),
      pause: vi.fn(), resume: vi.fn(), stop: vi.fn(),
      isPlaying: vi.fn().mockReturnValue(false),
      hasActiveAudio: vi.fn().mockReturnValue(false),
    } as unknown as AudioPlayer;
    const focus = {
      id: 'focus', type: 'spotlight', elementId: 'table',
      speechId: 'speech-1', endSpeechId: 'speech-2',
    } as Action;
    const scene = {
      id: 'lesson', stageId: 'stage', order: 0, title: 'Lesson', type: 'slide',
      content: { type: 'slide', elements: [] },
      actions: [
        focus,
        { id: 'speech-1', type: 'speech', text: '第一段', audioUrl: '/first.mp3' },
        { id: 'speech-2', type: 'speech', text: '第二段', audioUrl: '/second.mp3' },
      ] as Action[],
    } as unknown as Scene;
    const engine = new PlaybackEngine([scene], actionEngine, audioPlayer);

    expect(engine.playSpeechAt(2)).toBe(true);
    await vi.waitFor(() => expect(audioPlayer.play).toHaveBeenCalledWith('', '/second.mp3', 0));
    expect(actionEngine.execute).toHaveBeenCalledWith(focus);
  });

  it('plays multiple offset cues inside one unsplit speech and pauses their schedule', async () => {
    vi.useFakeTimers();
    const actionEngine = {
      clearEffects: vi.fn(),
      pauseEffects: vi.fn(),
      resumeEffects: vi.fn(),
      execute: vi.fn().mockResolvedValue(undefined),
      restoreWhiteboard: vi.fn().mockResolvedValue(undefined),
    } as unknown as ActionEngine;
    const audioPlayer = {
      play: vi.fn().mockResolvedValue(true), onEnded: vi.fn(),
      getDuration: vi.fn().mockReturnValue(10_000),
      pause: vi.fn(), resume: vi.fn(), stop: vi.fn(),
      isPlaying: vi.fn().mockReturnValue(true),
      hasActiveAudio: vi.fn().mockReturnValue(true),
    } as unknown as AudioPlayer;
    const first = {
      id: 'point-pbl', type: 'laser', elementId: 'title', speechId: 'speech', speechOffsetMs: 1000,
    } as Action;
    const second = {
      id: 'focus-traction', type: 'spotlight', elementId: 'traction', speechId: 'speech',
      speechOffsetMs: 4000, endSpeechId: 'speech',
    } as Action;
    const scene = {
      id: 'lesson', stageId: 'stage', order: 0, title: 'Lesson', type: 'slide',
      content: { type: 'slide', elements: [] },
      actions: [first, second, {
        id: 'speech', type: 'speech', text: '同一自然段先介绍 PBL，再解释牵引力。', audioUrl: '/speech.mp3',
      }] as Action[],
    } as unknown as Scene;
    const engine = new PlaybackEngine([scene], actionEngine, audioPlayer);

    engine.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(actionEngine.execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(actionEngine.execute).toHaveBeenNthCalledWith(1, first);

    await vi.advanceTimersByTimeAsync(1000);
    engine.pause();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(actionEngine.execute).toHaveBeenCalledTimes(1);
    engine.resume();
    await vi.advanceTimersByTimeAsync(1999);
    expect(actionEngine.execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(actionEngine.execute).toHaveBeenNthCalledWith(2, second);
  });

  it('restores the active offset cue when seeking into the middle of a speech', async () => {
    const delayed = {
      id: 'focus-traction', type: 'spotlight', elementId: 'traction', speechId: 'speech',
      speechOffsetMs: 3000, endSpeechId: 'speech',
    } as Action;
    const actionEngine = {
      clearEffects: vi.fn(), execute: vi.fn().mockResolvedValue(undefined),
      restoreWhiteboard: vi.fn().mockResolvedValue(undefined),
    } as unknown as ActionEngine;
    const audioPlayer = {
      play: vi.fn().mockResolvedValue(true), onEnded: vi.fn(),
      getDuration: vi.fn().mockReturnValue(10_000),
      pause: vi.fn(), resume: vi.fn(), stop: vi.fn(),
      isPlaying: vi.fn().mockReturnValue(false), hasActiveAudio: vi.fn().mockReturnValue(false),
    } as unknown as AudioPlayer;
    const scene = {
      id: 'lesson', stageId: 'stage', order: 0, title: 'Lesson', type: 'slide',
      content: { type: 'slide', elements: [] },
      actions: [delayed, {
        id: 'speech', type: 'speech', text: '同一自然段先介绍 PBL，再解释牵引力。', audioUrl: '/speech.mp3',
      }] as Action[],
    } as unknown as Scene;
    const engine = new PlaybackEngine([scene], actionEngine, audioPlayer);

    expect(engine.playSpeechAt(1, 0.5)).toBe(true);
    await vi.waitFor(() => expect(actionEngine.execute).toHaveBeenCalledWith(delayed));
  });
});
