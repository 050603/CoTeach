import { loadSnippet } from '@openmaic/lib/prompts';
import { createLogger } from '@openmaic/lib/logger';
import type { GeneratedSlideContent, SceneOutline, UserRequirements } from '@openmaic/lib/types/generation';
import type { LaserWaypoint, VisualTargetSelector } from '@openmaic/lib/types/action';
import { formatTeachingConstraintsForPrompt } from '@openmaic/lib/pedagogy/teaching-constraints';
import type { AICallFn, AgentInfo, SceneGenerationContext } from './pipeline-types';
import { parseJsonResponse } from './json-repair';
import { hasCurrentTeachingBrief } from './teaching-enhancement';
import { compileActionBindings, type ActionCompilationResult, type VisualActionCue } from './action-bindings';
import type { NarrationModuleOutput, SlideElementBinding } from './action-binding-types';
import {
  buildNarrationContext,
  normalizeNarrationPageEnding,
  normalizeCourseFirstOpening,
  rewriteFalseFutureSessionReferences,
  stripPrematureCourseClosing,
  stripRepeatedNarrationOpening,
} from './narration-continuity';
import { normalizeNarrationPunctuation } from './narration-punctuation';

export const TEACHING_NARRATION_VERSION = 'section-continuous-narration-v22-worked-examples-before-quiz';
/**
 * Changes to local normalization invalidate narration attempt checkpoints
 * without invalidating the already generated slide-content checkpoints.
 */
export const TEACHING_NARRATION_NORMALIZATION_VERSION = 'verified-anchor-recovery-v9-quiz-handoff';

const log = createLogger('TeachingNarration');

export interface TeachingSectionNarrationOutput {
  sectionId: string;
  pages: NarrationModuleOutput[];
}

function teachingAgent(agents?: readonly AgentInfo[]): AgentInfo | undefined {
  return agents?.find((agent) => agent.role.toLocaleLowerCase().includes('teacher')) ?? agents?.[0];
}

function pageNarrationContext(
  outline: SceneOutline,
  sectionIndex: number,
  sectionOutlines: readonly SceneOutline[],
  courseProgression?: readonly SceneOutline[],
  courseTitle?: string,
): SceneGenerationContext {
  const progression = courseProgression?.length ? courseProgression : sectionOutlines;
  const courseIndex = progression.findIndex((candidate) => candidate.id === outline.id);
  return buildNarrationContext(
    progression,
    courseIndex >= 0 ? courseIndex : sectionIndex,
    { courseTitle },
  );
}

const EXPLICIT_PREVIOUS_PAGE_LEAD = /(?:上一页|前一页|刚才我们|刚刚我们|前面我们)/;

function withoutTerminalPunctuation(value: string): string {
  return value.trim().replace(/[，,。.!！?？；;：:\s]+$/u, '');
}

function groundedPageTransition(_previous: SceneOutline, current: SceneOutline): string {
  const currentPlan = current.teachingBrief?.teachingPlan;
  const adoptedBridge = currentPlan?.entryPoint?.bridge;
  const bridge = withoutTerminalPunctuation(
    adoptedBridge
      || currentPlan?.purpose
      || currentPlan?.newContent
      || current.description
      || current.title,
  );
  // entryPoint.bridge is the adopted adjacent-page contract. Do not paste the
  // previous page's takeaway here: doing so repeats an entire conclusion at
  // the start of the next page and can detach visual anchors from speech.
  return `${EXPLICIT_PREVIOUS_PAGE_LEAD.test(bridge) ? bridge : `接下来，${bridge}`}。`;
}

/**
 * Replace an explicit retrospective lead with a transition compiled from the
 * adjacent page contracts. The first verified current-page anchor is retained,
 * so narration detail and its visual action stay authored by the model while
 * unsupported claims about what the previous page contained are removed.
 */
export function groundPreviousPageNarrationLead(
  segment: NarrationModuleOutput['segments'][number],
  previous: SceneOutline,
  current: SceneOutline,
): string {
  const marker = segment.text.search(EXPLICIT_PREVIOUS_PAGE_LEAD);
  if (marker < 0 || marker > 160) return segment.text;
  const candidates = (segment.anchors ?? []).flatMap((anchor) => {
    const index = segment.text.indexOf(anchor.quote);
    return index > marker ? [index] : [];
  });
  for (const statement of current.teachingBrief?.teachingPlan?.visibleContent ?? []) {
    const index = segment.text.indexOf(statement);
    if (index > marker) candidates.push(index);
  }
  const boundary = candidates.length ? Math.min(...candidates) : undefined;
  if (boundary === undefined) {
    const currentContent = withoutTerminalPunctuation(
      current.teachingBrief?.teachingPlan?.newContent
        || current.description
        || current.title,
    );
    return `${groundedPageTransition(previous, current)}${currentContent}。`;
  }
  const suffix = segment.text.slice(boundary).replace(/^[，,。.!！?？；;：:\s]+/u, '');
  return `${groundedPageTransition(previous, current)}${suffix}`;
}

/**
 * Apply course-level continuity after structural normalization. This is a
 * deterministic fallback for a missing greeting, repeated section welcome or
 * unsupported retrospective lead. The latter is rebuilt from the adjacent
 * adopted page contracts while retaining the first verified current-page
 * anchor. Anchors removed by trimming are discarded so no later action can
 * point at text that TTS will not speak.
 */
function applyPageNarrationContinuity(
  narration: NarrationModuleOutput,
  context: SceneGenerationContext,
  outline: SceneOutline,
  previousOutline?: SceneOutline,
): NarrationModuleOutput {
  const lastSpokenIndex = narration.segments.findLastIndex((segment) => segment.text.trim().length > 0);
  const segments = narration.segments.map((segment, index) => {
    let text = segment.text;
    if (index === 0) {
      if (previousOutline) {
        text = groundPreviousPageNarrationLead({ ...segment, text }, previousOutline, outline);
      }
      text = context.sectionPosition === 'course-first' && context.narrationMode === 'standalone-course'
        ? normalizeCourseFirstOpening(text, context.courseTitle)
        : stripRepeatedNarrationOpening(text);
    }
    if (context.narrationMode === 'embedded-segment' || context.pageIndex < context.totalPages) {
      text = rewriteFalseFutureSessionReferences(text);
    }
    if (index === lastSpokenIndex) {
      text = normalizeNarrationPageEnding(text, context);
    } else {
      text = stripPrematureCourseClosing(text);
    }
    const anchors = (segment.anchors ?? []).filter((anchor) => (
      quoteOccurrenceExists(text, anchor.quote, anchor.occurrence)
    ));
    const { anchors: _discardedAnchors, ...withoutAnchors } = segment;
    return { ...withoutAnchors, text, ...(anchors.length ? { anchors } : {}) };
  });
  const spokenSegments = segments.filter((segment) => segment.text.trim().length > 0);
  return { ...narration, segments: spokenSegments.length ? spokenSegments : segments };
}

