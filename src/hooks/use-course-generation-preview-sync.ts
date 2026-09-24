"use client";

import { useEffect, useRef, useState } from "react";

const ACTIVE_STATUSES = new Set(["queued", "pending", "running", "cancelling"]);
const POLL_MS = 3_000;

type Options = {
  courseId?: string;
  courseVersion?: number;
  classroomId?: string;
  refreshCourse: () => Promise<unknown>;
};

/** Follow this course's generation lifecycle without remounting its classroom player. */
export function useCourseGenerationPreviewSync({
  courseId,
  courseVersion,
  classroomId,
  refreshCourse,
}: Options): { refreshKey: string; previewClassroomId?: string } {
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState<{ courseId: string; classroomId?: string }>();
  const current = useRef({ classroomId, refreshCourse });
  useEffect(() => {
    current.current = { classroomId, refreshCourse };
  }, [classroomId, refreshCourse]);

  useEffect(() => {
    if (!courseId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let active = false;
    // Promotion writes the course version just before enqueueing the job. A
    // single deferred probe closes that race, without polling completed courses.
    let deferredProbe = true;
    let initialRetries = 2;
    const headers = { "X-OpenPBL-Role": "teacher" };

    const sync = async () => {
      if (inFlight || controller.signal.aborted) return;
      clearTimeout(timer);
      inFlight = true;
      try {
        const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/generation`, {
          cache: "no-store", headers, signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Generation status: ${response.status}`);
        const { job } = await response.json() as {
          job?: { status?: string; preview?: { classroomId?: string } | null } | null;
        };
        if (controller.signal.aborted) return;
        const nextActive = ACTIVE_STATUSES.has(job?.status?.toLowerCase() ?? "");
        const stateResponse = await fetch(`/api/courses/${encodeURIComponent(courseId)}/state`, {
          cache: "no-store", headers, signal: controller.signal,
        });
        if (!stateResponse.ok) throw new Error(`Course state: ${stateResponse.status}`);
        const { course } = await stateResponse.json() as {
          course?: { aiLearningClassroomId?: string; content?: { _openmaicClassroomId?: string } };
        };
        if (controller.signal.aborted) return;
        const nextClassroomId = course?.aiLearningClassroomId || course?.content?._openmaicClassroomId;
        if (nextClassroomId && nextClassroomId !== current.current.classroomId) {
          await current.current.refreshCourse();
        }
        if (controller.signal.aborted) return;
        setPreview((previous) => previous?.courseId === courseId
          && previous.classroomId === job?.preview?.classroomId
          ? previous
          : { courseId, classroomId: job?.preview?.classroomId });
        active = nextActive;
        setRevision((value) => value + 1);
        initialRetries = 0;
        if (active) {
          deferredProbe = false;
          timer = setTimeout(() => void sync(), POLL_MS);
        } else if (deferredProbe) {
          deferredProbe = false;
          timer = setTimeout(() => void sync(), POLL_MS);
        }
      } catch {
        // A service restart must not terminate an already active preview sync.
        if (!controller.signal.aborted && (active || initialRetries-- > 0)) {
          timer = setTimeout(() => void sync(), POLL_MS);
        }
      } finally {
        inFlight = false;
      }
    };
    const wake = () => {
      if (document.visibilityState === "visible") void sync();
    };
    void sync();
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [courseId, courseVersion]);

  return {
    refreshKey: `${courseId ?? ""}:${revision}`,
    previewClassroomId: preview?.courseId === courseId ? preview?.classroomId : undefined,
  };
}
