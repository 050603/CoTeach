import type { NarrationModuleOutput, NarrationSegment } from './action-binding-types';
import {
  assertNarrationSourceDuties,
  resolveNarrationSourceParts,
  type NarrationSourceAuthoringDuty,
} from './source-narration-authoring';

export type NarrationInsertionSlot = {
  id: string;
  pageId: string;
  segmentId: string;
  /** UTF-16 offset into the unchanged saved segment. */
  offset: number;
  beforeContext: string;
  afterContext: string;
};

export type NarrationInsertionPart = { text: string } | { sourceRef: string };

export type AuthoredNarrationInsertions = {
  pages: Array<{ pageId: string; insertions: Array<{ at: string; textParts: NarrationInsertionPart[] }> }>;
};

type QuoteAnchor = { quote: string; occurrence?: number };
type Insertion = { offset: number; text: string };
type RecordValue = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(`Source narration patch: ${message}`);
}

function record(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactFields(value: unknown, fields: readonly string[], name: string): asserts value is RecordValue {
  if (!record(value) || Object.keys(value).some((key) => !fields.includes(key))) {
    fail(`${name} contains an unsupported field or is not an object`);
  }
}

function selectedDrafts(drafts: readonly NarrationModuleOutput[], targetPageIds: readonly string[]) {
  if (!Array.isArray(drafts) || !Array.isArray(targetPageIds)
    || targetPageIds.some((id) => typeof id !== 'string' || !id.trim())
    || new Set(targetPageIds).size !== targetPageIds.length) fail('target page ids must be unique nonempty ids');
  const pages = new Map<string, NarrationModuleOutput>();
  for (const draft of drafts) {
    if (!draft || typeof draft.pageId !== 'string' || !draft.pageId.trim() || pages.has(draft.pageId)) {
      fail('saved narration pages must have unique nonempty ids');
    }
    pages.set(draft.pageId, draft);
  }
  return targetPageIds.map((pageId) => {
    const draft = pages.get(pageId);
    if (!draft || !Array.isArray(draft.segments) || !draft.segments.length) fail(`target page ${pageId} has no saved narration segments`);
    const ids = new Set<string>();
    for (const segment of draft.segments) {
      if (!segment || typeof segment.id !== 'string' || !segment.id.trim() || ids.has(segment.id)
        || segment.pageId !== pageId || typeof segment.text !== 'string') {
        fail(`saved segments on page ${pageId} need unique ids, matching page ids and text`);
      }
      ids.add(segment.id);
    }
    return draft;
  });
}

function quoteStart(text: string, anchor: QuoteAnchor): number {
  const occurrence = anchor.occurrence ?? 0;
  if (typeof anchor.quote !== 'string' || !anchor.quote.trim() || !Number.isInteger(occurrence) || occurrence < 0) {
    fail('saved speech anchor has an invalid quote or occurrence');
  }
  let offset = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    const found = text.indexOf(anchor.quote, offset);
    if (found < 0) fail(`saved speech anchor ${JSON.stringify(anchor.quote)} does not occur at ${occurrence}`);
    if (index === occurrence) return found;
    offset = found + anchor.quote.length;
  }
  return fail('saved speech anchor could not be located');
}

function segmentQuoteAnchors(segment: NarrationSegment): QuoteAnchor[] {
  return (segment.anchors ?? []).flatMap((anchor) => [
    anchor,
    ...(anchor.visualCue?.endSpeechAnchor ? [anchor.visualCue.endSpeechAnchor] : []),
    ...(anchor.visualCue?.waypoints ?? []).flatMap((waypoint) => waypoint.speechAnchor ? [waypoint.speechAnchor] : []),
  ]);
}