function applySectionNarrationContinuity(
  output: TeachingSectionNarrationOutput,
  outlines: readonly SceneOutline[],
  courseProgression?: readonly SceneOutline[],
  courseTitle?: string,
): TeachingSectionNarrationOutput {
  return {
    ...output,
    pages: output.pages.map((page, index) => {
      const courseIndex = courseProgression?.findIndex((candidate) => candidate.id === outlines[index]!.id) ?? -1;
      const previousOutline = courseIndex > 0
        ? courseProgression?.[courseIndex - 1]
        : index > 0 ? outlines[index - 1] : undefined;
      return applyPageNarrationContinuity(
        page,
        pageNarrationContext(outlines[index]!, index, outlines, courseProgression, courseTitle),
        outlines[index]!,
        previousOutline,
      );
    }),
  };
}

/** Keep explicit whiteboard/widget/video playback contracts on their native path. */
export function canUseIndependentTeachingNarration(outline: SceneOutline): boolean {
  return outline.type === 'slide'
    && outline.audience !== 'teacher'
    && outline.generationPurpose === 'knowledge-teaching'
    && hasCurrentTeachingBrief(outline)
    && !outline.teachingToolPlan?.some((item) => item.required !== false
      && item.tool !== 'spotlight' && item.tool !== 'laser-pointer')
    && !outline.mediaGenerations?.some((request) => request.type === 'video')
    && !(outline.timingPlan?.videoSec && outline.timingPlan.videoSec > 0);
}

export function buildTeachingNarrationSemantics(outline: SceneOutline) {
  return {
    teaching: { id: `${outline.id}:teaching`, text: outline.teachingBrief?.teachingPlan?.newContent ?? outline.teachingObjective ?? outline.description },
    visible: (outline.teachingBrief?.teachingPlan?.visibleContent ?? []).map((text, index) => ({
      id: `${outline.id}:visible-${index + 1}`, text,
    })),
  };
}

function quoteOccurrenceExists(text: string, quote: string, occurrence = 0): boolean {
  if (!quote || occurrence < 0 || !Number.isInteger(occurrence)) return false;
  let offset = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    const found = text.indexOf(quote, offset);
    if (found < 0) return false;
    offset = found + quote.length;
  }
  return true;
}

type NormalizedTextIndex = {
  value: string;
  starts: number[];
  ends: number[];
};

/**
 * Build a conservative comparison form for copied speech quotes. We ignore
 * only typography (case, width, whitespace and punctuation) while retaining
 * every letter and number, so this cannot turn a paraphrase into a match.
 */
function normalizedTextIndex(value: string): NormalizedTextIndex {
  let normalized = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let sourceOffset = 0;
  for (const sourceCharacter of value) {
    const sourceEnd = sourceOffset + sourceCharacter.length;
    for (const normalizedCharacter of sourceCharacter.normalize('NFKC').toLocaleLowerCase()) {
      if (!/[\p{L}\p{N}]/u.test(normalizedCharacter)) continue;
      normalized += normalizedCharacter;
      starts.push(sourceOffset);
      ends.push(sourceEnd);
    }
    sourceOffset = sourceEnd;
  }
  return { value: normalized, starts, ends };
}

/** Resolve an authored quote to the exact contiguous substring used by TTS. */
function resolveNarrationAnchor(
  text: string,
  quote: string,
  requestedOccurrence: number,
): { quote: string; occurrence: number } | null {
  const exactOffsets: number[] = [];
  for (let offset = text.indexOf(quote); offset >= 0; offset = text.indexOf(quote, offset + Math.max(1, quote.length))) {
    exactOffsets.push(offset);
  }
  if (exactOffsets[requestedOccurrence] !== undefined) return { quote, occurrence: requestedOccurrence };
  if (exactOffsets.length === 1) return { quote, occurrence: 0 };

  const normalizedText = normalizedTextIndex(text);
  const normalizedQuote = normalizedTextIndex(quote).value;
  // One-character anchors are too ambiguous to repair after punctuation is
  // removed. They remain optional and are dropped below.
  if (normalizedQuote.length < 2) return null;
  const normalizedOffsets: number[] = [];
  for (
    let offset = normalizedText.value.indexOf(normalizedQuote);
    offset >= 0;
    offset = normalizedText.value.indexOf(normalizedQuote, offset + Math.max(1, normalizedQuote.length))
  ) normalizedOffsets.push(offset);
  const normalizedOffset = normalizedOffsets[requestedOccurrence]
    ?? (normalizedOffsets.length === 1 ? normalizedOffsets[0] : undefined);
  if (normalizedOffset === undefined) return null;
  const start = normalizedText.starts[normalizedOffset];
  const end = normalizedText.ends[normalizedOffset + normalizedQuote.length - 1];
  if (start === undefined || end === undefined || end <= start) return null;
  const exactQuote = text.slice(start, end);
  let occurrence = 0;
  for (let offset = text.indexOf(exactQuote); offset >= 0 && offset < start; offset = text.indexOf(exactQuote, offset + Math.max(1, exactQuote.length))) {
    occurrence += 1;
  }
  return quoteOccurrenceExists(text, exactQuote, occurrence) ? { quote: exactQuote, occurrence } : null;
}

