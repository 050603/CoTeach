import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybackEngine } from './engine';
import type { Scene } from '@openmaic/lib/types/stage';
import type { Action } from '@openmaic/lib/types/action';
import type { ActionEngine } from '@openmaic/lib/action/engine';
import type { AudioPlayer } from '@openmaic/lib/utils/audio-player';

function activityScene(
  durationSec = 1,
  purpose: 'quiz' | 'interaction' = 'quiz',
): Scene {
  return {
    id: purpose === 'quiz' ? 'quiz-scene' : 'interaction-activity-scene',
    stageId: 'stage-1',
    order: 0,
    title: 'Quiz',
    type: 'quiz',
    content: { type: 'quiz', questions: [] },
    actions: [
      {
        id: 'activity-gate',
        type: 'speech',
        text: '',
        activityPauseSec: durationSec,
        activityPausePurpose: purpose,
      },
      { id: 'after-gate', type: 'wb_close' },
    ] as Action[],
  } as unknown as Scene;
}

function discussionScene(): Scene {
  return {
    id: 'discussion-scene',
    stageId: 'stage-1',
    order: 0,
    title: 'Discussion',
    type: 'slide',
    content: { type: 'slide', elements: [] },
    actions: [
      {
        id: 'discussion-1',
        type: 'discussion',
        topic: 'Try this',
      },
    ] as Action[],
  } as unknown as Scene;
}

function transitionScene(durationSec = 5): Scene {
  return {
    id: 'slide-scene',
    stageId: 'stage-1',
    order: 0,
    title: 'Slide',
    type: 'slide',
    content: { type: 'slide', elements: [] },
    actions: [
      {
        id: 'page-transition',
        type: 'speech',
        text: '',
        timelinePauseSec: durationSec,
        timelinePausePurpose: 'page-transition',
      },
      { id: 'after-transition', type: 'wb_close' },
    ] as Action[],
  } as unknown as Scene;
}

function legacyInteractiveScene(): Scene {
  return {
    id: 'interactive-scene',
    stageId: 'stage-1',
    order: 0,
    title: 'Simulation',
    type: 'interactive',
    content: { type: 'interactive', html: '<!doctype html><html></html>' },
    actions: [
      { id: 'intro', type: 'speech', text: '' },
      { id: 'auto-demo', type: 'widget_setState', state: { speed: 2 } },
      {
        id: 'activity-gate',
        type: 'speech',
        text: '',
        activityPauseSec: 5,
        activityPausePurpose: 'interaction',
      },
      { id: 'feedback', type: 'speech', text: '' },
    ] as Action[],
  } as unknown as Scene;
}

function legacySlideScene(): Scene {
  return {
    id: 'slide-scene',
    stageId: 'stage-1',
    order: 0,
    title: 'Explanation',
    type: 'slide',
    content: { type: 'slide', elements: [] },
    actions: [
      { id: 'intro', type: 'speech', text: '' },
      {
        id: 'legacy-gate',
        type: 'speech',
        text: '',
        activityPauseSec: 5,
        activityPausePurpose: 'interaction',
        activityPauseSource: 'page-timing',
      },
      { id: 'first-visual-action', type: 'wb_open' },
      { id: 'explanation', type: 'speech', text: '' },
    ] as Action[],
  } as unknown as Scene;
}

function createEngine(
  callbacks: ConstructorParameters<typeof PlaybackEngine>[3] = {},
  scene = activityScene(),
) {
  const actionEngine = {
    clearEffects: vi.fn(),
    execute: vi.fn().mockResolvedValue(undefined),
  } as unknown as ActionEngine;
  const audioPlayer = {
    play: vi.fn().mockResolvedValue(false),
    onEnded: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    isPlaying: vi.fn().mockReturnValue(false),
    hasActiveAudio: vi.fn().mockReturnValue(false),
  } as unknown as AudioPlayer;
  const engine = new PlaybackEngine([scene], actionEngine, audioPlayer, callbacks);
  return { engine, actionEngine };
}

