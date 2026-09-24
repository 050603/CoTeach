import { nanoid } from 'nanoid';
import type {
  PPTElement,
  PPTTableElement,
  VisualTargetSelector as DslVisualTargetSelector,
} from '@openmaic/dsl';
import type { Action } from '@openmaic/lib/types/action';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import { createLogger } from '@openmaic/lib/logger';
import { estimateSpeechDurationSec } from '@openmaic/lib/audio/tts-timing';
import {
  findSpeechCueAnchorRange,
  resolveSpeechCueEnd,
  speechCueSentenceEnd,
} from './speech-cue-boundaries';

const log = createLogger('SemanticVisualCues');

export type VisualTargetSelector = DslVisualTargetSelector;

export interface SlideTargetInventoryItem {
  elementId: string;
  type: PPTElement['type'];
  name?: string;
  visibleText?: string;
  geometry: { left: number; top: number; width: number; height: number };
  table?: {
    rows: Array<{
      rowIndex: number;
      cells: Array<{
        cellId: string;
        rowIndex: number;
        columnIndex: number;
        rowspan: number;
        colspan: number;
        text: string;
        rowHeader?: string;
        columnHeader?: string;
        rowContext: string[];
        columnContext: string[];
      }>;
    }>;
  };
  chart?: {
    chartType: string;
    labels: string[];
    legends: string[];
    series: number[][];
  };
  latex?: string;
  imageType?: string;
}

interface NarrationSource {
  speechId: string;
  text: string;
  visualCueAllowed: boolean;
  estimatedDurationSec: number;
  startSec: number;
  barrierBefore: boolean;
  alignment?: {
    status: string;
    spans?: Array<{ startChar: number; endChar: number; startMs: number; endMs: number }>;
  };
}

type CueNecessity = 'essential' | 'helpful' | 'none';

interface ValidFocusCue {
  startSpeechId: string;
  endSpeechId: string;
  action: 'spotlight' | 'laser' | 'none';
  necessity: CueNecessity;
  omissionRisk: string;
  target?: { elementId: string; selector?: VisualTargetSelector };
  startIndex: number;
  endIndex: number;
  startOffsetMs: number;
  startSec: number;
  endSec: number;
  sourceAction?: Extract<Action, { type: 'spotlight' | 'laser' }>;
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => {
      const point = Number(code);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : _match;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => {
      const point = Number.parseInt(code, 16);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : _match;
    });
}

function plainTextFromMarkup(value: string): string {
  return decodeHtmlText(
    value
      .replace(/<br\s*\/?\s*>|<\/(?:p|div|li|h[1-6]|tr|td|th)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  ).replace(/[\t ]+\n/g, '\n').trim();
}

/** Preserve the complete learner-visible copy while removing markup only. */
export function extractVisibleElementText(element: PPTElement): string {
  let raw = '';
  switch (element.type) {
    case 'text':
      raw = element.content;
      break;
    case 'shape':
      raw = element.text?.content ?? '';
      break;
    case 'table':
      raw = element.data.flat().map((cell) => cell.text).join('\n');
      break;
    case 'chart':
      raw = [...element.data.labels, ...element.data.legends].join('\n');
      break;
    case 'latex':
      raw = element.latex;
      break;
    default:
      return '';
  }
  return plainTextFromMarkup(raw);
}

function tableInventory(table: PPTTableElement): NonNullable<SlideTargetInventoryItem['table']> {
  type Placement = {
    cell: PPTTableElement['data'][number][number];
    rowIndex: number;
    columnIndex: number;
  };
  const occupied = new Set<string>();
  const placements: Placement[][] = table.data.map((row, rowIndex) => {
    let columnIndex = 0;
    return row.map((cell) => {
      while (occupied.has(`${rowIndex}:${columnIndex}`)) columnIndex += 1;
      const placement = { cell, rowIndex, columnIndex };
      for (let rowOffset = 0; rowOffset < Math.max(1, cell.rowspan); rowOffset += 1) {
        for (let columnOffset = 0; columnOffset < Math.max(1, cell.colspan); columnOffset += 1) {
          occupied.add(`${rowIndex + rowOffset}:${columnIndex + columnOffset}`);
        }
      }
      columnIndex += Math.max(1, cell.colspan);
      return placement;
    });
  });
  const allPlacements = placements.flat();
  const columnCount = Math.max(
    0,
    ...allPlacements.map((placement) =>
      placement.columnIndex + Math.max(1, placement.cell.colspan)),
  );
  const textAt = (rowIndex: number, columnIndex: number): string => {
    const placement = allPlacements.find((candidate) =>
      candidate.rowIndex <= rowIndex
      && candidate.rowIndex + Math.max(1, candidate.cell.rowspan) > rowIndex
      && candidate.columnIndex <= columnIndex
      && candidate.columnIndex + Math.max(1, candidate.cell.colspan) > columnIndex,
    );
    return plainTextFromMarkup(placement?.cell.text ?? '');
  };
  const rowContext = table.data.map((_row, rowIndex) =>
    Array.from({ length: columnCount }, (_unused, columnIndex) => textAt(rowIndex, columnIndex)),
  );
  const columnContext = Array.from({ length: columnCount }, (_unused, columnIndex) =>
    table.data.map((_row, rowIndex) => textAt(rowIndex, columnIndex)),
  );
  return {
    rows: placements.map((row, rowIndex) => ({
      rowIndex,
      cells: row.map(({ cell, columnIndex }) => ({
        cellId: cell.id,
        rowIndex,
        columnIndex,
        rowspan: cell.rowspan,
        colspan: cell.colspan,
        text: plainTextFromMarkup(cell.text),
        rowHeader: textAt(rowIndex, 0) || undefined,
        columnHeader: textAt(0, columnIndex) || undefined,
        rowContext: rowContext[rowIndex],
        columnContext: columnContext[columnIndex] ?? [],
      })),
    })),
  };
}

/** Build the complete target inventory used by the in-place generator and local validator. */
export function buildSlideTargetInventory(
  elements: readonly PPTElement[],
): SlideTargetInventoryItem[] {
  return elements.map((element) => {
    const visibleText = extractVisibleElementText(element);
    const base: SlideTargetInventoryItem = {
      elementId: element.id,
      type: element.type,
      ...(element.name ? { name: element.name } : {}),
      ...(visibleText ? { visibleText } : {}),
      geometry: {
        left: element.left,
        top: element.top,
        width: element.width,
        height: element.type === 'line'
          ? Math.abs(element.end[1] - element.start[1])
          : element.height,
      },
    };
    if (element.type === 'table') base.table = tableInventory(element);
    if (element.type === 'chart') {
      base.chart = {
        chartType: element.chartType,
        labels: [...element.data.labels],
        legends: [...element.data.legends],
        series: element.data.series.map((series) => [...series]),
      };
    }
    if (element.type === 'latex') base.latex = element.latex;
    if (element.type === 'image' && element.imageType) base.imageType = element.imageType;
    return base;
  });
}

/** Visual cues from the first draft are uncalibrated until the semantic pass succeeds. */
export function removeUncalibratedVisualCues(actions: readonly Action[]): Action[] {
  return actions.filter((action) => action.type !== 'spotlight' && action.type !== 'laser');
}

function narrationSources(
  actions: readonly Action[],
  outline: SceneOutline,
): NarrationSource[] {
  let slideVisible = true;
  let startSec = 0;
  let barrierBeforeNextSpeech = false;
  const sources: NarrationSource[] = [];
  for (const action of actions) {
    if (action.type === 'wb_open') slideVisible = false;
    if (action.type === 'wb_close') slideVisible = true;
    if (action.type === 'speech' && !action.text.trim()) {
      // Empty speech actions carry pauses/page transitions. A focus interval
      // may resume after one, but must never span across it.
      barrierBeforeNextSpeech = true;
      continue;
    }
    if (action.type === 'speech') {
      const timing = outline.timingPlan;
      const estimatedDurationSec = typeof action.audioDurationSec === 'number'
        && Number.isFinite(action.audioDurationSec) && action.audioDurationSec > 0
        ? action.audioDurationSec
        : estimateSpeechDurationSec(action.text, {
            providerId: timing?.providerId,
            modelId: timing?.modelId,
            voiceId: timing?.voiceId,
            language: timing?.language,
            speed: action.speed ?? timing?.speed,
            minSeconds: 0,
          });
      sources.push({
        speechId: action.id,
        text: action.text,
        visualCueAllowed: slideVisible,
        estimatedDurationSec,
        startSec,
        barrierBefore: sources.length > 0 && barrierBeforeNextSpeech,
        alignment: (action as typeof action & { speechAlignment?: NarrationSource['alignment'] })
          .speechAlignment,
      });
      startSec += estimatedDurationSec;
      barrierBeforeNextSpeech = false;
      continue;
    }
    if (
      action.type === 'play_video'
      || action.type === 'discussion'
      || action.type.startsWith('wb_')
      || action.type.startsWith('widget_')
    ) {
      barrierBeforeNextSpeech = true;
    }
  }
  return sources;
}

function occurrenceCount(text: string, quote: string): number {
  if (!quote) return 0;
  let count = 0;
  let from = 0;
  while (from <= text.length - quote.length) {
    const index = text.indexOf(quote, from);
    if (index < 0) break;
    count += 1;
    from = index + Math.max(1, quote.length);
  }
  return count;
}

function occurrenceIndex(text: string, quote: string, occurrence: number): number {
  let fromIndex = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    const found = text.indexOf(quote, fromIndex);
    if (found < 0) return -1;
    if (index === occurrence) return found;
    fromIndex = found + Math.max(1, quote.length);
  }
  return -1;
}