/** Add shared semantic requirements without replacing the baseline slide prompt. */
export function withTeachingSlideGuidance(
  aiCall: AICallFn, outline: SceneOutline, onRawResponse?: (response: string) => void,
): AICallFn {
  const { visible } = buildTeachingNarrationSemantics(outline);
  const plan = outline.teachingBrief?.teachingPlan;
  const isStandaloneCourseOpening = outline.order === 0 && outline.narrationMode !== 'embedded-segment';
  return async (system, prompt, images) => {
    const response = await aiCall([
    system,
    'Use the shared page contract below as the teaching meaning of this slide. Preserve every required visible teaching claim; if a supplied statement is an unanswered exercise, keep its facts but turn it into a worked example with the conclusion and basis visible. Do not copy the oral explanation onto the canvas. A first-introduced core term or concept must remain a complete learner-readable definition (name plus essential meaning and any indispensable boundary); a label, question, slogan, or example title is not an adequate replacement. Keep the definition, key relationship, condition, or conclusion learners need to inspect on the slide, while leaving reasons, intermediate inference, analogy and example expansion to narration. Choose the visual form from the stated relationship: aligned comparison for differences, connected stages for a process, a relationship diagram for causes or systems, a chart for quantities, a sequence for derivation, an illustration for a concrete scene, or concise text when no stronger visual relation exists. These are choices, not a fixed template. Do not default to cards, equal columns, question titles, or an activity worksheet. Keep every independently referenced comparison item, process stage, diagram node, and worked step as a distinct targetable element; do not merge an entire sequence into one text box. Use each supplied semantic ID on the element that best represents the complete visible statement, rather than assigning it arbitrarily to the first label in a multi-object relationship. Keep required material readable and within the canvas; remove decorative copy before shrinking or dropping teaching evidence. Internal IDs and authoring fields must never be learner-visible. Return only the original slide response contract; do not add narration, source status, review notes, visual actions, or labels such as textbook original example, teaching adaptation, and AI supplement.',
    'A knowledge-teaching slide has no answer input. Do not add a stand-alone true/false decision, thinking question, answer blank, or instruction to pause and respond, including at the bottom of the page. If the supplied page task or key points resemble an exercise, use the same facts as a worked example and show its conclusion and key basis on this slide. Reserve independent answering for the section-end quiz or an explicitly answerable interactive page.',
    isStandaloneCourseOpening
      ? 'This is the opening page of a standalone AI course resource. Make the adopted entryPoint visible through its concrete object, familiar situation, meaningful contrast, or question so narration can begin from something learners can inspect or recall. The slide may also begin the first concept when time is short, but a course title, objectives list, or abstract definition alone is not an adequate knowledge entry.'
      : '',
  ].join('\n'), `${prompt}\n\nShared page contract:\n${JSON.stringify({
      understanding: plan?.purpose,
      introduces: plan?.introduces,
      deepens: plan?.deepens,
      references: plan?.references,
      visibleStatements: visible,
      visualRelationship: plan?.visualRelationship,
      entryPoint: plan?.entryPoint,
      oralOnly: plan?.narrationFocus,
      examples: outline.teachingBrief?.examples,
    })}`, images);
    onRawResponse?.(response);
    return response;
  };
}

function normalizeVisualTargetSelector(value: unknown): VisualTargetSelector | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const occurrence = Number.isInteger(record.occurrence) && Number(record.occurrence) >= 0
    ? Number(record.occurrence) : undefined;
  const quote = typeof record.quote === 'string' && record.quote.trim()
    ? record.quote.trim() : undefined;
  const cellId = typeof record.cellId === 'string' && record.cellId.trim()
    ? record.cellId.trim() : undefined;
  if (cellId) return { cellId, ...(quote ? { quote } : {}), ...(occurrence !== undefined ? { occurrence } : {}) };
  const rowIndex = Number.isInteger(record.rowIndex) && Number(record.rowIndex) >= 0
    ? Number(record.rowIndex) : undefined;
  if (rowIndex !== undefined) {
    return { rowIndex, ...(quote ? { quote } : {}), ...(occurrence !== undefined ? { occurrence } : {}) };
  }
  if (quote) return { quote, ...(occurrence !== undefined ? { occurrence } : {}) };
  return undefined;
}

function normalizeVisualTarget(value: unknown): { elementId: string; selector?: VisualTargetSelector } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const elementId = typeof record.elementId === 'string' ? record.elementId.trim() : '';
  if (!elementId) return undefined;
  const selector = normalizeVisualTargetSelector(record.selector);
  return { elementId, ...(selector ? { selector } : {}) };
}

function normalizeSpeechAnchor(value: unknown, text: string): { quote: string; occurrence: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const quote = typeof record.quote === 'string'
    ? normalizeNarrationPunctuation(record.quote.trim())
    : '';
  const occurrence = Number.isInteger(record.occurrence) && Number(record.occurrence) >= 0
    ? Number(record.occurrence) : 0;
  if (!quote) return undefined;
  return resolveNarrationAnchor(text, quote, occurrence) ?? undefined;
}

function normalizeLaserWaypoints(value: unknown, text: string): LaserWaypoint[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const waypoints = value.flatMap((item) => {
    const target = normalizeVisualTarget(item);
    if (!target) return [];
    const record = item as Record<string, unknown>;
    const speechAnchor = normalizeSpeechAnchor(record.speechAnchor, text);
    return [{ ...target, ...(speechAnchor ? { speechAnchor } : {}) }];
  });
  return waypoints.length ? waypoints : undefined;
}

/** Structural checks only. Never rewrite the teacher's generated words. */
export function normalizeTeachingNarration(value: unknown, outline: SceneOutline): NarrationModuleOutput {
  const root = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
  if (root?.pageId !== undefined && root.pageId !== outline.id) throw new Error('讲稿与课件页面编号不一致');
  const nested = root?.response && typeof root.response === 'object' && !Array.isArray(root.response)
    ? root.response as Record<string, unknown> : undefined;
  const raw = root?.segments ?? nested?.segments;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('教学讲稿没有返回有效段落');
  const semantics = buildTeachingNarrationSemantics(outline);
  const knownIds = new Set([semantics.teaching.id, ...semantics.visible.map((item) => item.id)]);
  const usedSegmentIds = new Set<string>();
  return {
    pageId: outline.id,
    segments: raw.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`讲稿第 ${index + 1} 段格式无效`);
      const segment = item as Record<string, unknown>;
      if (typeof segment.text !== 'string' || !segment.text.trim()) throw new Error(`讲稿第 ${index + 1} 段缺少正文`);
      if (!Array.isArray(segment.semanticIds) || segment.semanticIds.length === 0
        || segment.semanticIds.some((id) => typeof id !== 'string' || !knownIds.has(id))) {
        throw new Error(`讲稿第 ${index + 1} 段引用了缺失或未知教学语义编号`);
      }
      const proposedId = typeof segment.id === 'string' && segment.id.startsWith(`${outline.id}:speech-`)
        ? segment.id : `${outline.id}:speech-${index + 1}`;
      const id = usedSegmentIds.has(proposedId) ? `${outline.id}:speech-${index + 1}` : proposedId;
      usedSegmentIds.add(id);
      const text = normalizeNarrationPunctuation(segment.text);
      const semanticIds = new Set(segment.semanticIds as string[]);
      const anchors = Array.isArray(segment.anchors) ? segment.anchors.flatMap((rawAnchor, anchorIndex) => {
        if (!rawAnchor || typeof rawAnchor !== 'object' || Array.isArray(rawAnchor)) {
          log.warn(`Dropping malformed optional visual anchor at segment ${index + 1}, anchor ${anchorIndex + 1}`);
          return [];
        }
        const anchor = rawAnchor as Record<string, unknown>;
        const semanticId = typeof anchor.semanticId === 'string' ? anchor.semanticId : '';
        const quote = typeof anchor.quote === 'string'
          ? normalizeNarrationPunctuation(anchor.quote.trim())
          : '';
        const occurrence = Number.isInteger(anchor.occurrence) && Number(anchor.occurrence) >= 0
          ? Number(anchor.occurrence) : 0;
        if (!knownIds.has(semanticId)) {
          log.warn(`Dropping optional visual anchor with an unknown semantic id at segment ${index + 1}, anchor ${anchorIndex + 1}`);
          return [];
        }
        const resolvedAnchor = quote ? resolveNarrationAnchor(text, quote, occurrence) : null;
        if (!resolvedAnchor) {
          log.warn(`Dropping optional visual anchor whose quote does not match segment ${index + 1}, anchor ${anchorIndex + 1}`);
          return [];
        }
        if (!semanticIds.has(semanticId)) {
          semanticIds.add(semanticId);
          log.warn(`Recovered omitted segment semantic id from a verified visual anchor at segment ${index + 1}, anchor ${anchorIndex + 1}`);
        }
        const rawCue = anchor.visualCue && typeof anchor.visualCue === 'object' && !Array.isArray(anchor.visualCue)
          ? anchor.visualCue as Record<string, unknown> : undefined;
        const cueType: 'laser' | 'spotlight' | undefined = rawCue?.type === 'laser' || rawCue?.type === 'spotlight'
          ? rawCue.type : undefined;
        const target = normalizeVisualTarget(rawCue?.target);
        const waypoints = cueType === 'laser' ? normalizeLaserWaypoints(rawCue?.waypoints, text) : undefined;
        const endSpeechAnchor = normalizeSpeechAnchor(rawCue?.endSpeechAnchor, text);
        const invalidEndSpeechAnchor = rawCue?.endSpeechAnchor != null && !endSpeechAnchor;
        if (invalidEndSpeechAnchor) {
          log.warn(`Dropping optional visual cue whose end anchor does not match segment ${index + 1}, anchor ${anchorIndex + 1}`);
        }
        return [{
          id: `${id}:anchor-${anchorIndex + 1}`,
          semanticId,
          quote: resolvedAnchor.quote,
          occurrence: resolvedAnchor.occurrence,
          ...(cueType && !invalidEndSpeechAnchor ? { visualCue: {
            type: cueType,
            necessity: rawCue?.necessity === 'essential' ? 'essential' as const : 'helpful' as const,
            ...(target ? { target } : {}),
            ...(waypoints ? { waypoints } : {}),
            ...(endSpeechAnchor ? { endSpeechAnchor } : {}),
            ...(Number.isFinite(Number(rawCue?.durationMs))
              ? { durationMs: Math.max(200, Math.min(20_000, Math.round(Number(rawCue?.durationMs)))) }
              : {}),
          } } : {}),
        }];
      }) : [];
      return {
        id,
        pageId: outline.id,
        text,
        semanticIds: [...semanticIds],
        ...(anchors.length ? { anchors } : {}),
      };
    }),
  };
}

