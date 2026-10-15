import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageStore } from '@openmaic/lib/api/stage-api-types';
import { whiteboardIdForScene } from '@openmaic/lib/api/stage-api-whiteboard';
import { useCanvasStore } from '@openmaic/lib/store/canvas';
import { getWhiteboardPageId, useWhiteboardPagesStore } from '@openmaic/lib/store/whiteboard-pages';
import { useWhiteboardHistoryStore } from '@openmaic/lib/store/whiteboard-history';
import type { Action, WbDrawImageAction, WhiteboardAction } from '@openmaic/lib/types/action';
import { ActionEngine } from './engine';

const image: WbDrawImageAction = {
  id: 'show-diagram',
  type: 'wb_draw_image',
  elementId: 'diagram',
  src: '/api/openmaic/classroom-media/lesson/media/diagram.png',
  x: 80,
  y: 100,
  width: 500,
  height: 300,
};

function createStore(): StageStore {
  let state: ReturnType<StageStore['getState']> = {
    stage: { id: 'lesson', name: '课堂', createdAt: 1, updatedAt: 1, whiteboard: [] },
    scenes: [],
    currentSceneId: 'scene-1',
    mode: 'playback',
  };
  return {
    getState: () => state,
    setState: (partial) => { state = { ...state, ...partial }; },
    subscribe: () => () => undefined,
  };
}

beforeEach(() => {
  useWhiteboardPagesStore.setState({ pages: [], activePageKeys: {}, activeStageId: null,
    reviewPageId: null, reviewStageId: null });
  useWhiteboardHistoryStore.getState().clearHistory();
});

afterEach(() => {
  vi.useRealTimers();
  useCanvasStore.getState().setWhiteboardOpen(false);
});

describe('whiteboard teaching-page retention', () => {
  const title = (id: string, content: string): WhiteboardAction => ({ id, type: 'wb_draw_text',
    elementId: id, content, x: 40, y: 40, fontSize: 30 });
  const firstPage: WhiteboardAction[] = [{ id: 'open', type: 'wb_open' }, { id: 'clear-a', type: 'wb_clear' },
    title('title-a', '前期分析'), image];
  const secondPage: WhiteboardAction[] = [{ id: 'clear-b', type: 'wb_clear' }, title('title-b', '核心要素'),
    { ...image, id: 'second-image', elementId: 'second-image' }];

  it('saves nonempty pages before timed clear and close, without adding animation waits or undo snapshots', () => {
    vi.useFakeTimers();
    const store = createStore();
    const engine = new ActionEngine(store);
    engine.executeWhiteboardTimeline([...firstPage, ...secondPage, { id: 'close', type: 'wb_close' }]);
    const pages = useWhiteboardPagesStore.getState().pages;
    expect(pages.map((page) => [page.pageKey, page.title, page.completed])).toEqual([
      ['clear-a', '前期分析', true], ['clear-b', '核心要素', true],
    ]);
    expect(pages[0].elements.map((element) => element.id)).toEqual(['title-a', 'diagram']);
    expect(pages[1].elements.map((element) => element.id)).toEqual(['title-b', 'second-image']);
    expect(vi.getTimerCount()).toBe(0);
    expect(useWhiteboardHistoryStore.getState().snapshots).toEqual([]);
    engine.dispose();
  });

  it('preserves legacy clear and close pages while keeping their existing animations and undo behavior', async () => {
    vi.useFakeTimers();
    const store = createStore();
    const engine = new ActionEngine(store);
    const writing = engine.execute(image);
    await vi.runAllTimersAsync();
    await writing;
    const clearing = engine.execute({ id: 'legacy-clear', type: 'wb_clear' });
    await vi.advanceTimersByTimeAsync(0);
    expect(useWhiteboardPagesStore.getState().pages).toHaveLength(1);
    expect(store.getState().stage?.whiteboard?.[0].elements).toHaveLength(1);
    await vi.runAllTimersAsync();
    await clearing;
    expect(store.getState().stage?.whiteboard?.[0].elements).toEqual([]);
    expect(useWhiteboardHistoryStore.getState().snapshots).toHaveLength(1);
    const nextWriting = engine.execute({ ...image, id: 'later', elementId: 'later' });
    await vi.runAllTimersAsync();
    await nextWriting;
    const closing = engine.execute({ id: 'legacy-close', type: 'wb_close' });
    await vi.runAllTimersAsync();
    await closing;
    expect(useWhiteboardPagesStore.getState().pages.map((page) => page.pageKey)).toEqual(['show-diagram', 'legacy-clear']);
    expect(useWhiteboardPagesStore.getState().pages.every((page) => page.completed)).toBe(true);
    engine.dispose();
  });

  it('rebuilds completed earlier pages without duplicating them or marking the current cutoff as complete', async () => {
    const store = createStore();
    const engine = new ActionEngine(store);
    await engine.restoreWhiteboard([...firstPage, ...secondPage.slice(0, 2)]);
    const pages = useWhiteboardPagesStore.getState();
    const completeA = pages.pages[0];
    expect(completeA).toMatchObject({ pageKey: 'clear-a', completed: true });
    expect(completeA.elements).toHaveLength(2);
    expect(pages.pages).toHaveLength(1);
    expect(pages.getCurrentPageKey('lesson', 'scene-1')).toBe('clear-b');
    await engine.restoreWhiteboard(firstPage.slice(0, 3));
    expect(useWhiteboardPagesStore.getState().pages.find((page) => page.pageKey === 'clear-a')).toBe(completeA);
    expect(useWhiteboardPagesStore.getState().pages.find((page) => page.pageKey === 'clear-b')).toMatchObject({ completed: false });
    expect(store.getState().stage?.whiteboard?.[0].elements.map((element) => element.id)).toEqual(['title-a']);
    expect(pages.getCurrentPageKey('lesson', 'scene-1')).toBe('clear-a');
    await engine.restoreWhiteboard([...firstPage, ...secondPage, { id: 'close', type: 'wb_close' }]);
    await engine.restoreWhiteboard([...firstPage, ...secondPage, { id: 'close', type: 'wb_close' }]);
    expect(useWhiteboardPagesStore.getState().pages).toHaveLength(2);
    expect(useWhiteboardPagesStore.getState().pages.every((page) => page.completed)).toBe(true);
    expect(useWhiteboardPagesStore.getState().pages.find((page) => page.pageKey === 'clear-a')?.elements).toHaveLength(2);
    engine.dispose();
  });

  it('keeps the student review separate while live writing, clearing and closing continue', () => {
    const store = createStore();
    const engine = new ActionEngine(store);
    engine.executeWhiteboardTimeline([...firstPage, { id: 'close-a', type: 'wb_close' }]);
    const pages = useWhiteboardPagesStore.getState();
    const id = getWhiteboardPageId('lesson', 'scene-1', 'clear-a');
    expect(pages.reviewPage(id)).toBe(true);
    const retained = useWhiteboardPagesStore.getState().pages[0];
    engine.executeWhiteboardTimeline([...secondPage, { id: 'close-b', type: 'wb_close' }]);
    expect(useWhiteboardPagesStore.getState()).toMatchObject({ reviewPageId: id, reviewStageId: 'lesson' });
    expect(useWhiteboardPagesStore.getState().pages[0]).toBe(retained);
    expect(store.getState().stage?.whiteboard?.[0].elements.map((element) => element.id)).toEqual(['title-b', 'second-image']);
    pages.returnToLive();
    expect(store.getState().stage?.whiteboard?.[0].elements.map((element) => element.id)).toEqual(['title-b', 'second-image']);
    engine.dispose();
  });

  it('does not let a prior animated clear erase a newly restored current page', async () => {
    vi.useFakeTimers();
    const store = createStore();
    const engine = new ActionEngine(store);
    engine.executeWhiteboardTimeline(firstPage);
    const clearing = engine.execute({ id: 'old-animated-clear', type: 'wb_clear' });
    await vi.advanceTimersByTimeAsync(0);
    await engine.restoreWhiteboard(secondPage);
    await vi.runAllTimersAsync();
    await clearing;
    expect(store.getState().stage?.whiteboard?.[0].elements.map((element) => element.id)).toEqual(['title-b', 'second-image']);
    expect(useWhiteboardPagesStore.getState().getCurrentPageKey('lesson', 'scene-1')).toBe('clear-b');
    expect(useCanvasStore.getState().whiteboardClearing).toBe(false);
    engine.dispose();
  });
});

