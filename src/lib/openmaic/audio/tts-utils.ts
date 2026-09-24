/**
 * Shared TTS utilities used by both client-side and server-side generation.
 */

import type { TTSProviderId } from './types';
import type { Action, SpeechAction } from '@openmaic/lib/types/action';
import { createLogger } from '@openmaic/lib/logger';

const log = createLogger('TTS');

/** Provider-specific max text length limits. */
export const TTS_MAX_TEXT_LENGTH: Partial<Record<TTSProviderId, number>> = {
  'glm-tts': 1024,
};

/**
 * Split long text into chunks that respect sentence boundaries.
 * Tries splitting at sentence-ending punctuation first, then clause-level
 * punctuation, and finally hard-splits at maxLength as a last resort.
 */
export function splitLongSpeechText(text: string, maxLength: number): string[] {
  const normalized = text.trim();
  if (!normalized || normalized.length <= maxLength) return [normalized];

  const units = normalized
    .split(/(?<=[。！？!?；;：:\n])/u)
    .map((part) => part.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = '';

  const pushChunk = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) chunks.push(trimmed);
  };

  const appendUnit = (unit: string) => {
    if (!current) {
      current = unit;
      return;
    }
    if ((current + unit).length <= maxLength) {
      current += unit;
      return;
    }
    pushChunk(current);
    current = unit;
  };

  const hardSplitUnit = (unit: string) => {
    const parts = unit.split(/(?<=[，,、])/u).filter(Boolean);
    if (parts.length > 1) {
      for (const part of parts) {
        if (part.length <= maxLength) appendUnit(part);
        else hardSplitUnit(part);
      }
      return;
    }

    let start = 0;
    while (start < unit.length) {
      appendUnit(unit.slice(start, start + maxLength));
      start += maxLength;
    }
  };

  for (const unit of units.length > 0 ? units : [normalized]) {
    if (unit.length <= maxLength) appendUnit(unit);
    else hardSplitUnit(unit);
  }

  pushChunk(current);
  return chunks;
}

/**
 * Split long speech actions into multiple shorter actions so each stays
 * within the TTS provider's text length limit. Each sub-action gets its
 * own independent audio file — no byte concatenation needed.
 */
export function splitLongSpeechActions(actions: Action[], providerId: TTSProviderId): Action[] {
  const maxLength = TTS_MAX_TEXT_LENGTH[providerId];
  if (!maxLength) return actions;

  let didSplit = false;
  const splitBySpeechId = new Map<string, SpeechAction[]>();
  const splitSpeech = (action: SpeechAction): SpeechAction[] => {
    if (action.type !== 'speech' || !action.text || (action.audioUrl && !action.audioInvalidated) || action.text.length <= maxLength)
      return [action];

    const chunks = splitLongSpeechText(action.text, maxLength);
    if (chunks.length <= 1) return [action];
    didSplit = true;
    const { audioId: _audioId, ...baseAction } = action as SpeechAction;

    log.info(
      `Split speech for ${providerId}: action=${action.id}, len=${action.text.length}, chunks=${chunks.length}`,
    );
    const split = chunks.map((chunk, i) => ({
      ...baseAction,
      id: `${action.id}_tts_${i + 1}`,
      text: chunk,
    })) as SpeechAction[];
    splitBySpeechId.set(action.id, split);
    return split;
  };
  for (const action of actions) {
    if (action.type === 'speech') splitSpeech(action);
  }
  const anchorChunk = (speechId: string | undefined, quote: string | undefined, occurrence = 0) => {
    if (!speechId) return undefined;
    const chunks = splitBySpeechId.get(speechId);
    if (!chunks?.length) return undefined;
    if (!quote) return { speechId: chunks[0]!.id, occurrence };
    let remaining = occurrence;
    for (const chunk of chunks) {
      const count = chunk.text.split(quote).length - 1;
      if (remaining < count) return { speechId: chunk.id, occurrence: remaining };
      remaining -= count;
    }
    return { speechId: chunks[0]!.id, occurrence };
  };
  const nextActions: Action[] = actions.flatMap((action): Action[] => {
    if (action.type === 'speech') return splitBySpeechId.get(action.id) ?? [action];
    if (action.type !== 'spotlight' && action.type !== 'laser') return [action];
    const anchored = anchorChunk(action.speechId, action.speechAnchor?.quote, action.speechAnchor?.occurrence ?? 0);
    const endChunks = action.type === 'spotlight' && action.endSpeechId
      ? splitBySpeechId.get(action.endSpeechId) : undefined;
    return [{
      ...action,
      ...(anchored ? { speechId: anchored.speechId } : {}),
      ...(anchored && action.speechAnchor
        ? { speechAnchor: { ...action.speechAnchor, occurrence: anchored.occurrence } }
        : {}),
      ...(action.type === 'spotlight' && endChunks?.length
        ? { endSpeechId: endChunks[endChunks.length - 1]!.id }
        : {}),
    }];
  });
  return didSplit ? nextActions : actions;
}