/** A section response is complete only when every requested page appears exactly once. */
export function normalizeTeachingSectionNarration(
  value: unknown,
  sectionId: string,
  outlines: readonly SceneOutline[],
): TeachingSectionNarrationOutput {
  const root = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
  const rawPages = root?.pages;
  if (!Array.isArray(rawPages)) throw new Error('整节讲稿缺少 pages 数组');
  const expected = new Map(outlines.map((outline) => [outline.id, outline]));
  const result = new Map<string, NarrationModuleOutput>();
  for (const rawPage of rawPages) {
    if (!rawPage || typeof rawPage !== 'object' || Array.isArray(rawPage)) {
      throw new Error('整节讲稿包含无效页面结果');
    }
    const pageId = (rawPage as Record<string, unknown>).pageId;
    if (typeof pageId !== 'string' || !expected.has(pageId)) throw new Error(`整节讲稿包含未知页面：${String(pageId)}`);
    if (result.has(pageId)) throw new Error(`整节讲稿重复返回页面：${pageId}`);
    result.set(pageId, normalizeTeachingNarration(rawPage, expected.get(pageId)!));
  }
  const missing = outlines.filter((outline) => !result.has(outline.id));
  if (missing.length) throw new Error(`整节讲稿缺少页面：${missing.map((outline) => outline.title).join('、')}`);
  return { sectionId, pages: outlines.map((outline) => result.get(outline.id)!) };
}

function actualSlideForNarration(content: GeneratedSlideContent) {
  const readingOrder = [...content.elements]
    .sort((left, right) => left.top - right.top || left.left - right.left)
    .map((element) => element.id);
  return {
    canvas: { width: 1000, ratio: 0.5625 },
    readingOrder,
    elements: content.elements.map((element) => {
      const record = element as unknown as Record<string, unknown>;
      return {
        id: element.id,
        type: element.type,
        geometry: {
          left: element.left,
          top: element.top,
          width: element.width,
          height: element.type === 'line' ? Math.abs(element.end[1] - element.start[1]) : element.height,
        },
        content: typeof record.content === 'string' ? plainText(record.content) : undefined,
        text: typeof record.text === 'string' ? plainText(record.text) : undefined,
        alt: typeof record.alt === 'string' ? record.alt : undefined,
        name: typeof record.name === 'string' ? record.name : undefined,
        chart: element.type === 'chart' ? { chartType: record.chartType, data: record.data } : undefined,
        table: element.type === 'table' ? record.data : undefined,
        line: element.type === 'line' ? { start: record.start, end: record.end } : undefined,
        latex: element.type === 'latex' ? record.latex : undefined,
      };
    }),
  };
}

function actualSlideVisibleEvidence(content: GeneratedSlideContent): string[] {
  const evidence: string[] = [];
  for (const element of actualSlideForNarration(content).elements) {
    if (typeof element.content === 'string' && element.content) evidence.push(element.content);
    else if (typeof element.text === 'string' && element.text) evidence.push(element.text);
    else if (element.table) evidence.push(JSON.stringify(element.table));
    else if (element.chart) evidence.push(JSON.stringify(element.chart));
    else if (typeof element.latex === 'string' && element.latex) evidence.push(element.latex);
  }
  return evidence;
}

function pageContinuityContract(
  pages: ReadonlyArray<{ outline: SceneOutline; content: GeneratedSlideContent }>,
  index: number,
) {
  if (index === 0) return { position: 'section-opening' as const };
  const previous = pages[index - 1]!;
  const current = pages[index]!;
  return {
    position: 'continuation' as const,
    previousPageId: previous.outline.id,
    previousPageTitle: previous.outline.title,
    establishedVisibleStatements: previous.outline.teachingBrief?.teachingPlan?.visibleContent ?? [],
    establishedTakeaway: previous.outline.teachingBrief?.teachingPlan?.takeaway,
    previousActualVisibleEvidence: actualSlideVisibleEvidence(previous.content),
    adoptedCurrentEntryPoint: current.outline.teachingBrief?.teachingPlan?.entryPoint,
    transitionContract: {
      bridge: current.outline.teachingBrief?.teachingPlan?.entryPoint?.bridge,
      maximumSentences: 2,
      repeatPreviousTakeaway: false,
    },
    currentNewContent: current.outline.teachingBrief?.teachingPlan?.newContent,
    notYetEstablishedOnPreviousPage: pages.slice(index + 1).flatMap(({ outline }) => (
      outline.teachingBrief?.teachingPlan?.visibleContent ?? []
    )),
  };
}