describe('whiteboard image execution', () => {
  it('applies speech-clock batches without animation waits or stale clears', () => {
    vi.useFakeTimers();
    const store = createStore();
    const engine = new ActionEngine(store);
    const batch: WhiteboardAction[] = [{ id: 'open', type: 'wb_open' }, image,
      { id: 'clear', type: 'wb_clear' }, { ...image, id: 'new-image', elementId: 'latest' }];
    engine.executeWhiteboardTimeline(batch);
    expect(vi.getTimerCount()).toBe(0);
    expect(store.getState().stage?.whiteboard?.[0].elements.map((element) => element.id)).toEqual(['latest']);
    expect(useCanvasStore.getState().whiteboardOpen).toBe(true);
    engine.executeWhiteboardTimeline([{ id: 'close', type: 'wb_close' }]);
    expect(useCanvasStore.getState().whiteboardOpen).toBe(false);
    engine.dispose();
  });

  it('opens the board and creates a renderable image in the current scene', async () => {
    vi.useFakeTimers();
    const store = createStore();
    const engine = new ActionEngine(store);
    const execution = engine.execute(image);
    await vi.runAllTimersAsync();
    await execution;

    expect(useCanvasStore.getState().whiteboardOpen).toBe(true);
    expect(store.getState().stage?.whiteboard).toEqual([
      expect.objectContaining({
        id: whiteboardIdForScene('scene-1'),
        elements: [expect.objectContaining({
          id: 'diagram', type: 'image', src: image.src,
          left: 80, top: 100, width: 500, height: 300, rotate: 0, fixedRatio: true,
        })],
      }),
    ]);
    engine.dispose();
  });

  it('restores each image once and applies later deletion without changing another scene', async () => {
    const store = createStore();
    const engine = new ActionEngine(store);
    const actions: Action[] = [image, { id: 'explain', type: 'speech', text: '观察这张图。' }];
    await engine.restoreWhiteboard(actions);
    await engine.restoreWhiteboard(actions);
    expect(store.getState().stage?.whiteboard?.[0].elements).toHaveLength(1);

    store.setState({ currentSceneId: 'scene-2' });
    await engine.restoreWhiteboard([image, { id: 'delete', type: 'wb_delete', elementId: 'diagram' }]);
    const boards = store.getState().stage?.whiteboard;
    expect(boards?.find((board) => board.id === whiteboardIdForScene('scene-1'))?.elements).toHaveLength(1);
    expect(boards?.find((board) => board.id === whiteboardIdForScene('scene-2'))?.elements).toEqual([]);
    engine.dispose();
  });
});
