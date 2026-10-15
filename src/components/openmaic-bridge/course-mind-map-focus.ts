'use client';

import { useMemo } from 'react';
import { useStageStore } from '@openmaic/lib/store';
import { resolveCourseMindMapFocus } from '@/lib/course-mind-map/playback';
import { useTeachingKnowledgeGraph } from './knowledge-graph-context';

export type MindMapPlaybackProps = {
  activeActionIndex?: number;
  mediaTimeMs?: number | null;
  quizWaiting?: boolean;
};

export function useActiveCourseMindMapNode({
  activeActionIndex = -1, mediaTimeMs, quizWaiting = false,
}: MindMapPlaybackProps): string | null {
  const { mindMap } = useTeachingKnowledgeGraph();
  const scene = useStageStore(state => state.getCurrentScene());
  return useMemo(() => resolveCourseMindMapFocus(mindMap, {
    sceneId: scene?.id,
    knowledgePointIds: scene?.knowledgePointIds,
    actions: scene?.actions,
    activeActionIndex,
    mediaTimeMs,
    quizWaiting,
  }), [activeActionIndex, mediaTimeMs, mindMap, quizWaiting, scene]);
}
