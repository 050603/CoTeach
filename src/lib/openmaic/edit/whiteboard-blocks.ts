import type { Action } from '@openmaic/lib/types/action';
import { isWhiteboardAction } from '@openmaic/lib/types/action';
import { orderedActionExecutionEntries } from '../whiteboard/action-timeline';

export interface WhiteboardBlock {
  id: string;
  start: number;
  end: number;
  steps: Action[];
  /** Exact persisted members; bound boards may span unrelated action slots. */
  actionIndexes: number[];
  speechBound: boolean;
}

/** Legacy boards own their interleaved narration. Narration-bound boards own
 * only their whiteboard commands, projected between their timed open/close. */
export function whiteboardBlocks(actions: readonly Action[]): WhiteboardBlock[] {
  const blocks: WhiteboardBlock[] = [];
  let bound: WhiteboardBlock | undefined;
  for (const { action, actionIndex } of orderedActionExecutionEntries(actions)) {
    if (action.type === 'wb_open') {
      if (bound) blocks.push(bound);
      bound = action.speechId ? {
        id: action.id, start: actionIndex, end: actionIndex, steps: [],
        actionIndexes: [actionIndex], speechBound: true,
      } : undefined;
      continue;
    }
    if (!bound || !isWhiteboardAction(action)) continue;
    bound.actionIndexes.push(actionIndex);
    bound.end = Math.max(bound.end, actionIndex);
    if (action.type === 'wb_close') {
      blocks.push(bound);
      bound = undefined;
    } else bound.steps.push(action);
  }
  if (bound) blocks.push(bound);
  const boundIndexes = new Set(blocks.flatMap((block) => block.actionIndexes));
  for (let index = 0; index < actions.length; index++) {
    if (actions[index].type !== 'wb_open' || boundIndexes.has(index)) continue;
    const start = index;
    const actionIndexes = [index];
    while (index + 1 < actions.length) {
      if (boundIndexes.has(index + 1)) break;
      const type = actions[index + 1].type;
      if (type === 'wb_open' || (!type.startsWith('wb_') && type !== 'speech')) break;
      index++;
      actionIndexes.push(index);
      if (type === 'wb_close') break;
    }
    blocks.push({
      id: actions[start].id,
      start,
      end: index,
      steps: actions.slice(start + 1, actions[index].type === 'wb_close' ? index : index + 1),
      actionIndexes,
      speechBound: false,
    });
  }
  return blocks.sort((left, right) => left.start - right.start);
}

/** Retained elements keep their authored clock when an editor omits metadata.
 * New commands inherit the nearest preceding board step, then the opener. */
export function retainWhiteboardStepBindings(actions: readonly Action[], block: WhiteboardBlock, steps: readonly Action[]): Action[] {
  if (!block.speechBound) return [...steps];
  const previous = new Map(block.steps.map((step) => [step.id, step]));
  let preceding = actions[block.start];
  return steps.map((step) => {
    if (!isWhiteboardAction(step)) return step;
    const retained = previous.get(step.id) ?? block.steps.find((candidate) => (
      'elementId' in candidate && 'elementId' in step && candidate.elementId && candidate.elementId === step.elementId
    ));
    const source = retained ?? preceding;
    if (!isWhiteboardAction(source)) return step;
    const changedClock = (step.speechId !== undefined && step.speechId !== source.speechId)
      || (step.speechAnchor !== undefined && JSON.stringify(step.speechAnchor) !== JSON.stringify(source.speechAnchor));
    const next = {
      ...step,
      speechId: step.speechId ?? source.speechId,
      speechAnchor: step.speechAnchor ?? source.speechAnchor,
      speechOffsetMs: step.speechOffsetMs ?? (changedClock ? undefined : source.speechOffsetMs),
    };
    const retainedStep = next.speechId === step.speechId && next.speechAnchor === step.speechAnchor
      && next.speechOffsetMs === step.speechOffsetMs ? step : next;
    preceding = retainedStep;
    return retainedStep;
  });
}

