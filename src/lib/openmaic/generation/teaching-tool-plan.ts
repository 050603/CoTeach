import type { Action } from '@openmaic/lib/types/action';
import type {
  SceneOutline,
  TeachingToolKind,
  TeachingToolPlanItem,
} from '@openmaic/lib/types/generation';

const TOOL_KINDS = new Set<TeachingToolKind>([
  'whiteboard',
  'spotlight',
  'laser-pointer',
  'interactive-widget',
]);

function cleanText(value: unknown, maxLength = 240): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

export function normalizeTeachingToolPlan(
  value: unknown,
): TeachingToolPlanItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const raw = candidate as Record<string, unknown>;
    if (typeof raw.tool !== 'string' || !TOOL_KINDS.has(raw.tool as TeachingToolKind)) {
      return [];
    }
    const trigger = cleanText(raw.trigger);
    const purpose = cleanText(raw.purpose);
    const content = Array.isArray(raw.content)
      ? raw.content.map((item) => cleanText(item, 180)).filter(Boolean).slice(0, 6)
      : [];
    if (!trigger || !purpose || content.length === 0) return [];
    return [{
      id: cleanText(raw.id, 80) || `tool-plan-${index + 1}`,
      tool: raw.tool as TeachingToolKind,
      trigger,
      purpose,
      content,
      required: raw.required !== false,
    }];
  });
}

/**
 * Preserve explicit model-authored plans. We deliberately do not infer a
 * whiteboard from titles/key points: terms such as "model", "process" or
 * "comparison" are far too broad and previously turned lesson outlines into
 * meaningless numbered board notes.
 */
export function ensureTeachingToolPlans(
  outlines: ReadonlyArray<SceneOutline>,
): SceneOutline[] {
  return outlines.map((outline) => {
    // The action generators only implement planned tools for student-facing
    // teaching pages. In particular, quiz and PBL pages must not inherit a
    // whiteboard contract from a source slide during outline normalization.
    if (outline.audience === 'teacher' || (outline.type !== 'slide' && outline.type !== 'interactive')) {
      return { ...outline, teachingToolPlan: undefined };
    }
    const normalized = normalizeTeachingToolPlan(outline.teachingToolPlan);
    if (normalized.length > 0) return { ...outline, teachingToolPlan: normalized };

    if (outline.type === 'interactive' && outline.audience === 'student') {
      return {
        ...outline,
        teachingToolPlan: [{
          id: `interactive-${outline.id}`,
          tool: 'interactive-widget',
          trigger: `完成“${outline.title}”的必要讲解后`,
          purpose: '让学生通过操作、观察和比较形成可验证的理解。',
          content: [outline.description, ...(outline.keyPoints ?? [])]
            .map((item) => cleanText(item, 150))
            .filter(Boolean)
            .slice(0, 4),
          required: true,
        }],
      };
    }

    return { ...outline, teachingToolPlan: undefined };
  });
}

export function formatTeachingToolPlanForPrompt(outline: SceneOutline): string {
  const plan = normalizeTeachingToolPlan(outline.teachingToolPlan);
  if (plan.length === 0) {
    return [
      '## Page teaching-tool plan',
      '- No tool is contractually planned for this page. You may still use spotlight or laser sparingly when it materially improves attention.',
      '- Do not open the whiteboard merely to copy slide text.',
    ].join('\n');
  }
  return [
    '## Page teaching-tool plan (must follow)',
    '- Execute every item marked required. Synchronize it with the nearby narration instead of announcing the tool itself.',
    '- Whiteboard content below is a semantic specification: make every listed item visible, legible, and spatially organized; do not merely repeat the slide title.',
    ...plan.map((item, index) => [
      `${index + 1}. ${item.tool}${item.required === false ? ' (optional)' : ' (required)'}`,
      `   Trigger: ${item.trigger}`,
      `   Purpose: ${item.purpose}`,
      `   Visible content: ${item.content.join(' | ')}`,
    ].join('\n')),
  ].join('\n');
}

export type TeachingToolEvidence = {
  sceneType?: string;
  content?: unknown;
  actions?: ReadonlyArray<Action>;
};

const WHITEBOARD_VISIBLE_ACTIONS = new Set<Action['type']>([
  'wb_draw_text',
  'wb_draw_image',
  'wb_draw_latex',
  'wb_draw_shape',
  'wb_draw_line',
  'wb_draw_code',
  'wb_edit_code',
  'wb_draw_table',
  'wb_draw_chart',
]);

/**
 * An interactive page is itself the planned teaching tool. Requiring an
 * unrelated widget_* control action as proof caused fully generated embedded
 * activities to be reported as missing resources.
 */
