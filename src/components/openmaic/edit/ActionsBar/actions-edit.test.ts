import { describe, expect, it } from 'vitest';
import type { Action } from '@openmaic/lib/types/action';
import {
  appendWhiteboardTextBlock,
  removeWhiteboardTextBlockById,
  setElementIdById,
  setWhiteboardTextById,
} from './actions-edit';

describe('teacher preparation whiteboard actions', () => {
  it('adds an editable whiteboard lifecycle before a terminal discussion', () => {
    const actions = [
      { id: 'speech-1', type: 'speech', text: '讲解' },
      { id: 'discussion-1', type: 'discussion', topic: '讨论' },
    ] as Action[];

    const next = appendWhiteboardTextBlock(actions, 'board-1');

    expect(next.map((action) => action.type)).toEqual([
      'speech',
      'wb_open',
      'wb_draw_text',
      'wb_close',
      'discussion',
    ]);
    expect(next[2]).toMatchObject({ id: 'board-1', content: '', x: 80, y: 72 });
  });

  it('edits board text and removes the complete generated lifecycle', () => {
    const created = appendWhiteboardTextBlock([], 'board-1');
    const edited = setWhiteboardTextById(created, 'board-1', '能量守恒');
    expect(edited[1]).toMatchObject({ type: 'wb_draw_text', content: '能量守恒' });
    expect(removeWhiteboardTextBlockById(edited, 'board-1')).toEqual([]);
  });

  it('clears a fine-grained selector when a cue is rebound to another element', () => {
    const actions = [{
      id: 'focus',
      type: 'spotlight',
      elementId: 'old-table',
      selector: { cellId: 'r3c2' },
      speechId: 'speech-1',
    }] as Action[];

    expect(setElementIdById(actions, 'focus', 'new-table')).toEqual([{
      id: 'focus',
      type: 'spotlight',
      elementId: 'new-table',
      speechId: 'speech-1',
    }]);
  });
});
