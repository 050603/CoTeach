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