/**
 * Write one continuous explanation after the section's actual slides exist,
 * then split the authored result by page for the existing playback pipeline.
 */
export async function generateTeachingSectionNarration(input: {
  sectionId: string;
  pages: ReadonlyArray<{ outline: SceneOutline; content: GeneratedSlideContent }>;
  requirements: UserRequirements;
  courseTitle?: string;
  languageDirective?: string;
  courseProgression?: readonly SceneOutline[];
  agents?: readonly AgentInfo[];
  aiCall: AICallFn;
}): Promise<TeachingSectionNarrationOutput> {
  if (!input.pages.length) throw new Error('整节讲稿生成缺少页面');
  for (const page of input.pages) {
    if (!page.outline.teachingBrief?.teachingPlan) throw new Error(`页面“${page.outline.title}”缺少已采用的实质教学设计`);
  }
  const outlines = input.pages.map((page) => page.outline);
  const sharedCriteria = outlines.find((outline) => outline.teachingBrief?.understandingCriteria)
    ?.teachingBrief?.understandingCriteria;
  const teacher = teachingAgent(input.agents);
  const system = [
    'Write one continuous classroom micro-lecture for the complete section, then return it as page-scoped segments. Return only valid JSON.',
    loadSnippet('adaptive-narration-policy'),
    loadSnippet('teaching-accuracy-policy'),
    'The adopted teaching design is the authority for knowledge, concept boundaries, stable example facts, core reasoning and understanding criteria. The actual slide is the authority only for what is visible and what can be pointed to. Never preserve a slide error or delete a required explanation merely to make words agree with the slide.',
    'Explain the section at the depth this learner and time budget require. Define unfamiliar terms on first use, make intermediate causal or inferential links explicit, and explain how a result follows instead of repeating conclusions.',
    'Advance one line of understanding across pages. Use introduces, deepens, and references as page ownership: teach new nodes where introduced, add the planned relation or application where deepened, and use only a short bridge where referenced.',
    'Treat every page learningBoundary as authoritative learner state. You may rely on prerequisiteKnowledge and previouslyTaughtKnowledge. Establish currentKnowledge before using it in an example, comparison, judgment, or exercise. futureKnowledge may be named only in an agenda or goal; never use it as an explanation premise, example, option, task, or assumed student knowledge.',
    'Treat each page continuityContract as a closed-world handoff. A later page may say the previous page established only a proposition present in establishedVisibleStatements, establishedTakeaway, or previousActualVisibleEvidence. Never claim that the previous page raised, showed, discussed, or left a question, example, term, project or conclusion that is absent from that evidence. Material listed under currentNewContent or notYetEstablishedOnPreviousPage must be introduced as new at its own page. Follow transitionContract with at most one or two short linking sentences; do not paste or restate the full establishedTakeaway at the start of the next page. When no retrospective wording adds value, continue directly from the adopted bridge or current content instead of saying “上一页”.',
    'Use each page entryPoint as the real way into its reasoning. The standalone AI resource must feel complete even when a teacher-led phase may have introduced the wider lesson earlier. On the first course page, give a brief natural greeting, identify the course or immediate learning focus when useful, and establish the entryPoint through a concrete familiar experience, observable contrast, question, or direct proposition. Let learners notice the relevant feature before explicitly bridging from it to the first new idea. Do not merely prepend a greeting to a definition, recite objectives, announce an abstract agenda, or claim that learners answered. On later pages, connect from the exact idea already established instead of restarting the lesson.',
    'When an abstract or unfamiliar term has a familiar example or visible contrast, establish that object first, let the learner notice the relevant feature, and only then name and define the concept. A direct definition is still appropriate when the term is already familiar or the content calls for it.',
    'Use actual slide content for concrete visual references. Name the referent in speech. If a required visible item is absent or conflicts with the adopted design, do not invent that it is visible and do not silently weaken the explanation. Keep the correct explanation self-contained so the resource gap can be reported separately.',
    'Do not invent core claims, change concept boundaries, replace stable case facts, or turn a heuristic into a definition. Do not read internal field names, diagnostics, evidence status, review notes, learner profiles, or authoring instructions aloud.',
    'Provenance classifications and review notes are teacher-only. Present the knowledge, example, image, or activity directly. Never say labels such as textbook original example, teaching adaptation, AI supplement, from the textbook, or preserves the original example’s core meaning. Do not announce why an example was selected or how it was adapted.',
    'Choose examples, comparisons, analogies, demonstrations, or short self-questions for their local explanatory value, learner familiarity, and developmental fit. They do not need to connect to the project task or a later activity. Keep shared facts and quantities consistent. Do not present constructed quantities as named research findings or invent an institution or citation.',
    'Treat teachingPlan.taskConnection as a hard page boundary, not learner-facing content. With mode none, do not mention the driving question, final artifact, project workflow, or retrofit a project-shaped example. With helpful-context, use only the part that directly clarifies this page without adding project setup. With direct-application, guide the planned transfer but do not turn neighboring explanation pages into project work.',
    'Use the actual relationship on the slide and its reading structure to guide attention: name what learners should observe, compare items in a meaningful order, and follow a process or derivation in sequence. Spoken explanation should add meaning rather than read every label. If the teaching entry and slide begin with a concrete contrast, speak from that contrast before stating the abstract definition.',
    'Write connected spoken language for listening: each sentence should make the next step feel motivated by what the learner has just understood. Avoid a repeated definition–example–summary routine, stacked slogans, compressed label lists, and abrupt topic switches.',
    'Give the reasoning needed for the declared understanding criteria. The final quiz is authored later and must not be previewed with answers. Do not lower the learning standard because a slide is terse.',
    'A teaching slide is a worked explanation, not an answerable exercise. Do not end its speech by asking learners to judge true or false, write an answer, think silently, or wait to respond. If a page learningTask or visible question survives from an earlier plan, turn it into a narrated example and immediately explain the judgment, evidence, and conclusion without claiming a student response. Let the section-end quiz collect independent answers.',
    'Each requested teaching page must appear exactly once. Keep the requested pageId and stable segment id. Each segment must use only that page’s supplied semantic IDs. Segment boundaries are natural explanation paragraphs, with no fixed count. One natural segment may contain several visual focus changes: add a separate anchor exactly where attention moves from an example, image, definition, conclusion, or other visible object to the next one. Reasoning that does not depend on the screen may continue with no cue. Do not split fluent speech merely to end a visual cue.',
    'Finish each segment text before authoring anchors. Every anchor semanticId must also appear in that segment’s semanticIds. Every anchor quote must be copied as one contiguous substring from that exact finalized segment text; never paraphrase it, copy it from the slide, or include nearby words that are absent from the segment. Omit the anchor when no reliable substring exists. Put the anchor on the first spoken phrase that actually asks learners to attend to the target, not at the paragraph start by default. Add a visualCue only when pointing helps learners locate, compare, trace, or hold attention on a visible object. Use separate anchors for targets mentioned at different points. A segment may have no cue, and the same object may be cued again when later reasoning needs it.',
    'For every visualCue authored from an actual slide, copy target.elementId exactly from that page’s actualSlide.elements. Use target.selector only when a text phrase, complete table row, or table cell is more precise than the whole element. Choose spotlight for sustained explanation of text, a concept block, or one complete table row; use selector.rowIndex to frame that row and switch rows when the narration starts the next concept. Choose a stationary laser mainly for an image, diagram region, arrow, or isolated visual detail. Choose a multi-target laser only to trace an explicit order, process, route, or derivation across at least three distinct rendered nodes; set the first node as target and each later node as a waypoint with its own speechAnchor. A comparison of prose blocks or table rows is not a laser path. Set endSpeechAnchor to the exact spoken phrase where a spotlight should end; omit it to end at the containing sentence. Do not use a laser for sustained ordinary text explanation because the dot obscures glyphs. Do not add cues to transitions or reasoning that does not depend on the screen. Mark a cue essential only when the explanation is genuinely hard to follow without pointing; an invalid optional cue is omitted without changing the speech.',
    'The page visualIntent and visualActionIntent, when present, are the adopted teaching intent from earlier planning. Use their observation goal to decide which actual visible object deserves attention, then realize that intent in narration anchors with exact targets from actualSlide. Do not invent a target when the slide does not contain one.',
    'Respect each deliveryContext endingDisposition and the section position in the complete course. A test-generation scope does not make this the end of the course. Only verified-course-end may synthesize what the learner can now explain or do, connect that understanding to later use, and use one concise formal thanks and farewell. A pbl-stage-handoff must lead into its named next stage without saying the class is over or goodbye. A final teaching page followed by an assessment should use at most one short learner-facing bridge such as “接下来用几道小题检验一下理解”, without claiming mastery. Never read an assessment page title or an internal name such as “第X节·节末小测” aloud. If the page already ends with a natural quiz bridge, do not add or paraphrase a second one.',
    input.languageDirective ?? '',
    teacher?.persona ? `Teacher voice to follow for tone only; do not create extra speakers or fictional student replies:\n${teacher.persona}` : '',
  ].join('\n');
  const prompt = JSON.stringify({
    course: input.courseTitle,
    requirement: input.requirements.requirement,
    learners: input.requirements.teachingConstraints
      ? formatTeachingConstraintsForPrompt(input.requirements.teachingConstraints) : undefined,
    sectionId: input.sectionId,
    understandingCriteria: sharedCriteria,
    teacherVoice: teacher ? { name: teacher.name, role: teacher.role } : undefined,
    pages: input.pages.map(({ outline, content }, index) => ({
      order: index,
      pageId: outline.id,
      title: outline.title,
      objective: outline.teachingObjective,
      sharedContext: outline.teachingBrief?.sharedContext,
      learningTask: outline.teachingBrief?.pageTask,
      teachingPlan: outline.teachingBrief?.teachingPlan,
      learningBoundary: outline.teachingBrief?.learningBoundary,
      visualIntent: outline.visualIntent,
      visualActionIntent: outline.teachingToolPlan?.filter((item) => (
        item.tool === 'spotlight' || item.tool === 'laser-pointer'
      )),
      explanation: outline.teachingBrief?.explanation,
      examples: outline.teachingBrief?.examples,
      conditions: outline.teachingBrief?.conditions,
      stableTeachingMaterials: (outline.teachingBrief?.reviewItems ?? []).map((item) => ({
        content: item.content,
        teachingPurpose: item.teachingPurpose,
        values: item.values,
        comparisonObjects: item.comparisonObjects,
      })),
      actualSlide: actualSlideForNarration(content),
      targetDurationSec: outline.targetDurationSec,
      timingPlan: outline.timingPlan,
      semanticUnits: buildTeachingNarrationSemantics(outline),
      deliveryContext: pageNarrationContext(outline, index, outlines, input.courseProgression, input.courseTitle),
      continuityContract: pageContinuityContract(input.pages, index),
    })),
    courseProgression: input.courseProgression?.map((outline) => ({
      id: outline.id,
      type: outline.type,
      stageKey: outline.stageKey,
      stageLabel: outline.stageLabel,
      sectionId: outline.lectureSectionId ?? outline.parentActivityId,
      title: outline.type === 'quiz' ? undefined : outline.title,
      purpose: outline.teachingBrief?.teachingPlan?.purpose,
      newContent: outline.teachingBrief?.teachingPlan?.newContent,
      takeaway: outline.teachingBrief?.teachingPlan?.takeaway,
    })),
    visualCueExamples: {
      singleTarget: {
        type: 'spotlight',
        necessity: 'helpful',
        target: { elementId: 'copy the semantically correct exact ID from this page actualSlide.elements' },
      },
      orderedPath: {
        type: 'laser',
        necessity: 'helpful',
        target: { elementId: 'first exact actualSlide element ID', selector: { quote: 'optional exact phrase inside that element' } },
        waypoints: [{
          elementId: 'next exact actualSlide element ID',
          speechAnchor: { quote: 'exact spoken phrase for this target', occurrence: 0 },
        }],
        endSpeechAnchor: { quote: 'exact final spoken phrase for this path', occurrence: 0 },
      },
    },
    requiredOutputShape: {
      pages: input.pages.map(({ outline }) => ({
        pageId: outline.id,
        segments: [{
          id: `${outline.id}:speech-1`,
          text: 'Direct classroom speech',
          semanticIds: [buildTeachingNarrationSemantics(outline).teaching.id],
          anchors: [{
            semanticId: buildTeachingNarrationSemantics(outline).visible[0]?.id ?? buildTeachingNarrationSemantics(outline).teaching.id,
            quote: 'Exact short quote from text',
            occurrence: 0,
            visualCue: { type: 'spotlight', necessity: 'helpful', target: { elementId: 'exact-id-from-actualSlide' } },
          }],
        }],
      })),
    },
  });
  const response = await input.aiCall(system, prompt);
  try {
    return applySectionNarrationContinuity(
      normalizeTeachingSectionNarration(parseJsonResponse(response), input.sectionId, outlines),
      outlines,
      input.courseProgression,
      input.courseTitle,
    );
  } catch (error) {
    log.warn(`Section narration requires one technical correction: ${error instanceof Error ? error.message : String(error)}`);
    const corrected = await input.aiCall(system, `${prompt}\n\nTechnical JSON/schema correction only. Preserve every valid spoken sentence. Return every requested page exactly once and correct only serialization, page IDs, and semantic references.\n${JSON.stringify({
      structureError: error instanceof Error ? error.message : String(error), invalidResponse: response,
    })}`);
    return applySectionNarrationContinuity(
      normalizeTeachingSectionNarration(parseJsonResponse(corrected), input.sectionId, outlines),
      outlines,
      input.courseProgression,
      input.courseTitle,
    );
  }
}