function alignedOffsetAt(
  source: NarrationSource,
  charIndex: number,
  edge: 'start' | 'end',
): number | undefined {
  if (source.alignment?.status !== 'aligned' || !source.alignment.spans?.length) return undefined;
  const bounded = Math.max(0, Math.min(source.text.length, charIndex));
  const containing = source.alignment.spans.find((span) => (
    edge === 'start'
      ? span.startChar <= bounded && span.endChar > bounded
      : span.startChar < bounded && span.endChar >= bounded
  ));
  if (containing) return edge === 'start' ? containing.startMs : containing.endMs;
  const nearest = edge === 'start'
    ? source.alignment.spans.find((span) => span.startChar >= bounded)
    : [...source.alignment.spans].reverse().find((span) => span.endChar <= bounded);
  return nearest ? (edge === 'start' ? nearest.startMs : nearest.endMs) : undefined;
}

function resolveAlignedAnchorOffset(
  source: NarrationSource,
  anchor: { quote: string; occurrence?: number },
  edge: 'start' | 'end' = 'start',
): number | undefined {
  const anchorIndex = occurrenceIndex(source.text, anchor.quote, anchor.occurrence ?? 0);
  if (anchorIndex < 0) return undefined;
  return alignedOffsetAt(source, edge === 'start' ? anchorIndex : anchorIndex + anchor.quote.length, edge);
}

function validateTarget(
  action: ValidFocusCue['action'],
  targetValue: ValidFocusCue['target'],
  inventoryById: ReadonlyMap<string, SlideTargetInventoryItem>,
): boolean {
  if (action === 'none') return targetValue === undefined;
  if (!targetValue) return false;
  const inventoryTarget = inventoryById.get(targetValue.elementId);
  if (!inventoryTarget) return false;
  if (!targetValue.selector) return true;
  if ('cellId' in targetValue.selector) {
    const cellId = targetValue.selector.cellId;
    if (inventoryTarget.type !== 'table') return false;
    const cell = inventoryTarget.table?.rows
      .flatMap((row) => row.cells)
      .find((candidate) => candidate.cellId === cellId);
    if (!cell) return false;
    if (!targetValue.selector.quote) return true;
    return occurrenceCount(cell.text, targetValue.selector.quote)
      > (targetValue.selector.occurrence ?? 0);
  }
  if ('rowIndex' in targetValue.selector) {
    if (inventoryTarget.type !== 'table') return false;
    const row = inventoryTarget.table?.rows[targetValue.selector.rowIndex];
    if (!row) return false;
    if (!targetValue.selector.quote) return true;
    const rowText = row.cells.map((cell) => cell.text).join('\n');
    return occurrenceCount(rowText, targetValue.selector.quote)
      > (targetValue.selector.occurrence ?? 0);
  }
  const occurrence = targetValue.selector.occurrence ?? 0;
  return occurrenceCount(inventoryTarget.visibleText ?? '', targetValue.selector.quote) > occurrence;
}

