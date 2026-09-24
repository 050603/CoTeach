import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.hoisted(() => vi.fn());
const readClassroom = vi.hoisted(() => vi.fn());
vi.mock("@openmaic/lib/server/classroom-storage", () => ({
  readClassroom,
  isValidClassroomId: (id: string) => /^[a-zA-Z0-9_-]+$/.test(id),
}));

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
  beforeEach(() => { findFirst.mockReset(); readClassroom.mockReset(); });

  it("uses a reversible safe classroom id", () => {
    const classroomId = courseGenerationPreviewClassroomId("job_123-abc");
    expect(courseGenerationPreviewJobId(classroomId)).toBe("job_123-abc");
    expect(courseGenerationPreviewJobId("ordinary-classroom")).toBeNull();
  });

  it("reconstructs completed student pages in outline order without exposing teacher pages", async () => {
    findFirst.mockResolvedValue({
      request: { courseTitle: "机器学习入门" },
      status: "RUNNING",
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

  it("keeps compiler-created continuation pages between their parent and the next planned page", async () => {
    findFirst.mockResolvedValue({ request: {}, status: "RUNNING", createdAt: new Date(), updatedAt: new Date(), checkpoints: [
      { step: "prepared-outlines", state: [{ id: "page-1" }, { id: "page-2" }] },
      checkpoint("page-2", "下一主题", 2),
      checkpoint("page-1--2", "主题续页", 1),
      checkpoint("page-1", "主题首页", 0),
    ] });
    const result = await loadCourseGenerationPreviewClassroom(courseGenerationPreviewClassroomId("job-1"));
    expect(result?.scenes.map((scene) => scene.title)).toEqual(["主题首页", "主题续页", "下一主题"]);
  });

  it("uses only this task's persisted split and exposes media changes on unchanged page IDs", async () => {
    const draft = checkpoint("page-1", "第一页", 0);
    findFirst.mockResolvedValue({
      request: {}, status: "RUNNING", result: null,
      createdAt: new Date("2026-09-15T01:00:00Z"), updatedAt: new Date("2026-09-15T01:00:00Z"),
      checkpoints: [draft, { step: "course-finalization", state: { split: { studentClassroomId: "this-job-classroom" } } }],
    });
    const persisted = {
      id: "this-job-classroom", stage: {}, revision: 2,
      scenes: [{ ...draft.state.scene, actions: [{ id: "speech", type: "speech", text: "讲解" }] }],
    };
    readClassroom.mockResolvedValue(persisted);
    const id = courseGenerationPreviewClassroomId("job-1");
    const before = await loadCourseGenerationPreviewClassroom(id);
    expect(readClassroom).toHaveBeenCalledWith("this-job-classroom");
    expect(before?.generationPreview.scenes["scene-page-1"].status).toBe("preparing");
    readClassroom.mockResolvedValue({ ...persisted, revision: 3, scenes: [{ ...persisted.scenes[0], actions: [
      { id: "speech", type: "speech", text: "讲解", audioUrl: "/audio/speech.mp3" },
      { id: "focus", type: "spotlight", elementId: "element-1" },
    ] }] });
    const after = await loadCourseGenerationPreviewClassroom(id);
    expect(after?.generationPreview.contentVersion).not.toBe(before?.generationPreview.contentVersion);
    expect(after?.generationPreview.scenes["scene-page-1"].status).toBe("ready");
    expect(after?.scenes[0].actions).toHaveLength(2);
    expect(after?.id).toBe(id);
    expect(after?.scenes[0].stageId).toBe(id);
  });

  it("shows promoted continuation checkpoints after the old test classroom and retains accepted audio", async () => {
    const accepted = checkpoint("first", "测试小节", 0);
    const continued = checkpoint("second", "继续生成", 1);
    const acceptedAction = { id: "first-speech", type: "speech", text: "前半部分讲解" };
    const acceptedPage = { ...accepted, state: { ...accepted.state,
      scene: { ...accepted.state.scene, actions: [acceptedAction] } } };
    const continuedPage = { ...continued, state: { ...continued.state,
      scene: { ...continued.state.scene,
        actions: [{ id: "second-speech", type: "speech", text: "后半部分讲解" }] } } };
    const oldClassroom = {
      id: "accepted-test", revision: 3, stage: {},
      assetGeneration: { status: "completed", failures: [] },
      scenes: [{ ...accepted.state.scene, actions: [{ ...acceptedAction, audioUrl: "/audio/accepted.wav" }] }],
    };
    readClassroom.mockResolvedValue(oldClassroom);
    const job = {
      request: { generationScope: "full-course", courseTitle: "示例课" }, result: null, status: "RUNNING",
      createdAt: new Date(), updatedAt: new Date(),
      checkpoints: [acceptedPage, { step: "course-finalization", state: { split: { studentClassroomId: oldClassroom.id } } }],
    };
    findFirst.mockResolvedValue(job);
    const id = courseGenerationPreviewClassroomId("job-1");
    const before = await loadCourseGenerationPreviewClassroom(id);
    expect(before?.scenes).toHaveLength(1);

    findFirst.mockResolvedValue({ ...job, checkpoints: [...job.checkpoints, continuedPage] });
    const after = await loadCourseGenerationPreviewClassroom(id);
    expect(after?.scenes.map((scene) => scene.id)).toEqual(["scene-first", "scene-second"]);
    expect(after?.scenes[0].actions).toMatchObject([{ audioUrl: "/audio/accepted.wav" }]);
    expect(after?.generationPreview.scenes["scene-first"].status).toBe("ready");
    expect(after?.generationPreview.scenes["scene-second"].status).toBe("preparing");
    expect(after?.generationPreview.contentVersion).not.toBe(before?.generationPreview.contentVersion);
  });

  it("loads legacy completed job result and reports missing audio as failed", async () => {
    findFirst.mockResolvedValue({
      request: {}, status: "COMPLETED", result: { id: "legacy-job-result" },
      createdAt: new Date(), updatedAt: new Date(), checkpoints: [],
    });
    readClassroom.mockResolvedValue({ scenes: [{ ...checkpoint("p", "页面", 0).state.scene,
      actions: [{ type: "speech", id: "speech", text: "讲解" }],
    }] });
    const result = await loadCourseGenerationPreviewClassroom(courseGenerationPreviewClassroomId("job-1"));
    expect(readClassroom).toHaveBeenCalledWith("legacy-job-result");
    expect(result?.generationPreview).toMatchObject({ active: false, scenes: { "scene-p": { status: "failed" } } });
  });

  it("falls back to this job's checkpoints if its persisted snapshot is not yet visible", async () => {
    readClassroom.mockResolvedValue(null);
    findFirst.mockResolvedValue({
      request: {}, status: "RUNNING", result: { id: "not-yet-visible" },
      createdAt: new Date(), updatedAt: new Date(), checkpoints: [checkpoint("p", "本任务页面", 0)],
    });
    const result = await loadCourseGenerationPreviewClassroom(courseGenerationPreviewClassroomId("job-1"));
    expect(result?.scenes[0].title).toBe("本任务页面");
    expect(result?.generationPreview.active).toBe(true);
    expect(readClassroom).toHaveBeenCalledTimes(1);
  });

  it.each([['QUEUED', true, 'preparing'], ['RUNNING', true, 'preparing'], ['FAILED', false, 'failed'], ['COMPLETED', false, 'failed']] as const)("uses actual database status %s for media readiness", async (status, active, mediaStatus) => {
    const page = checkpoint("p", "页面", 0);
    findFirst.mockResolvedValue({ request: {}, status, result: { id: "own-classroom" }, createdAt: new Date(), updatedAt: new Date(), checkpoints: [] });
    readClassroom.mockResolvedValue({ scenes: [{ ...page.state.scene, actions: [{ id: "speech", type: "speech", text: "待生成音频" }] }] });
    const result = await loadCourseGenerationPreviewClassroom(courseGenerationPreviewClassroomId("job-1"));
    expect(result?.generationPreview).toMatchObject({ active, jobStatus: status.toLowerCase(), scenes: { "scene-p": { status: mediaStatus } } });
  });

  it("resolves the owning template for authorization", async () => {
    findFirst.mockResolvedValue({ targetId: "course-1" });
    await expect(findCourseGenerationPreviewCourseId(courseGenerationPreviewClassroomId("job-1")))
      .resolves.toBe("course-1");
  });
});
