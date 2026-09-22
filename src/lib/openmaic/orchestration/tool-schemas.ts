/**
 * Action Schemas for Stateless Generation
 *
 * Text descriptions of actions for inclusion in structured output prompts.
 * Actions are parsed from JSON array items in the model's response.
 */

import { SLIDE_ONLY_ACTIONS } from '@openmaic/lib/types/action';

const WIDGET_ACTIONS = new Set([
  'widget_highlight',
  'widget_setState',
  'widget_annotation',
  'widget_reveal',
]);

// ==================== Effective Actions ====================

/**
 * Filter allowed actions by scene type.
 * Slide-only actions (spotlight, laser) are removed for non-slide scenes.
 */
export function getEffectiveActions(allowedActions: string[], sceneType?: string): string[] {
  return allowedActions.filter(
    (action) =>
      (sceneType === 'slide' ||
        !SLIDE_ONLY_ACTIONS.includes(action as (typeof SLIDE_ONLY_ACTIONS)[number])) &&
      (sceneType === 'interactive' || !WIDGET_ACTIONS.has(action)),
  );
}

// ==================== Text Descriptions ====================

/**
 * Get text descriptions of allowed actions for inclusion in system prompts.
 * Used when the model generates structured output with JSON array format.
 */
export const ACTION_DESCRIPTIONS: Record<string, string> = {
    spotlight:
      'Use to frame one text block or table row while it is being explained. Ordinary text explanations should use spotlight instead of laser. Bind it to the exact finalized narration phrase with speechAnchor; endSpeechAnchor is optional and otherwise the cue ends with that sentence. For a complete table row use selector:{rowIndex}; for one table cell use selector:{cellId}; for exact text use quote and optional zero-based occurrence. Parameters: { elementId: string, speechAnchor:{quote:string,occurrence?:number}, endSpeechAnchor?:{quote:string,occurrence?:number}, selector?: {rowIndex:number,quote?:string,occurrence?:number}|{cellId:string,quote?:string,occurrence?:number}|{quote:string,occurrence?:number}, dimOpacity?: number }',
    laser:
      'Use a stationary laser mainly for an image, diagram region, or isolated visual detail. Use a multi-target laser path only to trace an explicit order, process, route, or derivation; every stage needs its own exact speechAnchor. Do not use laser for sustained explanation of ordinary text or table rows—frame those with spotlight. Parameters: { elementId: string, speechAnchor:{quote:string,occurrence?:number}, selector?: {cellId:string,quote?:string,occurrence?:number}|{quote:string,occurrence?:number}, waypoints?: Array<{elementId:string,selector?:object,speechAnchor:{quote:string,occurrence?:number}}>, color?: string }',
    wb_open:
      'Open the whiteboard for hand-drawn explanations, formulas, diagrams, or step-by-step derivations. Creates a new whiteboard if none exists. Call this before adding elements. Parameters: {}',
    wb_draw_text:
      'Add text to the whiteboard. Use for plain-language steps, labels or key points; use wb_draw_latex for formulas. Parameters: { content: string, x: number, y: number, width?: number, height?: number, fontSize?: number, color?: string, elementId?: string, groupId?: string }',
    wb_draw_image:
      'Show an existing image on the whiteboard. Reuse an image URL or asset reference supplied in the lesson or by the teacher; never invent a source URL. Parameters: { src: string, x: number, y: number, width: number, height: number, elementId?: string, groupId?: string }',
    wb_draw_shape:
      'Add a shape to the whiteboard. Use for diagrams and visual explanations. Parameters: { shape: "rectangle"|"circle"|"triangle", x: number, y: number, width: number, height: number, fillColor?: string, elementId?: string, groupId?: string }',
    wb_draw_chart:
      'Add a chart to the whiteboard. Use for data visualization (bar charts, line graphs, pie charts, etc.). Parameters: { chartType: "bar"|"column"|"line"|"pie"|"ring"|"area"|"radar"|"scatter", x: number, y: number, width: number, height: number, data: { labels: string[], legends: string[], series: number[][] }, themeColors?: string[], elementId?: string, groupId?: string }',
    wb_draw_latex:
      'Add a LaTeX formula to the whiteboard. Use for mathematical equations and scientific notation. Parameters: { latex: string, x: number, y: number, width?: number, height?: number, color?: string, elementId?: string, groupId?: string }',
    wb_draw_table:
      'Add a table to the whiteboard. Use for structured data display and comparisons. Parameters: { x: number, y: number, width: number, height: number, data: string[][] (first row is header), outline?: { width: number, style: string, color: string }, theme?: { color: string }, elementId?: string, groupId?: string }',
    wb_draw_line:
      'Add a line or arrow to the whiteboard. Use for connecting elements, drawing relationships, flow diagrams, or annotations. Bind endpoints to already visible elements using startAnchor/endAnchor {elementId,side:top|right|bottom|left|center}; connected endpoints follow their targets. Prefer boundary sides and keep fallback coordinates. Parameters: { startX: number, startY: number, endX: number, endY: number, color?: string (default "#333333"), width?: number (line thickness, default 2), style?: "solid"|"dashed" (default "solid"), points?: [startMarker, endMarker] where marker is ""|"arrow" (default ["",""]), elementId?: string, groupId?: string }',
    wb_draw_code:
      'Add a code block to the whiteboard with syntax highlighting. The code block has a header bar (~32px) showing the file name and language label, so the actual code area starts below that. When positioning, account for this: the effective code area top is about y+32. Use for demonstrating code, algorithms, or programming concepts. Parameters: { language: string (e.g. "python", "javascript", "typescript", "json", "go", "rust", "java", "c", "cpp"), code: string (source code, use \\n for newlines), x: number, y: number, width?: number (default 500), height?: number (default 300, includes ~32px header), fileName?: string (e.g. "main.py"), elementId?: string, groupId?: string }',
    wb_edit_code:
      'Edit an existing code block on the whiteboard by inserting, deleting, or replacing lines. Each line has a stable ID (e.g. "L1", "L2") shown in the whiteboard state. Use this for step-by-step code demonstrations: first draw a code block, then incrementally add/modify lines with speech in between. Parameters: { elementId: string (target code block), operation: "insert_after"|"insert_before"|"delete_lines"|"replace_lines", lineId?: string (reference line for insert), lineIds?: string[] (target lines for delete/replace), content?: string (new code for insert/replace, use \\n for newlines) }',
    wb_clear:
      'Clear all elements from the whiteboard. Use when whiteboard is too crowded before adding new elements. Parameters: {}',
    wb_delete:
      'Delete a specific element from the whiteboard by its ID. Use to remove an outdated, incorrect, or overlapping element without clearing the entire board. Parameters: { elementId: string }',
    wb_close:
      'Close the whiteboard and return to the slide view. Only use when the next teaching action needs the slide canvas; otherwise leave the board open for students to read. Parameters: {}',
    play_video:
      'Start playback of a video element on the current slide. Synchronous — blocks until the video finishes playing. Use a speech action before this to introduce the video. Parameters: { elementId: string }',
    widget_highlight:
      'Highlight a meaningful control or result inside the current interactive simulation. Parameters: { target: string, content?: string }',
    widget_setState:
      'Set state variables in the current interactive simulation. Use to demonstrate a controlled change, not to complete the learner task for them. Parameters: { state: object, content?: string }',
    widget_annotation:
      'Attach a short explanatory annotation to a control or result in the current interactive simulation. Parameters: { target: string, content?: string }',
    widget_reveal:
      'Reveal a hidden part of the current interactive simulation after the learner has made a prediction or attempt. Parameters: { target: string, content?: string }',
  };

export function getActionDescriptions(allowedActions: string[]): string {

  if (allowedActions.length === 0) {
    return 'You have no actions available. You can only speak to students.';
  }

  const lines = allowedActions
    .filter((action) => ACTION_DESCRIPTIONS[action])
    .map((action) => `- ${action}: ${ACTION_DESCRIPTIONS[action]}`);

  return lines.join('\n');
}