/** Shared exact-target check for authored cues and post-TTS calibration. */
export function isValidSlideVisualTarget(
  elements: readonly PPTElement[],
  target: { elementId: string; selector?: VisualTargetSelector },
): boolean {
  const inventory = buildSlideTargetInventory(elements);
  return validateTarget(
    'spotlight',
    target,
    new Map(inventory.map((item) => [item.elementId, item])),
  );
}

function targetKey(cue: ValidFocusCue): string {
  if (!cue.target) return 'none';
  const selector = cue.target.selector;
  const primary = !selector
    ? `${cue.target.elementId}:whole`
    : 'cellId' in selector
    ? `${cue.target.elementId}:cell:${selector.cellId}:${selector.quote ?? ''}:${selector.occurrence ?? 0}`
    : 'rowIndex' in selector
    ? `${cue.target.elementId}:row:${selector.rowIndex}:${selector.quote ?? ''}:${selector.occurrence ?? 0}`
    : `${cue.target.elementId}:quote:${selector.quote}:${selector.occurrence ?? 0}`;
  const waypoints = cue.sourceAction?.type === 'laser'
    ? cue.sourceAction.waypoints?.map((waypoint) => JSON.stringify(waypoint)).join('>')
    : undefined;
  return waypoints ? `${primary}:path:${waypoints}` : primary;
}

const TRANSITION_ONLY = /^(?:好[，,。！？!?]?)?(?:下面|接下来|然后|现在|首先|最后|随后)(?:让我们|我们)?(?:进入|来看|看一下|继续|转到|回到)(?:下一|下一个|这一|本页|这个)?(?:部分|环节|页面|主题|内容)?[。！？.!?]?$/u;

function isTransitionOnlyCue(
  cue: ValidFocusCue,
  narration: readonly NarrationSource[],
): boolean {
  const text = narration
    .slice(cue.startIndex, cue.endIndex + 1)
    .map((source) => source.text.trim())
    .join('');
  return text.length <= 40 && TRANSITION_ONLY.test(text);
}

function priority(cue: ValidFocusCue): [number, number, number] {
  return [
    cue.necessity === 'essential' ? 2 : cue.necessity === 'helpful' ? 1 : 0,
    cue.target?.selector ? 1 : 0,
    cue.action === 'spotlight' ? 1 : 0,
  ];
}

function comparePriority(left: ValidFocusCue, right: ValidFocusCue): number {
  const leftPriority = priority(left);
  const rightPriority = priority(right);
  for (let index = 0; index < leftPriority.length; index += 1) {
    if (leftPriority[index] !== rightPriority[index]) {
      return leftPriority[index]! - rightPriority[index]!;
    }
  }
  return 0;
}

function intervalsOverlap(left: ValidFocusCue, right: ValidFocusCue): boolean {
  return left.startSec < right.endSec && right.startSec < left.endSec;
}

function preferPreciseTargets(cues: readonly ValidFocusCue[]): ValidFocusCue[] {
  return cues.filter((cue) => !cues.some((candidate) => {
    if (candidate === cue || !candidate.target?.selector || cue.target?.selector) return false;
    if (candidate.target.elementId !== cue.target?.elementId || !intervalsOverlap(candidate, cue)) return false;
    return comparePriority(candidate, cue) >= 0;
  }));
}

function combineOmissionRisk(left: string, right: string): string {
  return left === right ? left : `${left}；${right}`;
}

function crossesPlaybackBoundary(
  startIndex: number,
  endIndex: number,
  narration: readonly NarrationSource[],
): boolean {
  return narration.slice(startIndex + 1, endIndex + 1).some((source) => source.barrierBefore);
}

function mergeAdjacentSpotlights(
  cues: readonly ValidFocusCue[],
  narration: readonly NarrationSource[],
): ValidFocusCue[] {
  const merged: ValidFocusCue[] = [];
  for (const cue of [...cues].sort((left, right) => left.startIndex - right.startIndex || left.endIndex - right.endIndex)) {
    const previous = merged.at(-1);
    if (
      previous
      && previous.action === 'spotlight'
      && cue.action === 'spotlight'
      && targetKey(previous) === targetKey(cue)
      && cue.startIndex <= previous.endIndex + 1
      && cue.startOffsetMs === 0
      && !crossesPlaybackBoundary(previous.startIndex, cue.endIndex, narration)
    ) {
      const stronger = comparePriority(cue, previous) > 0 ? cue : previous;
      merged[merged.length - 1] = {
        ...previous,
        endSpeechId: cue.endIndex > previous.endIndex ? cue.endSpeechId : previous.endSpeechId,
        endIndex: Math.max(previous.endIndex, cue.endIndex),
        necessity: stronger.necessity,
        omissionRisk: combineOmissionRisk(previous.omissionRisk, cue.omissionRisk),
      };
      continue;
    }
    merged.push(cue);
  }
  return merged;
}

function suppressOverlappingSameTarget(cues: readonly ValidFocusCue[]): ValidFocusCue[] {
  const stable: ValidFocusCue[] = [];
  for (const cue of cues) {
    const previous = stable.at(-1);
    if (
      previous
      && targetKey(previous) === targetKey(cue)
      && intervalsOverlap(previous, cue)
    ) {
      if (comparePriority(cue, previous) > 0) stable[stable.length - 1] = cue;
      continue;
    }
    stable.push(cue);
  }
  return stable;
}

