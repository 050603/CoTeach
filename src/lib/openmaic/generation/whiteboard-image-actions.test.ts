import { describe, expect, it } from 'vitest';
import type { WbDrawImageAction } from '@openmaic/lib/types/action';
import { createNativeTeachingTools } from '@openmaic/lib/orchestration/native-teaching-tools';
import { getActionsForRole } from '@openmaic/lib/orchestration/registry/types';
import { parseActionsFromStructuredOutput } from './action-parser';
import { normalizeWhiteboardActionLifecycle } from './whiteboard-action-lifecycle';
import { normalizeWhiteboardActionLayout } from './whiteboard-layout';
import { findMissingRequiredTeachingTools } from './teaching-tool-plan';

const image: WbDrawImageAction = {
  id: 'image-action', type: 'wb_draw_image', elementId: 'diagram',
  src: '/uploads/diagram.png', x: 60, y: 80, width: 500, height: 300,
};

describe('generated whiteboard images', () => {
  it('accepts an allowed image tool and preserves narration between image steps', () => {
    const allowed = getActionsForRole('teacher');
    expect(createNativeTeachingTools(allowed).wb_draw_image).toBeDefined();
    const { id, type, ...params } = image;
    const actions = parseActionsFromStructuredOutput(JSON.stringify([
      { type: 'action', name: type, action_id: id, params },
      { type: 'text', content: '观察图中的关系。' },
    ]), 'slide', allowed);
    expect(actions[0]).toEqual(image);
    expect(normalizeWhiteboardActionLifecycle(actions).map((action) => action.type)).toEqual([
      'wb_open', 'wb_draw_image', 'speech', 'wb_close',
    ]);
  });

  it('keeps image steps clear of notes already on the board', () => {
    const actions = normalizeWhiteboardActionLayout([
      { id: 'note', type: 'wb_draw_text', content: '已有板书', x: 60, y: 80, width: 500, height: 100 },
      image,
    ]);
    expect(actions[1]).toEqual({ ...image, y: 204 });
    expect(image.y).toBe(80);
  });

  it('counts a lesson image as usable whiteboard teaching output', () => {
    expect(findMissingRequiredTeachingTools({
      teachingToolPlan: [{
        id: 'show-image', tool: 'whiteboard', trigger: '讲解时', purpose: '展示关系',
        content: ['课程关系图'], required: true,
      }],
    }, { sceneType: 'slide', actions: [image] })).toEqual([]);
  });
});
