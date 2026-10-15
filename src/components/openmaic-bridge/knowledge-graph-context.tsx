'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { KnowledgeGraph, KnowledgePoint } from '@/lib/session/types';
import type { CourseMindMap } from '@/lib/course-mind-map/types';

type TeachingKnowledgeGraph = {
  graph?: KnowledgeGraph;
  points: KnowledgePoint[];
  mindMap?: CourseMindMap;
};

const KnowledgeGraphContext = createContext<TeachingKnowledgeGraph>({ points: [] });

export function TeachingKnowledgeGraphProvider({
  children,
  graph,
  points,
  mindMap,
}: TeachingKnowledgeGraph & { children: ReactNode }) {
  return (
    <KnowledgeGraphContext.Provider value={{ graph, points, mindMap }}>
      {children}
    </KnowledgeGraphContext.Provider>
  );
}

export function useTeachingKnowledgeGraph(): TeachingKnowledgeGraph {
  return useContext(KnowledgeGraphContext);
}