function stabilizeFocusCues(
  cues: readonly ValidFocusCue[],
  narration: readonly NarrationSource[],
): ValidFocusCue[] {
  let stable = cues
    .filter((cue) => (
      cue.action !== 'none'
      && cue.necessity !== 'none'
      && cue.target
      && !isTransitionOnlyCue(cue, narration)
    ))
    .sort((left, right) => (
      left.startIndex - right.startIndex
      || left.startOffsetMs - right.startOffsetMs
      || left.endIndex - right.endIndex
    ));
  stable = preferPreciseTargets(stable);
  stable = mergeAdjacentSpotlights(stable, narration);
  stable = suppressOverlappingSameTarget(stable);
  // Preserve intentional target changes and later returns to a prior object.
  // The narration author chooses cue count from teaching need; calibration only
  // verifies references, removes duplicates and attaches measured timing.
  return mergeAdjacentSpotlights(stable, narration);
}

function cueAction(cue: ValidFocusCue): Action | undefined {
  if (cue.action === 'none' || !cue.target) return undefined;
  const base = {
    ...cue.sourceAction,
    id: cue.sourceAction?.id ?? `action_${nanoid(8)}`,
    type: cue.action,
    elementId: cue.target.elementId,
    ...(cue.target.selector ? { selector: cue.target.selector } : {}),
    speechId: cue.startSpeechId,
    ...(cue.startOffsetMs > 0 ? { speechOffsetMs: Math.round(cue.startOffsetMs) } : {}),
    necessity: cue.necessity,
    omissionRisk: cue.omissionRisk,
    description: cue.omissionRisk,
  };
  return cue.action === 'spotlight'
    ? { ...base, endSpeechId: cue.endSpeechId } as Action
    : base as Action;
}

function applyCuePlan(actions: readonly Action[], cues: readonly ValidFocusCue[]): Action[] {
  const byStartSpeech = new Map<string, ValidFocusCue[]>();
  for (const cue of cues) {
    const group = byStartSpeech.get(cue.startSpeechId) ?? [];
    group.push(cue);
    byStartSpeech.set(cue.startSpeechId, group);
  }
  const result: Action[] = [];
  for (const action of removeUncalibratedVisualCues(actions)) {
    if (action.type === 'speech') {
      for (const cue of byStartSpeech.get(action.id) ?? []) {
        const visualAction = cueAction(cue);
        if (visualAction) result.push(visualAction);
      }
    }
    result.push(action);
  }
  return result;
}

type AuthoredVisualTarget = {
  elementId: string;
  selector?: VisualTargetSelector;
  speechAnchor?: { quote: string; occurrence?: number };
};

function actionTargets(action: Extract<Action, { type: 'laser' }>): AuthoredVisualTarget[] {
  return [
    {
      elementId: action.elementId,
      ...(action.selector ? { selector: action.selector } : {}),
      ...(action.speechAnchor ? { speechAnchor: action.speechAnchor } : {}),
    },
    ...(action.waypoints ?? []),
  ];
}

function isTextualTarget(
  target: AuthoredVisualTarget,
  inventory: ReadonlyMap<string, SlideTargetInventoryItem>,
): boolean {
  const item = inventory.get(target.elementId);
  return Boolean(
    target.selector
    || item?.type === 'text'
    || item?.type === 'table'
    || item?.type === 'latex'
    || (item?.type === 'shape' && item.visibleText),
  );
}

function sequenceStartIndex(text: string): number {
  const markers = ['顺序', '流程', '步骤', '依次', '路径', '先'];
  const indexes = markers.map((marker) => text.indexOf(marker)).filter((index) => index >= 0);
  return indexes.length ? Math.min(...indexes) : -1;
}

function anchorIndex(text: string, anchor: { quote: string; occurrence?: number } | undefined): number {
  return anchor ? occurrenceIndex(text, anchor.quote, anchor.occurrence ?? 0) : -1;
}

function hasStrongOrderedPath(action: Extract<Action, { type: 'laser' }>, speechText: string): boolean {
  const targets = actionTargets(action);
  // A text path needs at least three stages. This prevents an ordinary
  // two-item comparison from being mistaken for a process animation.
  if (targets.length < 3) return false;
  const sequenceStart = sequenceStartIndex(speechText);
  if (sequenceStart < 0) return false;
  let previous = sequenceStart - 1;
  return targets.every((target) => {
    const index = anchorIndex(speechText, target.speechAnchor);
    if (index < sequenceStart || index <= previous) return false;
    previous = index;
    return true;
  });
}

function spotlightFromLaserTarget(
  action: Extract<Action, { type: 'laser' }>,
  target: AuthoredVisualTarget,
  index: number,
): Extract<Action, { type: 'spotlight' }> | undefined {
  if (!action.speechId) return undefined;
  return {
    id: index === 0 ? action.id : `${action.id}:focus-${index + 1}`,
    type: 'spotlight',
    elementId: target.elementId,
    ...(target.selector ? { selector: target.selector } : {}),
    speechId: action.speechId,
    ...(target.speechAnchor ? { speechAnchor: target.speechAnchor } : {}),
    endSpeechId: action.speechId,
    necessity: action.necessity ?? 'helpful',
    omissionRisk: action.omissionRisk ?? '框选当前文字内容可避免激光点遮挡并保持阅读焦点。',
    description: action.description,
  };
}

function rowLabel(row: NonNullable<SlideTargetInventoryItem['table']>['rows'][number]): string | undefined {
  return row.cells.map((cell) => cell.text.trim()).find(Boolean);
}

function hasHeaderRow(table: NonNullable<SlideTargetInventoryItem['table']>): boolean {
  const headers = /^(?:层级|学段|定义|定义与作用|作用|名称|项目|维度|指标|阶段|步骤|类别|类型|特征|稳定性|可调整性|对应例子|内容|说明|对象|标准)$/u;
  return table.rows[0]?.cells.some((cell) => headers.test(cell.text.trim())) ?? false;
}

function occurrenceAt(text: string, quote: string, foundIndex: number): number {
  let occurrence = 0;
  let offset = 0;
  while (offset < foundIndex) {
    const found = text.indexOf(quote, offset);
    if (found < 0 || found >= foundIndex) break;
    occurrence += 1;
    offset = found + Math.max(1, quote.length);
  }
  return occurrence;
}

