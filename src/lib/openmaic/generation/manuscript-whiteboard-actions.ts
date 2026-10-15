import type { Action, SpeechAnchor, WbDrawTextAction } from '../types/action';
import type { SceneOutline, TeachingToolPlanItem } from '../types/generation';
import type { NarrationModuleOutput } from './action-binding-types';
import type { ActionBindingIssue } from './action-bindings';
import { findSpeechCueAnchorRange } from './speech-cue-boundaries';
import { minimumWhiteboardTextHeight, WHITEBOARD_HEIGHT, WHITEBOARD_WIDTH } from '../whiteboard/layout';
import { compileWhiteboardDiagram, parseWhiteboardDiagram, type WhiteboardDiagram } from '../whiteboard/diagram';

export type ManuscriptWhiteboardStep = {
  /** An optional subsection label, shown only when this group is reached. */
  title?: string;
  content?: string;
  /** Semantic diagram objects to reveal, or revisit without adding new text. */
  reveal?: string[];
  emphasize?: string[];
  speechId: string;
  speechAnchor: SpeechAnchor;
};

export type ManuscriptWhiteboardGroup = {
  /** Bind an existing required tool plan when one was supplied. */
  planId?: string;
  title: string;
  diagram?: WhiteboardDiagram;
  steps: ManuscriptWhiteboardStep[];
  exit: { speechId: string; speechAnchor: SpeechAnchor };
};

type Position = { segment: number; character: number };
type Bound = { speechId: string; speechAnchor: SpeechAnchor; position: Position };
type AcceptedGroup = { id: string; group: ManuscriptWhiteboardGroup; start: Position; end: Position };
type BoundWhiteboardAction = Action & { speechId: string; speechAnchor: SpeechAnchor };

export function compareManuscriptPositions(left: Position, right: Position): number {
  return left.segment - right.segment || left.character - right.character;
}

export function manuscriptActionPosition(action: Action, narration: NarrationModuleOutput): Position | undefined {
  if (!('speechId' in action) || !action.speechId || !('speechAnchor' in action) || !action.speechAnchor) return undefined;
  const segment = narration.segments.findIndex((candidate) => candidate.id === action.speechId);
  const range = segment >= 0 ? findSpeechCueAnchorRange(narration.segments[segment].text, action.speechAnchor) : undefined;
  return range ? { segment, character: range.start } : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function bind(value: unknown, narration: NarrationModuleOutput): Bound | undefined {
  const raw = record(value);
  const anchor = record(raw?.speechAnchor);
  if (typeof raw?.speechId !== 'string' || typeof anchor?.quote !== 'string' || !anchor.quote.trim()) return undefined;
  const occurrence = anchor.occurrence ?? 0;
  if (!Number.isInteger(occurrence) || Number(occurrence) < 0) return undefined;
  const speechAnchor = { quote: anchor.quote, occurrence: Number(occurrence) };
  const segment = narration.segments.findIndex((candidate) => candidate.id === raw.speechId);
  const range = segment >= 0 ? findSpeechCueAnchorRange(narration.segments[segment].text, speechAnchor) : undefined;
  return range ? { speechId: raw.speechId, speechAnchor, position: { segment, character: range.start } } : undefined;
}

function plainText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\r?\n/g, '<br/>');
}

const X = 50;
const WIDTH = WHITEBOARD_WIDTH - X * 2;
const BODY_X = 70;
const BODY_WIDTH = WHITEBOARD_WIDTH - BODY_X - X;
const LABEL_WIDTH = 210;
const GROUP_BODY_X = X + LABEL_WIDTH + 24;
const GROUP_BODY_WIDTH = WHITEBOARD_WIDTH - GROUP_BODY_X - X;
const MARGIN = 28;
// Match the existing normalizer's clearance so it preserves this measured
// composition instead of pushing the last readable row into an occupied area.
const GAP = 24;
const ACCENT = '#1d4ed8';
const INK = '#1e293b';

