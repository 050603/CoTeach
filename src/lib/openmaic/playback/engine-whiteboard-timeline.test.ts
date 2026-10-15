import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Action, SpeechAction, WhiteboardAction } from '../types/action';
import type { Scene } from '../types/stage';
import type { ActionEngine } from '../action/engine';
import type { AudioPlayer } from '../utils/audio-player';
import { useCanvasStore } from '../store/canvas';
import { PlaybackEngine } from './engine';
import { compileWhiteboardDiagram } from '../whiteboard/diagram';
import { projectWhiteboardActions } from '../whiteboard/projection';

function speech(id: string, text: string): SpeechAction {
  return { id, type: 'speech', text, audioUrl: `/${id}.wav`, audioDurationSec: text.length / 10,
    speechAlignment: { status: 'aligned', version: 'test', textHash: '', audioHash: '',
      spans: Array.from(text, (char, index) => ({ text: char, startChar: index, endChar: index + 1,
        startMs: index * 100, endMs: (index + 1) * 100 })) } };
}

function harness(actions: Action[]) {
  let mediaMs = 0;
  let ended: (() => void) | undefined;
  const batches: WhiteboardAction[][] = [];
  const actionEngine = {
    clearEffects: vi.fn(), execute: vi.fn().mockResolvedValue(undefined),
    restoreWhiteboard: vi.fn().mockImplementation(async () => useCanvasStore.getState().setWhiteboardOpen(false)),
    executeWhiteboardTimeline: vi.fn((batch: WhiteboardAction[]) => {
      batches.push(batch);
      for (const action of batch) useCanvasStore.getState().setWhiteboardOpen(action.type !== 'wb_close');
    }),
  } as unknown as ActionEngine;
  const audioPlayer = {
    play: vi.fn().mockResolvedValue(true), stop: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    isPlaying: vi.fn().mockReturnValue(true), hasActiveAudio: vi.fn().mockReturnValue(true),
    getCurrentTime: () => mediaMs, getDuration: () => 10_000,
    onEnded: (callback: () => void) => { ended = callback; },
  } as unknown as AudioPlayer;
  const scene = { id: 'page', stageId: 'stage', type: 'slide', title: 'Lesson', order: 0,
    content: { type: 'slide', canvas: { elements: [] } }, actions } as unknown as Scene;
  const onError = vi.fn();
  const engine = new PlaybackEngine([scene], actionEngine, audioPlayer, { onError });
  return { engine, actionEngine, audioPlayer, onError, batches, setMediaMs: (ms: number) => { mediaMs = ms; }, end: () => ended?.() };
}

const bound = (id: string, quote: string, type: 'wb_open' | 'wb_clear' | 'wb_close' = 'wb_open', speechId = 's1'): WhiteboardAction => ({
  id, type, speechId, speechAnchor: { quote },
});
const note = (id: string, quote: string, speechId = 's1'): WhiteboardAction => ({
  id, type: 'wb_draw_text', elementId: id, content: id, x: 40, y: 100, fontSize: 24,
  speechId, speechAnchor: { quote },
});

afterEach(() => { vi.useRealTimers(); useCanvasStore.getState().setWhiteboardOpen(false); });

