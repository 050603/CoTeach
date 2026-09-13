import type { Action } from '@openmaic/lib/types/action';

export interface WhiteboardBlock {
  id: string;
  start: number;
  end: number;
  steps: Action[];
}

/** A board is a single, movable teaching segment, including its narration. */
export function whiteboardBlocks(actions: readonly Action[]): WhiteboardBlock[] {
  const blocks: WhiteboardBlock[] = [];
  for (let index = 0; index < actions.length; index++) {
    if (actions[index].type !== 'wb_open') continue;
    const start = index;
    while (index + 1 < actions.length) {
      const type = actions[index + 1].type;
      if (type === 'wb_open' || (!type.startsWith('wb_') && type !== 'speech')) break;
      index++;
      if (type === 'wb_close') break;
    }
    blocks.push({
      id: actions[start].id,
      start,
      end: index,
      steps: actions.slice(start + 1, actions[index].type === 'wb_close' ? index : index + 1),
    });
  }
  return blocks;
}

/** Resolve by stable board id against the latest list, preserving unrelated edits. */
export function replaceWhiteboardSteps(actions: Action[], id: string, steps: Action[]): Action[] {
  const block = whiteboardBlocks(actions).find((item) => item.id === id);
  if (!block) return actions;
  const close = actions[block.end].type === 'wb_close'
    ? actions[block.end] : { id: `${id}-close`, type: 'wb_close' as const };
  return [...actions.slice(0, block.start + 1), ...steps, close, ...actions.slice(block.end + 1)];
}

/** Nudge an ordinary timeline action across a whole neighboring board segment. */
export function moveTimelineActionByIdDir(actions: Action[], id: string, direction: number): Action[] {
  const index = actions.findIndex((action) => action.id === id);
  if (index < 0 || !direction || actions[index].type === 'discussion') return actions;
  const blocks = whiteboardBlocks(actions);
  if (blocks.some((block) => index >= block.start && index <= block.end)) return actions;
  if (direction < 0) {
    if (index === 0) return actions;
    const previous = blocks.find((block) => block.end === index - 1);
    const start = previous?.start ?? index - 1;
    return [...actions.slice(0, start), actions[index], ...actions.slice(start, index), ...actions.slice(index + 1)];
  }
  if (index === actions.length - 1 || actions[index + 1].type === 'discussion') return actions;
  const next = blocks.find((block) => block.start === index + 1);
  const end = next?.end ?? index + 1;
  return [...actions.slice(0, index), ...actions.slice(index + 1, end + 1), actions[index], ...actions.slice(end + 1)];
}