function sequenceQuoteCandidates(visibleText: string): string[] {
  const compact = visibleText.replace(/^[①②③④⑤⑥⑦⑧⑨⑩\d.、)）\s]+/u, '').trim();
  const candidates = [compact];
  if (/^教学[\p{Script=Han}]{2,6}$/u.test(compact)) candidates.push(compact.slice(2));
  return Array.from(new Set(candidates.filter((candidate) => {
    const meaningful = candidate.replace(/[\s\p{P}\p{S}]+/gu, '');
    const han = meaningful.match(/\p{Script=Han}/gu)?.length ?? 0;
    const alphaNumeric = meaningful.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
    return han >= 2 || alphaNumeric >= 3;
  }))).sort((left, right) => right.length - left.length);
}

function synthesizeOrderedLaser(
  speech: Extract<Action, { type: 'speech' }>,
  inventory: readonly SlideTargetInventoryItem[],
): Extract<Action, { type: 'laser' }> | undefined {
  const sequenceStart = sequenceStartIndex(speech.text);
  if (sequenceStart < 0) return undefined;
  const matches = inventory.flatMap((item) => {
    if (!item.visibleText || !['text', 'shape'].includes(item.type)) return [];
    const visibleText = item.visibleText.trim();
    if (!visibleText || visibleText.length > 18) return [];
    const candidates = sequenceQuoteCandidates(visibleText)
      .flatMap((quote) => {
        const index = speech.text.indexOf(quote, sequenceStart);
        return index >= 0 ? [{ quote, index }] : [];
      });
    const match = candidates.sort((left, right) => left.index - right.index || right.quote.length - left.quote.length)[0];
    return match ? [{ item, ...match }] : [];
  }).sort((left, right) => left.index - right.index || left.item.geometry.top - right.item.geometry.top);

  const unique = matches.filter((match, index, all) => (
    all.findIndex((candidate) => candidate.index === match.index) === index
  )).slice(0, 5);
  if (unique.length < 3) return undefined;
  const [first, ...rest] = unique;
  const speechAnchor = {
    quote: first!.quote,
    occurrence: occurrenceAt(speech.text, first!.quote, first!.index),
  };
  return {
    id: `${speech.id}:ordered-path`,
    type: 'laser',
    elementId: first!.item.elementId,
    speechId: speech.id,
    speechAnchor,
    waypoints: rest.map((match) => ({
      elementId: match.item.elementId,
      speechAnchor: {
        quote: match.quote,
        occurrence: occurrenceAt(speech.text, match.quote, match.index),
      },
    })),
    necessity: 'helpful',
    omissionRisk: '顺序或流程需要沿着页面节点依次指示。',
    description: '按朗读顺序短暂移动激光笔。',
  };
}

/**
 * Normalize tool choice before timing calibration. Text and table explanation
 * uses a stable frame; laser paths are reserved for real ordered traversal.
 * Missing table-row and process cues are recovered from exact visible labels
 * and exact narration substrings, without asking a model to guess coordinates.
 */
export function refineVisualCueDesign(input: {
  elements: readonly PPTElement[];
  actions: readonly Action[];
}): Action[] {
  const inventory = buildSlideTargetInventory(input.elements);
  const inventoryById = new Map(inventory.map((item) => [item.elementId, item]));
  const speechById = new Map(input.actions.flatMap((action) => (
    action.type === 'speech' ? [[action.id, action] as const] : []
  )));

  const followingSpeechId = (actionIndex: number): string | undefined => {
    for (let index = actionIndex + 1; index < input.actions.length; index += 1) {
      const candidate = input.actions[index]!;
      if (candidate.type === 'spotlight' || candidate.type === 'laser') continue;
      return candidate.type === 'speech' && candidate.text.trim() ? candidate.id : undefined;
    }
    return undefined;
  };

  let actions = input.actions.flatMap((action, actionIndex): Action[] => {
    if (action.type !== 'laser') return [action];
    const speechId = action.speechId ?? followingSpeechId(actionIndex);
    const boundAction = speechId ? { ...action, speechId } : action;
    const targets = actionTargets(boundAction);
    if (!targets.every((target) => isTextualTarget(target, inventoryById))) return [action];
    const speech = speechId ? speechById.get(speechId) : undefined;
    if (speech && hasStrongOrderedPath(boundAction, speech.text)) return [boundAction];
    const spotlights = targets.flatMap((target, index) => {
      const spotlight = spotlightFromLaserTarget(boundAction, target, index);
      return spotlight ? [spotlight] : [];
    });
    return spotlights.length ? spotlights : [];
  });

  const synthesizedRows: Extract<Action, { type: 'spotlight' }>[] = [];
  for (const item of inventory) {
    if (item.type !== 'table' || !item.table || item.table.rows.length < 3 || !hasHeaderRow(item.table)) continue;
    const existingRows = new Set(actions.flatMap((action) => {
      if (action.type !== 'spotlight' || action.elementId !== item.elementId || !action.selector) return [];
      if ('rowIndex' in action.selector) return [action.selector.rowIndex];
      if ('cellId' in action.selector) {
        const cellId = action.selector.cellId;
        const row = item.table?.rows.find((candidate) => (
          candidate.cells.some((cell) => cell.cellId === cellId)
        ));
        return row ? [row.rowIndex] : [];
      }
      return [];
    }));
    for (const row of item.table.rows.slice(1)) {
      if (existingRows.has(row.rowIndex)) continue;
      const label = rowLabel(row);
      if (!label || label.length > 40) continue;
      const match = input.actions.flatMap((action, actionIndex) => {
        if (action.type !== 'speech') return [];
        const index = action.text.indexOf(label);
        return index >= 0 ? [{ speech: action, actionIndex, index }] : [];
      }).sort((left, right) => left.actionIndex - right.actionIndex || left.index - right.index)[0];
      if (!match) continue;
      synthesizedRows.push({
        id: `${match.speech.id}:table-${item.elementId}-row-${row.rowIndex}`,
        type: 'spotlight',
        elementId: item.elementId,
        selector: { rowIndex: row.rowIndex },
        speechId: match.speech.id,
        speechAnchor: {
          quote: label,
          occurrence: occurrenceAt(match.speech.text, label, match.index),
        },
        endSpeechId: match.speech.id,
        necessity: 'helpful',
        omissionRisk: `讲解“${label}”时需要框选对应表格整行。`,
        description: '随讲解逐行框选表格。',
      });
    }
    if (synthesizedRows.some((action) => action.elementId === item.elementId)) {
      actions = actions.filter((action) => !(
        action.type === 'spotlight'
        && action.elementId === item.elementId
        && !action.selector
      ));
    }
  }
  actions.push(...synthesizedRows);

  for (const speech of speechById.values()) {
    const existingPath = actions.some((action) => (
      action.type === 'laser'
      && action.speechId === speech.id
      && (action.waypoints?.length ?? 0) >= 2
    ));
    if (existingPath) continue;
    const path = synthesizeOrderedLaser(speech, inventory);
    if (!path) continue;
    const pathStart = anchorIndex(speech.text, path.speechAnchor);
    const latestPriorSpotlightStart = Math.max(-1, ...actions.flatMap((action) => (
      action.type === 'spotlight'
      && action.speechId === speech.id
      && action.speechAnchor
      && anchorIndex(speech.text, action.speechAnchor) < pathStart
        ? [anchorIndex(speech.text, action.speechAnchor)]
        : []
    )));
    actions = actions.map((action) => (
      action.type === 'spotlight'
      && action.speechId === speech.id
      && action.speechAnchor
      && anchorIndex(speech.text, action.speechAnchor) === latestPriorSpotlightStart
      && speechCueSentenceEnd(
        speech.text,
        latestPriorSpotlightStart + action.speechAnchor.quote.length,
      ) > pathStart
      && !action.endSpeechAnchor
        ? { ...action, endSpeechAnchor: path.speechAnchor }
        : action
    )).filter((action) => !(
      action.type === 'spotlight'
      && action.speechId === speech.id
      && action.speechAnchor
      && anchorIndex(speech.text, action.speechAnchor) >= pathStart
      && !(action.selector && 'rowIndex' in action.selector)
    ));
    actions.push(path);
  }
  return actions;
}