function drawing(elementId: string, content: string, y: number, fontSize: number, color: string, x = BODY_X, width = BODY_WIDTH): WbDrawTextAction {
  const action: WbDrawTextAction = { id: elementId, type: 'wb_draw_text', elementId,
    content: `<p>${escapeText(content)}</p>`, x, y, width, height: 0, fontSize, color };
  action.height = minimumWhiteboardTextHeight(action, width);
  return action;
}

/** Models choose facts and exact timing. The host owns all geometry and IDs. */
function layoutGroup(group: AcceptedGroup, diagnose: (id: string, message: string) => void): BoundWhiteboardAction[] {
  if (group.group.diagram) {
    const result = compileWhiteboardDiagram({ id: group.id, title: group.group.title,
      diagram: group.group.diagram, steps: group.group.steps.map((step) => ({ ...step, reveal: step.reveal ?? [] })),
      exit: group.group.exit });
    result.issues.forEach((message, index) => diagnose(`${group.id}:diagram-${index + 1}`, message));
    return result.actions as BoundWhiteboardAction[];
  }
  const actions: BoundWhiteboardAction[] = [];
  const add = (action: Action, owner: { speechId: string; speechAnchor: SpeechAnchor }) => {
    actions.push({ ...action, speechId: owner.speechId, speechAnchor: owner.speechAnchor });
  };
  const heading = drawing(`${group.id}:title`, group.group.title, MARGIN, 30, INK, X, WIDTH);
  const top = MARGIN + heading.height! + GAP;
  const bottom = WHITEBOARD_HEIGHT - MARGIN;
  let cursor = top;
  let page = 0;
  let shownTitle: string | undefined;
  let previous: WbDrawTextAction | undefined;
  let started = false;
  const acceptedSteps: ManuscriptWhiteboardStep[] = [];
  let inheritedTitle: string | undefined;
  const measured = group.group.steps.map((step, index) => {
    const stepId = `${group.id}:step-${String(index + 1).padStart(4, '0')}`;
    const currentTitle = step.title ?? inheritedTitle;
    inheritedTitle = currentTitle;
    const label = currentTitle ? drawing(`${stepId}:group`, currentTitle, cursor, 26, INK, X, LABEL_WIDTH) : undefined;
    const content = drawing(`${stepId}:content`, step.content!, cursor, 24, ACCENT,
      currentTitle ? GROUP_BODY_X : BODY_X, currentTitle ? GROUP_BODY_WIDTH : BODY_WIDTH);
    return { step, stepId, currentTitle, label, content };
  });
  measured.forEach(({ step, stepId, currentTitle, label, content }, index) => {
    if (top + Math.max(label?.height ?? 0, content.height!) > bottom) {
      diagnose(stepId, `白板“${group.group.title}”的第 ${index + 1} 项在 24px 字号下超出单板容量，原讲稿与完整要点已保留`);
      return;
    }
    const needsLabel = currentTitle && currentTitle !== shownTitle;
    const requiredHeight = Math.max(needsLabel ? label?.height ?? 0 : 0, content.height!);
    const startsSubgroup = index === 0 || currentTitle !== measured[index - 1].currentTitle;
    let subgroupHeight = Math.max(label?.height ?? 0, content.height!);
    if (startsSubgroup) {
      for (let next = index + 1; next < measured.length && measured[next].currentTitle === currentTitle; next++) {
        subgroupHeight += GAP + measured[next].content.height!;
      }
    }
    // A subsection that fits on one board must begin with enough room for all
    // its later reveals. Larger subsections still continue across full boards.
    const preserveSubgroup = startsSubgroup && subgroupHeight <= bottom - top
      && cursor + subgroupHeight > bottom;
    const newPage = !started || preserveSubgroup || cursor + requiredHeight > bottom;
    if (newPage) {
      if (!started) add({ id: `${group.id}:open`, type: 'wb_open' }, step);
      page += 1;
      add({ id: `${group.id}:page-${page}:clear`, type: 'wb_clear' }, step);
      add({ ...heading, id: `${group.id}:page-${page}:title` }, step);
      cursor = top;
      shownTitle = undefined;
      previous = undefined;
      started = true;
    } else if (previous) {
      add({ ...previous, id: `${stepId}:previous`, color: INK }, step);
    }
    const placedHeight = Math.max(currentTitle !== shownTitle ? label?.height ?? 0 : 0, content.height!);
    if (currentTitle && currentTitle !== shownTitle && label) {
      add({ ...label, y: cursor }, step);
      shownTitle = currentTitle;
    }
    const placed = { ...content, y: cursor };
    add(placed, step);
    previous = placed;
    cursor += placedHeight + GAP;
    acceptedSteps.push(step);
  });
  // Keep omitted complete facts in the contract so quality review can explain
  // a capacity gap instead of mistaking fewer actions for successful teaching.
  if (acceptedSteps.length > 0) add({ id: `${group.id}:close`, type: 'wb_close' }, group.group.exit);
  return actions;
}

