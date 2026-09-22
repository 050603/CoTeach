"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectMemoryEntry } from "@/lib/ai-collaboration/project-support-types";

function continuationFor(memories: ProjectMemoryEntry[]): string | undefined {
  const open = memories.find((memory) => memory.kind === "open-question");
  if (open) return `上次还没有解决的问题是：${open.content}`;
  const attempt = memories.find((memory) => memory.kind === "attempt-result");
  return attempt ? `可以从上次的尝试继续：${attempt.content}` : undefined;
}

export function useProjectMemory(input: {
  courseId: string;
  studentId: string;
  enabled: boolean;
}) {
  const scopeKey = input.enabled ? `${input.courseId}:${input.studentId}` : "";
  const [memoryState, setMemoryState] = useState<{ scopeKey: string; entries: ProjectMemoryEntry[] }>({ scopeKey: "", entries: [] });
  const memories = useMemo(
    () => memoryState.scopeKey === scopeKey ? memoryState.entries : [],
    [memoryState.entries, memoryState.scopeKey, scopeKey],
  );
  const setMemories = useCallback((value: ProjectMemoryEntry[] | ((current: ProjectMemoryEntry[]) => ProjectMemoryEntry[])) => {
    setMemoryState((current) => {
      const active = current.scopeKey === scopeKey ? current.entries : [];
      return { scopeKey, entries: typeof value === "function" ? value(active) : value };
    });
  }, [scopeKey]);

  useEffect(() => {
    if (!input.enabled || !input.courseId || !input.studentId) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ courseId: input.courseId, studentId: input.studentId });
    void fetch(`/api/ai-collaboration/memory?${query.toString()}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { memories?: ProjectMemoryEntry[] };
        if (response.ok && !controller.signal.aborted) {
          setMemoryState({ scopeKey, entries: payload.memories ?? [] });
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [input.courseId, input.enabled, input.studentId, scopeKey]);

  const updateMemory = useCallback((memoryId: string, content: string) => {
    void fetch("/api/ai-collaboration/memory", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update", courseId: input.courseId, studentId: input.studentId, memoryId, content }),
    }).then(async (response) => {
      const payload = await response.json() as { memories?: ProjectMemoryEntry[] };
      if (response.ok) setMemories(payload.memories ?? []);
    }).catch(() => undefined);
  }, [input.courseId, input.studentId, setMemories]);

  const deleteMemory = useCallback((memoryId: string) => {
    const query = new URLSearchParams({ courseId: input.courseId, studentId: input.studentId, memoryId });
    void fetch(`/api/ai-collaboration/memory?${query.toString()}`, { method: "DELETE" })
      .then(async (response) => {
        const payload = await response.json() as { memories?: ProjectMemoryEntry[] };
        if (response.ok) setMemories(payload.memories ?? []);
      }).catch(() => undefined);
  }, [input.courseId, input.studentId, setMemories]);

  const clearMemories = useCallback(() => {
    void fetch("/api/ai-collaboration/memory", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clear", courseId: input.courseId, studentId: input.studentId }),
    }).then(async (response) => {
      const payload = await response.json() as { memories?: ProjectMemoryEntry[] };
      if (response.ok) setMemories(payload.memories ?? []);
    }).catch(() => undefined);
  }, [input.courseId, input.studentId, setMemories]);

  return {
    memories,
    continuation: useMemo(() => continuationFor(memories), [memories]),
    replaceMemories: setMemories,
    updateMemory,
    deleteMemory,
    clearMemories,
  };
}