/**
 * Calibrate visual actions already interleaved by the original OpenMAIC action
 * generator. This performs no model call and never rewrites narration.
 */
export function calibrateGeneratedVisualCues(input: {
  outline: SceneOutline;
  elements: readonly PPTElement[];
  actions: readonly Action[];
}): Action[] {
  const refinedActions = refineVisualCueDesign({ elements: input.elements, actions: input.actions });
  const narration = narrationSources(refinedActions, input.outline);
  const inventory = buildSlideTargetInventory(input.elements);
  if (narration.length === 0 || inventory.length === 0) {
    return removeUncalibratedVisualCues(refinedActions);
  }
  const narrationIndex = new Map(narration.map((source, index) => [source.speechId, index]));
  const inventoryById = new Map(inventory.map((item) => [item.elementId, item]));
  const candidates: ValidFocusCue[] = [];
  const pending: Action[] = [];

  const nextSpeechId = (actionIndex: number): string | undefined => {
    for (let index = actionIndex + 1; index < refinedActions.length; index += 1) {
      const candidate = refinedActions[index]!;
      if (candidate.type === 'spotlight' || candidate.type === 'laser') continue;
      if (candidate.type === 'speech') return candidate.text.trim() ? candidate.id : undefined;
      return undefined;
    }
    return undefined;
  };

  refinedActions.forEach((action, actionIndex) => {
    if (action.type !== 'spotlight' && action.type !== 'laser') return;
    const startSpeechId = action.speechId ?? nextSpeechId(actionIndex);
    const endSpeechId = action.type === 'spotlight'
      ? (action.endSpeechId ?? startSpeechId)
      : startSpeechId;
    if (!startSpeechId || !endSpeechId) {
      log.warn(`Dropped unbound generated visual cue ${action.id}`);
      return;
    }
    const startIndex = narrationIndex.get(startSpeechId);
    const endIndex = narrationIndex.get(endSpeechId);
    if (startIndex === undefined || endIndex === undefined || endIndex < startIndex) {
      log.warn(`Dropped generated visual cue ${action.id} with an invalid speech range`);
      return;
    }
    const target = { elementId: action.elementId, ...(action.selector ? { selector: action.selector } : {}) };
    const waypointsValid = action.type !== 'laser' || (action.waypoints ?? []).every((waypoint) => (
      validateTarget(
        'laser',
        { elementId: waypoint.elementId, ...(waypoint.selector ? { selector: waypoint.selector } : {}) },
        inventoryById,
      )
    ));
    if (!validateTarget(action.type, target, inventoryById) || !waypointsValid) {
      log.warn(`Dropped generated visual cue ${action.id} with unverifiable target evidence`);
      return;
    }
    if (
      narration.slice(startIndex, endIndex + 1).some((source) => !source.visualCueAllowed)
      || crossesPlaybackBoundary(startIndex, endIndex, narration)
    ) {
      log.warn(`Dropped generated visual cue ${action.id} across a hidden-slide boundary`);
      return;
    }
    const speechAnchor = action.speechAnchor;
    const anchorIndex = speechAnchor
      ? occurrenceIndex(
          narration[startIndex]!.text,
          speechAnchor.quote,
          speechAnchor.occurrence ?? 0,
        )
      : 0;
    if (speechAnchor && anchorIndex < 0) {
      log.warn(`Dropped generated visual cue ${action.id} with a missing narration anchor`);
      return;
    }
    const startSource = narration[startIndex]!;
    const startOffsetMs = speechAnchor
      ? resolveAlignedAnchorOffset(startSource, speechAnchor)
      : Math.max(0, action.speechOffsetMs ?? 0);
    if (startOffsetMs === undefined) {
      // Preserve authored intent until audio alignment is available. Playback
      // already withholds anchored cues without verified timing.
      pending.push({ ...action, speechId: startSpeechId });
      return;
    }
    if (startOffsetMs >= startSource.estimatedDurationSec * 1000) {
      log.warn(`Dropped generated visual cue ${action.id} with an out-of-range speech offset`);
      return;
    }
    const explicitEndAnchor = action.endSpeechAnchor;
    const implicitAnchoredEnd = Boolean(speechAnchor && !explicitEndAnchor);
    const effectiveEndIndex = implicitAnchoredEnd ? startIndex : endIndex;
    const effectiveEndSpeechId = narration[effectiveEndIndex]!.speechId;
    const endSource = narration[effectiveEndIndex]!;
    const defaultEndChar = speechAnchor
      ? speechCueSentenceEnd(
          startSource.text,
          findSpeechCueAnchorRange(startSource.text, speechAnchor)?.end
            ?? anchorIndex + speechAnchor.quote.length,
        )
      : startSource.text.length;
    const endSpeechOffsetMs = explicitEndAnchor
      ? resolveAlignedAnchorOffset(endSource, explicitEndAnchor, 'end')
      : alignedOffsetAt(
          endSource,
          effectiveEndIndex === startIndex ? defaultEndChar : endSource.text.length,
          'end',
        );
    if (explicitEndAnchor && endSpeechOffsetMs === undefined) {
      log.warn(`Dropped generated visual cue ${action.id} with a missing narration end anchor`);
      return;
    }
    const timedWaypoints = action.type === 'laser'
      ? (action.waypoints ?? []).map((waypoint) => {
          if (!waypoint.speechAnchor) return undefined;
          const speechOffsetMs = resolveAlignedAnchorOffset(startSource, waypoint.speechAnchor);
          return speechOffsetMs === undefined ? undefined : { ...waypoint, speechOffsetMs };
        })
      : [];
    if (action.type === 'laser' && (action.waypoints?.length ?? 0) !== timedWaypoints.length) {
      log.warn(`Dropped generated visual cue ${action.id} because a laser waypoint lacks precise narration timing`);
      return;
    }
    const timedAction = {
      ...action,
      ...(action.type === 'spotlight' && implicitAnchoredEnd
        ? { endSpeechId: effectiveEndSpeechId }
        : {}),
      speechOffsetMs: startOffsetMs,
      ...(endSpeechOffsetMs !== undefined ? { endSpeechOffsetMs } : {}),
      ...(action.type === 'laser' && timedWaypoints.length ? { waypoints: timedWaypoints } : {}),
    } as typeof action;
    const endSec = endSource.startSec + (
      endSpeechOffsetMs ?? endSource.estimatedDurationSec * 1000
    ) / 1000;
    candidates.push({
      startSpeechId,
      endSpeechId: effectiveEndSpeechId,
      action: action.type,
      necessity: action.necessity === 'essential' ? 'essential' : 'helpful',
      omissionRisk: action.omissionRisk?.trim() || action.description?.trim()
        || 'The generated action directly maps this narration to visible slide evidence.',
      target,
      startIndex,
      endIndex,
      startOffsetMs,
      startSec: narration[startIndex]!.startSec + startOffsetMs / 1000,
      endSec,
      sourceAction: timedAction,
    });
  });

  const ordered = [...stabilizeFocusCues(candidates, narration)].sort((left, right) => (
    left.startIndex - right.startIndex || left.startOffsetMs - right.startOffsetMs
  ));
  const boundedCandidates = ordered.map((cue, index) => {
    if (cue.sourceAction?.endSpeechAnchor) return cue;
    const next = ordered.slice(index + 1).find((candidate) => (
      candidate.startIndex === cue.startIndex
      && candidate.startOffsetMs >= cue.startOffsetMs
    ));
    if (!next || !cue.sourceAction) return cue;
    const defaultEnd = cue.sourceAction.endSpeechOffsetMs
      ?? Math.max(cue.startOffsetMs, (cue.endSec - narration[cue.startIndex]!.startSec) * 1000);
    const endSpeechOffsetMs = resolveSpeechCueEnd({
      start: cue.startOffsetMs,
      defaultEnd,
      nextStart: next.startOffsetMs,
    });
    if (endSpeechOffsetMs === cue.sourceAction.endSpeechOffsetMs) return cue;
    return {
      ...cue,
      endSec: narration[cue.startIndex]!.startSec + endSpeechOffsetMs / 1000,
      sourceAction: { ...cue.sourceAction, endSpeechOffsetMs },
    };
  });

  const calibrated = applyCuePlan(refinedActions, boundedCandidates);
  return calibrated.flatMap((action) => action.type === 'speech'
    ? [...pending.filter((cue) => (cue.type === 'spotlight' || cue.type === 'laser') && cue.speechId === action.id), action]
    : [action]);
}

