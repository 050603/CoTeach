import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import { useWhiteboardPagesStore } from '@openmaic/lib/store/whiteboard-pages';

vi.mock('@openmaic/components/stage/scene-renderer', () => ({
  SceneRenderer: () => <div>scene</div>,
}));
vi.mock('@openmaic/lib/contexts/scene-context', () => ({
  SceneProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@openmaic/components/whiteboard', () => ({
  Whiteboard: () => <div>whiteboard</div>,
}));
vi.mock('@openmaic/components/canvas/canvas-toolbar', () => ({
  CanvasToolbar: () => <div>toolbar</div>,
}));
vi.mock('@openmaic/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@openmaic/components/scene-renderers/classroom-complete', () => ({
  ClassroomCompletePageConnected: ({ onReviewScene }: { onReviewScene?: (sceneId: string) => void }) => (
    <button type="button" onClick={() => onReviewScene?.('review-scene')}>complete</button>
  ),
}));

import { CanvasArea } from './canvas-area';

afterEach(() => {
  useWhiteboardPagesStore.setState({ pages: [], activePageKeys: {}, reviewPageId: null, reviewStageId: null });
});

const baseProps = {
  currentScene: {
    id: 'scene-1',
    stageId: 'stage-1',
    title: '测试场景',
    order: 0,
    type: 'slide' as const,
    content: {
      type: 'slide' as const,
      canvas: {
        id: 'slide-1',
        viewportSize: 1920,
        viewportRatio: 0.5625,
        theme: {
          themeColors: [],
          fontColor: '#000000',
          fontName: 'Arial',
          backgroundColor: '#ffffff',
        },
        elements: [],
      },
    },
    actions: [],
  },
  currentSceneIndex: 0,
  scenesCount: 1,
  mode: 'playback' as const,
  engineState: 'idle' as const,
  whiteboardOpen: true,
  onPrevSlide: vi.fn(),
  onNextSlide: vi.fn(),
  onPlayPause: vi.fn(),
  onWhiteboardClose: vi.fn(),
  hideToolbar: true,
};

it('passes completion review navigation back to the player', () => {
  const onReviewScene = vi.fn();
  render(<CanvasArea {...baseProps} currentScene={null} whiteboardOpen={false} isPendingScene isCourseComplete onReviewScene={onReviewScene} />);
  fireEvent.click(screen.getByRole('button', { name: 'complete' }));
  expect(onReviewScene).toHaveBeenCalledWith('review-scene');
});

