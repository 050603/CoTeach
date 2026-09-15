import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  prisma: { generationJob: { findFirst } },
}));

import {
  courseGenerationPreviewClassroomId,
  courseGenerationPreviewJobId,
  findCourseGenerationPreviewCourseId,
  loadCourseGenerationPreviewClassroom,
} from "./generation-preview";

function checkpoint(pageKey: string, title: string, order: number, audience: "student" | "teacher" = "student") {
  return {
    step: `page:${pageKey}`,
    state: {
      pageKey,
      outlineFingerprint: `fingerprint-${pageKey}`,
      scene: {
        id: `scene-${pageKey}`,
        stageId: "unreleased-stage",
        title,
        type: "slide",
        order,
        content: { type: "slide", canvas: { elements: [] } },
        actions: [],
        stageKey: audience === "student" ? "ai-learning" : "launch",
        audience,
        generationPurpose: audience === "student" ? "knowledge-teaching" : "teacher-resource",
      },
    },
  };
}

describe("course generation checkpoint preview", () => {
  beforeEach(() => findFirst.mockReset());

  it("uses a reversible safe classroom id", () => {
    const classroomId = courseGenerationPreviewClassroomId("job_123-abc");
    expect(courseGenerationPreviewJobId(classroomId)).toBe("job_123-abc");
    expect(courseGenerationPreviewJobId("ordinary-classroom")).toBeNull();
  });

  it("reconstructs completed student pages in outline order without exposing teacher pages", async () => {
    findFirst.mockResolvedValue({
      request: { courseTitle: "机器学习入门" },
      createdAt: new Date("2026-09-15T01:00:00.000Z"),
      updatedAt: new Date("2026-09-15T01:02:00.000Z"),
      checkpoints: [
        checkpoint("page-2", "第二页", 1),
        { step: "prepared-outlines", state: [{ id: "page-1" }, { id: "page-2" }, { id: "teacher-1" }] },
        checkpoint("teacher-1", "教师提示", 2, "teacher"),
        checkpoint("page-1", "第一页", 0),
      ],
    });

    const classroomId = courseGenerationPreviewClassroomId("job-1");
    const result = await loadCourseGenerationPreviewClassroom(classroomId);

    expect(result?.stage).toMatchObject({ id: classroomId, name: "机器学习入门" });
    expect(result?.scenes.map((scene) => ({ title: scene.title, stageId: scene.stageId, order: scene.order }))).toEqual([
      { title: "第一页", stageId: classroomId, order: 0 },
      { title: "第二页", stageId: classroomId, order: 1 },
    ]);
    expect(result?.revision).toBe(2);
  });

  it("resolves the owning template for authorization", async () => {
    findFirst.mockResolvedValue({ targetId: "course-1" });
    await expect(findCourseGenerationPreviewCourseId(courseGenerationPreviewClassroomId("job-1")))
      .resolves.toBe("course-1");
  });
});