export type VisualCueAnchorRepairIssue = {
  actionId: string;
  speechId?: string;
  reason: string;
};

function exactOccurrenceCount(text: string, quote: string): number {
  return occurrenceCount(text, quote);
}

function usableRecoveredQuote(value: string): boolean {
  const compact = value.replace(/[\s\p{P}\p{S}]+/gu, '');
  if (/^(?:我们|这个|这里|可以|看到|来看|然后|接下来)$/u.test(compact)) return false;
  const hanCount = (compact.match(/\p{Script=Han}/gu) ?? []).length;
  const wordCount = (compact.match(/[\p{L}\p{N}]/gu) ?? []).length;
  return hanCount >= 2 || wordCount >= 3;
}

/** Find a conservative exact quote from narration that is visibly supported by the target. */
function recoverExactQuote(narration: string, targetText: string): string | undefined {
  if (!narration || !targetText) return undefined;
  const source = narration.toLocaleLowerCase();
  const target = targetText.toLocaleLowerCase();
  let previous = new Array<number>(target.length + 1).fill(0);
  let bestLength = 0;
  let bestEnd = 0;
  for (let sourceIndex = 1; sourceIndex <= source.length; sourceIndex += 1) {
    const current = new Array<number>(target.length + 1).fill(0);
    for (let targetIndex = 1; targetIndex <= target.length; targetIndex += 1) {
      if (source[sourceIndex - 1] !== target[targetIndex - 1]) continue;
      current[targetIndex] = previous[targetIndex - 1]! + 1;
      if (current[targetIndex]! > bestLength) {
        bestLength = current[targetIndex]!;
        bestEnd = sourceIndex;
      }
    }
    previous = current;
  }
  if (!bestLength) return undefined;
  const raw = narration.slice(bestEnd - bestLength, bestEnd);
  const leading = raw.match(/^[\s\p{P}\p{S}]+/u)?.[0].length ?? 0;
  const trailing = raw.match(/[\s\p{P}\p{S}]+$/u)?.[0].length ?? 0;
  const quote = raw.slice(leading, raw.length - trailing);
  return quote && usableRecoveredQuote(quote) ? quote : undefined;
}