/** Resolve by stable board id against the latest list, preserving unrelated edits. */
export function replaceWhiteboardSteps(actions: Action[], id: string, steps: Action[]): Action[] {
  const block = whiteboardBlocks(actions).find((item) => item.id === id);
  if (!block) return actions;
  if (block.speechBound) {
    if (steps.some((step) => !isWhiteboardAction(step) || step.type === 'wb_open' || step.type === 'wb_close')) return actions;
    const replacement = retainWhiteboardStepBindings(actions, block, steps);
    const internalIds = new Set(block.steps.map((step) => step.id));
    return actions.flatMap((action, index) => (
      index === block.start ? [action, ...replacement] : internalIds.has(action.id) ? [] : [action]
    ));
  }
  const close = actions[block.end].type === 'wb_close'
    ? actions[block.end] : { id: `${id}-close`, type: 'wb_close' as const };
  return [...actions.slice(0, block.start + 1), ...steps, close, ...actions.slice(block.end + 1)];
}

/** Delete exact board members, never narration merely between their slots. */
export function removeWhiteboardBlock(actions: Action[], id: string): Action[] {
  const block = whiteboardBlocks(actions).find((item) => item.id === id);
  if (!block) return actions;
  const members = new Set(block.actionIndexes);
  return actions.filter((_action, index) => !members.has(index));
}

/** Bound board moves reorder only its stored commands; authored speech anchors
 * continue to determine playback order. Other actions keep their relative order. */
export function moveWhiteboardBlock(actions: Action[], id: string, direction: -1 | 1): Action[] {
  const blocks = whiteboardBlocks(actions);
  const block = blocks.find((item) => item.id === id);
  if (!block) return actions;
  const members = new Set(block.actionIndexes);
  const neighborIndex = direction < 0
    ? actions.findLastIndex((_action, index) => index < block.start && !members.has(index))
    : actions.findIndex((_action, index) => index > block.start && !members.has(index));
  if (neighborIndex < 0 || actions[neighborIndex].type === 'discussion') return actions;
  const neighborBoard = blocks.find((item) => item.id !== id && item.actionIndexes.includes(neighborIndex));
  const boundary = direction < 0
    ? neighborBoard ? Math.min(...neighborBoard.actionIndexes) : neighborIndex
    : neighborBoard ? Math.max(...neighborBoard.actionIndexes) + 1 : neighborIndex + 1;
  const remaining = actions.filter((_action, index) => !members.has(index));
  const slot = actions.slice(0, boundary).filter((_action, index) => !members.has(index)).length;
  const selected = actions.filter((_action, index) => members.has(index));
  return [...remaining.slice(0, slot), ...selected, ...remaining.slice(slot)];
}

/** A preview ends at the selected execution step, including preceding boards. */
export function whiteboardPreviewActions(actions: readonly Action[], boardId: string, throughStep: number): Action[] {
  const block = whiteboardBlocks(actions).find((item) => item.id === boardId);
  if (!block) return [];
  const target = block.steps[throughStep]?.id ?? block.id;
  const execution = orderedActionExecutionEntries(actions);
  const end = execution.findIndex(({ action }) => action.id === target);
  return end < 0 ? [] : execution.slice(0, end + 1).map(({ action }) => action);
}

/** Nudge an ordinary timeline action across a whole neighboring board segment. */
export function moveTimelineActionByIdDir(actions: Action[], id: string, direction: number): Action[] {
  const index = actions.findIndex((action) => action.id === id);
  if (index < 0 || !direction || actions[index].type === 'discussion') return actions;
  const blocks = whiteboardBlocks(actions);
  if (blocks.some((block) => block.actionIndexes.includes(index))) return actions;
  // Timed commands can surround a narration slot without owning it. Skip
  // those storage slots when moving ordinary narration, keeping their clocks.
  const boundIndexes = new Set(blocks.filter((block) => block.speechBound).flatMap((block) => block.actionIndexes));
  if (direction < 0) {
    if (index === 0) return actions;
    const neighbor = actions.findLastIndex((_action, at) => at < index && !boundIndexes.has(at));
    if (neighbor < 0 || actions[neighbor].type === 'discussion') return actions;
    const previous = blocks.find((block) => !block.speechBound && block.end === neighbor);
    const start = previous?.start ?? neighbor;
    return [...actions.slice(0, start), actions[index], ...actions.slice(start, index), ...actions.slice(index + 1)];
  }
  const neighbor = actions.findIndex((_action, at) => at > index && !boundIndexes.has(at));
  if (neighbor < 0 || actions[neighbor].type === 'discussion') return actions;
  const next = blocks.find((block) => !block.speechBound && block.start === neighbor);
  const end = next?.end ?? neighbor;
  return [...actions.slice(0, index), ...actions.slice(index + 1, end + 1), actions[index], ...actions.slice(end + 1)];
}
