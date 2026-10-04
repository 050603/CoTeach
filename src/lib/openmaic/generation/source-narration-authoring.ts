type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function narrationSegmentOwner(raw: RecordValue): RecordValue | undefined {
  // Match normalizeTeachingNarration's root.segments ?? response.segments.
  // A present invalid root must not authorize references from the wrapper.
  return raw.segments != null ? raw : record(raw.response) ? raw.response : undefined;
}

export type NarrationSourceAuthoringDuty = {
  text: string;
  availableReferences: readonly { pageId: string; sourceRef: string }[];
};

/** Check only newly authored responses, before source slots are expanded.
 * Existing text-only narration and cached output keep the resolver contract.
 * Each finite duty needs its own allowed page/reference identity; a heading,
 * paraphrase, or reference on another page cannot replace that authored slot. */
export function assertNarrationSourceDuties(
  value: unknown,
  duties: readonly NarrationSourceAuthoringDuty[],
  fallbackPageId?: string,
  anchorsByPage?: ReadonlyMap<string, ReadonlyMap<string, string>>,
): void {
  if (!duties.length) return;
  const usedReferences = new Set<string>();
  const key = (pageId: string, sourceRef: string) => JSON.stringify([pageId, sourceRef]);
  const collect = (raw: unknown, fallback?: string) => {
    if (!record(raw)) return;
    const owner = narrationSegmentOwner(raw);
    const pageId = typeof raw.pageId === 'string' ? raw.pageId : fallback;
    if (!pageId || !Array.isArray(owner?.segments)) return;
    for (const segment of owner.segments) {
      if (!record(segment) || !Array.isArray(segment.textParts)) continue;
      if (segment.text !== undefined && (typeof segment.text !== 'string' || segment.text.trim())) {
        // Some providers serialize both representations. Only the exact
        // expanded source-backed speech can authorize this redundant field.
        if (!anchorsByPage) continue;
        resolveNarrationSourceParts({ pageId, segments: [segment] }, anchorsByPage);
      }
      for (const part of segment.textParts) {
        if (!record(part) || !Object.hasOwn(part, 'sourceRef') || typeof part.sourceRef !== 'string' || !part.sourceRef.trim()
          || Object.keys(part).some((field) => field !== 'sourceRef' && field !== 'quote' && field !== 'text')
          || (Object.hasOwn(part, 'quote') && (typeof part.quote !== 'string' || !part.quote.trim()))) continue;
        if (Object.hasOwn(part, 'text')) {
          // A redundant representation can authorize a quotation only if the
          // actual page's source resolves to exactly the same spoken words.
          if (!anchorsByPage) continue;
          resolveNarrationSourceParts({ pageId, segments: [{ textParts: [part] }] }, anchorsByPage);
        }
        usedReferences.add(key(pageId, part.sourceRef));
      }
    }
  };
  if (record(value) && Array.isArray(value.pages)) {
    for (const page of value.pages) collect(page);
  } else collect(value, fallbackPageId);
  const missing = duties.flatMap((duty, index) => duty.availableReferences
    .some(({ pageId, sourceRef }) => usedReferences.has(key(pageId, sourceRef))) ? [] : [{
      dutyIndex: index + 1,
      text: duty.text,
      availableReferences: duty.availableReferences.map(({ pageId, sourceRef }) => ({ pageId, sourceRef })),
    }]);
  if (missing.length) {
    throw new Error(`Source narration: missing adopted source references ${JSON.stringify(missing)}`);
  }
}

/** Expand only authored source slots. Missing source duties remain missing for
 * final teacher review to assess; neither source text nor narration order is invented. */
