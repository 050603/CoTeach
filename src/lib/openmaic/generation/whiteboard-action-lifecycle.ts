import { nanoid } from 'nanoid';
import type { Action } from '@openmaic/lib/types/action';
import { isWhiteboardAction } from '@openmaic/lib/types/action';
import { orderedActionExecutionEntries } from '../whiteboard/action-timeline';

const WHITEBOARD_DRAW_ACTIONS = new Set<Action['type']>([
  'wb_draw_text',
  'wb_draw_image',
  'wb_draw_shape',
  'wb_draw_chart',
  'wb_draw_latex',
  'wb_draw_table',
  'wb_draw_line',
  'wb_draw_code',
  'wb_edit_code',
  'wb_clear',
  'wb_delete',
]);

const SLIDE_SURFACE_ACTIONS = new Set<Action['type']>([
  'spotlight',
  'laser',
  'play_video',
  'discussion',
]);

function lifecycleAction(type: 'wb_open' | 'wb_close', source?: Action): Action {
  return {
    id: `action_${nanoid(8)}`,
    type,
    ...(source && 'speechId' in source && source.speechId ? {
      speechId: source.speechId,
      speechAnchor: source.speechAnchor,
      speechOffsetMs: source.speechOffsetMs,
    } : {}),
  };
}

/**
 * Repairs the visual-surface lifecycle around model-generated whiteboard actions.
 * Narration may occur while the board is open; slide-surface actions may not.
 */
export function normalizeWhiteboardActionLifecycle(actions: Action[]): Action[] {
  const normalizedByIndex = new Map<number, Action[]>();
  let whiteboardOpen = false;

  for (const { action, actionIndex, speechBindingValid } of orderedActionExecutionEntries(actions)) {
    const normalized: Action[] = [];
    normalizedByIndex.set(actionIndex, normalized);
    // An unresolved binding remains available for diagnostics. Adding a
    // sequential opener here would expose its board before any valid speech.
    if (isWhiteboardAction(action) && action.speechId && speechBindingValid === false) {
      normalized.push(action);
      continue;
    }
    if (action.type === 'wb_open') {
      if (!whiteboardOpen) {
        normalized.push(action);
        whiteboardOpen = true;
      }
      continue;
    }

    if (action.type === 'wb_close') {
      if (whiteboardOpen) {
        normalized.push(action);
        whiteboardOpen = false;
      }
      continue;
    }

    if (WHITEBOARD_DRAW_ACTIONS.has(action.type) && !whiteboardOpen) {
      normalized.push(lifecycleAction('wb_open', action));
      whiteboardOpen = true;
    }

    if (SLIDE_SURFACE_ACTIONS.has(action.type) && whiteboardOpen) {
      normalized.push(lifecycleAction('wb_close', action));
      whiteboardOpen = false;
    }

    normalized.push(action);
  }

  const result = actions.flatMap((_action, index) => normalizedByIndex.get(index) ?? []);
  if (whiteboardOpen) result.push(lifecycleAction('wb_close'));
  return result;
}
