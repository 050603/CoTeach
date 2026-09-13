import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StageStore } from '@openmaic/lib/api/stage-api-types';
import { whiteboardIdForScene } from '@openmaic/lib/api/stage-api-whiteboard';
import { useCanvasStore } from '@openmaic/lib/store/canvas';
import type { Action, WbDrawImageAction } from '@openmaic/lib/types/action';
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

afterEach(() => {
  vi.useRealTimers();
  useCanvasStore.getState().setWhiteboardOpen(false);
});

describe('whiteboard image execution', () => {
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
