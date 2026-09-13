import { describe, expect, it, vi } from 'vitest';
import { PlaybackEngine } from './engine';
import type { ActionEngine } from '@openmaic/lib/action/engine';
import type { AudioPlayer } from '@openmaic/lib/utils/audio-player';
import type { Action } from '@openmaic/lib/types/action';
import type { Scene } from '@openmaic/lib/types/stage';

function whiteboardScene(): Scene {
  return {
    id: 'whiteboard-scene',
    stageId: 'stage-1',
    order: 0,
    title: 'Whiteboard explanation',
    type: 'slide',
    content: { type: 'slide', elements: [] },
    actions: [
      {
        id: 'draw-image',
        type: 'wb_draw_image',
        src: '/uploads/diagram.png',
        x: 40, y: 40, width: 400, height: 240,
      },
      {
        id: 'draw-line',
        type: 'wb_draw_line',
        startX: 40,
        startY: 80,
        endX: 240,
        endY: 80,
        points: ['', 'arrow'],
      },
      {
        id: 'draw-code',
        type: 'wb_draw_code',
        elementId: 'code-1',
        language: 'python',
        code: 'value = 1',
        x: 60,
        y: 120,
      },
      {
        id: 'edit-code',
        type: 'wb_edit_code',
        elementId: 'code-1',
        operation: 'replace_lines',
        lineIds: ['L1'],
        content: 'value = 2',
      },
    ] as Action[],
  } as unknown as Scene;
}

describe('PlaybackEngine whiteboard actions', () => {
  it('dispatches images, line drawing and incremental code actions to the ActionEngine', async () => {
    const execute = vi.fn<(action: Action) => Promise<void>>().mockResolvedValue(undefined);
    const actionEngine = {
      clearEffects: vi.fn(),
      execute,
    } as unknown as ActionEngine;
    const audioPlayer = {
      play: vi.fn().mockResolvedValue(false),
      onEnded: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      isPlaying: vi.fn().mockReturnValue(false),
      hasActiveAudio: vi.fn().mockReturnValue(false),
    } as unknown as AudioPlayer;
    const onComplete = vi.fn();
    const engine = new PlaybackEngine(
      [whiteboardScene()],
      actionEngine,
      audioPlayer,
      { onComplete },
    );

    engine.start();

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(execute).toHaveBeenCalledTimes(4);
    expect(execute.mock.calls.map(([action]) => action.type)).toEqual([
      'wb_draw_image',
      'wb_draw_line',
      'wb_draw_code',
      'wb_edit_code',
    ]);
  });
});
