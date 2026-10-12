import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  authorize: vi.fn(),
  getCourse: vi.fn(),
  audit: vi.fn(),
  getStatus: vi.fn(),
  start: vi.fn(),
}));

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/platform/template-access", () => ({ authorizeTemplateRequest: mocks.authorize }));
vi.mock("@/lib/session/server-store", () => ({ getCourse: mocks.getCourse }));
vi.mock("@/lib/course-generation/resource-audit-server", () => ({
  auditCourseGeneratedResources: mocks.audit,
}));
vi.mock("@/lib/course-generation/resource-repair-job", () => ({
  getCourseResourceRepairStatus: mocks.getStatus,
  startCourseResourceRepair: mocks.start,
}));

import { GET, POST } from "./route";

const context = { params: Promise.resolve({ courseId: "course-1" }) };

describe("course resource repair route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue("teacher-1");
    mocks.getCourse.mockResolvedValue({ id: "course-1", content: {} });
    mocks.audit.mockResolvedValue({ classroomId: "classroom-1", issues: [{ id: "tts:a1" }] });
    mocks.getStatus.mockReturnValue({ status: "idle" });
  });

  it("returns the current background repair status with the audit", async () => {
    mocks.getStatus.mockReturnValue({ status: "running", startedAt: "2026-09-21T00:00:00.000Z" });

    const response = await GET(new Request("http://localhost/api/courses/course-1/resource-repair") as never, context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      issues: [{ id: "tts:a1" }],
      repair: { status: "running" },
    });
  });

  it("responds immediately while a long TTS repair continues after the response", async () => {
    const completion = new Promise<void>(() => undefined);
    mocks.start.mockReturnValue({
      started: true,
      status: { status: "running", startedAt: "2026-09-21T00:00:00.000Z" },
      completion,
    });
    mocks.getStatus.mockImplementation((_courseId: string, mode?: string) => ({
      status: mode === "speech-sync" ? "idle" : "running",
    }));

    const response = await POST(new Request("http://localhost/api/courses/course-1/resource-repair", {
      method: "POST",
    }) as never, context);

    expect(response.status).toBe(202);
    expect(mocks.start).toHaveBeenCalledWith("course-1", "http://localhost", "missing-resources");
    expect(mocks.after).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toMatchObject({
      issues: [{ id: "tts:a1" }],
      repair: { status: "running" },
    });
  });

  it("starts speech synchronization independently from missing resource repair", async () => {
    const completion = new Promise<void>(() => undefined);
    mocks.start.mockReturnValue({
      started: true,
      status: { status: "running", mode: "speech-sync", completed: 0, total: 4 },
      completion,
    });
    mocks.getStatus.mockImplementation((_courseId: string, mode?: string) => ({
      status: mode === "speech-sync" ? "running" : "idle",
      mode,
    }));

    const response = await POST(new Request("http://localhost/api/courses/course-1/resource-repair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "speech-sync" }),
    }) as never, context);

    expect(response.status).toBe(202);
    expect(mocks.start).toHaveBeenCalledWith("course-1", "http://localhost", "speech-sync");
    await expect(response.json()).resolves.toMatchObject({
      syncRepair: { status: "running" },
    });
  });

  it("does not start a repair for a missing course", async () => {
    mocks.getCourse.mockResolvedValue(null);

    const response = await POST(new Request("http://localhost/api/courses/missing/resource-repair", {
      method: "POST",
    }) as never, { params: Promise.resolve({ courseId: "missing" }) });

    expect(response.status).toBe(404);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it.each(["missing-resources", "speech-sync"] as const)("keeps polling when %s completes during a GET audit", async (mode) => {
    const status = { status: "running", mode, completed: 62, total: 63 };
    mocks.getStatus.mockImplementation((_courseId: string, requestedMode = "missing-resources") => (
      requestedMode === mode ? status : { status: "idle", mode: requestedMode }
    ));
    mocks.audit.mockImplementationOnce(async () => {
      status.status = "completed";
      status.completed = 63;
      return { classroomId: "classroom-1", issues: [{ id: "speech-sync:old" }] };
    });

    const request = new Request("http://localhost/api/courses/course-1/resource-repair") as never;
    const duringCompletion = await GET(request, context);
    const result = await duringCompletion.json();
    expect(result.issues).toEqual([{ id: "speech-sync:old" }]);
    expect(result[mode === "speech-sync" ? "syncRepair" : "repair"])
      .toMatchObject({ status: "running", completed: 62 });
    expect(mocks.audit).toHaveBeenCalledOnce();

    mocks.audit.mockResolvedValueOnce({ classroomId: "classroom-1", issues: [] });
    const afterCompletion = await GET(request, context);
    const refreshed = await afterCompletion.json();
    expect(refreshed.issues).toEqual([]);
    expect(refreshed[mode === "speech-sync" ? "syncRepair" : "repair"])
      .toMatchObject({ status: "completed", completed: 63 });
  });

  it.each(["missing-resources", "speech-sync"] as const)("captures the current %s status before a POST audit", async (mode) => {
    const completion = new Promise<void>(() => undefined);
    const staleStatus = { status: "running", mode, completed: 0, total: 63 };
    const currentStatus = { status: "running", mode, completed: 62, total: 63 };
    mocks.start.mockReturnValue({ started: false, status: staleStatus, completion });
    mocks.getStatus.mockImplementation((_courseId: string, requestedMode = "missing-resources") => (
      requestedMode === mode ? currentStatus : { status: "idle", mode: requestedMode }
    ));
    mocks.audit.mockImplementationOnce(async () => {
      currentStatus.status = "completed";
      currentStatus.completed = 63;
      return { classroomId: "classroom-1", issues: [{ id: "speech-sync:old" }] };
    });

    const response = await POST(new Request("http://localhost/api/courses/course-1/resource-repair", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }),
    }) as never, context);
    expect(response.status).toBe(202);
    const result = await response.json();
    expect(result.repair).toMatchObject({ status: "running", mode, completed: 62 });
    if (mode === "speech-sync") expect(result.syncRepair).toMatchObject({ status: "running", completed: 62 });
    expect(result.issues).toEqual([{ id: "speech-sync:old" }]);
    expect(mocks.audit).toHaveBeenCalledOnce();
    expect(mocks.after).toHaveBeenCalledOnce();
    expect(mocks.after.mock.calls[0]?.[0]()).toBe(completion);
  });
});
