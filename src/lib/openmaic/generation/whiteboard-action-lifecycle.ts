import { nanoid } from 'nanoid';
import type { Action } from '@openmaic/lib/types/action';

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

function lifecycleAction(type: 'wb_open' | 'wb_close'): Action {
  return {
    id: `action_${nanoid(8)}`,
    type,
  };
}

/**
 * Repairs the visual-surface lifecycle around model-generated whiteboard actions.
 * Narration may occur while the board is open; slide-surface actions may not.
 */
export function normalizeWhiteboardActionLifecycle(actions: Action[]): Action[] {
  const normalized: Action[] = [];
  let whiteboardOpen = false;

  for (const action of actions) {
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
      normalized.push(lifecycleAction('wb_open'));
      whiteboardOpen = true;
    }

    if (SLIDE_SURFACE_ACTIONS.has(action.type) && whiteboardOpen) {
      normalized.push(lifecycleAction('wb_close'));
      whiteboardOpen = false;
    }

    normalized.push(action);
  }

  if (whiteboardOpen) {
    normalized.push(lifecycleAction('wb_close'));
  }

  return normalized;
}
