'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { Scene } from '@openmaic/lib/types/stage';
import type { LectureChatPage } from '@/lib/courses/lecture-chat-types';

export type LectureChatScope = { courseId: string; classroomId: string; studentId: string };
const LectureChatContext = createContext<LectureChatScope | null>(null);

export function LectureChatProvider({ children, scope }: { children: ReactNode; scope: LectureChatScope | null }) {
  return <LectureChatContext.Provider value={scope}>{children}</LectureChatContext.Provider>;
}

export function useLectureChatScope(): LectureChatScope | null {
  return useContext(LectureChatContext);
}

/** Resolve the durable source page rather than an insertion-specific runtime id. */
export function resolveLectureChatPage(scene: Scene | null | undefined, mainClassroomId: string): LectureChatPage | null {
  if (!scene || scene.type === 'quiz' || scene.type === 'pbl' || scene.audience === 'teacher') return null;
  const adaptive = scene as Scene & { openpblAdaptiveClassroomId?: string; openpblAdaptiveInsertionId?: string };
  const prefix = adaptive.openpblAdaptiveInsertionId ? `adaptive:${adaptive.openpblAdaptiveInsertionId}:` : '';
  return {
    classroomId: adaptive.openpblAdaptiveClassroomId || mainClassroomId,
    sceneId: prefix && scene.id.startsWith(prefix) ? scene.id.slice(prefix.length) : scene.id,
  };
}
