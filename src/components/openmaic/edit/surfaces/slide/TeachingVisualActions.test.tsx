import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => ({ recompose: vi.fn() }));
vi.mock('./use-slide-surface', async () => {
  const { useSlideEditSession } = await import('./slide-edit-session');
  return { useResolvedSlideContent: () => useSlideEditSession((state) => state.history!.present) };
});
vi.mock('./use-teaching-visual-actions', () => ({
  useTeachingVisualRecompose: () => ({
    pending: false, recompose: mocks.recompose,
    messages: {
      lock: '锁定构件', unlock: '解锁构件', recompose: '换构图', pending: '正在换构图',
      locked: '构件已锁定，仍可直接编辑', modified: '已保留手动修改',
    },
  }),
}));
vi.mock('./AnchoredBar', () => ({
  AnchoredBar: ({ children, elementId }: { children: ReactNode; elementId: string }) => <div data-anchor={elementId}>{children}</div>,
}));

import { TeachingVisualActions, TeachingVisualSelectionBar } from './TeachingVisualActions';
import { useSlideEditSession } from './slide-edit-session';
import { useCanvasStore } from '@openmaic/lib/store/canvas';
import { teachingVisualEditFixture } from '@openmaic/lib/edit/teaching-visual-edit-fixture';

beforeEach(() => {
  vi.useFakeTimers();
  mocks.recompose.mockReset();
  useSlideEditSession.getState().seed('scene', teachingVisualEditFixture());
  useCanvasStore.getState().setActiveElementIdList([]);
});
afterEach(() => {
  cleanup();
  useSlideEditSession.getState().end();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('teaching visual selection controls', () => {
  it('locks and unlocks a component while keeping its native elements editable', () => {
    render(<TeachingVisualActions elementId="support-label" />);
    fireEvent.click(screen.getByRole('button', { name: '锁定构件' }));
    expect(screen.getByRole('button', { name: '解锁构件' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '换构图' })).toBeDisabled();
    expect(useSlideEditSession.getState().history!.present.canvas.elements[1].lock).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: '解锁构件' }));
    expect(screen.getByRole('button', { name: '换构图' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '换构图' }));
    expect(mocks.recompose).toHaveBeenCalledWith('support');
  });

  it('keeps manual edits protected even after unlocking', () => {
    useSlideEditSession.getState().applyOp({ type: 'text.updateContent', elementId: 'support-label', content: '<p>教师解释</p>' });
    render(<TeachingVisualActions elementId="support-label" />);
    expect(screen.getByRole('button', { name: '换构图' })).toBeDisabled();
    expect(screen.getByText('已保留手动修改')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '锁定构件' }));
    fireEvent.click(screen.getByRole('button', { name: '解锁构件' }));
    expect(screen.getByRole('button', { name: '换构图' })).toBeDisabled();
  });

  it('offers one control bar for a grouped component and hides it for mixed groups', () => {
    useCanvasStore.getState().setActiveElementIdList(['support-label', 'support-image']);
    const { container } = render(<TeachingVisualSelectionBar />);
    expect(container.firstElementChild).toHaveAttribute('data-anchor', 'support-label');
    expect(screen.getByRole('button', { name: '锁定构件' })).toBeInTheDocument();
    act(() => useCanvasStore.getState().setActiveElementIdList(['support-label', 'evaluation-label']));
    expect(screen.queryByRole('button', { name: '锁定构件' })).not.toBeInTheDocument();
  });

  it('keeps legacy and unowned element toolbars free of unrelated controls', () => {
    render(<TeachingVisualActions elementId="title" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
