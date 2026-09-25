import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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
  ClassroomCompletePageConnected: () => <div>complete</div>,
}));

import { CanvasArea } from './canvas-area';

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