describe('speech anchored whiteboard playback', () => {
  it('restores a constructed diagram and its moving marks without future nodes or connectors', async () => {
    vi.useFakeTimers();
    const binding = (quote: string) => ({ speechId: 's1', speechAnchor: { quote } });
    const compiled = compileWhiteboardDiagram({ id: 'diagram', title: '分析依据',
      diagram: { panels: [{ key: 'panel', kind: 'branches', nodes: [
        { key: 'learner', label: '学习者', role: 'focus', icon: 'person' },
        { key: 'knowledge', label: '已有知识', icon: 'book' },
      ], relations: [{ key: 'branch', from: 'learner', to: 'knowledge', kind: 'branch' }] }] },
      steps: [{ reveal: ['learner'], emphasize: ['learner'], ...binding('前期') },
        { reveal: ['knowledge', 'branch'], emphasize: ['knowledge'], ...binding('已有知识') }],
      exit: binding('实施') });
    expect(compiled.issues).toEqual([]);
    const events = compiled.actions;
    const h = harness([...events, speech('s1', '前期分析，已有知识，实施阶段。')]);
    h.engine.start();
    await vi.advanceTimersByTimeAsync(0);
    const before = projectWhiteboardActions(h.batches.flat());
    expect(before.some((element) => element.type === 'text' && element.content.includes('学习者'))).toBe(true);
    expect(before.some((element) => element.type === 'text' && element.content.includes('已有知识'))).toBe(false);
    expect(before.some((element) => element.type === 'line')).toBe(false);
    h.setMediaMs(600);
    await vi.advanceTimersByTimeAsync(40);
    const after = projectWhiteboardActions(h.batches.flat());
    expect(after.some((element) => element.type === 'line')).toBe(true);
    expect(after.some((element) => element.type === 'text' && element.content.includes('已有知识'))).toBe(true);
    const firstMarks = before.filter((element) => element.type === 'image').map((element) => element.id);
    expect(firstMarks.some((id) => !after.some((element) => element.id === id))).toBe(true);
    const speechIndex = events.length;
    h.engine.playSpeechAt(speechIndex, 0.2);
    await vi.advanceTimersByTimeAsync(0);
    const restore = vi.mocked(h.actionEngine.restoreWhiteboard).mock.calls.at(-1)![0];
    expect(projectWhiteboardActions(restore)).toEqual(before);
    h.engine.stop();
  });

  it('reveals at real media positions, preserves same-anchor order, and freezes during pause', async () => {
    vi.useFakeTimers();
    const events = [bound('open', '前期'), bound('clear', '前期', 'wb_clear'), note('first', '前期'),
      note('second', '目标'), bound('close', '实施', 'wb_close')];
    const h = harness([...events, speech('s1', '前期分析，目标分析，实施阶段。')]);
    h.engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.batches.flat().map((action) => action.id)).toEqual(['open', 'clear', 'first']);
    expect(h.actionEngine.execute).not.toHaveBeenCalled();
    h.engine.pause();
    h.setMediaMs(600);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.batches).toHaveLength(1);
    h.engine.resume();
    expect(h.batches.flat().map((action) => action.id)).toEqual(['open', 'clear', 'first', 'second']);
    h.setMediaMs(1000); // media jumps, e.g. faster playback, without an estimated wall timer
    await vi.advanceTimersByTimeAsync(40);
    expect(h.batches.flat().map((action) => action.id)).toEqual(['open', 'clear', 'first', 'second', 'close']);
    expect(useCanvasStore.getState().whiteboardOpen).toBe(false);
    h.engine.stop();
  });

  it('restores only elapsed board content when seeking within or across speeches', async () => {
    vi.useFakeTimers();
    const events = [bound('open', '前期'), note('first', '前期'), note('later', '目标'),
      bound('clear2', '评价', 'wb_clear', 's2'), note('evaluation', '评价', 's2'), note('future', '后续', 's2')];
    const h = harness([...events, speech('s1', '前期分析，目标分析。'), speech('s2', '评价要求，后续内容。')]);
    expect(h.engine.playSpeechAt(6, 0.2)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.actionEngine.restoreWhiteboard).toHaveBeenLastCalledWith(events.slice(0, 2));
    expect(h.engine.playSpeechAt(7, 0.2)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.actionEngine.restoreWhiteboard).toHaveBeenLastCalledWith(events.slice(0, 5));
    expect(h.engine.playSpeechAt(6, 0)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.actionEngine.restoreWhiteboard).toHaveBeenLastCalledWith(events.slice(0, 2));
    h.engine.stop();
  });

  it('cancels future work on stop and omits anchors lacking real alignment', async () => {
    vi.useFakeTimers();
    const s = speech('s1', '前期分析，目标分析。');
    const h = harness([note('missing-phrase', '不存在'), note('next', '目标'), s]);
    h.engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.batches).toHaveLength(0);
    h.engine.stop();
    h.setMediaMs(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.batches).toHaveLength(0);
    const noAlignment = harness([note('first', '前期'), { ...s, speechAlignment: undefined }]);
    noAlignment.engine.start();
    await vi.advanceTimersByTimeAsync(0);
    noAlignment.setMediaMs(1000);
    await vi.advanceTimersByTimeAsync(80);
    expect(noAlignment.batches).toHaveLength(0);
    noAlignment.engine.stop();
  });

  it('hides PPT effects while the board is open and returns to PPT at the exit anchor', async () => {
    vi.useFakeTimers();
    const h = harness([bound('open', '前期'), note('first', '前期'), bound('close', '实施', 'wb_close'),
      { id: 'focus', type: 'spotlight', elementId: 'implementation', speechId: 's1', speechAnchor: { quote: '实施' } },
      speech('s1', '前期分析，实施阶段。')]);
    h.engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.actionEngine.execute).not.toHaveBeenCalled();
    h.setMediaMs(500);
    await vi.advanceTimersByTimeAsync(40);
    expect(h.actionEngine.execute).toHaveBeenCalledWith(expect.objectContaining({ id: 'focus' }));
    h.engine.stop();
  });

  it('ignores a stale audio-load result after seeking to the same paragraph', async () => {
    vi.useFakeTimers();
    const h = harness([bound('open', '前期'), note('first', '前期'), speech('s1', '前期分析，目标分析。')]);
    let resolveFirst!: (started: boolean) => void;
    vi.mocked(h.audioPlayer.play).mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveFirst = resolve; }));
    h.engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.audioPlayer.play).toHaveBeenCalledTimes(1);
    h.engine.playSpeechAt(2, 0.5);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.audioPlayer.play).toHaveBeenCalledTimes(2);
    resolveFirst(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.engine.getMode()).toBe('playing');
    expect(h.onError).not.toHaveBeenCalled();
    h.engine.stop();
  });

  it('keeps the restored board while a subtitle load is paused and resumed before audio is ready', async () => {
    vi.useFakeTimers();
    const h = harness([bound('open', '前期'), note('first', '前期'), note('later', '目标'),
      speech('s1', '前期分析，目标分析。')]);
    let resolveLoad!: (started: boolean) => void;
    vi.mocked(h.audioPlayer.play).mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveLoad = resolve; }));
    vi.mocked(h.audioPlayer.isPlaying).mockReturnValue(false);
    h.engine.playSpeechAt(3, 0.6);
    await vi.advanceTimersByTimeAsync(0);
    h.engine.pause();
    expect(h.audioPlayer.pause).toHaveBeenCalled();
    h.engine.resume();
    await vi.advanceTimersByTimeAsync(80);
    expect(h.batches).toHaveLength(0);

    h.setMediaMs(600);
    vi.mocked(h.audioPlayer.isPlaying).mockReturnValue(true);
    resolveLoad(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.batches.flat().map((action) => action.id)).toEqual(['open', 'first', 'later']);
    h.engine.stop();
  });
});
