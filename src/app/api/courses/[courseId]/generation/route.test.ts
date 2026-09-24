import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  loadCourse: vi.fn(),
  findJob: vi.fn(),
  replaceJob: vi.fn(),
}));

vi.mock("@/lib/platform/template-access", () => ({ authorizeTemplateRequest: mocks.authorize }));
vi.mock("@/lib/platform/pbl-template-repository", () => ({ loadPblTemplateCourse: mocks.loadCourse }));
vi.mock("@/lib/course-generation/job-storage", () => ({
  contentGenerationJobs: { findUnique: mocks.findJob, replace: mocks.replaceJob },
}));
vi.mock("@/lib/course-generation/capability", () => ({ isBackgroundCourseGenerationEnabled: () => true }));
vi.mock("@/lib/course-generation/job-runner", () => ({
  estimatePersistedCourseGenerationSeconds: () => 120,
  runQueuedCourseGenerationToCompletion: vi.fn(),
}));
vi.mock("@openmaic/lib/server/classroom-media-readiness", () => ({
  assertRequestedClassroomMediaProviders: vi.fn(),
  classroomMediaConfigurationErrorResponse: () => null,
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue("teacher-1");
  mocks.loadCourse.mockResolvedValue({ id: "course-1" });
});

it.each(["cancelled", "failed"])("clears old progress and checkpoints when %s work is explicitly resubmitted", async (status) => {
  const old = {
    id: "job-1", courseId: "course-1", status, version: 3,
    stageProgress: [{ stage: "content", completedPages: [1, 2] }],
    activePages: [{ index: 1, stage: "restoring" }],
    preparedOutlines: [{ id: "old-page" }],
    trace: [{ step: "old-content" }],
    updatedAt: new Date("2026-09-23T00:00:00Z"),
    request: { courseId: "course-1", requirement: "old" },
  };
  mocks.findJob.mockResolvedValue(old);
  mocks.replaceJob.mockResolvedValue({ ...old, status: "queued", updatedAt: new Date() });
  const response = await POST(new NextRequest("http://localhost/api/courses/course-1/generation", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ courseId: "course-1", requirement: "new", generationScope: "full-course", sceneOutlines: [{ id: "new-page" }] }),
  }), { params: Promise.resolve({ courseId: "course-1" }) });

  expect(response.status).toBe(202);
  expect(mocks.replaceJob).toHaveBeenCalledOnce();
  expect(mocks.replaceJob.mock.calls[0]?.[0]).toMatchObject({
    where: { id: "job-1", version: 3, status },
    checkpointPolicy: "all",
    data: {
      status: "queued", scenesGenerated: 0, progress: 0,
      activePages: [], stageProgress: [], currentStage: null,
      preparedOutlines: [], trace: [], stepIndex: 0,
      events: [], request: { requirement: "new", sceneOutlines: [{ id: "new-page" }] },
    },
  });
});
