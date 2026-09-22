import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPblTemplateCourse } from "@/lib/platform/pbl-template";
import type { Course } from "@/lib/session/types";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  load: vi.fn(),
  updateCourse: vi.fn(),
  designJob: vi.fn(),
  contentJob: vi.fn(),
  publication: vi.fn(),
}));

vi.mock("@/lib/platform/template-access", () => ({ authorizeTemplateRequest: mocks.authorize }));
vi.mock("@/lib/platform/pbl-template-repository", () => ({
  loadPblTemplateCourse: mocks.load,
  getPblTemplatePublicationState: mocks.publication,
}));
vi.mock("@/lib/session/server-store", () => ({ updateCourse: mocks.updateCourse }));
vi.mock("@/lib/course-generation/job-storage", () => ({
  designGenerationJobs: { findUnique: mocks.designJob },
  contentGenerationJobs: { findUnique: mocks.contentJob, replace: vi.fn() },
}));
vi.mock("@/lib/course-generation/job-runner", () => ({
  estimatePersistedCourseGenerationSeconds: vi.fn(() => 10),
  runQueuedCourseGenerationToCompletion: vi.fn(),
}));
vi.mock("@/lib/course-generation/capability", () => ({ isBackgroundCourseGenerationEnabled: vi.fn(() => true) }));
vi.mock("@/lib/openmaic/server/classroom-storage", () => ({ readClassroom: vi.fn(), updatePersistedClassroomForEditing: vi.fn() }));
vi.mock("@/lib/course-generation/teacher-review-items", () => ({ collectGeneratedTeacherReviewItems: vi.fn(() => []), teacherReviewSummary: vi.fn(() => "") }));
vi.mock("@/lib/openmaic/server/classroom-asset-generation", () => ({ summarizeTeachingTimingAudit: vi.fn() }));

import { PATCH } from "./route";

function fixture(): Course {
  const course = createPblTemplateCourse("course-1", {
    name: "原课程",
    subject: "科学",
    grade: "七年级",
    hours: 1,
    learningObjectives: ["原目标"],
  });
  course.version = 10;
  course.status = "ready";
  course.aiLearningClassroomId = "classroom-1";
  course.content._openmaicClassroomId = "classroom-1";
  course.content.knowledgePoints = [{ id: "kp-1", name: "知识", description: "说明" }];
  return course;
}

describe("course design workspace route", () => {
  let course: Course;
  beforeEach(() => {
    vi.clearAllMocks();
    course = fixture();
    mocks.authorize.mockResolvedValue("teacher-1");
    mocks.load.mockImplementation(async () => course);
    mocks.designJob.mockResolvedValue(null);
    mocks.contentJob.mockResolvedValue(null);
    mocks.publication.mockResolvedValue({ latestVersion: 2, publishedVersion: 1, draftVersion: 2 });
    mocks.updateCourse.mockImplementation(async (_id: string, updater: (value: Course) => Course) => {
      course = { ...updater(course), version: (course.version ?? 0) + 1 };
      return { courses: [course] };
    });
  });

  it("saves teacher edits as a draft while preserving generated classroom data", async () => {
    const response = await PATCH(new Request("http://localhost/api/courses/course-1/design-workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "save",
        section: "materials",
        expectedVersion: 10,
        data: {
          name: "更新课程",
          subject: "科学",
          grade: "七年级",
          hours: 1,
          summary: "简介",
          drivingQuestion: "为什么？",
          expectedOutcome: "研究报告",
          learningObjectives: ["更新目标"],
        },
      }),
    }), { params: Promise.resolve({ courseId: "course-1" }) });
    expect(response.status).toBe(200);
    expect(course.name).toBe("更新课程");
    expect(course.status).toBe("preparing");
    expect(course.aiLearningClassroomId).toBe("classroom-1");
    expect(course.content.designWorkspaceRevision?.pendingUpdates.some((item) => item.target === "classroom")).toBe(true);
  });

  it("rejects a stale browser version before applying the edit", async () => {
    const response = await PATCH(new Request("http://localhost/api/courses/course-1/design-workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "confirm-current", target: "classroom", expectedVersion: 9 }),
    }), { params: Promise.resolve({ courseId: "course-1" }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "VERSION_CONFLICT" });
  });

  it("requires every write to carry the course version", async () => {
    const response = await PATCH(new Request("http://localhost/api/courses/course-1/design-workspace", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "confirm-current", target: "classroom" }),
    }), { params: Promise.resolve({ courseId: "course-1" }) });
    expect(response.status).toBe(400);
    expect(mocks.updateCourse).not.toHaveBeenCalled();
  });
});
