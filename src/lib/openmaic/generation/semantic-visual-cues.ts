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
  sourceAction?: Extract<Action, { type: 'spotlight' | 'laser' }>;
}

const MAX_VISUAL_CUES = 8;
const MAX_LASER_CUES = 2;
const MIN_DIFFERENT_TARGET_GAP_SEC = 10;

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
  const occurrence = targetValue.selector.occurrence ?? 0;
  return occurrenceCount(inventoryTarget.visibleText ?? '', targetValue.selector.quote) > occurrence;
}

function targetKey(cue: ValidFocusCue): string {
  if (!cue.target) return 'none';
  const selector = cue.target.selector;
  const primary = !selector
    ? `${cue.target.elementId}:whole`
    : 'cellId' in selector
    ? `${cue.target.elementId}:cell:${selector.cellId}:${selector.quote ?? ''}:${selector.occurrence ?? 0}`
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
  return left.startIndex <= right.endIndex && right.startIndex <= left.endIndex;
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

function capByPriority(
  cues: readonly ValidFocusCue[],
  maximum: number,
  applies: (cue: ValidFocusCue) => boolean = () => true,
): ValidFocusCue[] {
  const candidates = cues.filter(applies);
  if (candidates.length <= maximum) return [...cues];
  const retained = new Set(
    [...candidates]
      .sort((left, right) => comparePriority(right, left) || left.startIndex - right.startIndex)
      .slice(0, maximum),
  );
  return cues.filter((cue) => !applies(cue) || retained.has(cue));
}

function suppressTargetBounce(
  cues: readonly ValidFocusCue[],
  narration: readonly NarrationSource[],
): ValidFocusCue[] {
  const stable = [...cues];
  let index = 1;
  while (index < stable.length - 1) {
    const before = stable[index - 1]!;
    const middle = stable[index]!;
    const after = stable[index + 1]!;
    if (targetKey(before) !== targetKey(after) || targetKey(before) === targetKey(middle)) {
      index += 1;
      continue;
    }
    if (crossesPlaybackBoundary(before.startIndex, after.endIndex, narration)) {
      index += 1;
      continue;
    }
    if (comparePriority(middle, before) > 0 && comparePriority(middle, after) > 0) {
      stable.splice(index + 1, 1);
    } else {
      if (before.action === 'spotlight' && after.action === 'spotlight') {
        stable[index - 1] = {
          ...before,
          endSpeechId: after.endSpeechId,
          endIndex: after.endIndex,
          necessity: comparePriority(after, before) > 0 ? after.necessity : before.necessity,
          omissionRisk: combineOmissionRisk(before.omissionRisk, after.omissionRisk),
        };
        stable.splice(index, 2);
      } else {
        stable.splice(index, 2);
      }
    }
    index = Math.max(1, index - 1);
  }
  return stable;
}

const EXPLICIT_CONTRAST = /(?:对比|相比|比较|区别|不同于|相反|一方面[^。！？!?]{0,80}另一方面|\bversus\b|\bvs\.?\b|\bcontrast\b|\bcompare\b)/iu;
const EXPLICIT_SEQUENCE = /(?:分别|依次|包括|三个|四个|五个|第一|第二|第三|首先|其次|然后|接着|最后|一头[^。！？!?]{0,100}另一头)/iu;

function hasExplicitEssentialContrast(
  left: ValidFocusCue,
  right: ValidFocusCue,
  narration: readonly NarrationSource[],
): boolean {
  if (left.necessity !== 'essential' || right.necessity !== 'essential') return false;
  const text = narration
    .slice(Math.min(left.startIndex, right.startIndex), Math.max(left.startIndex, right.startIndex) + 1)
    .map((source) => source.text)
    .join(' ');
  return EXPLICIT_CONTRAST.test(text);
}

function hasExplicitEssentialSequence(
  left: ValidFocusCue,
  right: ValidFocusCue,
  narration: readonly NarrationSource[],
): boolean {
  if (
    left.necessity !== 'essential'
    || right.necessity !== 'essential'
    || right.startSec <= left.startSec
  ) return false;
  const text = narration
    .slice(Math.min(left.startIndex, right.startIndex), Math.max(left.endIndex, right.endIndex) + 1)
    .map((source) => source.text)
    .join(' ');
  return EXPLICIT_SEQUENCE.test(text);
}

function enforceDifferentTargetSpacing(
  cues: readonly ValidFocusCue[],
  narration: readonly NarrationSource[],
): ValidFocusCue[] {
  const stable: ValidFocusCue[] = [];
  for (const cue of cues) {
    let keep = true;
    while (keep && stable.length > 0) {
      const previous = stable.at(-1)!;
      if (
        targetKey(previous) === targetKey(cue)
        || crossesPlaybackBoundary(previous.startIndex, cue.startIndex, narration)
        || cue.startSec - previous.startSec >= MIN_DIFFERENT_TARGET_GAP_SEC
        || (
          cue.startIndex > previous.endIndex
          && cue.startIndex > previous.startIndex
          && hasExplicitEssentialContrast(previous, cue, narration)
        )
        || (
          cue.startOffsetMs > 0
          && hasExplicitEssentialSequence(previous, cue, narration)
        )
      ) {
        break;
      }
      if (comparePriority(cue, previous) > 0) {
        stable.pop();
      } else {
        keep = false;
      }
    }
    if (keep) stable.push(cue);
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
  stable = capByPriority(stable, MAX_LASER_CUES, (cue) => cue.action === 'laser');
  stable = capByPriority(stable, MAX_VISUAL_CUES);
  stable = suppressTargetBounce(stable, narration);
  stable = mergeAdjacentSpotlights(stable, narration);
  stable = enforceDifferentTargetSpacing(stable, narration);
  stable = mergeAdjacentSpotlights(stable, narration);
  return stable.slice(0, MAX_VISUAL_CUES);
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

/**
 * Calibrate visual actions already interleaved by the original OpenMAIC action
 * generator. This performs no model call and never rewrites narration.
 */
export function calibrateGeneratedVisualCues(input: {
  outline: SceneOutline;
  elements: readonly PPTElement[];
  actions: readonly Action[];
}): Action[] {
  const narration = narrationSources(input.actions, input.outline);
  const inventory = buildSlideTargetInventory(input.elements);
  if (narration.length === 0 || inventory.length === 0) {
    return removeUncalibratedVisualCues(input.actions);
  }
  const narrationIndex = new Map(narration.map((source, index) => [source.speechId, index]));
  const inventoryById = new Map(inventory.map((item) => [item.elementId, item]));
  const candidates: ValidFocusCue[] = [];

  const nextSpeechId = (actionIndex: number): string | undefined => {
    for (let index = actionIndex + 1; index < input.actions.length; index += 1) {
      const candidate = input.actions[index]!;
      if (candidate.type === 'spotlight' || candidate.type === 'laser') continue;
      if (candidate.type === 'speech') return candidate.text.trim() ? candidate.id : undefined;
      return undefined;
    }
    return undefined;
  };

  input.actions.forEach((action, actionIndex) => {
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
    const startOffsetMs = speechAnchor
      ? Math.round(
          (anchorIndex / narration[startIndex]!.text.length)
          * narration[startIndex]!.estimatedDurationSec
          * 1000,
        )
      : Math.max(0, action.speechOffsetMs ?? 0);
    if (startOffsetMs >= narration[startIndex]!.estimatedDurationSec * 1000) {
      log.warn(`Dropped generated visual cue ${action.id} with an out-of-range speech offset`);
      return;
    }
    candidates.push({
      startSpeechId,
      endSpeechId,
      action: action.type,
      necessity: action.necessity === 'essential' ? 'essential' : 'helpful',
      omissionRisk: action.omissionRisk?.trim() || action.description?.trim()
        || 'The generated action directly maps this narration to visible slide evidence.',
      target,
      startIndex,
      endIndex,
      startOffsetMs,
      startSec: narration[startIndex]!.startSec + startOffsetMs / 1000,
      sourceAction: action,
    });
  });

  return applyCuePlan(input.actions, stabilizeFocusCues(candidates, narration));
}
