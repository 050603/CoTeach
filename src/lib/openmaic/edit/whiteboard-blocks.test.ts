import { describe, expect, it } from 'vitest';
import type { Action } from '@openmaic/lib/types/action';
import { moveTimelineActionByIdDir } from './whiteboard-blocks';

const actions: Action[] = [
  { id: 'intro', type: 'speech', text: '开始' },
  { id: 'board', type: 'wb_open' },
  { id: 'note', type: 'wb_draw_text', content: '板书', x: 1, y: 2 },
  { id: 'explain', type: 'speech', text: '解释板书' },
  { id: 'close', type: 'wb_close' },
  { id: 'laser', type: 'laser', elementId: 'slide-title' },
  { id: 'discussion', type: 'discussion', topic: '讨论' },
];
const ids = (items: Action[]) => items.map((action) => action.id);

describe('timeline nudge around whiteboards', () => {
  it('crosses the whole next board when nudging narration right', () => {
    expect(ids(moveTimelineActionByIdDir(actions, 'intro', 1))).toEqual(['board', 'note', 'explain', 'close', 'intro', 'laser', 'discussion']);
  });
  it('crosses the whole preceding board when nudging a cue left', () => {
    expect(ids(moveTimelineActionByIdDir(actions, 'laser', -1))).toEqual(['intro', 'laser', 'board', 'note', 'explain', 'close', 'discussion']);
  });
  it('keeps discussion terminal and leaves board-internal movement to the board editor', () => {
    expect(moveTimelineActionByIdDir(actions, 'laser', 1)).toBe(actions);
    expect(moveTimelineActionByIdDir(actions, 'discussion', -1)).toBe(actions);
    expect(moveTimelineActionByIdDir(actions, 'explain', 1)).toBe(actions);
    expect(moveTimelineActionByIdDir(actions, 'board', -1)).toBe(actions);
  });
});
