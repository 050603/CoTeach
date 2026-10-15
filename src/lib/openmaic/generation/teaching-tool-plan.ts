import type { Action, SpeechAnchor, SpeechAction } from '@openmaic/lib/types/action';
import { isWhiteboardAction } from '@openmaic/lib/types/action';
import { findSpeechCueAnchorRange } from './speech-cue-boundaries';
import { compileWhiteboardDiagram, parseWhiteboardDiagram, whiteboardDiagramElementId, whiteboardDiagramKeyEntries } from '../whiteboard/diagram';
import { orderedActionExecutionEntries } from '../whiteboard/action-timeline';
import { auditWhiteboardLayout } from '../whiteboard/layout';
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

function normalizeWhiteboardPlan(value: unknown): TeachingToolPlanItem['whiteboard'] {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const binding = (value: unknown) => {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    const anchor = record.speechAnchor as Record<string, unknown> | undefined;
    if (typeof record.speechId !== 'string' || !record.speechId.trim()
      || typeof anchor?.quote !== 'string' || !anchor.quote.trim()
      || anchor.occurrence !== undefined && (!Number.isInteger(anchor.occurrence) || Number(anchor.occurrence) < 0)) return undefined;
    return { speechId: record.speechId, speechAnchor: { quote: anchor.quote,
      ...(anchor.occurrence !== undefined ? { occurrence: Number(anchor.occurrence) } : {}) } };
  };
  const exit = binding(raw.exit);
  if (typeof raw.title !== 'string' || !raw.title.trim() || !Array.isArray(raw.steps) || !exit) return undefined;
  const diagram = raw.diagram === undefined ? undefined : parseWhiteboardDiagram(raw.diagram);
  if (raw.diagram !== undefined && !diagram) return undefined;
  const diagramKeys = new Set(diagram ? whiteboardDiagramKeyEntries(diagram).map((entry) => entry.key) : []);
  const keys = (value: unknown): string[] | undefined => Array.isArray(value)
    && value.every((key) => typeof key === 'string' && key.trim() && diagramKeys.has(key.trim()))
    ? value.map((key) => (key as string).trim()) : undefined;
  const steps = raw.steps.flatMap((value) => {
    const anchor = binding(value);
    const step = value as Record<string, unknown> | null;
    const content = typeof step?.content === 'string' ? step.content.trim() : '';
    const reveal = step?.reveal === undefined ? undefined : keys(step.reveal);
    const emphasize = step?.emphasize === undefined ? undefined : keys(step.emphasize);
    if (!step || !anchor || (diagram ? !reveal?.length && !emphasize?.length : !content)
      || step?.reveal !== undefined && !reveal || step?.emphasize !== undefined && !emphasize) return [];
    return [{ ...anchor, ...(content ? { content } : {}), ...(reveal ? { reveal } : {}), ...(emphasize ? { emphasize } : {}),
      ...(typeof step.title === 'string' && step.title.trim() ? { title: step.title.trim() } : {}) }];
  });
  if (!steps.length || steps.length !== raw.steps.length) return undefined;
  return { title: raw.title.trim(), ...(diagram ? { diagram } : {}), steps, exit };
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
    const whiteboard = raw.tool === 'whiteboard' ? normalizeWhiteboardPlan(raw.whiteboard) : undefined;
    const whiteboardValidationIssues = raw.tool === 'whiteboard' ? [
      ...(!whiteboard && Array.isArray(raw.whiteboardValidationIssues) ? raw.whiteboardValidationIssues.filter((issue): issue is string => typeof issue === 'string' && Boolean(issue.trim())) : []),
      ...(raw.whiteboard !== undefined && !whiteboard ? ['白板合同的图示、步骤引用或讲词绑定结构无效，原教学要求尚未核验'] : []),
    ] : [];
    const content = Array.isArray(raw.content)
      ? raw.content.flatMap((item) => typeof item === 'string' && item.trim() ? [item.trim()] : [])
      : [];
    if (!trigger || !purpose || content.length === 0) return [];
    return [{
      id: cleanText(raw.id, 80) || `tool-plan-${index + 1}`,
      tool: raw.tool as TeachingToolKind,
      trigger,
      purpose,
      content,
      required: raw.required !== false,
      ...(whiteboard ? { whiteboard } : {}),
      ...(whiteboardValidationIssues.length ? { whiteboardValidationIssues: [...new Set(whiteboardValidationIssues)] } : {}),
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
      ...(item.whiteboard ? [`   Anchored whiteboard: ${JSON.stringify(item.whiteboard)}`] : []),
    ].join('\n')),
  ].join('\n');
}

export type TeachingToolEvidence = {
  sceneType?: string;
  content?: unknown;
  actions?: ReadonlyArray<Action>;
};

function visibleText(text: string): string {
  return text.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, '');
}

