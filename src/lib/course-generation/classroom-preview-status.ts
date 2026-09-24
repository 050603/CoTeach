import { createHash } from 'node:crypto';
import type { PersistedClassroomData } from '@openmaic/lib/server/classroom-storage';
import type { GenerationPreviewStatus } from './preview-status';
import type { Action, SpeechAction, SpeechAnchor } from '@openmaic/lib/types/action';
import { findSpeechCueAnchorRange } from '@openmaic/lib/generation/speech-cue-boundaries';

function hasPlayableAlignment(speech: SpeechAction, anchors: SpeechAnchor[]): boolean {
  const alignment = speech.speechAlignment;
  if (alignment?.status !== 'aligned' || !Array.isArray(alignment.spans) || !alignment.spans.length || !alignment.audioHash
    || alignment.textHash !== createHash('sha256').update(speech.text).digest('hex')) return false;
  let previousChar = 0;
  let previousMs = 0;
  for (const span of alignment.spans) {
    if (![span.startChar, span.endChar, span.startMs, span.endMs].every(Number.isFinite)
      || span.startChar < previousChar || span.endChar <= span.startChar || span.endChar > speech.text.length
      || span.startMs < previousMs || span.endMs < span.startMs
      || span.text !== speech.text.slice(span.startChar, span.endChar)) return false;
    previousChar = span.endChar;
    previousMs = span.endMs;
  }
  return anchors.every((anchor) => {
    const range = findSpeechCueAnchorRange(speech.text, anchor);
    if (!range) return false;
    // Forced alignment times spoken tokens, not surrounding quote marks or punctuation.
    const quote = speech.text.slice(range.start, range.end);
    const start = range.start + (quote.match(/^[\p{P}\s]+/u)?.[0].length ?? 0);
    const end = range.end - (quote.match(/[\p{P}\s]+$/u)?.[0].length ?? 0);
    return end > start && alignment.spans.some((span) => span.startChar <= start && span.endChar > start)
      && alignment.spans.some((span) => span.startChar < end && span.endChar >= end);
  });
}

/** Only phrase-timed cues require alignment; legacy adjacent cues remain playable. */
function requiredSpeechAnchors(actions: Action[]): Map<string, SpeechAnchor[]> {
  const required = new Map<string, SpeechAnchor[]>();
  const add = (id: string | undefined, anchor: SpeechAnchor | undefined) => {
    if (!anchor) return;
    const key = id ?? '';
    required.set(key, [...(required.get(key) ?? []), anchor]);
  };
  actions.forEach((action, index) => {
    if (action.type !== 'spotlight' && action.type !== 'laser') return;
    const speechId = action.speechId ?? actions.slice(index + 1).find((item) => item.type === 'speech')?.id;
    add(speechId, action.speechAnchor);
    add(action.type === 'spotlight' ? action.endSpeechId ?? speechId : speechId, action.endSpeechAnchor);
    if (action.type === 'laser') action.waypoints?.forEach((waypoint) => add(speechId, waypoint.speechAnchor));
  });
  return required;
}

/** Derived from durable media, so canonical and in-progress preview URLs agree. */
export function classroomPreviewStatus(
  classroom: Pick<PersistedClassroomData, 'scenes' | 'assetGeneration'>,
  lifecycle?: { active: boolean; status: string },
): GenerationPreviewStatus {
  const active = lifecycle?.active ?? classroom.assetGeneration?.status === 'running';
  const status = lifecycle?.status ?? classroom.assetGeneration?.status ?? 'completed';
  const scenes = Object.fromEntries(classroom.scenes.map((scene) => {
    const speeches = (scene.actions ?? []).filter((action) => action.type === 'speech' && action.text.trim());
    const audioReady = speeches.every((action) => action.type === 'speech' && action.audioUrl && !action.audioInvalidated);
    const required = requiredSpeechAnchors(scene.actions ?? []);
    const waitingForAlignment = [...required].filter(([id, anchors]) => {
      const speech = speeches.find((item) => item.id === id);
      return !speech || speech.type !== 'speech' || !hasPlayableAlignment(speech, anchors);
    });
    const alignmentFailure = waitingForAlignment.flatMap(([id]) => {
      const speech = speeches.find((item) => item.id === id);
      return speech?.type === 'speech' && speech.speechAlignment?.status === 'failed'
        ? [speech.speechAlignment.error || '教学动作与讲解音频对齐失败，请恢复生成后重试。'] : [];
    })[0];
    const ready = audioReady && waitingForAlignment.length === 0;
    const failure = classroom.assetGeneration?.failures.find((item) => item.type === 'tts'
      && (item.elementId === 'tts-batch' || speeches.some((speech) => speech.id === item.elementId)));
    return [scene.id, {
      status: ready ? 'ready' : failure || alignmentFailure || !active ? 'failed' : 'preparing',
      ...(!ready ? { phase: audioReady ? 'alignment' : 'audio' } : {}),
      ...(failure || alignmentFailure ? { error: failure?.error ?? alignmentFailure } : {}),
    }];
  })) as GenerationPreviewStatus['scenes'];
  return {
    active,
    jobStatus: status,
    contentVersion: createHash('sha256').update(JSON.stringify({ scenes: classroom.scenes, assets: classroom.assetGeneration, status })).digest('hex'),
    scenes,
  };
}
