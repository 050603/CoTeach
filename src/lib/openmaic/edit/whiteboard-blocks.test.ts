import { describe, expect, it } from 'vitest';
import type { Action } from '@openmaic/lib/types/action';
import { moveTimelineActionByIdDir, moveWhiteboardBlock, removeWhiteboardBlock, replaceWhiteboardSteps, whiteboardBlocks, whiteboardPreviewActions } from './whiteboard-blocks';

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

describe('narration-bound whiteboard ownership', () => {
  const bound: Action[] = [
    { id: 'board-2', type: 'wb_open', speechId: 's7', speechAnchor: { quote: '第二阶段' } },
    { id: 'note-2', type: 'wb_draw_text', elementId: 'note-2', content: '身体', x: 40, y: 40, fontSize: 24, speechId: 's7', speechAnchor: { quote: '身体' }, speechOffsetMs: 2300 },
    { id: 's7', type: 'speech', text: '进入第二阶段，分析身体。', audioUrl: '/s7.wav' },
    { id: 'extra-2', type: 'wb_draw_text', content: '交互', x: 40, y: 140, fontSize: 24, speechId: 's8', speechAnchor: { quote: '交互' } },
    { id: 'close-2', type: 'wb_close', speechId: 's8', speechAnchor: { quote: '实施阶段' } },
    { id: 'board-3', type: 'wb_open', speechId: 's8', speechAnchor: { quote: '评价阶段' } },
    { id: 'note-3', type: 'wb_draw_text', content: '评价', x: 40, y: 40, fontSize: 24, speechId: 's8', speechAnchor: { quote: '评价阶段' } },
    { id: 's8', type: 'speech', text: '补充交互。回到实施阶段，再进入评价阶段，最后总结。', audioUrl: '/s8.wav' },
    { id: 'close-3', type: 'wb_close', speechId: 's8', speechAnchor: { quote: '总结' } },
  ];

  it('groups timed commands across speech slots without claiming narration or another board', () => {
    const blocks = whiteboardBlocks(bound);
    expect(blocks.map((block) => block.id)).toEqual(['board-2', 'board-3']);
    expect(blocks[0]).toMatchObject({ speechBound: true, actionIndexes: [0, 1, 3, 4] });
    expect(blocks[0].steps.map((step) => step.id)).toEqual(['note-2', 'extra-2']);
    expect(blocks[1].steps.map((step) => step.id)).toEqual(['note-3']);
    expect(removeWhiteboardBlock(bound, 'board-2')).toEqual([bound[2], ...bound.slice(5)]);
  });

  it('replaces only member commands and inherits omitted timing on retained elements', () => {
    const replacement: Action = { id: 'note-2', type: 'wb_draw_text', elementId: 'note-2', content: '关键概念与身体体验', x: 40, y: 40, fontSize: 24 };
    const replaced = replaceWhiteboardSteps(bound, 'board-2', [replacement]);
    expect(replaced.filter((action) => action.type === 'speech')).toEqual([bound[2], bound[7]]);
    expect(replaced.filter((action) => action.id.includes('3'))).toEqual([bound[5], bound[6], bound[8]]);
    expect(replaced.find((action) => action.id === 'note-2')).toMatchObject({
      speechId: 's7', speechAnchor: { quote: '身体' }, speechOffsetMs: 2300,
    });
    expect(whiteboardBlocks(replaced)[0].steps).toHaveLength(1);
    expect(replaceWhiteboardSteps(bound, 'board-2', [{ id: 's7', type: 'speech', text: '覆盖原稿' }])).toBe(bound);
  });

  it('moves only board members while its anchor-defined teaching order and outside actions remain intact', () => {
    const moved = moveWhiteboardBlock(bound, 'board-2', 1);
    const members = new Set(['board-2', 'note-2', 'extra-2', 'close-2']);
    expect(moved.filter((action) => !members.has(action.id))).toEqual(bound.filter((action) => !members.has(action.id)));
    expect(whiteboardBlocks(moved).find((block) => block.id === 'board-2')?.steps.map((step) => step.id)).toEqual(['note-2', 'extra-2']);
    expect(moved.filter((action) => action.type === 'speech')).toEqual([bound[2], bound[7]]);
    const preview = whiteboardPreviewActions(bound, 'board-2', 0);
    expect(preview.map((action) => action.id)).toEqual(['s7', 'board-2', 'note-2']);
    expect(preview.some((action) => action.id === 'extra-2' || action.id === 'note-3')).toBe(false);
  });
});
