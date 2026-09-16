"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FinalArtifactSummary, ShowcasePresentationSnapshot } from "@/lib/session/types";
import { subscribeShowcasePresentation } from "@/lib/showcase/realtime-client";
import type { ShowcaseAction, ShowcaseData, ShowcaseEventPayload } from "@/lib/showcase/types";

type HookState = {
  data?: ShowcaseData;
  loading: boolean;
  error?: string;
};

function isTeacherPage(): boolean {
  return typeof window !== "undefined" && window.location.pathname.startsWith("/teacher");
}

function mergeSnapshot(
  data: ShowcaseData,
  snapshot: ShowcasePresentationSnapshot,
): ShowcaseData {
  const previous = data.presentations.find((item) => item.id === snapshot.id);
  const merged = {
    ...previous,
    ...snapshot,
    studentName: snapshot.studentName ?? previous?.studentName,
  };
  const presentations = [
    merged,
    ...data.presentations.filter((item) => item.id !== snapshot.id),
  ];
  return {
    ...data,
    presentations,
    activePresentation: snapshot.status === "active"
      ? merged
      : data.activePresentation?.id === snapshot.id
        ? null
        : data.activePresentation,
  };
}

function applyRealtimePayload(
  data: ShowcaseData,
  payload: ShowcaseEventPayload,
): ShowcaseData {
  let next = data;
  if (Object.prototype.hasOwnProperty.call(payload, "presentingGroupId")
    || Object.prototype.hasOwnProperty.call(payload, "presentingStudentId")
    || Object.prototype.hasOwnProperty.call(payload, "presentingStudentName")) {
    const presentingGroupId = Object.prototype.hasOwnProperty.call(payload, "presentingGroupId")
      ? payload.presentingGroupId
      : data.presentingGroupId;
    const presentingStudentId = Object.prototype.hasOwnProperty.call(payload, "presentingStudentId")
      ? payload.presentingStudentId
      : data.presentingStudentId;
    next = {
      ...next,
      presentingGroupId,
      presentingStudentId,
      presentingStudentName: payload.presentingStudentName
        ?? next.students.find((student) => student.studentId === presentingStudentId)?.name
        ?? (presentingStudentId === data.presentingStudentId ? data.presentingStudentName : undefined),
      students: next.students.map((student) => ({
        ...student,
        isAssigned: presentingStudentId
          ? student.studentId === presentingStudentId && student.groupId === presentingGroupId
          : Boolean(presentingGroupId) && student.groupId === presentingGroupId,
      })),
    };
  }
  if (payload.queue || payload.minutesPerStudent !== undefined) {
    const queue = payload.queue ?? next.queue;
    next = {
      ...next,
      queue,
      minutesPerStudent: payload.minutesPerStudent ?? next.minutesPerStudent,
      currentQueueItem: queue.find((item) => ["called", "pending-approval", "presenting", "evaluating", "rejected"].includes(item.status)) ?? null,
      nextQueueItem: queue.find((item) => item.status === "waiting") ?? null,
    };
  }
  if (payload.snapshot) {
    const incomingRevision = payload.snapshot.revision ?? payload.snapshot.viewState?.revision ?? 0;
    const existingRevision = next.presentations.find((item) => item.id === payload.snapshot!.id)?.revision
      ?? next.presentations.find((item) => item.id === payload.snapshot!.id)?.viewState?.revision
      ?? 0;
    // Every lifecycle and viewport update carries the same server revision.
    // Do not let a delayed terminal event clear a newer active snapshot.
    if (incomingRevision >= existingRevision) {
      next = mergeSnapshot(next, payload.snapshot);
    }
  }
  return next;
}

function mergeLoadedData(current: ShowcaseData | undefined, incoming: ShowcaseData): ShowcaseData {
  if (!current) return incoming;
  const currentById = new Map(current.presentations.map((item) => [item.id, item]));
  const presentations = incoming.presentations.map((next) => {
    const previous = currentById.get(next.id);
    if (!previous || next.revision >= previous.revision) return next;
    return previous;
  }).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  // `presentations` is the revision-merged source of truth. Looking up the
  // active row there avoids resurrecting a delayed lower-revision
  // `activePresentation` field from a polling response.
  const activePresentation = presentations.find((item) => item.status === "active") ?? null;
  return {
    ...incoming,
    presentations,
    activePresentation,
  };
}

