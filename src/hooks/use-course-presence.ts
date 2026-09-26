"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  onlineStudentIds,
  type PresenceMember,
  type PresenceSnapshot,
} from "@/lib/presence";
import {
  PRESENCE_SNAPSHOT_INTERVAL_MS,
  shouldReadPresence,
} from "@/lib/realtime/presence-policy";

const HEARTBEAT_INTERVAL_MS = 20_000;
type CoursePresenceSnapshot = PresenceSnapshot & { courseId?: string };
const EMPTY_MEMBERS: PresenceMember[] = [];

export function useCoursePresence({
  courseId,
  role,
  enabled = true,
  heartbeat = false,
}: {
  courseId?: string;
  role: "teacher" | "student";
  enabled?: boolean;
  heartbeat?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<CoursePresenceSnapshot>({ members: [] });
  const [transportDegraded, setTransportDegraded] = useState(false);
  const readFailuresRef = useRef(0);
  const heartbeatFailuresRef = useRef(0);
  const readSequenceRef = useRef(0);

  const recordSuccess = useCallback((channel: "read" | "heartbeat") => {
    const failures = channel === "read" ? readFailuresRef : heartbeatFailuresRef;
    if (failures.current >= 3) {
      toast.success("在线状态同步已恢复", { id: `presence-sync-${role}-${courseId}` });
    }
    failures.current = 0;
    if (readFailuresRef.current < 3 && heartbeatFailuresRef.current < 3) {
      setTransportDegraded(false);
    }
  }, [courseId, role]);

  const recordFailure = useCallback((channel: "read" | "heartbeat", error: unknown) => {
    const failures = channel === "read" ? readFailuresRef : heartbeatFailuresRef;
    failures.current += 1;
    console.error("[presence] synchronization failed", error);
    if (failures.current === 3) {
      setTransportDegraded(true);
      toast.error("在线状态同步中断", {
        id: `presence-sync-${role}-${courseId}`,
        description: "服务器未能确认最新在线状态，正在自动重试。",
      });
    }
  }, [courseId, role]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!courseId || !enabled) return;
    const sequence = ++readSequenceRef.current;
    const response = await fetch(
      `/api/courses/${encodeURIComponent(courseId)}/presence`,
      {
        headers: { "X-OpenPBL-Role": role },
        cache: "no-store",
        signal,
      },
    );
    if (!response.ok) throw new Error(`Presence request failed: ${response.status}`);
    const body = (await response.json()) as PresenceSnapshot;
    if (signal?.aborted || sequence !== readSequenceRef.current) return;
    setSnapshot({
      ...body,
      courseId,
    });
    recordSuccess("read");
  }, [courseId, enabled, recordSuccess, role]);

  useEffect(() => {
    if (!courseId || !enabled) {
      return;
    }

    const controller = new AbortController();
    const updateSnapshot = () => {
      if (!shouldReadPresence(document.visibilityState)) return;
      void refresh(controller.signal).catch((error) => {
        if (!controller.signal.aborted) recordFailure("read", error);
      });
    };
    updateSnapshot();
    document.addEventListener("visibilitychange", updateSnapshot);
    const intervalId = window.setInterval(
      updateSnapshot,
      PRESENCE_SNAPSHOT_INTERVAL_MS[role],
    );
    return () => {
      controller.abort();
      document.removeEventListener("visibilitychange", updateSnapshot);
      window.clearInterval(intervalId);
    };
  }, [courseId, enabled, recordFailure, refresh, role]);

  useEffect(() => {
    if (!courseId || !enabled || !heartbeat || role !== "student") return;

    const sendHeartbeat = () => {
      void fetch(`/api/courses/${encodeURIComponent(courseId)}/presence`, {
        method: "PUT",
        headers: { "X-OpenPBL-Role": "student" },
        keepalive: true,
      })
        .then((response) => {
          if (!response.ok) throw new Error(`Presence heartbeat failed: ${response.status}`);
          recordSuccess("heartbeat");
        })
        .catch((error) => recordFailure("heartbeat", error));
    };

    sendHeartbeat();
    const intervalId = window.setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [courseId, enabled, heartbeat, recordFailure, recordSuccess, role]);

  const visibleMembers = enabled && snapshot.courseId === courseId
    ? snapshot.members
    : EMPTY_MEMBERS;
  const studentIds = useMemo(
    () => onlineStudentIds(visibleMembers),
    [visibleMembers],
  );

  return {
    members: visibleMembers,
    onlineStudentIds: studentIds,
    onlineCount: studentIds.size,
    degraded: snapshot.degraded === true || transportDegraded,
    source: snapshot.source,
    refresh,
  };
}