describe('PlaybackEngine activity gates', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps a quiz blocked after its planned duration until the student completes it', async () => {
    const onActivityComplete = vi.fn();
    const { engine, actionEngine } = createEngine({ onActivityComplete });

    engine.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(onActivityComplete).not.toHaveBeenCalled();
    expect(actionEngine.execute).not.toHaveBeenCalled();

    expect(engine.completeActivity('quiz-scene', 'quiz')).toBe(true);
    await vi.runAllTimersAsync();

    expect(onActivityComplete).toHaveBeenCalledWith(
      expect.objectContaining({ sceneId: 'quiz-scene', purpose: 'quiz' }),
      'user',
    );
    expect(actionEngine.execute).toHaveBeenCalledTimes(1);
  });

  it('retains the timeout fallback for interactive activities', async () => {
    const onActivityComplete = vi.fn();
    const { engine, actionEngine } = createEngine(
      { onActivityComplete },
      activityScene(1, 'interaction'),
    );

    engine.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(onActivityComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        sceneId: 'interaction-activity-scene',
        purpose: 'interaction',
      }),
      'timeout',
    );
    expect(actionEngine.execute).toHaveBeenCalledTimes(1);
  });

  it('continues once when the student completes early', async () => {
    const { engine, actionEngine } = createEngine();
    engine.start();

    expect(engine.completeActivity('quiz-scene', 'quiz')).toBe(true);
    expect(engine.completeActivity('quiz-scene', 'quiz')).toBe(false);
    await vi.runAllTimersAsync();

    expect(actionEngine.execute).toHaveBeenCalledTimes(1);
  });

  it('preserves the remaining activity time across pause and resume', async () => {
    const { engine, actionEngine } = createEngine({}, activityScene(1, 'interaction'));
    engine.start();
    await vi.advanceTimersByTimeAsync(400);
    engine.pause();
    await vi.advanceTimersByTimeAsync(1000);
    expect(actionEngine.execute).not.toHaveBeenCalled();

    engine.resume();
    await vi.advanceTimersByTimeAsync(599);
    expect(actionEngine.execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(actionEngine.execute).toHaveBeenCalledTimes(1);
  });

  it('executes a fixed transition pause without exposing a learner activity gate', async () => {
    const onActivityStart = vi.fn();
    const actionEngine = {
      clearEffects: vi.fn(),
      execute: vi.fn().mockResolvedValue(undefined),
    } as unknown as ActionEngine;
    const audioPlayer = {
      play: vi.fn().mockResolvedValue(false),
      onEnded: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      isPlaying: vi.fn().mockReturnValue(false),
      hasActiveAudio: vi.fn().mockReturnValue(false),
    } as unknown as AudioPlayer;
    const engine = new PlaybackEngine(
      [transitionScene()],
      actionEngine,
      audioPlayer,
      { onActivityStart },
    );

    engine.start();
    await vi.advanceTimersByTimeAsync(399);
    expect(actionEngine.execute).not.toHaveBeenCalled();
    expect(onActivityStart).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(actionEngine.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'after-transition' }),
    );
  });

  it('preserves the remaining fixed transition across pause and resume', async () => {
    const actionEngine = {
      clearEffects: vi.fn(),
      execute: vi.fn().mockResolvedValue(undefined),
    } as unknown as ActionEngine;
    const audioPlayer = {
      play: vi.fn().mockResolvedValue(false),
      onEnded: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      isPlaying: vi.fn().mockReturnValue(false),
      hasActiveAudio: vi.fn().mockReturnValue(false),
    } as unknown as AudioPlayer;
    const engine = new PlaybackEngine(
      [transitionScene()],
      actionEngine,
      audioPlayer,
    );

    engine.start();
    await vi.advanceTimersByTimeAsync(200);
    engine.pause();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(actionEngine.execute).not.toHaveBeenCalled();

    engine.resume();
    await vi.advanceTimersByTimeAsync(199);
    expect(actionEngine.execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(actionEngine.execute).toHaveBeenCalledTimes(1);
  });

  it('records completion while paused and continues only after resume', async () => {
    const { engine, actionEngine } = createEngine();
    engine.start();
    engine.pause();

    expect(engine.completeActivity('quiz-scene', 'quiz')).toBe(true);
    await vi.runAllTimersAsync();
    expect(actionEngine.execute).not.toHaveBeenCalled();

    engine.resume();
    await vi.runAllTimersAsync();
    expect(actionEngine.execute).toHaveBeenCalledTimes(1);
  });

  it('normalizes legacy interactive scenes so automation waits for the learner', async () => {
    const onActivityStart = vi.fn();
    const actionEngine = {
      clearEffects: vi.fn(),
      execute: vi.fn().mockResolvedValue(undefined),
    } as unknown as ActionEngine;
    const audioPlayer = {
      play: vi.fn().mockResolvedValue(false),
      onEnded: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      isPlaying: vi.fn().mockReturnValue(false),
      hasActiveAudio: vi.fn().mockReturnValue(false),
    } as unknown as AudioPlayer;
    const engine = new PlaybackEngine(
      [legacyInteractiveScene()],
      actionEngine,
      audioPlayer,
      { onActivityStart },
    );

    engine.start();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(onActivityStart).toHaveBeenCalledWith(
      expect.objectContaining({
        sceneId: 'interactive-scene',
        purpose: 'interaction',
        durationSec: 30,
      }),
    );
    expect(actionEngine.execute).not.toHaveBeenCalled();

    expect(engine.completeActivity('interactive-scene', 'interaction')).toBe(true);
    await vi.runAllTimersAsync();
    expect(actionEngine.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'auto-demo', type: 'widget_setState' }),
    );
  });

  it('does not expose a persisted slide timing pause as an operation gate', async () => {
    const onActivityStart = vi.fn();
    const actionEngine = {
      clearEffects: vi.fn(),
      execute: vi.fn().mockResolvedValue(undefined),
    } as unknown as ActionEngine;
    const audioPlayer = {
      play: vi.fn().mockResolvedValue(false),
      onEnded: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      isPlaying: vi.fn().mockReturnValue(false),
      hasActiveAudio: vi.fn().mockReturnValue(false),
    } as unknown as AudioPlayer;
    const engine = new PlaybackEngine(
      [legacySlideScene()],
      actionEngine,
      audioPlayer,
      { onActivityStart },
    );

    engine.start();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(actionEngine.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'first-visual-action' }),
    );
    expect(onActivityStart).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(onActivityStart).not.toHaveBeenCalled();
  });

  it('re-schedules a delayed discussion trigger after pause and resume', async () => {
    const onProactiveShow = vi.fn();
    const actionEngine = {
      clearEffects: vi.fn(),
      execute: vi.fn().mockResolvedValue(undefined),
    } as unknown as ActionEngine;
    const audioPlayer = {
      play: vi.fn().mockResolvedValue(false),
      onEnded: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      isPlaying: vi.fn().mockReturnValue(false),
      hasActiveAudio: vi.fn().mockReturnValue(false),
    } as unknown as AudioPlayer;
    const engine = new PlaybackEngine(
      [discussionScene()],
      actionEngine,
      audioPlayer,
      { onProactiveShow },
    );

    engine.start();
    await vi.advanceTimersByTimeAsync(1_000);
    engine.pause();
    engine.resume();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(onProactiveShow).toHaveBeenCalledTimes(1);
    expect(onProactiveShow).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'discussion-1' }),
    );
  });

  it('continues playback when one visual action fails', async () => {
    const actionEngine = {
      clearEffects: vi.fn(),
      execute: vi.fn()
        .mockRejectedValueOnce(new Error('transient failure'))
        .mockResolvedValue(undefined),
    } as unknown as ActionEngine;
    const audioPlayer = {
      play: vi.fn().mockResolvedValue(false),
      onEnded: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      isPlaying: vi.fn().mockReturnValue(false),
      hasActiveAudio: vi.fn().mockReturnValue(false),
    } as unknown as AudioPlayer;
    const scene = {
      ...activityScene(),
      actions: [
        { id: 'open', type: 'wb_open' },
        { id: 'close', type: 'wb_close' },
      ] as Action[],
    } as Scene;
    const engine = new PlaybackEngine([scene], actionEngine, audioPlayer);

    engine.start();
    await vi.runAllTimersAsync();

    expect(actionEngine.execute).toHaveBeenCalledTimes(2);
  });
});