type NarrationBinding = { speechId?: string; speechAnchor?: SpeechAnchor };
type NarrationPosition = { speech: number; character: number };

/** Resolve the original occurrence across provider-created chunks, so a quote
 * repeated in another chunk cannot stand in for the intended teaching point. */
function narrationBindingContext(actions: ReadonlyArray<Action>) {
  const speeches = actions.filter((action): action is SpeechAction => action.type === 'speech');
  const position = (binding: NarrationBinding): NarrationPosition | undefined => {
    const { speechId, speechAnchor } = binding;
    if (!speechId || !speechAnchor || !Number.isInteger(speechAnchor.occurrence ?? 0)
      || (speechAnchor.occurrence ?? 0) < 0) return undefined;
    const exact = speeches.findIndex((speech) => speech.id === speechId);
    if (exact >= 0) {
      const range = findSpeechCueAnchorRange(speeches[exact].text, speechAnchor);
      return range ? { speech: exact, character: range.start } : undefined;
    }
    const prefix = `${speechId}_tts_`;
    const chunks = speeches.flatMap((speech, index) => speech.id.startsWith(prefix) && /^\d+$/.test(speech.id.slice(prefix.length))
      ? [{ speech, index }] : []);
    const range = findSpeechCueAnchorRange(chunks.map(({ speech }) => speech.text).join(''), speechAnchor);
    if (!range) return undefined;
    let start = 0;
    for (const chunk of chunks) {
      const end = start + chunk.speech.text.length;
      if (start <= range.start && range.end <= end) return { speech: chunk.index, character: range.start - start };
      start = end;
    }
    return undefined;
  };
  return {
    position,
    matches(actual: NarrationBinding, expected: NarrationBinding) {
      const left = position(actual);
      const right = position(expected);
      return Boolean(left && right && left.speech === right.speech && left.character === right.character);
    },
  };
}

function sameDiagramPayload(actual: Action, expected: Action): boolean {
  if (actual.type !== expected.type) return false;
  if (actual.type === 'wb_draw_text' && expected.type === 'wb_draw_text') {
    return visibleText(actual.content) === visibleText(expected.content) && actual.color === expected.color;
  }
  if (actual.type === 'wb_draw_shape' && expected.type === 'wb_draw_shape') {
    return actual.shape === expected.shape && actual.fillColor === expected.fillColor;
  }
  if (actual.type === 'wb_draw_image' && expected.type === 'wb_draw_image') return actual.src === expected.src;
  if (actual.type === 'wb_draw_line' && expected.type === 'wb_draw_line') {
    return JSON.stringify(actual.startAnchor) === JSON.stringify(expected.startAnchor)
      && JSON.stringify(actual.endAnchor) === JSON.stringify(expected.endAnchor)
      && JSON.stringify(actual.points) === JSON.stringify(expected.points)
      && actual.style === expected.style && actual.color === expected.color
      && (Boolean(expected.startAnchor || expected.endAnchor) || (
        Math.abs((actual.endX - actual.startX) - (expected.endX - expected.startX)) < 0.01
        && Math.abs((actual.endY - actual.startY) - (expected.endY - expected.startY)) < 0.01
      ));
  }
  return true;
}