export function compileManuscriptWhiteboards(input: {
  outline: SceneOutline;
  narration: NarrationModuleOutput;
  whiteboards: unknown;
}): {
  actions: BoundWhiteboardAction[];
  issues: ActionBindingIssue[];
  groups: AcceptedGroup[];
  teachingToolPlan?: TeachingToolPlanItem[];
} {
  const issues: ActionBindingIssue[] = [];
  const diagnose = (id: string, message: string) => issues.push({ id: `${id}:whiteboard-diagnostic`, cueId: id,
    severity: 'warning', code: 'missing-required-cue', message });
  const groups: AcceptedGroup[] = [];
  const plans = input.outline.teachingToolPlan ?? [];
  const supplied = input.whiteboards === undefined ? [] : input.whiteboards;
  if (!Array.isArray(supplied)) diagnose(`${input.outline.id}:whiteboards`, '白板编排不是数组，已保留原讲稿');
  for (const [index, value] of (Array.isArray(supplied) ? supplied : []).entries()) {
    let id = `${input.outline.id}:whiteboard-${String(index + 1).padStart(4, '0')}`;
    while (input.narration.segments.some((segment) => segment.id === id || segment.id.startsWith(`${id}:`))) id += ':board';
    const raw = record(value);
    const title = plainText(raw?.title);
    const exit = bind(raw?.exit, input.narration);
    const diagram = raw?.diagram === undefined ? undefined : parseWhiteboardDiagram(raw.diagram);
    if (raw?.diagram !== undefined && !diagram) {
      diagnose(id, `白板分组 ${index + 1} 的图示结构无效，已保留原计划与讲稿`);
      continue;
    }
    if (!title || !Array.isArray(raw?.steps) || raw.steps.length === 0 || !exit) {
      diagnose(id, `白板分组 ${index + 1} 的标题、步骤或退出锚点无效，已保留原讲稿`);
      continue;
    }
    const steps: ManuscriptWhiteboardStep[] = [];
    let previous: Position | undefined;
    for (const [stepIndex, value] of raw.steps.entries()) {
      const step = record(value);
      const binding = bind(value, input.narration);
      const content = plainText(step?.content);
      const stepTitle = step?.title === undefined ? undefined : plainText(step.title);
      const keys = (value: unknown) => Array.isArray(value) && value.every((key) => typeof key === 'string' && key.trim())
        ? value as string[] : undefined;
      const reveal = step?.reveal === undefined ? undefined : keys(step.reveal);
      const emphasize = step?.emphasize === undefined ? undefined : keys(step.emphasize);
      if (!binding || (diagram ? !reveal?.length && !emphasize?.length : !content)
        || step?.reveal !== undefined && !reveal || step?.emphasize !== undefined && !emphasize
        || step?.title !== undefined && !stepTitle
        || previous && compareManuscriptPositions(binding.position, previous) < 0
        || binding && compareManuscriptPositions(binding.position, exit.position) >= 0) {
        diagnose(`${id}:step-${String(stepIndex + 1).padStart(4, '0')}`, `白板“${title}”的第 ${stepIndex + 1} 项内容、讲稿锚点或先后顺序无法核验，已保留原讲稿`);
        continue;
      }
      steps.push({ ...(stepTitle ? { title: stepTitle } : {}), ...(content ? { content } : {}),
        ...(reveal ? { reveal } : {}), ...(emphasize ? { emphasize } : {}),
        speechId: binding.speechId, speechAnchor: binding.speechAnchor });
      previous = binding.position;
    }
    if (!steps.length) continue;
    const first = bind(steps[0], input.narration)!;
    const group: ManuscriptWhiteboardGroup = { ...(typeof raw.planId === 'string' ? { planId: raw.planId } : {}), title,
      ...(diagram ? { diagram } : {}),
      steps, exit: { speechId: exit.speechId, speechAnchor: exit.speechAnchor } };
    groups.push({ id, group, start: first.position, end: exit.position });
  }
  groups.sort((left, right) => compareManuscriptPositions(left.start, right.start));
  const accepted: AcceptedGroup[] = [];
  for (const group of groups) {
    const previous = accepted.at(-1);
    if (previous && compareManuscriptPositions(group.start, previous.end) < 0) {
      diagnose(group.id, `白板“${group.group.title}”与“${previous.group.title}”的讲解时段重叠，已保留原讲稿`);
      continue;
    }
    accepted.push(group);
  }
  const actions = accepted.flatMap((group) => layoutGroup(group, diagnose));
  const matches = (group: AcceptedGroup, plan: TeachingToolPlanItem) => plan.tool === 'whiteboard'
    && (group.group.planId && group.group.planId === plan.id || !group.group.planId && (group.group.title === plan.whiteboard?.title || group.group.title === plan.purpose
      || plan.content.includes(group.group.title)));
  for (const [index, plan] of plans.entries()) {
    if (plan.tool !== 'whiteboard' || plan.required === false || accepted.some((group) => matches(group, plan))) continue;
    diagnose(`${input.outline.id}:whiteboard-plan-${index + 1}`, `白板计划“${plan.purpose}”未生成对应分组，已保留原计划与可播放讲稿`);
  }
  const teachingToolPlan = [...plans];
  for (const group of accepted) {
    const existing = teachingToolPlan.findIndex((plan) => matches(group, plan));
    const previous = existing >= 0 ? teachingToolPlan[existing] : undefined;
    const actual: TeachingToolPlanItem = { ...previous, id: previous?.id ?? `${group.id}:plan`, tool: 'whiteboard',
      trigger: group.group.steps[0].speechAnchor.quote,
      purpose: previous?.purpose ?? `随讲解构建“${group.group.title}”的知识结构与关键关系。`,
      content: [...new Set([...(previous?.content ?? []), ...(group.group.diagram
        ? group.group.diagram.panels.flatMap((panel) => panel.nodes.flatMap((node) => [node.label, ...(node.lines ?? []).map((line) => line.text)]))
        : group.group.steps.flatMap((step) => step.content ? [step.title ? `${step.title}：${step.content}` : step.content] : []))])],
      required: previous?.required ?? true,
      whiteboard: previous?.whiteboard ?? { title: group.group.title, ...(group.group.diagram ? { diagram: group.group.diagram } : {}),
        steps: group.group.steps, exit: group.group.exit } };
    if (existing >= 0) teachingToolPlan[existing] = actual;
    else teachingToolPlan.push(actual);
  }
  return { actions, issues, groups: accepted, ...(teachingToolPlan.length ? { teachingToolPlan } : {}) };
}
