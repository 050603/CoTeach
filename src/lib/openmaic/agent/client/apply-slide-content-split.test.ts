import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStageStore } from '@openmaic/lib/store/stage';
import { useCanvasStore } from '@openmaic/lib/store/canvas';
import { useSlideEditSession } from '@openmaic/components/edit/surfaces/slide/slide-edit-session';
import { regenerateSplitFixture } from './regenerate-split-fixture';
import { planRegenerateApply } from './apply-regenerate';
import { applySceneRangeInSync, persistRegenerateSceneRange } from './apply-slide-content';
import { fireEvent, render, screen } from '@testing-library/react';
import { RestoreButton } from '@openmaic/components/edit/AgentPanel/restore-button';
import { useRegenSnapshots } from './regen-snapshots';
import { createElement } from 'react';

const storage = vi.hoisted(() => ({
  putOutlines: vi.fn(async () => undefined),
  transaction: vi.fn(async (_mode: string, _tables: unknown[], run: () => Promise<void>) => run()),
  saveStage: vi.fn(async () => undefined),
  toast: vi.fn(),
}));
vi.mock('@openmaic/lib/utils/database', () => ({ db: {
  stages: { name: 'stages' }, scenes: { name: 'scenes' }, chatSessions: { name: 'chatSessions' },
  stageOutlines: { name: 'stageOutlines', put: storage.putOutlines }, transaction: storage.transaction,
} }));
vi.mock('@openmaic/lib/utils/stage-storage', () => ({ saveStageData: storage.saveStage }));
vi.mock('sonner', () => ({ toast: { error: storage.toast } }));
vi.mock('@openmaic/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

function fixture() {
  const data = regenerateSplitFixture();
  useStageStore.getState().setStage({ id: 'stage', name: '课堂', createdAt: 1, updatedAt: 1 });
  useStageStore.getState().setScenes(data.context.scenes);
  useStageStore.setState({ outlines: data.context.outlines, currentSceneId: data.scene.id, generationComplete: true });
  data.context.scenes = useStageStore.getState().scenes;
  const scene = useStageStore.getState().getSceneById(data.scene.id)!;
  data.context.requestScene = structuredClone(scene);
  data.details.visualRedesign!.before.content = structuredClone(scene.content);
  const plan = planRegenerateApply(data.details, scene, 'regenerate_scene', data.context);
  expect(plan.error).toBeUndefined();
  if (scene.content.type === 'slide') useSlideEditSession.getState().seed(scene.id, scene.content);
  return { ...data, plan, transaction: plan.sceneRange! };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useStageStore.getState().clearStore();
  useSlideEditSession.getState().end();
  useRegenSnapshots.getState().clearAll();
});
afterEach(async () => {
  await persistRegenerateSceneRange('stage');
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('split application and editor synchronization', () => {
  it('notifies once per apply/undo/redo and keeps the active edit history in sync', async () => {
    const { transaction } = fixture();
    const updates = vi.fn();
    const unsubscribe = useStageStore.subscribe(updates);
    expect(applySceneRangeInSync(transaction)).toBeUndefined();
    expect(updates).toHaveBeenCalledOnce();
    expect(useStageStore.getState().scenes).toHaveLength(4);
    expect(useStageStore.getState().generationComplete).toBe(true);
    expect(useSlideEditSession.getState().history?.present).toEqual(useStageStore.getState().getSceneById('original')?.content);
    expect(applySceneRangeInSync(transaction, 'undo')).toBeUndefined();
    expect(updates).toHaveBeenCalledTimes(2);
    expect(useStageStore.getState().scenes).toHaveLength(3);
    expect(useStageStore.getState().getSceneById('original')?.actions?.[0]).toHaveProperty('audioUrl', '/ready.wav');
    expect(applySceneRangeInSync(transaction, 'redo')).toBeUndefined();
    expect(updates).toHaveBeenCalledTimes(3);
    unsubscribe();
    await persistRegenerateSceneRange('stage');
    expect(storage.transaction).toHaveBeenLastCalledWith('rw', [
      expect.objectContaining({ name: 'stages' }), expect.objectContaining({ name: 'scenes' }),
      expect.objectContaining({ name: 'chatSessions' }), expect.objectContaining({ name: 'stageOutlines' }),
    ], expect.any(Function));
    expect(storage.saveStage).toHaveBeenLastCalledWith('stage', expect.objectContaining({ scenes: useStageStore.getState().scenes }));
    expect(storage.putOutlines).toHaveBeenLastCalledWith(expect.objectContaining({ outlines: useStageStore.getState().outlines, generationComplete: true }));
  });

  it('returns to the original page and closes its whiteboard when undo removes the selected sibling', () => {
    const { transaction } = fixture();
    applySceneRangeInSync(transaction);
    const sibling = useStageStore.getState().scenes[2];
    useStageStore.getState().setCurrentSceneId(sibling.id);
    if (sibling.content.type === 'slide') useSlideEditSession.getState().seed(sibling.id, sibling.content);
    useCanvasStore.getState().setWhiteboardOpen(true);
    expect(applySceneRangeInSync(transaction, 'undo')).toBeUndefined();
    expect(useStageStore.getState().currentSceneId).toBe('original');
    expect(useSlideEditSession.getState().sceneId).toBe('original');
    expect(useCanvasStore.getState().whiteboardOpen).toBe(false);
  });

  it('refuses undo after direct teacher editing of a generated component', () => {
    const { transaction } = fixture();
    applySceneRangeInSync(transaction);
    useSlideEditSession.getState().applyOp({ type: 'visual.setLocked', componentId: 'support', locked: true });
    const current = useStageStore.getState().scenes;
    expect(applySceneRangeInSync(transaction, 'undo')).toContain('已有后续修改');
    expect(useStageStore.getState().scenes).toBe(current);
    expect(useSlideEditSession.getState().history?.present.canvas.teachingVisual?.components[0].locked).toBe(true);
  });

  it('refuses a stale classroom transaction and a divergent live edit session', () => {
    const { transaction } = fixture();
    const present = useSlideEditSession.getState().history!.present;
    useSlideEditSession.setState({ history: { past: [], future: [], present: { ...present,
      canvas: { ...present.canvas, background: { type: 'solid', color: '#aaa' } } } } });
    expect(applySceneRangeInSync(transaction)).toContain('未同步的编辑');
    expect(useStageStore.getState().scenes).toHaveLength(3);
    useStageStore.setState({ stage: { id: 'other-classroom', name: '另一课程', createdAt: 1, updatedAt: 1 } });
    expect(applySceneRangeInSync(transaction)).toContain('当前课程已切换');
  });

  it('uses the real restore control for atomic undo/redo and shows an edit-conflict refusal', () => {
    const { transaction, plan } = fixture();
    applySceneRangeInSync(transaction);
    useRegenSnapshots.getState().setSnapshot('split-card', plan.snapshot!);
    render(createElement(RestoreButton, { toolCallId: 'split-card' }));
    fireEvent.click(screen.getByRole('button', { name: 'edit.regenScene.restore' }));
    expect(useStageStore.getState().scenes).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'edit.regenScene.resume' }));
    expect(useStageStore.getState().scenes).toHaveLength(4);
    useSlideEditSession.getState().applyOp({ type: 'visual.setLocked', componentId: 'support', locked: true });
    fireEvent.click(screen.getByRole('button', { name: 'edit.regenScene.restore' }));
    expect(useStageStore.getState().scenes).toHaveLength(4);
    expect(storage.toast).toHaveBeenCalledWith(expect.stringContaining('已有后续修改'));
    expect(useRegenSnapshots.getState().snapshots['split-card'].restored).toBe(false);
  });
});