function findDiagramPlanIssues(plan: TeachingToolPlanItem, actions: ReadonlyArray<Action>): string[] {
  const board = plan.whiteboard!;
  if (!board.diagram) return [];
  const issues: string[] = [];
  const binding = narrationBindingContext(actions);
  const exitPosition = binding.position(board.exit);
  let previous: NarrationPosition | undefined;
  for (const step of board.steps) {
    const position = binding.position(step);
    if (!position) issues.push(`白板“${board.title}”的步骤缺少有效的逐项讲词绑定：${step.speechAnchor.quote}`);
    else {
      if (previous && (position.speech < previous.speech
        || position.speech === previous.speech && position.character < previous.character)) {
        issues.push(`白板“${board.title}”的图示步骤与实际讲词顺序不一致`);
      }
      if (exitPosition && (position.speech > exitPosition.speech
        || position.speech === exitPosition.speech && position.character >= exitPosition.character)) {
        issues.push(`白板“${board.title}”的图示步骤位于返回 PPT 之后`);
      }
      previous = position;
    }
  }
  if (!exitPosition) issues.push(`白板“${board.title}”缺少有效的返回 PPT 锚点`);
  const title = actions.find((action) => action.type === 'wb_draw_text'
    && visibleText(action.content) === visibleText(board.title) && action.elementId?.endsWith(':title'));
  const open = actions.find((action) => action.type === 'wb_open' && action.id.endsWith(':open')
    && binding.matches(action, board.steps[0]));
  const prefix = title?.type === 'wb_draw_text' ? title.elementId!.slice(0, -':title'.length)
    : open ? open.id.slice(0, -':open'.length) : plan.id?.replace(/:plan$/, '') ?? 'unresolved-whiteboard';
  const expected = compileWhiteboardDiagram({ id: prefix, title: board.title, diagram: board.diagram,
    steps: board.steps.map((step) => ({ ...step, reveal: step.reveal ?? [] })), exit: board.exit });
  issues.push(...expected.issues.map((issue) => `白板“${board.title}”：${issue}`));
  const execution = orderedActionExecutionEntries(actions);
  const validBindings = new Map(execution.map((entry) => [entry.action, entry.speechBindingValid !== false]));
  const scoped = actions.filter((action) => action.id.startsWith(`${prefix}:`)
    || ('elementId' in action && action.elementId?.startsWith(`${prefix}:`)));

  for (const expectedAction of expected.actions) {
    const elementId = 'elementId' in expectedAction ? expectedAction.elementId : undefined;
    const matching = scoped.find((action) => action.type === expectedAction.type
      && (elementId ? 'elementId' in action && action.elementId === elementId : action.id === expectedAction.id)
      && isWhiteboardAction(action) && validBindings.get(action)
      && binding.matches(action, expectedAction) && sameDiagramPayload(action, expectedAction));
    if (!matching) {
      const content = expectedAction.type === 'wb_draw_text' ? expectedAction.content.replace(/<[^>]+>/g, '') : elementId ?? expectedAction.type;
      issues.push(`白板“${board.title}”的图示对象“${content}”缺少对应内容或有效的逐项讲词绑定`);
    }
  }

  const primary = new Set(whiteboardDiagramKeyEntries(board.diagram).map((entry) => whiteboardDiagramElementId(prefix, entry.key)));
  const relationIds = new Set(whiteboardDiagramKeyEntries(board.diagram).filter((entry) => entry.kind === 'relation')
    .map((entry) => whiteboardDiagramElementId(prefix, entry.key)));
  const firstVisible = new Map<string, NarrationPosition | undefined>();
  const visible = new Map<string, Action>();
  let openBoard = false;
  const register = (action: Action, at: Action) => {
    const elementId = 'elementId' in action && action.elementId ? action.elementId : action.id;
    if (primary.has(elementId) && !firstVisible.has(elementId)) {
      firstVisible.set(elementId, isWhiteboardAction(at) ? binding.position(at) : undefined);
    }
    if (action.type === 'wb_draw_line' && relationIds.has(elementId)
      && [action.startAnchor, action.endAnchor].some((anchor) => !anchor || !visible.has(anchor.elementId))) {
      issues.push(`白板“${board.title}”的关系“${elementId}”在端点显示之前出现`);
    }
  };
  for (const { action, speechBindingValid } of execution) {
    if (!isWhiteboardAction(action) || speechBindingValid === false) continue;
    if (action.type === 'wb_clear') visible.clear();
    else if (action.type === 'wb_delete') visible.delete(action.elementId);
    else if (action.type === 'wb_open') {
      openBoard = true;
      for (const draw of visible.values()) register(draw, action);
    } else if (action.type === 'wb_close') openBoard = false;
    else if (action.type.startsWith('wb_draw_')) {
      const elementId = 'elementId' in action && action.elementId ? action.elementId : action.id;
      visible.set(elementId, action);
      if (openBoard) register(action, action);
    }
  }
  for (const entry of whiteboardDiagramKeyEntries(board.diagram)) {
    const elementId = whiteboardDiagramElementId(prefix, entry.key);
    const firstExpected = expected.actions.find((action) => 'elementId' in action && action.elementId === elementId);
    if (!firstExpected) continue;
    const planned = binding.position(firstExpected);
    const actual = firstVisible.get(elementId);
    if (!planned || !actual || actual.speech !== planned.speech || actual.character !== planned.character) {
      const early = planned && actual && (actual.speech < planned.speech
        || actual.speech === planned.speech && actual.character < planned.character);
      issues.push(`白板“${board.title}”的“${entry.text ?? entry.key}”${early ? '提前展示' : '未在指定讲词锚点首次显示'}`);
    }
  }
  const scopedIds = new Set(scoped.map((action) => action.id));
  issues.push(...auditWhiteboardLayout(actions).filter((issue) => issue.actionIds.some((id) => scopedIds.has(id)))
    .map((issue) => `白板“${board.title}”：${issue.message}`));
  const text = scoped.filter((action) => action.type === 'wb_draw_text').map((action) => visibleText(action.content)).join('');
  const labels = new Set([board.title, ...whiteboardDiagramKeyEntries(board.diagram).flatMap((entry) => entry.text ? [entry.text] : [])].map(visibleText));
  for (const content of [...(plan.required === false ? [] : plan.content), ...board.steps.flatMap((step) => step.content ? [step.content] : [])]) {
    const labeled = content.match(/^([^：:]+)[：:]([\s\S]+)$/u);
    const complete = text.includes(visibleText(content)) || Boolean(labeled && labels.has(visibleText(labeled[1]))
      && labeled[2].split(/[、；;]/u).every((part) => text.includes(visibleText(part))));
    if (!complete) issues.push(`白板“${board.title}”未展示原计划要点“${content}”`);
  }
  return [...new Set(issues)];
}

