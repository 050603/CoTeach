export interface SpeechCueAnchor {
  quote: string;
  occurrence?: number;
}

/** Locate an exact spoken anchor without guessing between repeated phrases. */
export function findSpeechCueAnchorRange(
  text: string,
  anchor: SpeechCueAnchor,
): { start: number; end: number } | null {
  const quote = anchor.quote.trim();
  if (!quote) return null;
  const wantedOccurrence = Math.max(0, Math.trunc(anchor.occurrence ?? 0));
  let fromIndex = 0;
  for (let occurrence = 0; occurrence <= wantedOccurrence; occurrence += 1) {
    const start = text.indexOf(quote, fromIndex);
    if (start < 0) return null;
    if (occurrence === wantedOccurrence) return { start, end: start + quote.length };
    fromIndex = start + Math.max(1, quote.length);
  }
  return null;
}

/** Resolve an authored phrase only when alignment covers all of its spoken words.
 * A gap containing punctuation or whitespace is harmless; a missing word is not.
 */
export function resolveAlignedSpeechCueAnchor(
  text: string,
  spans: readonly { startChar: number; endChar: number; startMs: number; endMs: number }[],
  anchor: SpeechCueAnchor,
): { startMs: number; endMs: number } | null {
  const range = findSpeechCueAnchorRange(text, anchor);
  if (!range) return null;
  return resolveAlignedSpeechCueRange(text, spans, range.start, range.end);
}

/** Resolve a spoken character interval only when every lexical character is aligned. */
export function resolveAlignedSpeechCueRange(
  text: string,
  spans: readonly { startChar: number; endChar: number; startMs: number; endMs: number }[],
  start: number,
  end: number,
): { startMs: number; endMs: number } | null {
  if (start < 0 || end <= start || end > text.length) return null;
  const relevant = spans.filter((span) => span.endChar > start && span.startChar < end);
  if (!relevant.length) return null;
  let coveredUntil = start;
  for (const span of relevant) {
    const gapEnd = Math.min(end, span.startChar);
    if (gapEnd > coveredUntil && /[\p{L}\p{N}]/u.test(text.slice(coveredUntil, gapEnd))) return null;
    coveredUntil = Math.max(coveredUntil, span.endChar);
  }
  if (coveredUntil < end && /[\p{L}\p{N}]/u.test(text.slice(coveredUntil, end))) return null;
  return { startMs: relevant[0]!.startMs, endMs: relevant[relevant.length - 1]!.endMs };
}

/** Map a sentence boundary to audio without jumping across unaligned words. */
export function resolveAlignedSpeechCueBoundary(
  text: string,
  spans: readonly { startChar: number; endChar: number; startMs: number; endMs: number }[],
  charIndex: number,
  edge: 'start' | 'end',
): number | null {
  const index = Math.max(0, Math.min(text.length, charIndex));
  const containing = spans.find((span) => edge === 'start'
    ? span.startChar <= index && span.endChar > index
    : span.startChar < index && span.endChar >= index);
  if (containing) return edge === 'start' ? containing.startMs : containing.endMs;
  const nearest = edge === 'start'
    ? spans.find((span) => span.startChar >= index)
    : [...spans].reverse().find((span) => span.endChar <= index);
  if (!nearest) return null;
  const gap = edge === 'start'
    ? text.slice(index, nearest.startChar)
    : text.slice(nearest.endChar, index);
  if (/[\p{L}\p{N}]/u.test(gap)) return null;
  return edge === 'start' ? nearest.startMs : nearest.endMs;
}

/**
 * The implicit lifetime of an anchored cue ends with the sentence containing
 * its start anchor. Newlines and semicolons are intentional teaching pauses.
 */
export function speechCueSentenceEnd(text: string, anchorEnd: number): number {
  for (let index = Math.max(0, anchorEnd); index < text.length; index += 1) {
    if ('。！？!?；;\n'.includes(text[index]!)) return index + 1;
    if (text[index] === '.' && (!text[index + 1] || /\s/.test(text[index + 1]!))) {
      return index + 1;
    }
  }
  return text.length;
}

/** Explicit ends win; otherwise the sentence boundary is capped by the next cue. */
export function resolveSpeechCueEnd(input: {
  start: number;
  defaultEnd: number;
  explicitEnd?: number | null;
  nextStart?: number | null;
}): number {
  const explicitEnd = input.explicitEnd;
  const nextStart = input.nextStart;
  const end = explicitEnd !== undefined && explicitEnd !== null
    ? explicitEnd
    : nextStart !== undefined && nextStart !== null && nextStart >= input.start
      ? Math.min(input.defaultEnd, nextStart)
      : input.defaultEnd;
  return Math.max(input.start, end);
}