describe('CanvasArea whiteboard restore entry', () => {
  it('lets the user reopen a minimized whiteboard when the toolbar is hidden', () => {
    const onWhiteboardClose = vi.fn();
    const { rerender } = render(
      <CanvasArea {...baseProps} onWhiteboardClose={onWhiteboardClose} />,
    );

    rerender(
      <CanvasArea
        {...baseProps}
        onWhiteboardClose={onWhiteboardClose}
        whiteboardOpen={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '重新打开白板' }));
    expect(onWhiteboardClose).toHaveBeenCalledTimes(1);
  });

  it('opens only the current PPT page’s saved boards', () => {
    const store = useWhiteboardPagesStore.getState();
    store.startPage('stage-1', 'earlier-scene', 'first-board');
    store.retainCurrentPage({
      stageId: 'stage-1', sceneId: 'earlier-scene', completed: true,
      elements: [{ id: 'first-note', type: 'text', content: '<p>前期分析</p>' } as PPTElement],
    });
    store.startPage('stage-1', 'scene-1', 'current-board');
    const currentPage = store.retainCurrentPage({
      stageId: 'stage-1', sceneId: 'scene-1', completed: true,
      elements: [{ id: 'current-note', type: 'text', content: '<p>本页板书</p>' } as PPTElement],
    })!;
    const onWhiteboardClose = vi.fn();
    render(<CanvasArea {...baseProps} whiteboardOpen={false} onWhiteboardClose={onWhiteboardClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'whiteboard.reviewPages' }));
    expect(useWhiteboardPagesStore.getState().reviewPageId).toBe(currentPage.id);
    expect(onWhiteboardClose).not.toHaveBeenCalled();
    expect(screen.queryByText('scene')).toBeNull();
  });

  it('hides both review and reopen entries on a page without boards and restores access on return', () => {
    const store = useWhiteboardPagesStore.getState();
    store.startPage('stage-1', 'scene-1', 'board');
    store.retainCurrentPage({ stageId: 'stage-1', sceneId: 'scene-1', completed: true,
      elements: [{ id: 'note', type: 'text', content: '<p>本页板书</p>' } as PPTElement] });
    const { rerender } = render(<CanvasArea {...baseProps} />);

    rerender(<CanvasArea {...baseProps} whiteboardOpen={false}
      currentScene={{ ...baseProps.currentScene, id: 'scene-without-boards' }} />);
    expect(screen.queryByRole('button', { name: 'whiteboard.reviewPages' })).toBeNull();
    expect(screen.queryByRole('button', { name: '重新打开白板' })).toBeNull();
    expect(screen.getByText('scene')).toBeVisible();

    rerender(<CanvasArea {...baseProps} whiteboardOpen={false} />);
    expect(screen.getByRole('button', { name: 'whiteboard.reviewPages' })).toHaveTextContent('1');
  });

  it('keeps each PPT page’s entry and active review separate within the same course', () => {
    const store = useWhiteboardPagesStore.getState();
    const pages = ['scene-1', 'scene-2'].map((sceneId) => {
      store.startPage('stage-1', sceneId, 'board');
      return store.retainCurrentPage({ stageId: 'stage-1', sceneId, completed: true,
        elements: [{ id: sceneId, type: 'text', content: `<p>${sceneId}</p>` } as PPTElement] })!;
    });
    const { rerender } = render(<CanvasArea {...baseProps} whiteboardOpen={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'whiteboard.reviewPages' }));
    expect(useWhiteboardPagesStore.getState().reviewPageId).toBe(pages[0].id);

    rerender(<CanvasArea {...baseProps} whiteboardOpen={false}
      currentScene={{ ...baseProps.currentScene, id: 'scene-2' }} />);
    expect(screen.getByText('scene')).toBeVisible();
    const entry = screen.getByRole('button', { name: 'whiteboard.reviewPages' });
    expect(entry).toHaveTextContent('1');
    fireEvent.click(entry);
    expect(useWhiteboardPagesStore.getState().reviewPageId).toBe(pages[1].id);
  });

  it('does not expose another course’s retained boards', () => {
    const store = useWhiteboardPagesStore.getState();
    store.startPage('other-stage', 'other-scene', 'board');
    store.retainCurrentPage({ stageId: 'other-stage', sceneId: 'other-scene', completed: true,
      elements: [{ id: 'other', type: 'text', content: '<p>Other</p>' } as PPTElement] });
    render(<CanvasArea {...baseProps} whiteboardOpen={false} />);
    expect(screen.queryByRole('button', { name: 'whiteboard.reviewPages' })).toBeNull();
  });
});

describe('CanvasArea automatic page advance', () => {
  it('hides only the center play hint while a finished slide waits to advance', () => {
    const onPlayPause = vi.fn();
    const { rerender, container } = render(
      <CanvasArea
        {...baseProps}
        autoAdvancePending
        onPlayPause={onPlayPause}
        whiteboardOpen={false}
      />,
    );

    expect(container.querySelector('[data-canvas-play-hint]')).toBeNull();
    fireEvent.click(screen.getByText('scene'));
    expect(onPlayPause).not.toHaveBeenCalled();

    rerender(
      <CanvasArea
        {...baseProps}
        autoAdvancePending={false}
        engineState="paused"
        onPlayPause={onPlayPause}
        whiteboardOpen={false}
      />,
    );
    expect(container.querySelector('[data-canvas-play-hint]')).not.toBeNull();
  });
});
