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
    let currentTime = 0;
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
      getCurrentTime: vi.fn(() => currentTime),
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
    await vi.advanceTimersByTimeAsync(40);
    expect(actionEngine.execute).not.toHaveBeenCalled();
    currentTime = 1000;
    await vi.advanceTimersByTimeAsync(40);
    expect(actionEngine.execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining(first),
    );

    engine.pause();
    currentTime = 4000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(actionEngine.execute).toHaveBeenCalledTimes(1);
    engine.resume();
    await vi.advanceTimersByTimeAsync(40);
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
      getCurrentTime: vi.fn().mockReturnValue(5000),
      pause: vi.fn(), resume: vi.fn(), stop: vi.fn(),
      isPlaying: vi.fn().mockReturnValue(true), hasActiveAudio: vi.fn().mockReturnValue(true),
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

  it('uses the audio clock and forced-alignment anchors for progress and cue changes', async () => {
    vi.useFakeTimers();
    let currentTime = 0;
    const onSpeechProgress = vi.fn();
    const first = {
      id: 'focus-title', type: 'spotlight', elementId: 'title', speechId: 'speech',
      speechAnchor: { quote: '标题' },
    } as Action;
    const second = {
      id: 'point-data', type: 'laser', elementId: 'data', speechId: 'speech',
      speechAnchor: { quote: '数据' },
    } as Action;
    const actionEngine = {
      clearEffects: vi.fn(), execute: vi.fn().mockResolvedValue(undefined),
      restoreWhiteboard: vi.fn().mockResolvedValue(undefined),
      pauseEffects: vi.fn(), resumeEffects: vi.fn(),
    } as unknown as ActionEngine;
    const audioPlayer = {
      play: vi.fn().mockResolvedValue(true), onEnded: vi.fn(),
      getDuration: vi.fn().mockReturnValue(4000),
      getCurrentTime: vi.fn(() => currentTime),
      pause: vi.fn(), resume: vi.fn(), stop: vi.fn(),
      isPlaying: vi.fn().mockReturnValue(true), hasActiveAudio: vi.fn().mockReturnValue(true),
    } as unknown as AudioPlayer;
    const scene = {
      id: 'lesson', stageId: 'stage', order: 0, title: 'Lesson', type: 'slide',
      content: { type: 'slide', elements: [] },
      actions: [first, second, {
        id: 'speech', type: 'speech', text: '先看标题，再看数据。', audioUrl: '/speech.mp3',
        speechAlignment: {
          version: 'test', status: 'aligned', textHash: 'text', audioHash: 'audio', language: 'zh',
          spans: [
            { text: '先看', startChar: 0, endChar: 2, startMs: 0, endMs: 500 },
            { text: '标题', startChar: 2, endChar: 4, startMs: 500, endMs: 1100 },
            { text: '，再看', startChar: 4, endChar: 7, startMs: 1100, endMs: 2000 },
            { text: '数据', startChar: 7, endChar: 9, startMs: 2000, endMs: 2700 },
            { text: '。', startChar: 9, endChar: 10, startMs: 2700, endMs: 3000 },
          ],
        },
      }] as Action[],
    } as unknown as Scene;
    const engine = new PlaybackEngine([scene], actionEngine, audioPlayer, {
      onSpeechProgress,
      getPlaybackSpeed: () => 2,
    });

    engine.start();
    await vi.advanceTimersByTimeAsync(40);
    expect(actionEngine.execute).not.toHaveBeenCalled();

    currentTime = 500;
    await vi.advanceTimersByTimeAsync(40);
    expect(actionEngine.execute).toHaveBeenNthCalledWith(1, first);

    currentTime = 2000;
    await vi.advanceTimersByTimeAsync(40);
    expect(actionEngine.execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 'point-data', elementId: 'data', waypoints: undefined }),
    );
    expect(onSpeechProgress).toHaveBeenLastCalledWith(0.5);

    engine.pause();
    currentTime = 2500;
    await vi.advanceTimersByTimeAsync(400);
    expect(onSpeechProgress).toHaveBeenLastCalledWith(0.5);
    engine.resume();
    await vi.advanceTimersByTimeAsync(40);
    expect(onSpeechProgress).toHaveBeenLastCalledWith(0.625);
  });

  it('ends an implicit cue at its sentence boundary and caps it at the next focus', () => {
    const text = '先看小鱼和青蛙怎样理解牛，接着看顺应的定义。后面继续解释原因。';
    const first = {
      id: 'focus-example', type: 'spotlight', elementId: 'animal-example', speechId: 'speech',
      speechAnchor: { quote: '小鱼和青蛙' },
    } as Action;
    const second = {
      id: 'focus-definition', type: 'spotlight', elementId: 'accommodation-definition', speechId: 'speech',
      speechAnchor: { quote: '顺应的定义' },
    } as Action;
    const speechAction = {
      id: 'speech', type: 'speech', text,
      speechAlignment: {
        version: 'test', status: 'aligned', textHash: 'text', audioHash: 'audio', language: 'zh',
        spans: Array.from(text, (character, index) => ({
          text: character,
          startChar: index,
          endChar: index + 1,
          startMs: index * 100,
          endMs: (index + 1) * 100,
        })),
      },
    } as Action;
    const scene = {
      id: 'lesson', stageId: 'stage', order: 0, title: 'Lesson', type: 'slide',
      content: { type: 'slide', elements: [] }, actions: [first, second, speechAction],
    } as unknown as Scene;
    const engine = new PlaybackEngine(
      [scene],
      { clearEffects: vi.fn() } as unknown as ActionEngine,
      {} as AudioPlayer,
    );
    const internals = engine as unknown as {
      sceneIndex: number;
      buildSpeechCuePoints: (
        value: Action,
        durationMs: number,
        browserBoundary?: boolean,
      ) => Array<{ key: string; startMs: number; endMs: number; endChar: number | null }>;
    };
    internals.sceneIndex = 0;

    const points = internals.buildSpeechCuePoints(speechAction, text.length * 100);

    expect(points).toHaveLength(2);
    expect(points[0]?.endMs).toBe(points[1]?.startMs);
    expect(points[1]?.endMs).toBe((text.indexOf('。') + 1) * 100);
  });

  it('does not fire anchored visual cues without a valid alignment', async () => {
    vi.useFakeTimers();
    const actionEngine = {
      clearEffects: vi.fn(), execute: vi.fn().mockResolvedValue(undefined),
    } as unknown as ActionEngine;
    const audioPlayer = {
      play: vi.fn().mockResolvedValue(true), onEnded: vi.fn(),
      getDuration: vi.fn().mockReturnValue(3000), getCurrentTime: vi.fn().mockReturnValue(2500),
      pause: vi.fn(), resume: vi.fn(), stop: vi.fn(),
      isPlaying: vi.fn().mockReturnValue(true), hasActiveAudio: vi.fn().mockReturnValue(true),
    } as unknown as AudioPlayer;
    const scene = {
      id: 'lesson', stageId: 'stage', order: 0, title: 'Lesson', type: 'slide',
      content: { type: 'slide', elements: [] },
      actions: [{
        id: 'focus', type: 'spotlight', elementId: 'title', speechId: 'speech',
        speechAnchor: { quote: '标题' },
      }, {
        id: 'speech', type: 'speech', text: '先看标题。', audioUrl: '/speech.mp3',
        speechAlignment: {
          version: 'test', status: 'failed', textHash: 'text', audioHash: 'audio', language: 'zh',
          spans: [], error: 'alignment failed',
        },
      }] as Action[],
    } as unknown as Scene;
    const engine = new PlaybackEngine([scene], actionEngine, audioPlayer);

    engine.start();
    await vi.advanceTimersByTimeAsync(120);
    expect(actionEngine.execute).not.toHaveBeenCalled();
  });

  it('uses browser speech character boundaries when server alignment is unavailable', async () => {
    const actionEngine = {
      clearEffects: vi.fn(), execute: vi.fn().mockResolvedValue(undefined),
    } as unknown as ActionEngine;
    const speech = {
      id: 'speech', type: 'speech', text: '先看标题，再看数据。',
    } as Action;
    const focus = {
      id: 'focus', type: 'spotlight', elementId: 'title', speechId: 'speech',
      speechAnchor: { quote: '标题' },
    } as Action;
    const scene = {
      id: 'lesson', stageId: 'stage', order: 0, title: 'Lesson', type: 'slide',
      content: { type: 'slide', elements: [] }, actions: [focus, speech],
    } as unknown as Scene;
    const engine = new PlaybackEngine([scene], actionEngine, {} as AudioPlayer);
    const internals = engine as unknown as {
      sceneIndex: number;
      speechCuePoints: unknown[];
      buildSpeechCuePoints: (value: Action, durationMs: number, browserBoundary: boolean) => unknown[];
      reconcileSpeechCuesAtCharacter: (index: number) => void;
    };
    internals.sceneIndex = 0;
    internals.speechCuePoints = internals.buildSpeechCuePoints(speech, 3_000, true);

    internals.reconcileSpeechCuesAtCharacter(1);
    expect(actionEngine.execute).not.toHaveBeenCalled();
    internals.reconcileSpeechCuesAtCharacter(2);
    await vi.waitFor(() => expect(actionEngine.execute).toHaveBeenCalledWith(focus));
  });

  it('turns timed laser waypoints into separate audio-clock target changes', async () => {
    vi.useFakeTimers();
    let currentTime = 0;
    const actionEngine = {
      clearEffects: vi.fn(), execute: vi.fn().mockResolvedValue(undefined),
    } as unknown as ActionEngine;
    const audioPlayer = {
      play: vi.fn().mockResolvedValue(true), onEnded: vi.fn(),
      getDuration: vi.fn().mockReturnValue(3000), getCurrentTime: vi.fn(() => currentTime),
      pause: vi.fn(), resume: vi.fn(), stop: vi.fn(),
      isPlaying: vi.fn().mockReturnValue(true), hasActiveAudio: vi.fn().mockReturnValue(true),
    } as unknown as AudioPlayer;
    const scene = {
      id: 'lesson', stageId: 'stage', order: 0, title: 'Lesson', type: 'slide',
      content: { type: 'slide', elements: [] },
      actions: [{
        id: 'tour', type: 'laser', elementId: 'title', speechId: 'speech',
        speechAnchor: { quote: '标题' },
        waypoints: [{ elementId: 'chart', speechAnchor: { quote: '图表' } }],
      }, {
        id: 'speech', type: 'speech', text: '先看标题，再看图表。', audioUrl: '/speech.mp3',
        speechAlignment: {
          version: 'test', status: 'aligned', textHash: 'text', audioHash: 'audio', language: 'zh',
          spans: [
            { text: '先看', startChar: 0, endChar: 2, startMs: 0, endMs: 400 },
            { text: '标题', startChar: 2, endChar: 4, startMs: 400, endMs: 1000 },
            { text: '，再看', startChar: 4, endChar: 7, startMs: 1000, endMs: 1800 },
            { text: '图表', startChar: 7, endChar: 9, startMs: 1800, endMs: 2500 },
            { text: '。', startChar: 9, endChar: 10, startMs: 2500, endMs: 3000 },
          ],
        },
      }] as Action[],
    } as unknown as Scene;
    const engine = new PlaybackEngine([scene], actionEngine, audioPlayer);

    engine.start();
    currentTime = 400;
    await vi.advanceTimersByTimeAsync(40);
    expect(actionEngine.execute).toHaveBeenLastCalledWith(expect.objectContaining({
      elementId: 'title', waypoints: undefined,
    }));

    currentTime = 1800;
    await vi.advanceTimersByTimeAsync(40);
    expect(actionEngine.execute).toHaveBeenLastCalledWith(expect.objectContaining({
      elementId: 'chart', waypoints: undefined,
    }));
  });

  it('keeps each cross-sentence laser target active through its own spoken sentence', () => {
    const text = '先看标题。接着看图表。最后看结论。';
    const speech = {
      id: 'speech', type: 'speech', text, audioUrl: '/speech.mp3',
      speechAlignment: {
        version: 'test', status: 'aligned', textHash: 'text', audioHash: 'audio',
        spans: [...text].map((character, index) => ({
          text: character, startChar: index, endChar: index + 1,
          startMs: index * 100, endMs: (index + 1) * 100,
        })),
      },
    } as Action;
    const scene = {
      id: 'lesson', stageId: 'stage', order: 0, title: 'Lesson', type: 'slide',
      content: { type: 'slide', elements: [] },
      actions: [{
        id: 'path', type: 'laser', elementId: 'title', speechId: 'speech',
        speechAnchor: { quote: '标题' },
        waypoints: [
          { elementId: 'chart', speechAnchor: { quote: '图表' } },
          { elementId: 'conclusion', speechAnchor: { quote: '结论' } },
        ],
      }, speech] as Action[],
    } as unknown as Scene;
    const engine = new PlaybackEngine([scene], { clearEffects: vi.fn() } as unknown as ActionEngine, {} as AudioPlayer);
    const internals = engine as unknown as {
      buildSpeechCuePoints: (value: Action, durationMs: number) => Array<{
        action: Action; startMs: number; endMs: number;
      }>;
    };
    const points = internals.buildSpeechCuePoints(speech, text.length * 100);
    expect(points.map((point) => point.action.type === 'laser' ? point.action.elementId : '')).toEqual([
      'title', 'chart', 'conclusion',
    ]);
    expect(points.every((point) => point.endMs > point.startMs)).toBe(true);
    expect(points[1]!.endMs).toBeGreaterThan(text.indexOf('图表') * 100);
    expect(points[2]!.endMs).toBeGreaterThan(text.indexOf('结论') * 100);
  });

  it('does not start a visual cue by skipping an unaligned spoken word', () => {
    const text = '先看图表。';
    const speech = {
      id: 'speech', type: 'speech', text, audioUrl: '/speech.mp3',
      speechAlignment: {
        version: 'test', status: 'aligned', textHash: 'text', audioHash: 'audio',
        spans: [
          { text: '先看', startChar: 0, endChar: 2, startMs: 0, endMs: 400 },
          { text: '表。', startChar: 3, endChar: 5, startMs: 600, endMs: 1100 },
        ],
      },
    } as Action;
    const scene = {
      id: 'lesson', stageId: 'stage', order: 0, title: 'Lesson', type: 'slide',
      content: { type: 'slide', elements: [] },
      actions: [{ id: 'focus', type: 'spotlight', elementId: 'chart', speechId: 'speech',
        speechAnchor: { quote: '图表' } }, speech] as Action[],
    } as unknown as Scene;
    const engine = new PlaybackEngine([scene], { clearEffects: vi.fn() } as unknown as ActionEngine, {} as AudioPlayer);
    const internals = engine as unknown as { buildSpeechCuePoints: (value: Action, durationMs: number) => unknown[] };
    expect(internals.buildSpeechCuePoints(speech, 1100)).toEqual([]);
  });

  it('does not extend a cue across an unaligned spoken word before the sentence end', () => {
    const text = '先看图表。';
    const completeSpans = Array.from(text, (character, index) => ({
      text: character, startChar: index, endChar: index + 1,
      startMs: index * 100, endMs: (index + 1) * 100,
    }));
    const speech = {
      id: 'speech', type: 'speech', text, audioUrl: '/speech.mp3',
      speechAlignment: {
        version: 'test', status: 'aligned', textHash: 'text', audioHash: 'audio',
        spans: completeSpans.filter((span) => span.text !== '表'),
      },
    } as Action;
    const scene = {
      id: 'lesson', stageId: 'stage', order: 0, title: 'Lesson', type: 'slide',
      content: { type: 'slide', elements: [] },
      actions: [{ id: 'focus', type: 'spotlight', elementId: 'chart', speechId: 'speech',
        speechAnchor: { quote: '先看图' } }, speech] as Action[],
    } as unknown as Scene;
    const engine = new PlaybackEngine([scene], { clearEffects: vi.fn() } as unknown as ActionEngine, {} as AudioPlayer);
    const internals = engine as unknown as { buildSpeechCuePoints: (value: Action, durationMs: number) => unknown[] };
    expect(internals.buildSpeechCuePoints(speech, text.length * 100)).toEqual([]);
  });

  it('ignores an ended callback from audio replaced by a seek', async () => {
    const endedCallbacks: Array<() => void> = [];
    const onSpeechEnd = vi.fn();
    const actionEngine = {
      clearEffects: vi.fn(), restoreWhiteboard: vi.fn().mockResolvedValue(undefined),
    } as unknown as ActionEngine;
    const audioPlayer = {
      play: vi.fn().mockResolvedValue(true),
      onEnded: vi.fn((callback: () => void) => { endedCallbacks.push(callback); }),
      getDuration: vi.fn().mockReturnValue(3000), getCurrentTime: vi.fn().mockReturnValue(0),
      pause: vi.fn(), resume: vi.fn(), stop: vi.fn(),
      isPlaying: vi.fn().mockReturnValue(true), hasActiveAudio: vi.fn().mockReturnValue(true),
    } as unknown as AudioPlayer;
    const scene = {
      id: 'lesson', stageId: 'stage', order: 0, title: 'Lesson', type: 'slide',
      content: { type: 'slide', elements: [] },
      actions: [{
        id: 'speech', type: 'speech', text: '同一句讲解。', audioUrl: '/speech.mp3',
      }] as Action[],
    } as unknown as Scene;
    const engine = new PlaybackEngine([scene], actionEngine, audioPlayer, { onSpeechEnd });

    engine.start();
    await vi.waitFor(() => expect(endedCallbacks).toHaveLength(1));
    expect(engine.playSpeechAt(0, 0.5)).toBe(true);
    await vi.waitFor(() => expect(endedCallbacks).toHaveLength(2));

    endedCallbacks[0]?.();
    expect(onSpeechEnd).not.toHaveBeenCalled();
    endedCallbacks[1]?.();
    expect(onSpeechEnd).toHaveBeenCalledOnce();
  });
});
