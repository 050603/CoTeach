"use client";

import { createContext, useContext } from "react";
import type { KnowledgeLectureAttempt } from "@/lib/session/types";

const KnowledgeLectureQuizLockContext = createContext<ReadonlyMap<string, KnowledgeLectureAttempt>>(new Map());

export function KnowledgeLectureQuizLockProvider({
  attemptsBySceneId,
  children,
}: {
  attemptsBySceneId: ReadonlyMap<string, KnowledgeLectureAttempt>;
  children: React.ReactNode;
}) {
  return <KnowledgeLectureQuizLockContext.Provider value={attemptsBySceneId}>{children}</KnowledgeLectureQuizLockContext.Provider>;
}

export function useLockedKnowledgeLectureAttempt(sceneId: string, quizOutlineId?: string): KnowledgeLectureAttempt | undefined {
  const attempts = useKnowledgeLectureQuizAttempts();
  return (quizOutlineId ? attempts.get(quizOutlineId) : undefined) ?? attempts.get(sceneId);
}

export function useKnowledgeLectureQuizAttempts(): ReadonlyMap<string, KnowledgeLectureAttempt> {
  return useContext(KnowledgeLectureQuizLockContext);
}