export function latestArtifact(
  artifacts: FinalArtifactSummary[],
  kind: FinalArtifactSummary["kind"],
): FinalArtifactSummary | undefined {
  return artifacts.find((artifact) => artifact.kind === kind);
}

export function useShowcasePresentation(courseId: string | undefined) {
  const [state, setState] = useState<HookState>({ loading: Boolean(courseId) });
  const requestInFlight = useRef(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!courseId) return;
    try {
      const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/showcase/presentation`, {
        cache: "no-store",
        signal,
        headers: { "X-OpenPBL-Role": isTeacherPage() ? "teacher" : "student" },
      });
      const payload = await response.json().catch(() => null) as ShowcaseData & { message?: string } | null;
      if (!response.ok) throw new Error(payload?.message ?? `汇报状态读取失败（${response.status}）`);
      if (!signal?.aborted) {
        setState((current) => ({
          data: mergeLoadedData(current.data, payload as ShowcaseData),
          loading: false,
          error: undefined,
        }));
      }
    } catch (error) {
      if (signal?.aborted) return;
      setState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : "汇报状态读取失败" }));
    }
  }, [courseId]);

  useEffect(() => {
    if (!courseId) {
      setState({ loading: false });
      return;
    }
    const controller = new AbortController();
    void load(controller.signal);
    const unsubscribe = subscribeShowcasePresentation(courseId, (payload) => {
      if (payload.snapshot || Object.prototype.hasOwnProperty.call(payload, "presentingGroupId") || Object.prototype.hasOwnProperty.call(payload, "presentingStudentId") || Object.prototype.hasOwnProperty.call(payload, "presentingStudentName")) {
        // Student devices only need queue/lifecycle refreshes. The active
        // artifact and viewport stay teacher-side because the room watches
        // the physical teacher projection.
        const visiblePayload = isTeacherPage() ? payload : { ...payload, snapshot: undefined };
        setState((current) => current.data ? { ...current, data: applyRealtimePayload(current.data, visiblePayload), error: undefined } : current);
        if (!payload.queue && (Object.prototype.hasOwnProperty.call(payload, "presentingStudentId") || payload.snapshot?.status !== "active")) {
          void load();
        }
      } else {
        void load();
      }
    });
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && !requestInFlight.current) {
        requestInFlight.current = true;
        void load().finally(() => { requestInFlight.current = false; });
      }
    }, 3_000);
    return () => {
      controller.abort();
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [courseId, load]);

  const runAction = useCallback(async (action: ShowcaseAction) => {
    if (!courseId) throw new Error("COURSE_REQUIRED");
    const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/showcase/presentation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-OpenPBL-Role": isTeacherPage() ? "teacher" : "student",
      },
      body: JSON.stringify(action),
    });
    const payload = await response.json().catch(() => null) as ShowcaseData | ShowcasePresentationSnapshot | { message?: string } | null;
    if (!response.ok) {
      const message = payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string"
        ? payload.message
        : `汇报操作失败（${response.status}）`;
      throw new Error(message);
    }
    setState((current) => {
      if (!current.data || !payload || typeof payload !== "object") return current;
      if ("courseId" in payload && "status" in payload && "id" in payload) {
        return { ...current, data: applyRealtimePayload(current.data, { snapshot: payload as ShowcasePresentationSnapshot }) };
      }
      return { ...current, data: payload as ShowcaseData, error: undefined };
    });
    return payload;
  }, [courseId]);

  return useMemo(() => ({ ...state, runAction, reload: load }), [load, runAction, state]);
}

/** Shared controller shape used by the classroom shell and both showcase views. */
export type ShowcasePresentationController = ReturnType<typeof useShowcasePresentation>;
