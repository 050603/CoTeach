import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TeachingVisualMetadata } from '@openmaic/dsl';

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
import { LectureSubtitleDock } from '@openmaic/components/roundtable/lecture-subtitle-dock';

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

const teachingVisual: TeachingVisualMetadata = {
  scene: { schemaVersion: 1, designVersion: 'teaching-visual-v2', pages: [
    { id: 'slide-1', title: '测试图解', focus: '看清主体', components: [] },
  ] },
  pageId: 'slide-1', candidateId: 'focus', components: [],
  compilerVersion: 'teaching-visual-compiler-v2', themeVersion: 'teaching-visual-theme-v2',
};

const visualScene = {
  ...baseProps.currentScene,
  content: { ...baseProps.currentScene.content, canvas: { ...baseProps.currentScene.content.canvas, teachingVisual } },
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

describe('CanvasArea teaching visual playback', () => {
  it.each(['idle', 'paused'] as const)('keeps a %s teaching visual unobstructed while retaining canvas and chrome playback', (engineState) => {
    const onPlayPause = vi.fn();
    const { container } = render(<>
      <CanvasArea {...baseProps} currentScene={visualScene} engineState={engineState} whiteboardOpen={false} onPlayPause={onPlayPause} />
      <LectureSubtitleDock
        activeActionIndex={0} autoPlay={false} canGoNext={false} canGoNextCue={false}
        canGoPrevious={false} canGoPreviousCue={false} cues={[]} currentText=""
        engineMode={engineState} muted={false} onCycleSpeed={vi.fn()} onPlayPause={onPlayPause}
        onToggleAutoPlay={vi.fn()} onToggleMute={vi.fn()} playbackSpeed={1}
        sceneIndex={0} scenesCount={1} teacherAvatar="/teacher.webp" teacherName="知知"
      />
    </>);

    expect(container.querySelector('[data-canvas-play-hint]')).toBeNull();
    fireEvent.click(screen.getByText('scene'));
    expect(onPlayPause).toHaveBeenCalledTimes(1);
    const play = screen.getByRole('button', { name: '继续讲解' });
    expect(play).toBeEnabled();
    expect(play).toHaveAttribute('type', 'button');
    play.focus();
    expect(play).toHaveFocus();
    fireEvent.click(play);
    expect(onPlayPause).toHaveBeenCalledTimes(2);
  });

  it.each(['idle', 'paused'] as const)('preserves the original %s hint for legacy slides', (engineState) => {
    const onPlayPause = vi.fn();
    const { container } = render(
      <CanvasArea {...baseProps} engineState={engineState} whiteboardOpen={false} onPlayPause={onPlayPause} />,
    );
    const hint = container.querySelector('[data-canvas-play-hint] .cursor-pointer');
    expect(hint).not.toBeNull();
    fireEvent.click(hint!);
    expect(onPlayPause).toHaveBeenCalledTimes(1);
  });
});
