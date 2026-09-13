import { describe, expect, it } from 'vitest';
import type { ThreadMessageLike } from '@assistant-ui/react';
import { serializeThread, deserializeThread } from './serialize-thread';

function message(result: unknown): ThreadMessageLike {
  return {
    id: 'message', role: 'assistant', content: [{
      type: 'tool-call', toolCallId: 'edit', toolName: 'edit_whiteboard',
      args: { sceneId: 'scene', boardId: 'board' }, result,
    }],
  } as ThreadMessageLike;
}

describe('whiteboard tool history', () => {
  it('keeps the success marker and step counts while dropping snapshots and image bytes', () => {
    const saved = serializeThread([message({ details: {
      sceneId: 'scene', whiteboardPatch: {
        boardId: 'board', before: [{ type: 'speech', text: 'old' }],
        steps: [{ type: 'wb_draw_image', src: 'data:image/png;base64,ABCDEF' }],
      },
    } })]);
    const part = saved[0].content[0];
    expect(part).toMatchObject({ result: { details: { whiteboardPatch: { boardId: 'board', steps: [{ type: 'wb_draw_image' }] } } } });
    expect(JSON.stringify(saved)).not.toContain('ABCDEF');
    expect(JSON.stringify(saved)).not.toContain('before');
    expect(deserializeThread(saved)[0].content).toEqual(saved[0].content);
  });

  it('retains a failed/conflicting edit marker and its readable explanation', () => {
    const saved = serializeThread([message({ details: { sceneId: 'scene', whiteboardPatch: null, error: '已保留你的最新内容' } })]);
    expect(saved[0].content[0]).toMatchObject({ result: { details: { whiteboardPatch: null, error: '已保留你的最新内容' } } });
  });
});
