import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlideContent } from '@openmaic/lib/types/stage';
import { teachingVisualEditFixture } from '@openmaic/lib/edit/teaching-visual-edit-fixture';
import { useSlideEditSession } from './slide-edit-session';

const mocks = vi.hoisted(() => ({ recompose: vi.fn() }));
vi.mock('@openmaic/lib/edit/teaching-visual-recompose', () => ({ recomposeTeachingVisualSlide: mocks.recompose }));

import { recomposeCurrentTeachingVisual } from './use-teaching-visual-actions';

beforeEach(() => {
  vi.useFakeTimers();
  mocks.recompose.mockReset();
  useSlideEditSession.getState().seed('scene', teachingVisualEditFixture());
});
afterEach(() => {
  useSlideEditSession.getState().end();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function candidate(content: SlideContent): SlideContent {
  const next = structuredClone(content);
  next.canvas.elements[3].left = 500;
  next.canvas.teachingVisual!.candidateId = 'visual-2';
  return next;
}

describe('editor composition request boundary', () => {
  it('calls the measured compiler and commits one reversible layout action', async () => {
    mocks.recompose.mockImplementation(async (content: SlideContent) => candidate(content));
    const before = useSlideEditSession.getState().history!.present;
    expect(await recomposeCurrentTeachingVisual('evaluation')).toBe(true);
    expect(mocks.recompose).toHaveBeenCalledWith(before, { componentId: 'evaluation' });
    expect(useSlideEditSession.getState().history?.past).toHaveLength(1);
    expect(useSlideEditSession.getState().history?.present.canvas.teachingVisual?.components[1].modified).toBeUndefined();
    useSlideEditSession.getState().undo();
    expect(useSlideEditSession.getState().history?.present).toBe(before);
  });

  it('keeps newer teacher text if the asynchronous candidate finishes later', async () => {
    let started!: () => void;
    const measured = new Promise<void>((resolve) => { started = resolve; });
    let complete!: (content: SlideContent) => void;
    mocks.recompose.mockImplementation(async () => {
      started();
      return new Promise<SlideContent>((resolve) => { complete = resolve; });
    });
    const before = useSlideEditSession.getState().history!.present;
    const request = recomposeCurrentTeachingVisual('evaluation');
    await measured;
    useSlideEditSession.getState().applyOp({ type: 'text.updateContent', elementId: 'support-label', content: '<p>后来的修改</p>' });
    const latest = useSlideEditSession.getState().history!.present;
    complete(candidate(before));
    expect(await request).toBe(false);
    expect(useSlideEditSession.getState().history?.present).toBe(latest);
  });

  it('does not apply a result to a different open scene', async () => {
    const original = useSlideEditSession.getState().history!.present;
    mocks.recompose.mockImplementation(async () => {
      useSlideEditSession.getState().seed('another-scene', teachingVisualEditFixture());
      return candidate(original);
    });
    expect(await recomposeCurrentTeachingVisual('evaluation')).toBe(false);
    expect(useSlideEditSession.getState().sceneId).toBe('another-scene');
    expect(useSlideEditSession.getState().history?.past).toHaveLength(0);
  });

  it('does not compile a locked local target', async () => {
    useSlideEditSession.getState().applyOp({ type: 'visual.setLocked', componentId: 'support', locked: true });
    expect(await recomposeCurrentTeachingVisual('support')).toBe(false);
    expect(mocks.recompose).not.toHaveBeenCalled();
  });
});
