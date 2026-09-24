import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStageStore } from './stage';
import { useCanvasStore } from './canvas';
import { createBlankSlideScene } from '@openmaic/lib/edit/slide-defaults';
import { useDeletedSceneRecycle } from '@openmaic/lib/edit/deleted-scene-recycle';

beforeEach(() => {
  vi.useFakeTimers();
  useStageStore.getState().clearStore();
  useStageStore.getState().setStage({ id: 'c1', name: '课堂', createdAt: 1, updatedAt: 1 });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('scene editing order and identity', () => {
  it('keeps zero-based order and stamped narration after insertion and reorder', () => {
    const first = createBlankSlideScene('c1', '第一', 0);
    const second = createBlankSlideScene('c1', '第二', 1);
    second.actions = [{ id: 'speech-2', type: 'speech', text: '第二页', audioId: 'tts_s1_speech-2', audioUrl: '/second.wav' }];
    const inserted = createBlankSlideScene('c1', '插入', 1);
    useStageStore.getState().setScenes([first, second]);
    useStageStore.getState().setCurrentSceneId(second.id);
    useStageStore.getState().insertSceneAfter(first.id, inserted);
    expect(useStageStore.getState().scenes.map((scene) => scene.order)).toEqual([0, 1, 2]);
    const live = useStageStore.getState().scenes;
    useStageStore.getState().setScenes([live[2], live[0], live[1]]);
    expect(useStageStore.getState().scenes.map((scene) => scene.order)).toEqual([0, 1, 2]);
    expect(useStageStore.getState().currentSceneId).toBe(second.id);
    expect(useStageStore.getState().scenes[0].actions).toEqual(second.actions);
  });

  it('rebalances deletion and restoring the first scene without losing action ids', () => {
    const first = createBlankSlideScene('c1', '第一', 0);
    first.actions = [{ id: 'speech-1', type: 'speech', text: '保留讲稿' }];
    const second = createBlankSlideScene('c1', '第二', 1);
    useStageStore.getState().setScenes([first, second]);
    useDeletedSceneRecycle.getState().capture(first, 0);
    useStageStore.getState().deleteScene(first.id);
    expect(useStageStore.getState().scenes.map((scene) => scene.order)).toEqual([0]);
    expect(useStageStore.getState().currentSceneId).toBe(second.id);
    const entry = useDeletedSceneRecycle.getState().consume()!;
    useStageStore.getState().setScenes([entry.scene, ...useStageStore.getState().scenes]);
    expect(useStageStore.getState().scenes.map((scene) => scene.order)).toEqual([0, 1]);
    expect(useStageStore.getState().scenes[0].actions).toEqual(first.actions);
  });

  it('selects a valid page when a replaced scene list omits the current one', () => {
    const first = createBlankSlideScene('c1', '第一', 0);
    const second = createBlankSlideScene('c1', '第二', 1);
    useStageStore.getState().setScenes([first, second]);
    useStageStore.getState().setScenes([second]);
    expect(useStageStore.getState().currentSceneId).toBe(second.id);
    useStageStore.getState().setScenes([]);
    expect(useStageStore.getState().currentSceneId).toBeNull();
  });
});


describe('whiteboard page isolation', () => {
  it('closes a paused board on page navigation but preserves it for same-page media updates', () => {
    const first = createBlankSlideScene('c1', '第一', 0);
    const second = createBlankSlideScene('c1', '第二', 1);
    useStageStore.getState().setScenes([first, second]);
    useStageStore.getState().setCurrentSceneId(first.id);
    useCanvasStore.getState().setWhiteboardOpen(true);
    useStageStore.getState().setScenes([{ ...first, actions: [{ id: 'audio', type: 'speech', text: '讲解', audioUrl: '/ready.wav' }] }, second]);
    useStageStore.getState().setCurrentSceneId(first.id);
    expect(useCanvasStore.getState().whiteboardOpen).toBe(true);
    useStageStore.getState().setCurrentSceneId(second.id);
    expect(useCanvasStore.getState().whiteboardOpen).toBe(false);
  });

  it('closes the board if replacing pages removes the selected page', () => {
    const first = createBlankSlideScene('c1', '第一', 0);
    const second = createBlankSlideScene('c1', '第二', 1);
    useStageStore.getState().setScenes([first, second]);
    useCanvasStore.getState().setWhiteboardOpen(true);
    useStageStore.getState().setScenes([second]);
    expect(useCanvasStore.getState().whiteboardOpen).toBe(false);
  });
});
