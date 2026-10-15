import type { CourseMindMap } from './types';
import { courseMindMapAncestors } from './layout';

export type CourseMindMapPlaybackPosition = {
  sceneId?: string;
  knowledgePointIds?: string[];
  actions?: ReadonlyArray<{
    id: string;
    type: string;
    text?: string;
    audioInvalidated?: boolean;
    speechAlignment?: { status: string; textHash: string; audioHash: string };
  }>;
  activeActionIndex?: number;
  /** Actual HTMLAudioElement time, in milliseconds; never character progress. */
  mediaTimeMs?: number | null;
  quizWaiting?: boolean;
};

function commonBranch(map: CourseMindMap, nodeIds: string[], fallback: string): string {
  const paths = [...new Set(nodeIds)].map(id => courseMindMapAncestors(map, id)).filter(path => path.length);
  if (!paths.length) return fallback;
  const common = paths[0].filter((id, index) => paths.every(path => path[index] === id));
  const candidate = common.at(-1) ?? fallback;
  // Without an audio clock, show a branch rather than guessing a detail's timing.
  return paths.length === 1 && !map.nodes.some(node => node.parentId === candidate)
    ? map.nodes.find(node => node.id === candidate)?.parentId ?? candidate
    : candidate;
}

/** Pure projection: jumping backwards, replay and pause all use the same position. */
export function resolveCourseMindMapFocus(
  map: CourseMindMap | undefined,
  position: CourseMindMapPlaybackPosition,
): string | null {
  if (!map?.nodes.length) return null;
  const ids = new Set(map.nodes.map(node => node.id));
  const binding = map.bindings.find(item => item.sceneId === position.sceneId);
  const pageFallback = binding && ids.has(binding.defaultNodeId) ? binding.defaultNodeId
    : commonBranch(map, map.nodes.filter(node => node.knowledgePointIds.some(id => position.knowledgePointIds?.includes(id)))
      .map(node => node.id), map.rootId);
  if (position.quizWaiting) return pageFallback;
  const action = position.actions?.[position.activeActionIndex ?? -1];
  if (!binding || action?.type !== 'speech') return pageFallback;
  const cues = binding.cues.filter(cue => cue.speechId === action.id && ids.has(cue.nodeId));
  if (!cues.length) return pageFallback;
  const speechFallback = commonBranch(map, cues.map(cue => cue.nodeId), pageFallback);
  const alignment = action.speechAlignment;
  if (position.mediaTimeMs === null || position.mediaTimeMs === undefined
    || !Number.isFinite(position.mediaTimeMs) || position.mediaTimeMs < 0
    || action.audioInvalidated || alignment?.status !== 'aligned'
    || cues.some(cue => cue.startMs === undefined || !Number.isFinite(cue.startMs) || cue.startMs < 0
      || !cue.speechTextHash || cue.speechTextHash !== alignment.textHash
      || !cue.audioHash || cue.audioHash !== alignment.audioHash
      || !action.text?.includes(cue.anchor.quote))) {
    return speechFallback;
  }
  return [...cues].sort((a, b) => a.startMs! - b.startMs!)
    .filter(cue => cue.startMs! <= position.mediaTimeMs!).at(-1)?.nodeId ?? speechFallback;
}