export function hasUsableInteractiveSurface(evidence: TeachingToolEvidence): boolean {
  if (evidence.sceneType !== 'interactive') return false;
  if (!evidence.content || typeof evidence.content !== 'object') return false;
  const content = evidence.content as Record<string, unknown>;
  const html = typeof content.html === 'string' ? content.html.trim() : '';
  const url = typeof content.url === 'string' ? content.url.trim() : '';

  const hasEmbeddedInteraction = html.length >= 80
    && /<(?:button|input|select|textarea|canvas|svg|form|script)\b/i.test(html);
  const hasExternalInteraction = Boolean(url)
    && url !== '#'
    && !/^about:blank(?:$|[?#])/i.test(url)
    && !/^javascript:/i.test(url);
  return hasEmbeddedInteraction || hasExternalInteraction;
}

/**
 * Canonical semantic acceptance contract used while generating, restoring
 * checkpoints and auditing the finished course. Lifecycle-only whiteboard
 * actions do not count as visible teaching output, and an interactive surface
 * does not need a fabricated widget action to prove that it exists.
 */
export function findMissingRequiredTeachingTools(
  outline: Pick<SceneOutline, 'teachingToolPlan'>,
  evidence: TeachingToolEvidence,
): TeachingToolKind[] {
  // Persisted outlines created before normalization may still contain an
  // inapplicable plan. Treat it as legacy metadata instead of making the
  // whole classroom generation fail at the final quiz/PBL page.
  if (evidence.sceneType !== 'slide' && evidence.sceneType !== 'interactive') return [];

  const actions = evidence.actions ?? [];
  const actual = new Set<TeachingToolKind>();
  if (actions.some((action) => WHITEBOARD_VISIBLE_ACTIONS.has(action.type))) {
    actual.add('whiteboard');
  }
  if (actions.some((action) => action.type === 'spotlight')) actual.add('spotlight');
  if (actions.some((action) => action.type === 'laser')) actual.add('laser-pointer');
  if (hasUsableInteractiveSurface(evidence)) actual.add('interactive-widget');

  return normalizeTeachingToolPlan(outline.teachingToolPlan)
    .filter((item) => item.required !== false && !actual.has(item.tool))
    .map((item) => item.tool);
}

/**
 * Do not fabricate tool output when generation omitted it. Readiness checks
 * report a missing required tool and the normal generation retry/error path
 * handles it with the real model-authored content.
 */
export function applyPlannedTeachingToolActions(
  _outline: Pick<SceneOutline, 'teachingToolPlan'>,
  actions: ReadonlyArray<Action>,
): Action[] {
  return actions.map((action) => ({ ...action }));
}

function actualContent(action: Action): string[] {
  switch (action.type) {
    case 'wb_draw_text':
      return [action.content.replace(/<[^>]+>/g, '')];
    case 'wb_draw_image':
      return [action.title || '白板图片'];
    case 'wb_draw_latex':
      return [action.latex];
    case 'wb_draw_code':
      return [`${action.fileName || action.language}：${action.code}`];
    case 'wb_draw_table':
      return action.data.slice(0, 3).map((row) => row.join('｜'));
    case 'wb_draw_chart':
      return [`${action.chartType}：${action.data.labels.join('、')}`];
    case 'wb_draw_shape':
      return [`${action.shape} 图形`];
    case 'wb_draw_line':
      return ['关系连线 / 箭头'];
    case 'widget_highlight':
    case 'widget_annotation':
    case 'widget_reveal':
      return [action.content || action.target];
    case 'widget_setState':
      return [JSON.stringify(action.state)];
    default:
      return [];
  }
}

export type ActualTeachingToolSummary = {
  tool: TeachingToolKind;
  actionCount: number;
  trigger: string;
  content: string[];
};

export function summarizeActualTeachingTools(
  actions: ReadonlyArray<Action> = [],
): ActualTeachingToolSummary[] {
  const firstToolIndex = actions.findIndex((action) =>
    action.type.startsWith('wb_')
    || action.type.startsWith('widget_')
    || action.type === 'spotlight'
    || action.type === 'laser',
  );
  const priorSpeech = firstToolIndex > 0
    ? [...actions.slice(0, firstToolIndex)].reverse().find((action) => action.type === 'speech')
    : undefined;
  const trigger = priorSpeech?.type === 'speech'
    ? priorSpeech.text.slice(0, 90)
    : '进入本页相关讲解时';
  const groups: Array<{ tool: TeachingToolKind; actions: Action[] }> = [
    { tool: 'whiteboard', actions: actions.filter((action) => action.type.startsWith('wb_')) },
    { tool: 'interactive-widget', actions: actions.filter((action) => action.type.startsWith('widget_')) },
    { tool: 'spotlight', actions: actions.filter((action) => action.type === 'spotlight') },
    { tool: 'laser-pointer', actions: actions.filter((action) => action.type === 'laser') },
  ];
  return groups.flatMap((group) => group.actions.length > 0 ? [{
    tool: group.tool,
    actionCount: group.actions.length,
    trigger,
    content: Array.from(new Set(group.actions.flatMap(actualContent).filter(Boolean))).slice(0, 6),
  }] : []);
}
