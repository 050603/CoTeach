import { createHash } from 'node:crypto';
import type { Scene } from '@/lib/openmaic/types/stage';
import type { SpeechAction } from '@/lib/openmaic/types/action';
import { resolveAlignedSpeechCueAnchor } from '@/lib/openmaic/generation/speech-cue-boundaries';
import { computeCourseMindMapBindingFingerprint } from './source';
import type { CourseMindMap } from './types';

function authenticAlignment(speech: SpeechAction): boolean {
  const alignment = speech.speechAlignment;
  if (speech.audioInvalidated || (!speech.audioId && !speech.audioUrl) || !alignment || alignment.status !== 'aligned'
    || !alignment.spans.length || !/^[a-f0-9]{64}$/i.test(alignment.audioHash)
    || alignment.textHash !== createHash('sha256').update(speech.text).digest('hex')) return false;
  let charEnd = 0;
  let previousStart = 0;
  return alignment.spans.every((span) => {
    const valid = Number.isInteger(span.startChar) && Number.isInteger(span.endChar)
      && span.startChar >= charEnd && span.endChar > span.startChar && span.endChar <= speech.text.length
      && Number.isFinite(span.startMs) && Number.isFinite(span.endMs)
      && span.startMs >= previousStart && span.endMs >= span.startMs
      && speech.text.slice(span.startChar, span.endChar) === span.text;
    charEnd = span.endChar;
    previousStart = span.startMs;
    return valid;
  });
}

/** Re-resolve every cue from exact text and authentic spans; never estimate time by text length. */
export function resolveCourseMindMapBindings(map: CourseMindMap, scenes: Scene[]): CourseMindMap {
  const nodes = new Map(map.nodes.map((node) => [node.id, node]));
  const parents = new Set(map.nodes.map((node) => node.parentId));
  const bindings = new Map(map.bindings.map((binding) => [binding.sceneId, binding]));
  return {
    ...map,
    bindingFingerprint: computeCourseMindMapBindingFingerprint(scenes),
    bindings: scenes.map((scene) => {
      const binding = bindings.get(scene.id);
      let defaultNodeId = binding?.defaultNodeId ?? map.rootId;
      if (!nodes.has(defaultNodeId)) defaultNodeId = map.rootId;
      // A quiz opens a broad branch only; narration never focuses an answer leaf.
      if (scene.type === 'quiz') {
        if (!parents.has(defaultNodeId)) defaultNodeId = nodes.get(defaultNodeId)?.parentId ?? map.rootId;
        return { sceneId: scene.id, defaultNodeId, cues: [] };
      }
      const speeches = new Map((scene.actions ?? []).filter((action) => action.type === 'speech').map((action) => [action.id, action]));
      const cues = (binding?.cues ?? []).filter((cue) => nodes.has(cue.nodeId) && speeches.has(cue.speechId)).map((cue) => {
        const authored = { speechId: cue.speechId, nodeId: cue.nodeId, anchor: { ...cue.anchor } };
        const speech = speeches.get(cue.speechId)!;
        const quote = cue.anchor.quote.trim();
        const first = speech.text.indexOf(quote);
        const unambiguous = cue.anchor.occurrence !== undefined
          ? Number.isInteger(cue.anchor.occurrence) && cue.anchor.occurrence >= 0
          : first >= 0 && speech.text.indexOf(quote, first + quote.length) < 0;
        const timing = unambiguous && authenticAlignment(speech)
          ? resolveAlignedSpeechCueAnchor(speech.text, speech.speechAlignment!.spans, cue.anchor) : null;
        return { ...authored, ...(timing ? { startMs: timing.startMs,
          speechTextHash: speech.speechAlignment!.textHash, audioHash: speech.speechAlignment!.audioHash } : {}) };
      });
      return { sceneId: scene.id, defaultNodeId, cues };
    }),
  };
}
