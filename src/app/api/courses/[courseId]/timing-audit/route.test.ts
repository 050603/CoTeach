// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  getCourse: vi.fn(),
  updateCourse: vi.fn(),
  readClassroom: vi.fn(),
  remeasure: vi.fn(),
  findJob: vi.fn(),
}));

vi.mock("@/lib/platform/template-access", () => ({ authorizeTemplateRequest: mocks.authorize }));
vi.mock("@/lib/session/server-store", () => ({ getCourse: mocks.getCourse, updateCourse: mocks.updateCourse }));
vi.mock("@/lib/openmaic/server/classroom-storage", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/openmaic/server/classroom-storage")>(),
  readClassroom: mocks.readClassroom,
}));
vi.mock("@/lib/openmaic/server/classroom-timing-audit", () => ({ remeasureClassroomSpeech: mocks.remeasure }));
vi.mock("@/lib/course-generation/job-storage", () => ({ contentGenerationJobs: { findUnique: mocks.findJob } }));

import { POST } from "./route";

const context = { params: Promise.resolve({ courseId: "course-1" }) };
const course = {
  id: "course-1", version: 7, aiLearningClassroomId: "classroom-1",
  content: {
    _openmaicSceneOutlines: [
      { id: "teach", type: "slide", targetDurationSec: 120, plannedTiming: { narrationSec: 100, role: "teaching" } },
      { id: "quiz", type: "quiz", targetDurationSec: 60, plannedTiming: { narrationSec: 20, role: "assessment" } },
    ],
    teachingRevisionState: { classroomRevision: 4, invalidated: ["audio", "timing-audit"] },
  },
};
const classroom = {
  id: "classroom-1", revision: 4,
  scenes: [
    { id: "scene-teach", outlineId: "teach", type: "slide", actions: [{ id: "speech-1", type: "speech", text: "讲授", audioDurationSec: 112 }] },
    { id: "scene-quiz", outlineId: "quiz", type: "quiz", actions: [{ id: "speech-2", type: "speech", text: "小测", audioDurationSec: 18 }] },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue("teacher-1");
  mocks.getCourse.mockResolvedValue(course);
  mocks.readClassroom.mockResolvedValue(classroom);
  mocks.remeasure.mockImplementation(async (_id, scenes) => scenes);
  mocks.findJob.mockResolvedValue({ request: { enableTTS: true } });
  mocks.updateCourse.mockImplementation(async (_id, updater) => updater(course));
});

describe("POST classroom timing audit", () => {
  it("stores the latest full-course audio totals and clears the timing invalidation", async () => {
    const response = await POST(new Request("https://app.test/api/courses/course-1/timing-audit", { method: "POST" }), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      audit: { substantiveTeachingDurationSec: 112, assessmentAudioDurationSec: 18,
        measuredSegmentCount: 2, narrationSegmentCount: 2, complete: true, teachingRatioValid: false },
    });
    const saved = mocks.updateCourse.mock.results[0].value;
    await expect(saved).resolves.toMatchObject({
      content: { teachingTimingAudit: { complete: true },
        teachingRevisionState: { invalidated: ["audio"] } },
    });
  });

  it("keeps publication blocked when an edited speech clip is missing", async () => {
    mocks.remeasure.mockResolvedValue([
      classroom.scenes[0],
      { ...classroom.scenes[1], actions: [{ ...classroom.scenes[1].actions[0], audioDurationSec: undefined }] },
    ]);
    const response = await POST(new Request("https://app.test/api/courses/course-1/timing-audit", { method: "POST" }), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      audit: { measuredSegmentCount: 1, narrationSegmentCount: 2, complete: false },
    });
    const saved = await mocks.updateCourse.mock.results[0].value;
    expect(saved.content.teachingRevisionState.invalidated).toContain("timing-audit");
  });

  it("checks manually added audio even when the original generation disabled TTS", async () => {
    mocks.findJob.mockResolvedValue({ request: { enableTTS: false } });
    mocks.readClassroom.mockResolvedValue({
      ...classroom,
      scenes: [{ ...classroom.scenes[0], actions: [{ ...classroom.scenes[0].actions[0], audioUrl: "/api/openmaic/classroom-media/classroom-1/audio/edited.wav" }] }],
    });
    const response = await POST(new Request("https://app.test/api/courses/course-1/timing-audit", { method: "POST" }), context);
    expect(response.status).toBe(200);
    expect(mocks.remeasure).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toMatchObject({ audit: { narrationDurationSource: "actual-audio" } });
  });

  it("accepts a forked draft whose saved edit revision came from the published classroom", async () => {
    const forked = {
      ...course,
      content: {
        ...course.content,
        teachingRevisionState: { updatedAt: "2026-09-25T09:41:41.484Z", classroomRevision: 9, invalidated: ["timing-audit"] },
      },
    };
    mocks.getCourse.mockResolvedValue(forked);
    mocks.readClassroom.mockResolvedValue({ ...classroom, revision: 1 });
    mocks.updateCourse.mockImplementation(async (_id, updater) => updater({ ...forked, version: 8 }));

    const response = await POST(new Request("https://app.test/api/courses/course-1/timing-audit", { method: "POST" }), context);
    expect(response.status).toBe(200);
    const saved = await mocks.updateCourse.mock.results[0].value;
    expect(saved.content.teachingRevisionState).toMatchObject({ classroomRevision: 1, invalidated: [] });
    expect(saved.content.teachingTimingAudit.complete).toBe(true);
  });

  it("rejects a classroom revision that changes during measurement", async () => {
    mocks.readClassroom.mockResolvedValueOnce(classroom).mockResolvedValueOnce({ ...classroom, revision: 5 });
    const response = await POST(new Request("https://app.test/api/courses/course-1/timing-audit", { method: "POST" }), context);
    expect(response.status).toBe(409);
    expect(mocks.updateCourse).not.toHaveBeenCalled();
  });
});