function sentenceBoundaries(text: string): number[] {
  const offsets = new Set([0, text.length]);
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    // Decimal points, word-internal dots and ellipses are not sentence ends.
    if (char === '.' && (/[.A-Za-z0-9０-９]/u.test(text[index + 1] ?? '') || text[index - 1] === '.')) continue;
    if (!/[。！？!?]/u.test(char) && char !== '.') continue;
    let end = index + 1;
    while (end < text.length && /[。！？!?]/u.test(text[end]!)) end += 1;
    while (end < text.length && /["'”’」』】）》\])]/u.test(text[end]!)) end += 1;
    offsets.add(end);
    index = end - 1;
  }
  return [...offsets].sort((left, right) => left - right);
}

/** Offer genuine sentence boundaries which do not split an accepted cue quote. */
export function buildNarrationInsertionSlots(
  drafts: readonly NarrationModuleOutput[], targetPageIds: readonly string[],
): NarrationInsertionSlot[] {
  return selectedDrafts(drafts, targetPageIds).flatMap((draft) => draft.segments.flatMap((segment) => {
    const protectedQuotes = segmentQuoteAnchors(segment).map((anchor) => {
      const start = quoteStart(segment.text, anchor);
      return { start, end: start + anchor.quote.length };
    });
    return sentenceBoundaries(segment.text)
      .filter((offset) => !protectedQuotes.some(({ start, end }) => offset > start && offset < end))
      .map((offset) => ({
        id: `narration-slot:${encodeURIComponent(draft.pageId)}:${encodeURIComponent(segment.id)}:${offset}`,
        pageId: draft.pageId, segmentId: segment.id, offset,
        beforeContext: segment.text.slice(Math.max(0, offset - 120), offset),
        afterContext: segment.text.slice(offset, offset + 120),
      }));
  }));
}

function remapQuote<T extends QuoteAnchor>(anchor: T, oldText: string, text: string, insertions: readonly Insertion[]): T {
  const original = quoteStart(oldText, anchor);
  if (insertions.some(({ offset }) => offset > original && offset < original + anchor.quote.length)) {
    fail('an insertion splits an accepted speech quote');
  }
  const shifted = original + insertions.reduce((total, insertion) => total + (insertion.offset <= original ? insertion.text.length : 0), 0);
  let offset = 0;
  let occurrence = 0;
  while (offset <= text.length) {
    const found = text.indexOf(anchor.quote, offset);
    if (found < 0 || found > shifted) fail('an insertion makes the original speech quote occurrence unrepresentable');
    if (found === shifted) return occurrence === (anchor.occurrence ?? 0) ? anchor : { ...anchor, occurrence };
    offset = found + anchor.quote.length;
    occurrence += 1;
  }
  return fail('the original speech quote could not be remapped');
}

function insertIntoSegment(segment: NarrationSegment, insertions: readonly Insertion[]): NarrationSegment {
  const ordered = [...insertions].sort((left, right) => left.offset - right.offset);
  let cursor = 0;
  const parts: string[] = [];
  for (const insertion of ordered) {
    parts.push(segment.text.slice(cursor, insertion.offset), insertion.text);
    cursor = insertion.offset;
  }
  parts.push(segment.text.slice(cursor));
  const text = parts.join('');
  const anchors = segment.anchors?.map((anchor) => {
    const remapped = remapQuote(anchor, segment.text, text, ordered);
    const cue = anchor.visualCue;
    if (!cue) return remapped;
    const endSpeechAnchor = cue.endSpeechAnchor ? remapQuote(cue.endSpeechAnchor, segment.text, text, ordered) : undefined;
    const waypoints = cue.waypoints?.map((waypoint) => {
      const speechAnchor = waypoint.speechAnchor ? remapQuote(waypoint.speechAnchor, segment.text, text, ordered) : undefined;
      return speechAnchor === waypoint.speechAnchor ? waypoint : { ...waypoint, speechAnchor };
    });
    if (endSpeechAnchor === cue.endSpeechAnchor && (!waypoints || waypoints.every((waypoint, index) => waypoint === cue.waypoints![index]))) return remapped;
    return { ...remapped, visualCue: { ...cue,
      ...(endSpeechAnchor ? { endSpeechAnchor } : {}), ...(waypoints ? { waypoints } : {}),
    } };
  });
  const anchorsChanged = anchors?.some((anchor, index) => anchor !== segment.anchors![index]);
  return { ...segment, text, ...(anchorsChanged ? { anchors } : {}) };
}

/** Compile only model-selected insertions; never rewrite or complete a saved draft. */
export function compileNarrationInsertions(input: {
  authored: unknown;
  drafts: readonly NarrationModuleOutput[];
  slots: readonly NarrationInsertionSlot[];
  anchorsByPage: ReadonlyMap<string, ReadonlyMap<string, string>>;
  duties: readonly NarrationSourceAuthoringDuty[];
  targetPageIds: readonly string[];
}): NarrationModuleOutput[] {
  const { authored, drafts, slots, anchorsByPage, duties, targetPageIds } = input;
  const expected = new Map(buildNarrationInsertionSlots(drafts, targetPageIds).map((slot) => [slot.id, slot]));
  const available = new Map<string, NarrationInsertionSlot>();
  if (!Array.isArray(slots)) fail('insertion slots must be an array');
  for (const slot of slots) {
    if (!slot || typeof slot.id !== 'string') fail('insertion slots must identify saved sentence boundaries');
    const actual = expected.get(slot.id);
    if (!actual || available.has(slot.id) || slot.pageId !== actual.pageId || slot.segmentId !== actual.segmentId
      || slot.offset !== actual.offset || slot.beforeContext !== actual.beforeContext || slot.afterContext !== actual.afterContext) {
      fail('insertion slots are stale, duplicated or outside the selected saved narration');
    }
    available.set(slot.id, slot);
  }
  exactFields(authored, ['pages'], 'response');
  if (!Array.isArray(authored.pages) || authored.pages.length !== targetPageIds.length) fail('response must contain each requested target page exactly once');
  const seenPages = new Set<string>();
  const seenSlots = new Set<string>();
  const pseudo = { pages: authored.pages.map((page: unknown) => {
    exactFields(page, ['pageId', 'insertions'], 'page');
    if (typeof page.pageId !== 'string' || !targetPageIds.includes(page.pageId) || seenPages.has(page.pageId)) {
      fail('response must contain each requested target page exactly once');
    }
    seenPages.add(page.pageId);
    if (!Array.isArray(page.insertions)) fail('page insertions must be an array');
    const pageId = page.pageId;
    return { pageId, segments: page.insertions.map((insertion: unknown) => {
      exactFields(insertion, ['at', 'textParts'], 'insertion');
      const slot = typeof insertion.at === 'string' ? available.get(insertion.at) : undefined;
      if (!slot || slot.pageId !== pageId || seenSlots.has(slot.id)) fail('insertion uses an unknown, cross-page or duplicate slot');
      seenSlots.add(slot.id);
      if (!Array.isArray(insertion.textParts) || !insertion.textParts.length) fail('insertion textParts must be a nonempty array');
      const textParts = insertion.textParts.map((part: unknown) => {
        exactFields(part, ['text', 'sourceRef'], 'text part');
        const keys = Object.keys(part);
        if (keys.length !== 1 || (keys[0] !== 'text' && keys[0] !== 'sourceRef')
          || typeof part[keys[0]] !== 'string'
          || (keys[0] === 'sourceRef' && !String(part.sourceRef).trim())) fail('each text part must contain exactly text or a nonempty sourceRef');
        return part;
      });
      return { id: slot.id, textParts };
    }) };
  }) };
  const resolved = resolveNarrationSourceParts(pseudo, anchorsByPage) as {
    pages: Array<{ pageId: string; segments: Array<{ id: string; text: string }> }>;
  };
  assertNarrationSourceDuties(pseudo, duties);
  const insertionsByPage = new Map<string, Map<string, Insertion[]>>();
  for (const page of resolved.pages) {
    const bySegment = new Map<string, Insertion[]>();
    for (const segment of page.segments) {
      if (!segment.text.trim()) fail('an insertion must contain nonempty authored text');
      const slot = available.get(segment.id)!;
      const insertions = bySegment.get(slot.segmentId) ?? [];
      insertions.push({ offset: slot.offset, text: segment.text });
      bySegment.set(slot.segmentId, insertions);
    }
    insertionsByPage.set(page.pageId, bySegment);
  }
  return drafts.map((draft) => {
    const bySegment = insertionsByPage.get(draft.pageId);
    if (!bySegment?.size) return draft;
    return { ...draft, segments: draft.segments.map((segment) => {
      const insertions = bySegment.get(segment.id);
      return insertions ? insertIntoSegment(segment, insertions) : segment;
    }) };
  });
}
