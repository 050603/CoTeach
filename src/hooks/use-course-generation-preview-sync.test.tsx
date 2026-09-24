import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCourseGenerationPreviewSync } from "./use-course-generation-preview-sync";

const response = (data: unknown) => new Response(JSON.stringify(data));
const settle = () => act(async () => { await Promise.resolve(); });
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(3_000); });

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function setup(status = "COMPLETED") {
  const model = { status, classroomId: "accepted-test", previewId: undefined as string | undefined, unavailable: false };
  const fetchMock = vi.fn(async (url: string) => {
    if (model.unavailable) return new Response(null, { status: 503 });
    return url.endsWith("/generation")
      ? response({ job: { status: model.status, preview: model.previewId ? { classroomId: model.previewId } : null } })
      : response({ course: { aiLearningClassroomId: model.classroomId } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const refreshCourse = vi.fn(async () => undefined);
  const options = { courseId: "course-a", courseVersion: 1, classroomId: "accepted-test", refreshCourse };
  return { model, fetchMock, refreshCourse, options };
}

describe("course generation preview synchronization", () => {
  it("opens a task preview as soon as its first pages are available when the course has no classroom yet", async () => {
    const { model, options, refreshCourse } = setup("RUNNING");
    model.classroomId = "";
    const { result } = renderHook(() => useCourseGenerationPreviewSync({ ...options, classroomId: undefined }));
    await settle();
    expect(result.current.previewClassroomId).toBeUndefined();

    model.previewId = "course-generation-preview-job-1";
    await tick();
    expect(result.current.previewClassroomId).toBe(model.previewId);

    model.status = "COMPLETED";
    model.previewId = undefined;
    model.classroomId = "persisted-classroom";
    await tick();
    expect(result.current.previewClassroomId).toBeUndefined();
    expect(refreshCourse).toHaveBeenCalledOnce();
  });

  it("wakes a completed player on external course-version changes, follows promotion, and stops at terminal", async () => {
    const { model, fetchMock, options, refreshCourse } = setup();
    const { result, rerender } = renderHook((props) => useCourseGenerationPreviewSync(props), { initialProps: options });
    await settle();
    await tick();
    const terminalCalls = fetchMock.mock.calls.length;
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(terminalCalls);
    const initialKey = result.current.refreshKey;

    // The course event arrives before the job enqueue commit. The bounded
    // deferred probe must discover it without a window focus event.
    rerender({ ...options, courseVersion: 2 });
    await settle();
    model.status = "RUNNING";
    await tick();
    expect(result.current.refreshKey).not.toBe(initialKey);
    const activeKey = result.current.refreshKey;
    await tick();
    expect(result.current.refreshKey).not.toBe(activeKey);
    expect(refreshCourse).not.toHaveBeenCalled();

    model.classroomId = "full-classroom";
    model.status = "COMPLETED";
    await tick();
    expect(refreshCourse).toHaveBeenCalledTimes(1);
    const completedCalls = fetchMock.mock.calls.length;
    await tick();
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(completedCalls);
  });

  it("wakes on focus and survives a service restart while the job is active", async () => {
    const { model, fetchMock, options } = setup();
    const { result } = renderHook(() => useCourseGenerationPreviewSync(options));
    await settle(); await tick();
    model.status = "QUEUED";
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    const beforeRestart = result.current.refreshKey;
    model.unavailable = true;
    await tick(); await tick(); await tick();
    expect(result.current.refreshKey).toBe(beforeRestart);
    model.unavailable = false;
    model.status = "RUNNING";
    await tick();
    expect(result.current.refreshKey).not.toBe(beforeRestart);
    expect(fetchMock.mock.calls.every(([url]) => url.startsWith("/api/courses/course-a/"))).toBe(true);
  });

  it("retries the final course synchronization if state transport fails after job completion", async () => {
    const { options, refreshCourse } = setup();
    let finished = false;
    let stateUnavailable = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/generation")) return response({ job: { status: finished ? "COMPLETED" : "RUNNING" } });
      if (stateUnavailable) return new Response(null, { status: 503 });
      return response({ course: { aiLearningClassroomId: finished ? "full-classroom" : "accepted-test" } });
    }));
    const { result } = renderHook(() => useCourseGenerationPreviewSync(options));
    await settle();
    const activeKey = result.current.refreshKey;
    finished = true;
    stateUnavailable = true;
    await tick(); await tick(); await tick();
    expect(result.current.refreshKey).toBe(activeKey);
    stateUnavailable = false;
    await tick();
    expect(refreshCourse).toHaveBeenCalledTimes(1);
    expect(result.current.refreshKey).not.toBe(activeKey);
    await tick();
    expect(refreshCourse).toHaveBeenCalledTimes(1);
  });

  it("stops failed jobs and allows visibility to wake a later resume", async () => {
    const { model, fetchMock, options } = setup("RUNNING");
    renderHook(() => useCourseGenerationPreviewSync(options));
    await settle();
    model.status = "FAILED";
    await tick();
    const failedCalls = fetchMock.mock.calls.length;
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(failedCalls);
    model.status = "RUNNING";
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await tick();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(failedCalls + 2);
  });

  it("ignores a previous course's response after navigation and removes timers on unmount", async () => {
    const { options, refreshCourse } = setup();
    let release!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/courses/course-a/generation") return pending;
      return url.endsWith("/generation") ? response({ job: null }) : response({ course: { aiLearningClassroomId: "accepted-test" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender, unmount } = renderHook((props) => useCourseGenerationPreviewSync(props), { initialProps: options });
    rerender({ ...options, courseId: "course-b" });
    await settle();
    const newKey = result.current.refreshKey;
    await act(async () => { release(response({ job: { status: "RUNNING" } })); });
    expect(result.current.refreshKey).toBe(newKey);
    expect(refreshCourse).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/courses/course-a/state")).toBe(false);
    unmount();
    const calls = fetchMock.mock.calls.length;
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });
});