export function resolveNarrationSourceParts(
  value: unknown,
  anchorsByPage: ReadonlyMap<string, ReadonlyMap<string, string>>,
  fallbackPageId?: string,
  options: { qualityReviewMode?: 'diagnostic'; onDiagnostic?: (message: string, pageId?: string) => void } = {},
): unknown {
  const page = (raw: unknown, fallback?: string): unknown => {
    if (!record(raw)) return raw;
    // Match the existing normalizer's root.segments ?? response.segments
    // selection. The outer page identity remains authoritative in both forms.
    const nested = record(raw.response) ? raw.response : undefined;
    const segmentOwner = narrationSegmentOwner(raw);
    if (!segmentOwner || !Array.isArray(segmentOwner.segments)) return raw;
    const pageId = typeof raw.pageId === 'string' ? raw.pageId : fallback;
    const diagnose = (message: string) => options.onDiagnostic?.(message, pageId);
    let changed = false;
    const segments = segmentOwner.segments.map((segment: unknown) => {
      if (!record(segment) || !Object.hasOwn(segment, 'textParts')) return segment;
      const authoredText = typeof segment.text === 'string' && segment.text.trim() ? segment.text : undefined;
      const expand = () => {
        if (segment.text !== undefined && typeof segment.text !== 'string') {
          throw new Error('Source narration: textParts cannot be combined with nonempty text');
        }
        if (!Array.isArray(segment.textParts) || !segment.textParts.length) {
          throw new Error('Source narration: textParts must be a nonempty array');
        }
        const text = segment.textParts.map((part: unknown) => {
          if (!record(part)) throw new Error('Source narration: each text part must be an object');
          const hasText = Object.hasOwn(part, 'text');
          const hasRef = Object.hasOwn(part, 'sourceRef');
          if ((!hasText && !hasRef) || Object.keys(part).some((key) => key !== 'text' && key !== 'sourceRef' && key !== 'quote')
            || (hasText && !hasRef && Object.hasOwn(part, 'quote'))) {
            throw new Error('Source narration: each text part must contain exactly text or sourceRef');
          }
          if (hasText && !hasRef) {
            if (typeof part.text !== 'string') throw new Error('Source narration: authored text must be a string');
            return part.text;
          }
          if (typeof part.sourceRef !== 'string' || !part.sourceRef.trim()) {
            throw new Error('Source narration: sourceRef must be a nonempty source id');
          }
          const source = pageId ? anchorsByPage.get(pageId)?.get(part.sourceRef) : undefined;
          if (source === undefined) {
            if (options.qualityReviewMode === 'diagnostic' && typeof part.quote === 'string' && part.quote.trim()) {
              diagnose(`Source narration: unknown source reference ${part.sourceRef}; retained the authored quote`);
              return part.quote;
            }
            throw new Error(`Source narration: unknown source reference ${part.sourceRef} for page ${pageId ?? '(missing)'}`);
          }
          if (typeof source !== 'string' || !source.trim()) {
            throw new Error(`Source narration: source reference ${part.sourceRef} has no authoritative text`);
          }
          let selected = source;
          if (Object.hasOwn(part, 'quote')) {
            if (typeof part.quote !== 'string' || !part.quote.trim() || !source.includes(part.quote)) {
              if (options.qualityReviewMode === 'diagnostic' && typeof part.quote === 'string' && part.quote.trim()) {
                diagnose(`Source narration: selected quote differs from ${part.sourceRef}; retained the authored quote`);
                return part.quote;
              }
              throw new Error('Source narration: a selected quote must occur unchanged in its authoritative source');
            }
            selected = part.quote;
          }
          if (hasText) {
            if (typeof part.text !== 'string' || !part.text.trim()) {
              throw new Error('Source narration: redundant authored text must be a nonempty string');
            }
            if (part.text !== selected) {
              if (options.qualityReviewMode === 'diagnostic') {
                // This is available authored speech with a faulty citation,
                // not a missing speech body. Never silently replace it with a
                // different quotation or pretend the quotation was verified.
                diagnose(`Source narration: text attached to ${part.sourceRef} differs from its source slot; retained authored speech without verifying it as a quotation`);
                return part.text;
              }
              throw new Error('Source narration: text attached to a sourceRef must equal its authoritative expansion');
            }
          }
          return selected;
        }).reduce((joined, part) => /。[ \t]*$/u.test(joined) && /^[ \t]*。/u.test(part)
          ? joined + part.replace(/^([ \t]*)。/u, '$1') : joined + part, '');
        if (typeof segment.text === 'string' && segment.text.trim() && segment.text !== text) {
          if (options.qualityReviewMode === 'diagnostic') {
            diagnose('Source narration: authored text differs from its source-parts expansion; retained the authored speech');
            return segment.text;
          }
          throw new Error('Source narration: textParts cannot be combined with nonempty text that differs from its authoritative expansion');
        }
        return text;
      };
      let text: string;
      try { text = expand(); }
      catch (error) {
        if (options.qualityReviewMode !== 'diagnostic' || !authoredText) throw error;
        diagnose(`${error instanceof Error ? error.message : String(error)}; retained the available authored speech`);
        text = authoredText;
      }
      changed = true;
      const { textParts: _parts, ...rest } = segment;
      return { ...rest, text };
    });
    if (!changed) return raw;
    return segmentOwner === raw ? { ...raw, segments } : { ...raw, response: { ...nested, segments } };
  };
  if (!record(value) || !Array.isArray(value.pages)) return page(value, fallbackPageId);
  const rawPages = value.pages;
  const pages = rawPages.map((raw: unknown) => page(raw));
  return pages.some((resolved, index) => resolved !== rawPages[index]) ? { ...value, pages } : value;
}