/** Inspect each saved board step, rather than accepting one draw for the whole page. */
export function findWhiteboardPlanIssues(plan: TeachingToolPlanItem, actions: ReadonlyArray<Action>): string[] {
  if (plan.tool !== 'whiteboard') return [];
  if (!plan.whiteboard && plan.whiteboardValidationIssues?.length) return [...plan.whiteboardValidationIssues];
  if (!plan.whiteboard) return [];
  if (plan.whiteboard.diagram) return findDiagramPlanIssues(plan, actions);
  const issues: string[] = [];
  const board = plan.whiteboard;
  const binding = narrationBindingContext(actions);
  const textActions = actions.filter((action) => action.type === 'wb_draw_text');
  const titleAction = textActions.find((action) => visibleText(action.content) === visibleText(board.title)
    && action.elementId?.endsWith(':title'));
  const boardPrefix = titleAction?.elementId?.slice(0, -'title'.length);
  const boundText = boardPrefix ? textActions.filter((action) => (action.elementId ?? action.id).startsWith(boardPrefix)) : textActions;
  if (!boundText.some((action) => visibleText(action.content).includes(visibleText(board.title)))) {
    issues.push(`白板“${board.title}”缺少阶段标题`);
  }
  for (const step of board.steps) {
    const matching = step.content?.trim() ? boundText.find((action) => binding.matches(action, step)
      && visibleText(action.content).includes(visibleText(step.content!))) : undefined;
    const speech = matching && actions.find((action) => action.type === 'speech' && action.id === matching.speechId);
    if (!matching || speech?.type !== 'speech' || !matching.speechAnchor
      || !findSpeechCueAnchorRange(speech.text, matching.speechAnchor)) {
      issues.push(`白板“${board.title}”要点“${step.title || step.content}”缺少有效的逐项讲词绑定`);
    } else if ((matching.fontSize ?? 18) < 24 || (matching.width ?? 400) <= 0 || (matching.height ?? 100) <= 0) {
      issues.push(`白板“${board.title}”要点“${step.title || step.content}”未满足可读尺寸`);
    }
  }
  // A first response may supply only part of a semantic plan. Keep every
  // original required item rather than accepting the smaller returned step list.
  const visible = boundText.map((action) => visibleText(action.content)).join('');
  const titles = new Set([board.title, ...board.steps.flatMap((step) => step.title ? [step.title] : [])].map(visibleText));
  for (const content of plan.required === false ? [] : plan.content) {
    const expected = visibleText(content);
    if (board.steps.some((step) => step.content && (expected === visibleText(step.content)
      || step.title && expected === visibleText(`${step.title}：${step.content}`)))) continue;
    const labeled = content.match(/^([^：:]+)[：:]([\s\S]+)$/u);
    const displayed = labeled && titles.has(visibleText(labeled[1]))
      ? visible.includes(visibleText(labeled[1])) && visible.includes(visibleText(labeled[2]))
      : visible.includes(expected);
    if (!displayed) issues.push(`白板“${board.title}”未展示原计划要点“${content}”`);
  }
  const exit = actions.find((action): action is Extract<Action, { type: 'wb_close' }> => action.type === 'wb_close'
    && binding.matches(action, board.exit));
  const exitSpeech = exit && actions.find((action) => action.type === 'speech' && action.id === exit.speechId);
  if (!exit || exitSpeech?.type !== 'speech' || !exit.speechAnchor || !findSpeechCueAnchorRange(exitSpeech.text, exit.speechAnchor)) {
    issues.push(`白板“${board.title}”缺少有效的返回 PPT 锚点`);
  }
  return issues;
}

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
    .filter((item) => {
      if (item.required === false) return false;
      if (item.tool === 'whiteboard' && (item.whiteboard || item.whiteboardValidationIssues?.length)) return findWhiteboardPlanIssues(item, actions).length > 0;
      if (actual.has(item.tool)) return false;
      // Spotlight and laser entries in the outline are authoring intent rather
      // than a delivery contract. The semantic cue pass may deliberately drop
      // them when it cannot bind the narration to a reliable rendered target.
      // Treating that safe omission as a generation failure would encourage a
      // fallback to the first element or the centre of a whole table.
      return item.tool !== 'spotlight' && item.tool !== 'laser-pointer';
    })
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
