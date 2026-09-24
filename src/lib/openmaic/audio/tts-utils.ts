/**
 * Shared TTS utilities used by both client-side and server-side generation.
 */

import type {
  Action,
  LaserAction,
  LaserWaypoint,
  SpeechAction,
  SpeechAnchor,
  SpotlightAction,
} from '@openmaic/lib/types/action';
import { createLogger } from '@openmaic/lib/logger';
import { speechCueSentenceEnd } from '../generation/speech-cue-boundaries';
import type { TTSProviderId } from './types';

const log = createLogger('TTS');

/** Provider-specific max text length limits. */
export const TTS_MAX_TEXT_LENGTH: Partial<Record<TTSProviderId, number>> = {
  'glm-tts': 1024,
};

interface TextRange {
  text: string;
  start: number;
  end: number;
}

interface SpeechChunk extends TextRange {
  originalId: string;
  action: SpeechAction;
}

interface LocatedAnchor {
  chunk: SpeechChunk;
  anchor: SpeechAnchor;
  start: number;
  end: number;
}

function findAnchorRange(text: string, anchor: SpeechAnchor): { start: number; end: number } | undefined {
  const quote = anchor.quote.trim();
  if (!quote || !Number.isInteger(anchor.occurrence ?? 0) || (anchor.occurrence ?? 0) < 0) return undefined;
  let from = 0;
  for (let occurrence = 0; occurrence <= (anchor.occurrence ?? 0); occurrence += 1) {
    const start = text.indexOf(quote, from);
    if (start < 0) return undefined;
    if (occurrence === (anchor.occurrence ?? 0)) return { start, end: start + quote.length };
    from = start + quote.length;
  }
  return undefined;
}

function localOccurrence(text: string, quote: string, start: number): number | undefined {
  let from = 0;
  let occurrence = 0;
  while (from <= start) {
    const found = text.indexOf(quote, from);
    if (found === start) return occurrence;
    if (found < 0 || found > start) return undefined;
    from = found + quote.length;
    occurrence += 1;
  }
  return undefined;
}

function splitTextRanges(text: string, maxLength: number, protectedRanges: readonly TextRange[] = []): TextRange[] {
  const limit = Math.floor(maxLength);
  if (!Number.isFinite(limit) || limit < 1 || text.length <= limit) {
    return [{ text, start: 0, end: text.length }];
  }

  const ranges: TextRange[] = [];
  const safeBoundary = (index: number) => (
    !(index > 0
      && index < text.length
      && /[\uD800-\uDBFF]/u.test(text[index - 1]!)
      && /[\uDC00-\uDFFF]/u.test(text[index]!))
    && !protectedRanges.some((range) => range.start < index && index < range.end)
  );

  for (let start = 0; start < text.length;) {
    const limitEnd = Math.min(text.length, start + limit);
    if (limitEnd === text.length) {
      ranges.push({ text: text.slice(start), start, end: text.length });
      break;
    }
    let sentenceEnd = 0;
    let clauseEnd = 0;
    let hardEnd = 0;
    for (let end = start + 1; end <= limitEnd; end += 1) {
      if (!safeBoundary(end)) continue;
      hardEnd = end;
      const previous = text[end - 1]!;
      if ('。！？!?；;：:\n'.includes(previous)
        || (previous === '.' && (!text[end] || /\s/u.test(text[end]!)))) {
        sentenceEnd = end;
      } else if ('，,、'.includes(previous)) {
        clauseEnd = end;
      }
    }
    // An anchor longer than the provider limit cannot fit in one audio clip.
    // The cue is rejected below when its quote no longer fits in one range.
    const end = sentenceEnd || clauseEnd || hardEnd || limitEnd;
    ranges.push({ text: text.slice(start, end), start, end });
    start = end;
  }
  return ranges;
}

/**
 * Split long narration while preserving every original UTF-16 character.
 * The returned chunks concatenate to the exact input text.
 */
export function splitLongSpeechText(text: string, maxLength: number): string[] {
  return splitTextRanges(text, maxLength).map((range) => range.text);
}