/** Legacy/special-resource fallback. Ordinary knowledge pages use the section generator above. */
export async function generateTeachingNarration(input: {
  outline: SceneOutline;
  requirements: UserRequirements;
  courseTitle?: string;
  languageDirective?: string;
  outlineContext?: SceneGenerationContext;
  courseProgression?: readonly SceneOutline[];
  agents?: readonly AgentInfo[];
  aiCall: AICallFn;
}): Promise<NarrationModuleOutput> {
  const plan = input.outline.teachingBrief?.teachingPlan;
  if (!plan) throw new Error('独立讲稿生成需要已确认的教学计划');
  const semantics = buildTeachingNarrationSemantics(input.outline);
  const teacher = teachingAgent(input.agents);
  const system = [
    'Write the classroom teacher’s actual spoken narration, read verbatim by TTS. Return only a JSON object with segments. Follow the requested course language.',
    loadSnippet('adaptive-narration-policy'),
    loadSnippet('teaching-accuracy-policy'),
    'The course-wide request is background, not a command to perform every lesson task on this page. Generate only the current page’s teaching responsibility. Other pages in progression define boundaries: do not execute their quizzes, reveal their answers, or introduce unplanned activities. End this page after its own explanation rather than adding a quiz or announcing another page’s full teaching.',
    'Use the shared teaching plan as the explanation responsibility. Complete only this page’s introduced and deepened nodes, and keep referenced material to the shortest bridge needed. Explain unfamiliar terms, relations, intermediate steps, and reasons at the depth required by the learner and time budget. Do not read planning fields aloud. Segment boundaries are natural speech units with no fixed count.',
    'Treat learningBoundary as authoritative learner state. Rely only on evidenced prerequisiteKnowledge and previouslyTaughtKnowledge. Establish currentKnowledge before applying it. futureKnowledge may be named only as an agenda preview and must not become an example, comparison target, judgment option, exercise premise, or assumed student knowledge.',
    'Follow teachingPlan.entryPoint. A standalone course-first page must make this AI resource complete: greet naturally, name the course or immediate focus when useful, establish a concrete familiar experience, visible contrast, question or direct proposition, and explicitly bridge that observation to the first new idea. Do not merely attach a greeting to a definition, recite objectives, claim a student response, or restart the lesson. Later pages bridge from what has already been understood. Follow continuity.endingDisposition: only verified-course-end may end with one formal thanks and farewell; pbl-stage-handoff leads into the named next stage without saying goodbye; continues and partial-preview do not announce course completion.',
    'Give primary concepts and likely misconceptions the needed depth; keep known background and transitions brief. Preserve precise terms, negation, necessary conditions and the evidence status. Not yet verified is different from false; a recommended method is not the only possible method.',
    'Use the class’s stated prior knowledge and familiar contexts. Choose an example for explanatory value and learner familiarity; project linkage is optional. Do not invent individual learner histories, test results or responses. Do not recite the learner profile. Enter examples directly without announcing whether they are real or illustrative.',
    'Provenance classifications and review notes are teacher-only. Present the knowledge, example, image, or activity directly. Never say labels such as textbook original example, teaching adaptation, AI supplement, from the textbook, or preserves the original example’s core meaning. Do not announce why an example was selected or how it was adapted.',
    'Respect teachingPlan.taskConnection as a hard boundary. Mode none forbids adding the driving question, final artifact, project workflow, or a project-shaped example. helpful-context permits only locally clarifying context; direct-application permits the planned transfer. Never read the mode or rationale aloud.',
    'Respect the lesson position: no repeated welcome on continuation pages, no premature course ending. Do not repeat neighboring pages’ explanations. A full explanation can span several speech segments; do not restate its conclusion after every segment.',
    'The narration is generated independently of the slide. Explain the content so it can be followed by hearing alone; do not invent slide layout, element IDs, pointer movements, animation, or say “look at this” when the referent is not named.',
    'This static teaching page has no answer input. Do not add a true/false task, open thinking question, request to write or pause for an answer, or an unanswered closing prompt. If learningTask or learnerQuestion suggests a judgment, walk through it as an example and state the evidence and conclusion in this page’s speech. The section-end quiz handles independent answering.',
    'Each segment has text and semanticIds. Use the supplied teaching semantic ID; optionally add a supplied visible semantic ID only when the segment discusses that exact visible statement. IDs are metadata and must never appear in spoken text. No visual cue is required per segment.',
    'Target duration and timing plan guide the amount of speech; preserve the core explanation, remove repeated premises and conclusions before secondary detail. Do not fill a quota with extra facts. Before returning this same first draft, silently read every sentence once and correct accidental missing or repeated words, homophone-like substitutions, and broken clauses. Do not output a review or request another drafting pass.',
    input.languageDirective ?? '',
    teacher?.persona ? `Teacher voice to follow for tone only; do not create extra speakers or fictional student replies:\n${teacher.persona}` : '',
  ].join('\n');
  const prompt = JSON.stringify({
    course: input.courseTitle,
    requirement: input.requirements.requirement,
    learners: input.requirements.teachingConstraints
      ? formatTeachingConstraintsForPrompt(input.requirements.teachingConstraints) : undefined,
    page: {
      title: input.outline.title,
      objective: input.outline.teachingObjective,
      sharedContext: input.outline.teachingBrief?.sharedContext,
      learningTask: input.outline.teachingBrief?.pageTask,
      teachingPlan: plan,
      learningBoundary: input.outline.teachingBrief?.learningBoundary,
    },
    continuity: input.outlineContext,
    progression: input.courseProgression?.map((outline) => ({
      id: outline.id, type: outline.type, stageKey: outline.stageKey, stageLabel: outline.stageLabel,
      currentPage: outline.id === input.outline.id,
      title: outline.type === 'quiz' ? undefined : outline.title,
      purpose: outline.teachingBrief?.teachingPlan?.purpose,
      newContent: outline.teachingBrief?.teachingPlan?.newContent,
      learningTask: outline.teachingBrief?.pageTask,
      sharedContext: outline.teachingBrief?.sharedContext,
      reasoningSteps: outline.teachingBrief?.teachingPlan?.reasoningSteps,
      takeaway: outline.teachingBrief?.teachingPlan?.takeaway,
    })),
    evidence: input.outline.teachingBrief?.evidence,
    examples: input.outline.teachingBrief?.examples,
    conditions: input.outline.teachingBrief?.conditions,
    targetDurationSec: input.outline.targetDurationSec,
    timingPlan: input.outline.timingPlan,
    semanticUnits: semantics,
    requiredOutputShape: { segments: [{ id: `${input.outline.id}:speech-1`, text: 'Direct classroom speech in the requested language', semanticIds: [semantics.teaching.id], anchors: [] }] },
  });
  const response = await input.aiCall(system, prompt);
  const progressionIndex = input.courseProgression?.findIndex((outline) => outline.id === input.outline.id) ?? -1;
  const previousOutline = progressionIndex > 0 ? input.courseProgression?.[progressionIndex - 1] : undefined;
  try {
    return applyPageNarrationContinuity(
      normalizeTeachingNarration(parseJsonResponse(response), input.outline),
      input.outlineContext ?? pageNarrationContext(input.outline, 0, [input.outline], input.courseProgression, input.courseTitle),
      input.outline,
      previousOutline,
    );
  } catch (error) {
    log.warn(`Page narration requires one technical correction: ${error instanceof Error ? error.message : String(error)}`);
    // Transport failures stay outside this boundary. Only invalid JSON/schema
    // receives one technical correction; valid prose is never rewritten.
    const corrected = await input.aiCall(system, `${prompt}\n\nTechnical JSON/schema correction only. Preserve every valid spoken sentence; do not polish, shorten, expand or re-evaluate teaching quality. Correct the serialization and semantic references using the supplied schema.\n${JSON.stringify({
      structureError: error instanceof Error ? error.message : String(error),
      invalidResponse: response,
    })}`);
    return applyPageNarrationContinuity(
      normalizeTeachingNarration(parseJsonResponse(corrected), input.outline),
      input.outlineContext ?? pageNarrationContext(input.outline, 0, [input.outline], input.courseProgression, input.courseTitle),
      input.outline,
      previousOutline,
    );
  }
}

