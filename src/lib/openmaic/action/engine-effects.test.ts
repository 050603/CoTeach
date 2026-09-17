import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageStore } from '@openmaic/lib/api/stage-api-types';
import { useCanvasStore } from '@openmaic/lib/store/canvas';
import { ActionEngine } from './engine';

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

describe('ActionEngine visual cue lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useCanvasStore.getState().clearAllEffects();
  });

  afterEach(() => {
    vi.useRealTimers();
    useCanvasStore.getState().clearAllEffects();
  });

  it('keeps a spotlight active for narration and preserves its fine-grained selector', async () => {
    const engine = new ActionEngine(createStore());
    await engine.execute({
      id: 'focus',
      type: 'spotlight',
      elementId: 'table',
      selector: { cellId: 'r3c2' },
      speechId: 'speech-1',
    });

    expect(useCanvasStore.getState()).toMatchObject({
      spotlightElementId: 'table',
      laserElementId: '',
      spotlightOptions: { selector: { cellId: 'r3c2' } },
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(useCanvasStore.getState().spotlightElementId).toBe('table');
    engine.dispose();
  });

  it('pauses and resumes the remaining laser lifetime without stale timers clearing a newer cue', async () => {
    const engine = new ActionEngine(createStore());
    await engine.execute({
      id: 'point',
      type: 'laser',
      elementId: 'table',
      selector: { cellId: 'r2c3' },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    engine.pauseEffects();
    expect(useCanvasStore.getState().laserElementId).toBe('');

    await vi.advanceTimersByTimeAsync(10_000);
    engine.resumeEffects();
    expect(useCanvasStore.getState().laserElementId).toBe('table');
    await vi.advanceTimersByTimeAsync(1_499);
    expect(useCanvasStore.getState().laserElementId).toBe('table');

    await engine.execute({ id: 'focus', type: 'spotlight', elementId: 'summary' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useCanvasStore.getState()).toMatchObject({
      spotlightElementId: 'summary',
      laserElementId: '',
    });
    engine.dispose();
  });
});
