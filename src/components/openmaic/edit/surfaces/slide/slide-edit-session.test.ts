import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStageStore } from '@openmaic/lib/store/stage';
import { teachingVisualEditFixture } from '@openmaic/lib/edit/teaching-visual-edit-fixture';
import type { SlideContent } from '@openmaic/lib/types/stage';
import { createBlankSlideScene } from '@openmaic/lib/edit/slide-defaults';
import { useSlideEditSession } from './slide-edit-session';

beforeEach(() => {
  vi.useFakeTimers();
  useStageStore.getState().clearStore();
  useStageStore.getState().setStage({ id: 'stage', name: '课堂', createdAt: 1, updatedAt: 1 });
  const scene = createBlankSlideScene('stage', '支持与评价', 0);
  scene.id = 'scene';
  scene.content = teachingVisualEditFixture();
  useStageStore.getState().setScenes([scene]);
  useSlideEditSession.getState().seed('scene', scene.content as SlideContent);
});

afterEach(() => {
  useSlideEditSession.getState().end();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function savedContent(): SlideContent {
  return useStageStore.getState().getSceneById('scene')!.content as SlideContent;
}

describe('visual edit session persistence and async composition', () => {
  it('records debounced keyboard edits while auto-height remains outside undo', () => {
    const session = useSlideEditSession.getState();
    const normalized = structuredClone(session.history!.present);
    const normalizedLabel = normalized.canvas.elements[1];
    if (normalizedLabel.type !== 'text') throw new Error('Expected the editable text label');
    normalizedLabel.height += 15;
    session.commitContent(normalized, false);
    expect(useSlideEditSession.getState().history?.past).toHaveLength(0);
    expect(savedContent().canvas.teachingVisual?.components[0].modified).toBeUndefined();
    const typed = structuredClone(useSlideEditSession.getState().history!.present);
    const label = typed.canvas.elements[1];
    if (label.type === 'text') label.content = '<p>独立解决问题时撤离</p>';
    session.commitContent(typed, false);
    expect(savedContent().canvas.teachingVisual?.components[0].modified).toBe(true);
    expect(useSlideEditSession.getState().history?.past).toHaveLength(1);
    session.undo();
    expect(savedContent().canvas.teachingVisual?.components[0].modified).toBeUndefined();
    expect(savedContent().canvas.elements[1]).toMatchObject({ height: normalizedLabel.height });
    session.redo();
    expect(savedContent().canvas.elements[1]).toEqual(typed.canvas.elements[1]);
    expect(savedContent().canvas.teachingVisual?.components[0].modified).toBe(true);
  });

  it('writes locks through to saved scenes and restores them with undo and redo', () => {
    const session = useSlideEditSession.getState();
    session.applyOp({ type: 'visual.setLocked', componentId: 'support', locked: true });
    expect(savedContent().canvas.teachingVisual?.components[0].locked).toBe(true);
    session.undo();
    expect(savedContent().canvas.teachingVisual?.components[0].locked).toBeUndefined();
    session.redo();
    expect(savedContent().canvas.teachingVisual?.components[0].locked).toBe(true);
  });

  it('applies composition as one reversible action without claiming it as a manual edit', () => {
    const session = useSlideEditSession.getState();
    session.applyOp({ type: 'visual.setLocked', componentId: 'support', locked: true });
    const expected = useSlideEditSession.getState().history!.present;
    const next = structuredClone(expected);
    next.canvas.elements[1].left = 300;
    next.canvas.elements[3].left = 500;
    next.canvas.teachingVisual!.candidateId = 'focus-stacked';
    expect(session.commitComposition(expected, next)).toBe(true);
    expect(savedContent().canvas.elements[1].left).toBe(expected.canvas.elements[1].left);
    expect(savedContent().canvas.elements[3].left).toBe(500);
    expect(savedContent().canvas.teachingVisual?.components[1].modified).toBeUndefined();
    session.undo();
    expect(savedContent()).toEqual(expected);
    session.redo();
    expect(savedContent().canvas.elements[3].left).toBe(500);
  });

  it('rejects a layout result after any newer teacher edit', () => {
    const session = useSlideEditSession.getState();
    const expected = session.history!.present;
    const next = structuredClone(expected);
    next.canvas.elements[3].left = 500;
    session.applyOp({ type: 'text.updateContent', elementId: 'support-label', content: '<p>最新教师修改</p>' });
    const latest = savedContent();
    expect(session.commitComposition(expected, next)).toBe(false);
    expect(savedContent()).toBe(latest);
    expect(useSlideEditSession.getState().history?.past).toHaveLength(1);
  });

  it('owns the accepted compiler snapshot independently of its caller', () => {
    const session = useSlideEditSession.getState();
    const expected = session.history!.present;
    const next = structuredClone(expected);
    next.canvas.elements[3].left = 500;
    expect(session.commitComposition(expected, next)).toBe(true);
    next.canvas.elements[3].left = 800;
    expect(savedContent().canvas.elements[3].left).toBe(500);
  });
});