function plainText(content: string): string {
  return content.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Exact semantic or text bindings only; unbound optional cues cannot change speech. */
export function compileTeachingNarrationActions(input: {
  outline: SceneOutline;
  content: GeneratedSlideContent;
  narration: NarrationModuleOutput;
}): ActionCompilationResult {
  // Check restored narration under the current semantic contract, too.
  const narration = normalizeTeachingNarration(input.narration, input.outline);
  if (input.narration.pageId !== input.outline.id) throw new Error('讲稿与课件页面编号不一致');
  const semantics = buildTeachingNarrationSemantics(input.outline);
  const bindings: SlideElementBinding[] = semantics.visible.flatMap((unit) => {
    const exactId = input.content.elements.find((element) => element.id === unit.id);
    if (exactId) return [{ semanticId: unit.id, elementIds: [exactId.id] }];
    const matches = input.content.elements.filter((element) => element.type === 'text'
      && plainText(unit.text).length > 0 && plainText(element.content).includes(plainText(unit.text)));
    return matches.length === 1 ? [{ semanticId: unit.id, elementIds: [matches[0].id] }] : [];
  });
  const cues: VisualActionCue[] = narration.segments.flatMap((segment) => (segment.anchors ?? []).flatMap((anchor) => {
    if (!anchor.visualCue || (anchor.semanticId === semantics.teaching.id && !anchor.visualCue.target)) return [];
    return [{
      id: `${anchor.id}:focus`,
      type: anchor.visualCue.type,
      semanticId: anchor.semanticId,
      narrationSegmentId: segment.id,
      anchorId: anchor.id,
      necessity: anchor.visualCue.necessity,
      ...(anchor.visualCue.target ? {
        elementId: anchor.visualCue.target.elementId,
        ...(anchor.visualCue.target.selector ? { selector: anchor.visualCue.target.selector } : {}),
      } : {}),
      ...(anchor.visualCue.type === 'laser' && anchor.visualCue.waypoints?.length
        ? { waypoints: anchor.visualCue.waypoints } : {}),
      ...(anchor.visualCue.endSpeechAnchor
        ? { endSpeechAnchor: anchor.visualCue.endSpeechAnchor } : {}),
      ...(anchor.visualCue.durationMs ? { durationMs: anchor.visualCue.durationMs } : {}),
    }];
  }));
  return compileActionBindings({ slide: { pageId: input.outline.id, content: input.content, bindings }, narration, cues });
}

const ELEMENT_IDENTITY_FIELDS = [
  'type', 'left', 'top', 'width', 'height', 'content', 'text', 'src', 'latex',
  'path', 'start', 'end', 'chartType', 'data',
] as const;

/** Restore only identities surviving the baseline parser exactly; never guess. */
export function restoreTeachingSemanticElementIds(
  content: GeneratedSlideContent,
  rawResponse: string,
  outline: SceneOutline,
): GeneratedSlideContent {
  let parsed: { elements?: unknown } | null;
  try { parsed = parseJsonResponse<{ elements?: unknown }>(rawResponse); }
  catch { return content; }
  if (!Array.isArray(parsed?.elements)) return content;
  const requiredIds = new Set(buildTeachingNarrationSemantics(outline).visible.map((item) => item.id));
  const rawElements = parsed.elements.filter((item): item is Record<string, unknown> => Boolean(
    item && typeof item === 'object' && !Array.isArray(item)
    && typeof item.id === 'string' && requiredIds.has(item.id),
  ));
  const proposals = rawElements.flatMap((raw) => {
    const semanticId = raw.id as string;
    if (rawElements.filter((item) => item.id === semanticId).length !== 1) return [];
    const fields = ELEMENT_IDENTITY_FIELDS.filter((field) => raw[field] !== undefined);
    if (fields.length < 5 || !fields.some((field) => !['type', 'left', 'top', 'width', 'height'].includes(field))) return [];
    const matches = content.elements.flatMap((element, index) => fields.every((field) => (
      JSON.stringify(raw[field]) === JSON.stringify((element as unknown as Record<string, unknown>)[field])
    )) ? [index] : []);
    if (matches.length !== 1) return [];
    if (content.elements.some((element, index) => element.id === semanticId && index !== matches[0])) return [];
    return [{ index: matches[0], semanticId }];
  });
  const unique = proposals.filter((proposal) => proposals.filter((other) => other.index === proposal.index).length === 1);
  if (!unique.length) return content;
  const ids = new Map(unique.map((item) => [item.index, item.semanticId]));
  return { ...content, elements: content.elements.map((element, index) => (
    ids.has(index) ? { ...element, id: ids.get(index)! } : element
  )) };
}