function lastSpokenAnchor(text: string): SpeechAnchor | undefined {
  const end = text.trimEnd().length;
  let contentEnd = end;
  while (contentEnd > 0 && !/[\p{L}\p{N}]/u.test(text[contentEnd - 1]!)) contentEnd -= 1;
  if (contentEnd === 0) return undefined;
  let start = Math.max(0, contentEnd - 8);
  while (start < contentEnd && !/[\p{L}\p{N}]/u.test(text[start]!)) start += 1;
  const quote = text.slice(start, end);
  const occurrence = localOccurrence(text, quote, start);
  return occurrence === undefined ? undefined : { quote, occurrence };
}

function nextSpeechId(actions: readonly Action[], index: number): string | undefined {
  for (let next = index + 1; next < actions.length; next += 1) {
    const action = actions[next]!;
    if (action.type === 'spotlight' || action.type === 'laser') continue;
    return action.type === 'speech' ? action.id : undefined;
  }
  return undefined;
}

/**
 * Split narration before TTS generation, then bind each visual cue to the
 * exact chunk containing its authored phrase. Cues whose phrase cannot be
 * preserved are omitted instead of being redirected to an unrelated chunk.
 */
export function splitLongSpeechActions(actions: Action[], providerId: TTSProviderId): Action[] {
  const maxLength = TTS_MAX_TEXT_LENGTH[providerId];
  if (!maxLength) return actions;

  const originalSpeech = new Map(actions.flatMap((action) => (
    action.type === 'speech' ? [[action.id, action] as const] : []
  )));
  const protectedBySpeech = new Map<string, TextRange[]>();
  const addProtected = (speechId: string | undefined, anchor: SpeechAnchor | undefined) => {
    const speech = speechId ? originalSpeech.get(speechId) : undefined;
    const range = speech && anchor ? findAnchorRange(speech.text, anchor) : undefined;
    if (!speechId || !range) return;
    const existing = protectedBySpeech.get(speechId) ?? [];
    existing.push({ ...range, text: speech!.text.slice(range.start, range.end) });
    protectedBySpeech.set(speechId, existing);
  };

  actions.forEach((action, index) => {
    if (action.type !== 'spotlight' && action.type !== 'laser') return;
    const speechId = action.speechId ?? nextSpeechId(actions, index);
    addProtected(speechId, action.speechAnchor);
    addProtected(action.type === 'spotlight' ? action.endSpeechId ?? speechId : speechId, action.endSpeechAnchor);
    if (action.type === 'laser') {
      for (const waypoint of action.waypoints ?? []) addProtected(speechId, waypoint.speechAnchor);
    }
  });

  const chunksBySpeech = new Map<string, SpeechChunk[]>();
  let didSplit = false;
  for (const action of actions) {
    if (action.type !== 'speech') continue;
    if (!action.text || (action.audioUrl && !action.audioInvalidated) || action.text.length <= maxLength) {
      chunksBySpeech.set(action.id, [{ originalId: action.id, action, text: action.text, start: 0, end: action.text.length }]);
      continue;
    }
    const ranges = splitTextRanges(action.text, maxLength, protectedBySpeech.get(action.id));
    if (ranges.length <= 1) {
      chunksBySpeech.set(action.id, [{ originalId: action.id, action, text: action.text, start: 0, end: action.text.length }]);
      continue;
    }
    didSplit = true;
    const chunks = ranges.map((range, index): SpeechChunk => {
      const { audioId: _audioId, audioUrl: _audioUrl, audioDurationSec: _duration,
        audioInvalidated: _invalidated, speechAlignment: _alignment, ...base } = action;
      return {
        ...range,
        originalId: action.id,
        action: { ...base, id: action.id + '_tts_' + (index + 1), text: range.text },
      };
    });
    chunksBySpeech.set(action.id, chunks);
    log.info(
      'Split speech for ' + providerId + ': action=' + action.id
        + ', len=' + action.text.length + ', chunks=' + chunks.length,
    );
  }
  if (!didSplit) return actions;

  const orderedChunks = actions.flatMap((action) => (
    action.type === 'speech' ? chunksBySpeech.get(action.id) ?? [] : []
  ));
  const chunkIndex = new Map(orderedChunks.map((chunk, index) => [chunk.action.id, index]));
  const locate = (speechId: string, anchor: SpeechAnchor): LocatedAnchor | undefined => {
    const speech = originalSpeech.get(speechId);
    const range = speech ? findAnchorRange(speech.text, anchor) : undefined;
    if (!range) return undefined;
    const chunk = chunksBySpeech.get(speechId)?.find((candidate) => (
      candidate.start <= range.start && range.end <= candidate.end
    ));
    if (!chunk) return undefined;
    const occurrence = localOccurrence(chunk.text, anchor.quote.trim(), range.start - chunk.start);
    return occurrence === undefined
      ? undefined
      : { chunk, anchor: { ...anchor, occurrence }, ...range };
  };
  const containingEnd = (speechId: string, end: number): SpeechChunk | undefined => (
    chunksBySpeech.get(speechId)?.find((chunk) => chunk.start < end && end <= chunk.end)
  );
  const affected = (startId: string, endId: string) => {
    const start = orderedChunks.findIndex((chunk) => chunk.originalId === startId);
    const end = orderedChunks.findLastIndex((chunk) => chunk.originalId === endId);
    return start >= 0 && end >= start
      && orderedChunks.slice(start, end + 1).some((chunk) => (chunksBySpeech.get(chunk.originalId)?.length ?? 0) > 1);
  };

  const splitSpotlight = (action: SpotlightAction, speechId: string): Action[] => {
    const endSpeechId = action.endSpeechId ?? speechId;
    if (!affected(speechId, endSpeechId)) return [action];
    const startActionIndex = actions.findIndex((candidate) => candidate.type === 'speech' && candidate.id === speechId);
    const endActionIndex = actions.findIndex((candidate) => candidate.type === 'speech' && candidate.id === endSpeechId);
    if (startActionIndex < 0 || endActionIndex < startActionIndex
      || actions.slice(startActionIndex, endActionIndex + 1).some((candidate) => (
        candidate.type !== 'speech' && candidate.type !== 'spotlight' && candidate.type !== 'laser'
      ))) return [];
    const start = action.speechAnchor
      ? locate(speechId, action.speechAnchor)
      : undefined;
    if ((action.speechAnchor && !start) || (!action.speechAnchor && (action.speechOffsetMs ?? 0) > 0)) return [];
    const startChunk = start?.chunk ?? chunksBySpeech.get(speechId)?.[0];
    const explicitEnd = action.endSpeechAnchor
      ? locate(endSpeechId, action.endSpeechAnchor)
      : undefined;
    if (action.endSpeechAnchor && !explicitEnd) return [];
    if (start && explicitEnd && speechId === endSpeechId && explicitEnd.end < start.end) return [];
    const implicitEnd = start && endSpeechId === speechId && !action.endSpeechAnchor
      ? containingEnd(speechId, speechCueSentenceEnd(originalSpeech.get(speechId)!.text, start.end))
      : undefined;
    const endChunk = explicitEnd?.chunk ?? implicitEnd
      ?? chunksBySpeech.get(endSpeechId)?.at(-1);
    const firstIndex = startChunk ? chunkIndex.get(startChunk.action.id) : undefined;
    const lastIndex = endChunk ? chunkIndex.get(endChunk.action.id) : undefined;
    if (firstIndex === undefined || lastIndex === undefined || lastIndex < firstIndex) return [];
    const selected = orderedChunks.slice(firstIndex, lastIndex + 1);
    return selected.map((chunk, index): SpotlightAction => ({
      ...action,
      id: selected.length === 1 ? action.id : action.id + '_tts_' + (index + 1),
      speechId: chunk.action.id,
      endSpeechId: chunk.action.id,
      speechAnchor: index === 0 ? start?.anchor : undefined,
      speechOffsetMs: undefined,
      endSpeechAnchor: index === selected.length - 1
        ? explicitEnd?.anchor
        : lastSpokenAnchor(chunk.text),
      endSpeechOffsetMs: undefined,
    }));
  };

  const splitLaser = (action: LaserAction, speechId: string): Action[] => {
    if ((chunksBySpeech.get(speechId)?.length ?? 0) <= 1) return [action];
    const primary = action.speechAnchor
      ? locate(speechId, action.speechAnchor)
      : undefined;
    if ((action.speechAnchor && !primary) || (!action.speechAnchor && (action.speechOffsetMs ?? 0) > 0)) return [];
    const firstChunk = primary?.chunk ?? chunksBySpeech.get(speechId)?.[0];
    if (!firstChunk) return [];
    type Stage = {
      chunk: SpeechChunk;
      start: number;
      end: number;
      elementId: string;
      selector?: LaserAction['selector'];
      anchor?: SpeechAnchor;
    };
    const stages: Stage[] = [{
      chunk: firstChunk,
      start: primary?.start ?? 0,
      end: primary?.end ?? 0,
      elementId: action.elementId,
      selector: action.selector,
      anchor: primary?.anchor,
    }];
    for (const waypoint of action.waypoints ?? []) {
      if (!waypoint.speechAnchor) return [];
      const located = locate(speechId, waypoint.speechAnchor);
      if (!located || located.start < stages[stages.length - 1]!.start) return [];
      stages.push({
        chunk: located.chunk,
        start: located.start,
        end: located.end,
        elementId: waypoint.elementId,
        selector: waypoint.selector,
        anchor: located.anchor,
      });
    }
    const explicitEnd = action.endSpeechAnchor
      ? locate(speechId, action.endSpeechAnchor)
      : undefined;
    if (action.endSpeechAnchor && !explicitEnd) return [];
    const lastStage = stages[stages.length - 1]!;
    if (explicitEnd && explicitEnd.end < lastStage.end) return [];
    const endChar = lastStage.anchor
      ? speechCueSentenceEnd(
          originalSpeech.get(speechId)!.text,
          lastStage.end,
        )
      : firstChunk.end;
    const endChunk = explicitEnd?.chunk ?? containingEnd(speechId, endChar);
    const firstIndex = chunkIndex.get(firstChunk.action.id);
    const lastIndex = endChunk ? chunkIndex.get(endChunk.action.id) : undefined;
    if (firstIndex === undefined || lastIndex === undefined || lastIndex < firstIndex) return [];
    const selected = orderedChunks.slice(firstIndex, lastIndex + 1);
    return selected.map((chunk, index): LaserAction => {
      const currentStages = stages.filter((stage) => stage.chunk === chunk);
      const atStart = currentStages.find((stage) => stage.start === chunk.start);
      const previous = [...stages].reverse().find((stage) => stage.start < chunk.start);
      const primaryStage = index === 0
        ? stages[0]!
        : atStart ?? previous;
      if (!primaryStage) throw new Error('Laser path lost its previous target while splitting speech');
      const laterStages = currentStages.filter((stage) => stage !== primaryStage);
      const waypoints: LaserWaypoint[] = laterStages.map((stage) => ({
        elementId: stage.elementId,
        ...(stage.selector ? { selector: stage.selector } : {}),
        ...(stage.anchor ? { speechAnchor: stage.anchor } : {}),
      }));
      return {
        ...action,
        id: selected.length === 1 ? action.id : action.id + '_tts_' + (index + 1),
        elementId: primaryStage.elementId,
        selector: primaryStage.selector,
        speechId: chunk.action.id,
        speechAnchor: primaryStage.chunk === chunk ? primaryStage.anchor : undefined,
        speechOffsetMs: undefined,
        endSpeechAnchor: index === selected.length - 1
          ? explicitEnd?.anchor
          : lastSpokenAnchor(chunk.text),
        endSpeechOffsetMs: undefined,
        duration: index === 0 && !action.speechAnchor && stages.length === 1
          ? action.duration
          : undefined,
        waypoints: waypoints.length ? waypoints : undefined,
      };
    });
  };

  return actions.flatMap((action, index): Action[] => {
    if (action.type === 'speech') return (chunksBySpeech.get(action.id) ?? []).map((chunk) => chunk.action);
    if (action.type !== 'spotlight' && action.type !== 'laser') return [action];
    const speechId = action.speechId ?? nextSpeechId(actions, index);
    if (!speechId) return [action];
    return action.type === 'spotlight'
      ? splitSpotlight(action, speechId)
      : splitLaser(action, speechId);
  });
}
