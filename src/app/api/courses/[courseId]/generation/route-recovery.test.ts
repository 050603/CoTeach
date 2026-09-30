import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  after: vi.fn(), background: vi.fn(), find: vi.fn(), repair: vi.fn(),
  runDesign: vi.fn(), requeueContent: vi.fn(), runContent: vi.fn(),
}));
vi.mock("next/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("next/server")>(), after: mocks.after,
}));
vi.mock("@/lib/platform/template-access", () => ({ authorizeTemplateRequest: async () => "teacher-1" }));
vi.mock("@/lib/platform/pbl-template-repository", () => ({ loadPblTemplateCourse: vi.fn() }));
vi.mock("@/lib/course-generation/job-storage", () => ({ contentGenerationJobs: { findUnique: mocks.find } }));
vi.mock("@/lib/course-generation/capability", () => ({ isBackgroundCourseGenerationEnabled: mocks.background }));
vi.mock("@/lib/course-design/job-runner", () => ({
  requeueCourseDesignForSourceRepair: mocks.repair, runQueuedCourseDesignSourceRepair: mocks.runDesign,
}));
vi.mock("@/lib/course-generation/job-runner", () => ({
  requeueCourseGenerationFromCheckpoints: mocks.requeueContent,
  runQueuedCourseGenerationToCompletion: mocks.runContent,
}));
vi.mock("@openmaic/lib/server/classroom-media-readiness", () => ({
  assertRequestedClassroomMediaProviders: vi.fn(), classroomMediaConfigurationErrorResponse: vi.fn(),
}));
import { PATCH } from "./route";

const failed = { id: "content-1", status: "failed", scenesGenerated: 0,
  request: { courseId: "course-1", sceneOutlines: [] }, updatedAt: new Date(), error: null };
function resume() {
  return PATCH(new NextRequest("http://localhost/api/courses/course-1/generation", {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "resume-from-checkpoints" }),
  }), { params: Promise.resolve({ courseId: "course-1" }) });
}

describe("first-pass recovery API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.background.mockReturnValue(false);
    mocks.find.mockResolvedValue(failed);
    mocks.requeueContent.mockResolvedValue({ ...failed, status: "queued" });
  });

  it.each([true, false])("continues saved work without authorizing source repair when background=%s", async (background) => {
    mocks.background.mockReturnValue(background);
    mocks.repair.mockResolvedValue({ id: "design-1", status: "queued" });
    const response = await resume();
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ backgroundEnabled: background, job: { status: "queued" } });
    expect(mocks.requeueContent).toHaveBeenCalledWith("course-1", { regenerateFailedStages: false });
    expect(mocks.repair).not.toHaveBeenCalled();
    expect(mocks.runDesign).not.toHaveBeenCalled();
    if (background) expect(mocks.after).not.toHaveBeenCalled();
    else { await mocks.after.mock.calls[0][0](); expect(mocks.runContent).toHaveBeenCalledWith("course-1"); }
  });

  it("opens a new failed-stage authoring request only through the explicit action", async () => {
    const response = await PATCH(new NextRequest("http://localhost/api/courses/course-1/generation", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "regenerate-failed-stages" }),
    }), { params: Promise.resolve({ courseId: "course-1" }) });
    expect(response.status).toBe(202);
    expect(mocks.requeueContent).toHaveBeenCalledWith("course-1", { regenerateFailedStages: true });
    expect(mocks.repair).not.toHaveBeenCalled();
  });

  it("does not start missing work", async () => {
    mocks.requeueContent.mockResolvedValue(null);
    const response = await resume();
    expect(response.status).toBe(404);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it('does not replay an authoring request after a concurrent task replacement', async () => {
    mocks.requeueContent.mockRejectedValue(new Error('GENERATION_JOB_NOT_FOUND'));
    const response = await resume();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'GENERATION_JOB_CONFLICT' });
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it('returns the specific source problem before creating a replacement request', async () => {
    mocks.requeueContent.mockRejectedValue(Object.assign(new Error('无法定位缺少来源的已生成页面，请先修改对应大纲。'), {
      code: 'COURSE_SOURCE_EDIT_REQUIRED',
    }));
    const response = await PATCH(new NextRequest('http://localhost/api/courses/course-1/generation', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'regenerate-failed-stages' }),
    }), { params: Promise.resolve({ courseId: 'course-1' }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'COURSE_SOURCE_EDIT_REQUIRED', detail: '无法定位缺少来源的已生成页面，请先修改对应大纲。',
    });
    expect(mocks.after).not.toHaveBeenCalled();
  });
});
