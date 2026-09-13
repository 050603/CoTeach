import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { MAX_WHITEBOARD_STEPS, prepareWhiteboardPatch, type WhiteboardPatch } from '@openmaic/lib/edit/whiteboard-patch';
import { replaceWhiteboardSteps } from '@openmaic/lib/edit/whiteboard-blocks';
import type { RegenerateActionsDeps } from './regenerate-scene-actions';
import { normalizeWhiteboardActionLayout } from '@openmaic/lib/generation/whiteboard-layout';
import { auditWhiteboardLayout } from '@openmaic/lib/whiteboard/layout';
import { auditWhiteboardContent } from '@openmaic/lib/whiteboard/quality';

export const EditWhiteboardParams = Type.Object({
  sceneId: Type.String({ minLength: 1, maxLength: 200, description: 'Current scene id returned by read_scene_content.' }),
  boardId: Type.String({ minLength: 1, maxLength: 200, description: 'Existing whiteboard id returned by read_scene_content (the wb_open action id).' }),
  steps: Type.Array(Type.Record(Type.String(), Type.Unknown()), {
    maxItems: MAX_WHITEBOARD_STEPS,
    description: 'Complete replacement for this board’s internal steps, in playback order. Exclude wb_open/wb_close. Keep existing step ids and elementIds; omit id for new steps. Interleave speech with drawings. An empty array clears this board segment.',
  }),
});
export type EditWhiteboardParams = Static<typeof EditWhiteboardParams>;
export interface EditWhiteboardDetails {
  sceneId: string;
  whiteboardPatch: WhiteboardPatch | null;
  error?: string;
}

export function makeEditWhiteboardTool(deps: Pick<RegenerateActionsDeps, 'getSceneContext'>): AgentTool<typeof EditWhiteboardParams, EditWhiteboardDetails> {
  return {
    name: 'edit_whiteboard',
    label: '编辑白板',
    description: 'Edit one existing whiteboard after read_scene_content. Supply sceneId, boardId and its COMPLETE internal Action steps; all other scene actions and content stay intact. ' +
      'Every step has type, optional id/title/description/groupId. Allowed types and required fields: ' +
      'speech {text}; wb_draw_text {content:plain text,x,y,width?,height?,fontSize?,color?}; ' +
      'wb_draw_image {src,x,y,width,height}; wb_draw_shape {shape:rectangle|circle|triangle,x,y,width,height,fillColor?}; ' +
      'wb_draw_latex {latex,x,y,width?,height?,color?}; wb_draw_table {x,y,width,height,data:string[][],theme?:{color}}; ' +
      'wb_draw_chart {chartType:bar|column|line|pie|ring|area|radar|scatter,x,y,width,height,data:{labels:string[],legends:string[],series:number[][]}}; ' +
      'wb_draw_line {startX,startY,endX,endY,startAnchor?:{elementId,side:top|right|bottom|left|center},endAnchor?:{elementId,side},color?,width?,points?:[""|"arrow",""|"arrow"]}; ' +
      'wb_draw_code {language,code,x,y,width?,height?,fileName?}; wb_edit_code {elementId,operation:insert_after|insert_before|delete_lines|replace_lines,lineId?,lineIds?,content?}; ' +
      'wb_clear {}; wb_delete {elementId}. Draw actions accept elementId. Delete/edit only an element drawn earlier in this replacement board and still visible. ' +
      'Use existing uploaded or HTTP(S) image URLs; never invent URLs. To retain an elided embedded image, keep its step id and omit src. ' +
      'Keep existing ids for retained steps. New ids are assigned if omitted. Never include lifecycle, spotlight, laser, video, discussion, widget actions, or audio references. ' +
      'Plan the page in 1000×562.5 whiteboard pixels (safe area x=20..980,y=20..542.5). Reserve title/body/annotation regions before writing; use groupId for a shape and its label, and bind arrow anchors to already visible elementIds. ' +
      'Reuse elementId to update a visible element of the same type. Anchor references follow its position. Use wb_clear for an explicit next page after explaining the current page, never push work off screen or shrink text to fit. ' +
      'Data must come from the lesson/teacher or be explicitly labelled sample data; never fabricate observations. Chart series match legends and labels; pie/ring use one nonnegative series with positive total, scatter uses exactly two numeric arrays (X and Y). ' +
      'For derivations, alternate a formula and explanation of the operation/conditions; preserve earlier equations when comparing steps. Use narration between successive writing steps. ' +
      'The tool computes layout/content defects and returns specific errors. Correct them and retry without removing requested teaching content.',
    parameters: EditWhiteboardParams,
    execute: async (_toolCallId, params) => {
      const { sceneId, boardId, steps } = params;
      try {
        const ctx = deps.getSceneContext(sceneId);
        if (!ctx?.actions) throw new Error('未找到当前页面的白板内容，请重新读取页面后再试。');
        const whiteboardPatch = prepareWhiteboardPatch(ctx.actions, boardId, steps);
        const normalized = normalizeWhiteboardActionLayout(whiteboardPatch.steps);
        const issues = [...auditWhiteboardLayout(normalized), ...auditWhiteboardContent(normalized)];
        if (issues.length) throw new Error(`白板尚有需要修正的问题，请按元素 ID 修正后重试：${issues.slice(0, 8).map((issue) => `[${issue.actionIds.join(', ')}] ${issue.message}`).join('；')}`);
        whiteboardPatch.steps = normalized;
        // Later reads/edits in the same agent turn must see this result. The
        // client still compares `before` against live state before applying it.
        ctx.actions = replaceWhiteboardSteps(ctx.actions, boardId, whiteboardPatch.steps);
        return {
          content: [{ type: 'text', text: `已生成当前白板的 ${whiteboardPatch.steps.length} 个步骤。` }],
          details: { sceneId, whiteboardPatch },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : '白板编辑失败，请重试。';
        return { content: [{ type: 'text', text: message }], details: { sceneId, whiteboardPatch: null, error: message }, isError: true };
      }
    },
  };
}