function targetEvidenceText(
  inventory: ReadonlyMap<string, SlideTargetInventoryItem>,
  target: { elementId: string; selector?: VisualTargetSelector },
): string | undefined {
  const item = inventory.get(target.elementId);
  if (!item) return undefined;
  if (target.selector && 'cellId' in target.selector) {
    const cellId = target.selector.cellId;
    const cell = item.table?.rows.flatMap((row) => row.cells)
      .find((candidate) => candidate.cellId === cellId);
    if (!cell) return undefined;
    const directEvidence = [target.selector.quote, cell.text]
      .filter((value): value is string => Boolean(value?.trim()))
      .join('\n');
    return directEvidence || [...cell.rowContext, ...cell.columnContext]
      .filter((value) => Boolean(value.trim()))
      .join('\n');
  }
  if (target.selector && 'rowIndex' in target.selector) {
    const row = item.table?.rows[target.selector.rowIndex];
    if (!row) return undefined;
    return [target.selector.quote, ...row.cells.map((cell) => cell.text)]
      .filter((value): value is string => Boolean(value?.trim()))
      .join('\n');
  }
  return [target.selector?.quote, item.visibleText, item.name]
    .filter((value): value is string => Boolean(value?.trim()))
    .join('\n');
}

/**
 * Recover missing anchors in an old course without rewriting its narration.
 * Only exact overlap between the fixed script and actual target text is used;
 * ambiguous or stale targets are removed so repair cannot re-enable guessed cues.
 */
export function recoverLegacyVisualCueAnchors(input: {
  elements: readonly PPTElement[];
  actions: readonly Action[];
}): { actions: Action[]; issues: VisualCueAnchorRepairIssue[] } {
  const speechById = new Map(input.actions.flatMap((action) => (
    action.type === 'speech' ? [[action.id, action] as const] : []
  )));
  const inventory = new Map(buildSlideTargetInventory(input.elements)
    .map((item) => [item.elementId, item]));
  const consumed = new Map<string, number>();
  const issues: VisualCueAnchorRepairIssue[] = [];

  const nextSpeechId = (actionIndex: number): string | undefined => {
    for (let index = actionIndex + 1; index < input.actions.length; index += 1) {
      const candidate = input.actions[index]!;
      if (candidate.type === 'spotlight' || candidate.type === 'laser') continue;
      return candidate.type === 'speech' && candidate.text.trim() ? candidate.id : undefined;
    }
    return undefined;
  };
  const anchorFor = (
    speechId: string,
    target: { elementId: string; selector?: VisualTargetSelector },
    existing?: { quote: string; occurrence?: number },
  ) => {
    const speech = speechById.get(speechId);
    if (!speech) return undefined;
    if (existing && occurrenceIndex(speech.text, existing.quote, existing.occurrence ?? 0) >= 0) {
      const key = `${speechId}\u0000${existing.quote}`;
      consumed.set(key, Math.max(consumed.get(key) ?? 0, (existing.occurrence ?? 0) + 1));
      return existing;
    }
    const evidence = targetEvidenceText(inventory, target);
    if (!evidence) return undefined;
    const preferred = target.selector?.quote;
    const quote = preferred && speech.text.includes(preferred)
      ? preferred
      : recoverExactQuote(speech.text, evidence);
    if (!quote) return undefined;
    const key = `${speechId}\u0000${quote}`;
    const occurrence = consumed.get(key) ?? 0;
    if (occurrence >= exactOccurrenceCount(speech.text, quote)) return undefined;
    consumed.set(key, occurrence + 1);
    return { quote, occurrence };
  };

  const actions = input.actions.flatMap((action, actionIndex): Action[] => {
    if (action.type !== 'spotlight' && action.type !== 'laser') return [action];
    const speechId = action.speechId ?? nextSpeechId(actionIndex);
    const target = { elementId: action.elementId, ...(action.selector ? { selector: action.selector } : {}) };
    if (!speechId || !isValidSlideVisualTarget(input.elements, target)) {
      issues.push({ actionId: action.id, speechId, reason: '指示目标已失效，自动指示已停用' });
      return [];
    }
    const speechAnchor = anchorFor(speechId, target, action.speechAnchor);
    if (!speechAnchor) {
      issues.push({ actionId: action.id, speechId, reason: '讲稿中找不到与页面目标可靠对应的词句，自动指示已停用' });
      return [];
    }
    if (action.endSpeechAnchor) {
      const endSpeechId = action.type === 'spotlight' ? action.endSpeechId ?? speechId : speechId;
      const endSpeech = speechById.get(endSpeechId);
      if (!endSpeech || occurrenceIndex(
        endSpeech.text,
        action.endSpeechAnchor.quote,
        action.endSpeechAnchor.occurrence ?? 0,
      ) < 0) {
        issues.push({ actionId: action.id, speechId, reason: '指示结束词句已失效，自动指示已停用' });
        return [];
      }
    }
    if (action.type === 'spotlight') return [{ ...action, speechId, speechAnchor }];
    const waypoints = (action.waypoints ?? []).map((waypoint) => {
      const waypointTarget = {
        elementId: waypoint.elementId,
        ...(waypoint.selector ? { selector: waypoint.selector } : {}),
      };
      if (!isValidSlideVisualTarget(input.elements, waypointTarget)) return undefined;
      const anchor = anchorFor(speechId, waypointTarget, waypoint.speechAnchor);
      return anchor ? { ...waypoint, speechAnchor: anchor } : undefined;
    });
    if (waypoints.some((waypoint) => waypoint === undefined)) {
      issues.push({ actionId: action.id, speechId, reason: '激光路径中有目标无法对应到讲稿词句，整条路径已停用' });
      return [];
    }
    return [{ ...action, speechId, speechAnchor, waypoints: waypoints as NonNullable<typeof action.waypoints> }];
  });
  return { actions, issues };
}
