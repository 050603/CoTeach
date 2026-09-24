import { mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import type { PersistedClassroomData } from "@/lib/openmaic/server/classroom-storage";

const getCourse = vi.fn();
const readClassroom = vi.fn();
const resolveDurableCourseSceneOutlines = vi.fn();
const remoteFetch = vi.fn();
const createSsrfSafeDispatcher = vi.fn();
const closeRemoteConnection = vi.fn();
const fileAssetFindFirst = vi.fn();
const textbookFigureFindMany = vi.fn();

vi.mock("@/lib/session/server-store", () => ({ getCourse }));
vi.mock("@/lib/db/client", () => ({ prisma: {
  fileAsset: { findFirst: fileAssetFindFirst },
  textbookFigure: { findMany: textbookFigureFindMany },
} }));
const CLASSROOMS_DIR = "/tmp/openpbl-resource-audit-tests";
vi.mock("@/lib/openmaic/server/classroom-storage", () => ({
  CLASSROOMS_DIR,
  readClassroom,
  isValidClassroomId: (id: string) => /^[a-zA-Z0-9_-]+$/.test(id),
}));
vi.mock("@/lib/course-generation/course-resource-outlines", () => ({
  resolveDurableCourseSceneOutlines,
}));
vi.mock("undici", async (importOriginal) => ({
  ...await importOriginal<typeof import("undici")>(),
  fetch: remoteFetch,
}));
vi.mock("@/lib/openmaic/server/ssrf-guard", () => ({ createSsrfSafeDispatcher }));

describe("final course resource audit", () => {
  beforeEach(() => {
    getCourse.mockReset();
    readClassroom.mockReset();
    resolveDurableCourseSceneOutlines.mockReset();
    resolveDurableCourseSceneOutlines.mockImplementation(async (_courseId, outlines) => outlines);
    remoteFetch.mockReset();
    createSsrfSafeDispatcher.mockReset();
    closeRemoteConnection.mockReset();
    fileAssetFindFirst.mockReset();
    textbookFigureFindMany.mockReset();
    createSsrfSafeDispatcher.mockResolvedValue({ dispatcher: {}, close: closeRemoteConnection });
  });

  afterEach(async () => {
    await rm(CLASSROOMS_DIR, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("reports adaptive, planned-action, TTS, and media gaps before completion", async () => {
    getCourse.mockResolvedValue({
      id: "course-1",
      aiLearningClassroomId: "classroom-1",
      content: {
        _openmaicSceneOutlines: [{
          id: "quiz-1",
          title: "主课达标测",
          type: "slide",
          teachingToolPlan: [{
            id: "plan-1",
            tool: "whiteboard",
            trigger: "作答前",
            purpose: "回顾标准",
            content: ["判断标准"],
            required: true,
          }],
        }],
        adaptiveLearningPlan: {
          enabled: true,
          branches: [{
            id: "branch-1",
            title: "机器学习基本概念回顾",
            enabled: true,
            status: "teacher-confirmed",
            preparedResource: { status: "failed", error: "语音未生成" },
          }],
        },
      },
    } as unknown as Course);
    readClassroom.mockResolvedValue({
      id: "classroom-1",
      createdAt: "2026-08-17T00:00:00.000Z",
      stage: {},
      scenes: [{
        id: "scene-1",
        outlineId: "quiz-1",
        title: "主课达标测",
        type: "slide",
        order: 0,
        ttsPolicy: "target-duration",
        content: { type: "slide", canvas: { elements: [{ id: "cover-1", type: "image", src: "gen_img_1" }] } },
        actions: [{ id: "speech-1", type: "speech", text: "开始测验" }],
      }],
      assetGeneration: {
        status: "partial-failure",
        requested: 1,
        completed: 0,
        failures: [{ elementId: "old-cover", type: "image", error: "provider unavailable" }],
        updatedAt: "2026-08-17T00:00:00.000Z",
      },
    } as unknown as PersistedClassroomData);

    const { auditCourseGeneratedResources } = await import("./resource-audit-server");
    const audit = await auditCourseGeneratedResources("course-1");

    expect(audit.issues.map((issue) => issue.type)).toEqual([
      "adaptive-resource",
      "teaching-tool",
      "tts",
      "media",
    ]);
    expect(audit.issues.map((issue) => issue.title)).toContain("主课达标测");
    const mediaIssue = audit.issues.find((issue) => issue.type === "media");
    expect(mediaIssue).toMatchObject({ title: "课程图片", detail: "图片生成未完成，请重新生成" });
    expect(`${mediaIssue?.title}${mediaIssue?.detail}`).not.toContain("cover-1");
    expect(`${mediaIssue?.title}${mediaIssue?.detail}`).not.toContain("provider unavailable");
  });

  it("reports narration that has audio but no precise alignment", async () => {
    getCourse.mockResolvedValue({
      id: "course-1",
      aiLearningClassroomId: "classroom-1",
      content: { _openmaicSceneOutlines: [] },
    } as unknown as Course);
    readClassroom.mockResolvedValue({
      id: "classroom-1",
      createdAt: "2026-08-17T00:00:00.000Z",
      stage: {},
      scenes: [{
        id: "scene-1",
        title: "概念讲解",
        type: "slide",
        order: 0,
        actions: [{
          id: "speech-1",
          type: "speech",
          text: "请观察这个概念。",
          audioUrl: "/api/openmaic/classroom-media/classroom-1/audio/speech.mp3",
        }],
      }],
    } as unknown as PersistedClassroomData);

    const { auditCourseGeneratedResources } = await import("./resource-audit-server");
    const audit = await auditCourseGeneratedResources("course-1");

    expect(audit.issues).toContainEqual(expect.objectContaining({
      type: "speech-sync",
      title: "概念讲解",
      detail: expect.stringContaining("尚未建立字幕与动作的音频时间线"),
    }));
  });

  it("reports a precise timeline whose visual binding could not be repaired", async () => {
    getCourse.mockResolvedValue({
      id: "course-1",
      aiLearningClassroomId: "classroom-1",
      content: { _openmaicSceneOutlines: [] },
    } as unknown as Course);
    readClassroom.mockResolvedValue({
      id: "classroom-1",
      createdAt: "2026-08-17T00:00:00.000Z",
      stage: {},
      scenes: [{
        id: "scene-1",
        title: "概念讲解",
        type: "slide",
        order: 0,
        actions: [{
          id: "speech-1",
          type: "speech",
          text: "请观察这个概念。",
          audioUrl: "/api/openmaic/classroom-media/classroom-1/audio/speech.mp3",
          speechAlignment: {
            version: "test-v1",
            status: "aligned",
            textHash: "text",
            audioHash: "audio",
            spans: [{ text: "请", startChar: 0, endChar: 1, startMs: 0, endMs: 100 }],
            error: "讲稿中找不到与页面目标可靠对应的词句，自动指示已停用",
          },
        }],
      }],
    } as unknown as PersistedClassroomData);

    const { auditCourseGeneratedResources } = await import("./resource-audit-server");
    const audit = await auditCourseGeneratedResources("course-1");

    expect(audit.issues).toContainEqual(expect.objectContaining({
      type: "speech-sync",
      detail: "讲稿中找不到与页面目标可靠对应的词句，自动指示已停用",
    }));
  });

  it("audits the supplied immutable snapshot and validates managed audio bytes", async () => {
    const course = {
      id: "snapshot-course",
      aiLearningClassroomId: "snapshot-classroom",
      content: { _openmaicSceneOutlines: [] },
    } as unknown as Course;
    const classroom = {
      id: "snapshot-classroom",
      createdAt: "2026-09-22T00:00:00.000Z",
      stage: {},
      scenes: [{
        id: "scene",
        title: "有效讲解",
        type: "slide",
        order: 0,
        actions: [{
          id: "speech",
          type: "speech",
          text: "有效语音",
          audioUrl: "/api/openmaic/classroom-media/snapshot-classroom/audio/page-1:speech-1.wav",
          speechAlignment: { version: "test", status: "aligned", textHash: "text", audioHash: "audio", spans: [] },
        }],
      }],
    } as unknown as PersistedClassroomData;
    const audioDir = path.join(CLASSROOMS_DIR, "snapshot-classroom", "audio");
    await mkdir(audioDir, { recursive: true });
    await writeFile(path.join(audioDir, "page-1:speech-1.wav"), wavBytes());

    const { auditCourseGeneratedResources } = await import("./resource-audit-server");
    const audit = await auditCourseGeneratedResources(course.id, { course, classroom });

    expect(audit.issues.filter((issue) => issue.type === "tts")).toEqual([]);
    expect(getCourse).not.toHaveBeenCalled();
    expect(resolveDurableCourseSceneOutlines).not.toHaveBeenCalled();
  });

  it("reports missing and damaged managed files instead of trusting their URLs", async () => {
    const course = {
      id: "course-files",
      aiLearningClassroomId: "classroom-files",
      content: { _openmaicSceneOutlines: [] },
    } as unknown as Course;
    const classroom = {
      id: "classroom-files",
      createdAt: "2026-09-22T00:00:00.000Z",
      stage: {},
      scenes: [{
        id: "scene",
        title: "文件校验",
        type: "slide",
        order: 0,
        content: {
          type: "slide",
          canvas: { elements: [
            { id: "image", type: "image", src: "/api/openmaic/classroom-media/classroom-files/media/missing.png" },
            { id: "damaged", type: "image", src: "/api/openmaic/classroom-media/classroom-files/media/damaged.png" },
          ] },
        },
        actions: [{
          id: "speech",
          type: "speech",
          text: "损坏语音",
          audioUrl: "/api/openmaic/classroom-media/classroom-files/audio/broken.wav",
          speechAlignment: { version: "test", status: "aligned", textHash: "text", audioHash: "audio", spans: [] },
        }],
      }],
    } as unknown as PersistedClassroomData;
    const audioDir = path.join(CLASSROOMS_DIR, "classroom-files", "audio");
    await mkdir(audioDir, { recursive: true });
    await writeFile(path.join(audioDir, "broken.wav"), "not-a-wave-file");
    const mediaDir = path.join(CLASSROOMS_DIR, "classroom-files", "media");
    await mkdir(mediaDir, { recursive: true });
    await writeFile(path.join(mediaDir, "damaged.png"), "not-an-image");

    const { auditCourseGeneratedResources } = await import("./resource-audit-server");
    const audit = await auditCourseGeneratedResources(course.id, { course, classroom });

    expect(audit.issues).toContainEqual(expect.objectContaining({
      id: "tts:scene:speech",
      detail: "语音文件损坏或时长无效",
    }));
    expect(audit.issues).toContainEqual(expect.objectContaining({
      id: "media:image:image",
      detail: "媒体文件不存在或无法读取",
    }));
    expect(audit.issues).toContainEqual(expect.objectContaining({
      id: "media:image:damaged",
      detail: "图片文件损坏或尺寸无效",
    }));
  });

  it("ignores old media failures once the current page has a valid replacement or no media", async () => {
    const course = {
      id: "course-replaced", aiLearningClassroomId: "classroom-replaced",
      content: { _openmaicSceneOutlines: [] },
    } as unknown as Course;
    const classroom = {
      id: "classroom-replaced", createdAt: "2026-09-24", stage: {},
      scenes: [{
        id: "slide", type: "slide", order: 0, title: "替换后页面",
        content: { type: "slide", canvas: { elements: [{
          id: "replacement", type: "image",
          src: "/api/openmaic/classroom-media/classroom-replaced/media/replacement.png",
        }] } },
        actions: [],
      }],
      assetGeneration: {
        status: "partial-failure", requested: 2, completed: 1,
        failures: [{ elementId: "old-image", type: "image", error: "旧提供商失败" }],
        updatedAt: "2026-09-24",
      },
    } as unknown as PersistedClassroomData;
    const mediaDir = path.join(CLASSROOMS_DIR, "classroom-replaced", "media");
    await mkdir(mediaDir, { recursive: true });
    await writeFile(path.join(mediaDir, "replacement.png"), await sharp({
      create: { width: 4, height: 4, channels: 3, background: "#fff" },
    }).png().toBuffer());

    const { auditCourseGeneratedResources } = await import("./resource-audit-server");
    expect((await auditCourseGeneratedResources(course.id, { course, classroom })).issues.filter((issue) => issue.type === "media"))
      .toEqual([]);
    const removed = structuredClone(classroom);
    if (removed.scenes[0]?.content.type === "slide") removed.scenes[0].content.canvas.elements = [];
    expect((await auditCourseGeneratedResources(course.id, { course, classroom: removed })).issues.filter((issue) => issue.type === "media"))
      .toEqual([]);
  });

  it("checks the current adaptive classroom instead of its old generation failures", async () => {
    const course = {
      id: "course-adaptive-current", aiLearningClassroomId: "main-current",
      content: { _openmaicSceneOutlines: [], adaptiveLearningPlan: { enabled: true, branches: [{
        id: "branch", title: "补充学习", enabled: true, status: "teacher-confirmed",
        preparedResource: { status: "ready", classroomId: "adaptive-current" },
      }] } },
    } as unknown as Course;
    const slide = (id: string, src?: string) => ({
      id, type: "slide", order: 0, title: "补充页",
      content: { type: "slide", canvas: { elements: src ? [{ id: "picture", type: "image", src }] : [] } },
      actions: [],
    });
    const classroom = {
      id: "main-current", createdAt: "2026-09-24", stage: {}, scenes: [slide("main")],
    } as unknown as PersistedClassroomData;
    const adaptiveClassroom = {
      id: "adaptive-current", createdAt: "2026-09-24", stage: {}, scenes: [slide("adaptive")],
      assetGeneration: { status: "partial-failure", requested: 1, completed: 0,
        failures: [{ elementId: "old-image", type: "image", error: "旧失败" }], updatedAt: "2026-09-24" },
    } as unknown as PersistedClassroomData;
    readClassroom.mockResolvedValue(adaptiveClassroom);
    const { auditCourseGeneratedResources } = await import("./resource-audit-server");
    expect((await auditCourseGeneratedResources(course.id, { course, classroom })).issues.filter((issue) => issue.type === "adaptive-resource"))
      .toEqual([]);

    const pending = structuredClone(adaptiveClassroom);
    pending.scenes = [slide("adaptive", "gen_img_pending")] as unknown as PersistedClassroomData["scenes"];
    readClassroom.mockResolvedValue(pending);
    expect((await auditCourseGeneratedResources(course.id, { course, classroom })).issues)
      .toContainEqual(expect.objectContaining({ id: "adaptive:branch" }));
  });

  it("does not count ungenerated adaptive branches outside a single-section test", async () => {
    const course = {
      id: "course-test-lesson", aiLearningClassroomId: "test-classroom",
      content: {
        _openmaicSceneOutlines: [],
        classroomGenerationRun: { scope: "test-lesson", status: "completed", generatedOutlineIds: ["page"] },
        adaptiveLearningPlan: { enabled: true, branches: [{
          id: "outside-branch", title: "完整课程的自适应支线", enabled: true,
          status: "teacher-confirmed", preparedResource: { status: "failed" },
        }] },
      },
    } as unknown as Course;
    const classroom = {
      id: "test-classroom", createdAt: "2026-09-24", stage: {},
      scenes: [{ id: "scene", type: "slide", order: 0, title: "当前测试页",
        content: { type: "slide", canvas: { elements: [] } }, actions: [] }],
    } as unknown as PersistedClassroomData;

    const { auditCourseGeneratedResources } = await import("./resource-audit-server");
    const result = await auditCourseGeneratedResources(course.id, { course, classroom });
    expect(result.issues.filter((issue) => issue.type === "adaptive-resource")).toEqual([]);
    expect(readClassroom).not.toHaveBeenCalled();
  });

  it("checks the exact required textbook image across split pages and its upload bytes", async () => {
    const figureId = "textbook-figure-1";
    const resourceId = `textbook_fig_${createHash("sha256").update(figureId).digest("hex").slice(0, 12)}`;
    const assetId = "11111111-1111-4111-8111-111111111111";
    const otherAssetId = "22222222-2222-4222-8222-222222222222";
    const course = {
      id: "course-textbook", aiLearningClassroomId: "classroom-textbook",
      content: {
        _openmaicSceneOutlines: [
          { id: "parent-a", spatialParentId: "parent", type: "slide" },
          { id: "parent-b", spatialParentId: "parent", type: "slide" },
        ],
        courseEvidence: { items: [{ figureRefs: [{ figureId }] }] },
        teachingBlueprint: { sections: [{ pages: [{ id: "parent", outlineId: "parent", resourceNeeds: [{
          kind: "source-image", assetId: resourceId, required: true, purpose: "观察教材原图",
        }] }] }] },
      },
    } as unknown as Course;
    const classroom = {
      id: "classroom-textbook", createdAt: "2026-09-24", stage: {}, scenes: [
        { id: "scene-a", outlineId: "parent-a", type: "slide", order: 0, title: "原图（1/2）",
          content: { type: "slide", canvas: { elements: [] } }, actions: [] },
        { id: "scene-b", outlineId: "parent-b", type: "slide", order: 1, title: "原图（2/2）",
          content: { type: "slide", canvas: { elements: [{ id: "figure", type: "image", src: `/api/uploads/${assetId}` }] } }, actions: [] },
      ],
    } as unknown as PersistedClassroomData;
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).png().toBuffer();
    const uploadDir = path.join(CLASSROOMS_DIR, "uploads");
    await mkdir(uploadDir, { recursive: true });
    await writeFile(path.join(uploadDir, "figure.png"), png);
    vi.stubEnv("UPLOAD_DIR", uploadDir);
    textbookFigureFindMany.mockResolvedValue([{ id: figureId, fileAssetId: assetId, status: "AVAILABLE" }]);
    fileAssetFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      storageKey: "figure.png", mimeType: "image/png", size: BigInt(png.length), id: where.id,
    }));

    const { auditCourseGeneratedResources } = await import("./resource-audit-server");
    const valid = await auditCourseGeneratedResources(course.id, { course, classroom });
    expect(valid.issues.filter((issue) => issue.type === "media")).toEqual([]);
    expect(fileAssetFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: assetId, deletedAt: null } }));

    const unrelated = structuredClone(classroom);
    const currentElement = unrelated.scenes[1]?.content.type === "slide"
      ? unrelated.scenes[1].content.canvas.elements[0] : undefined;
    if (currentElement?.type === "image") currentElement.src = `/api/uploads/${otherAssetId}`;
    expect((await auditCourseGeneratedResources(course.id, { course, classroom: unrelated })).issues)
      .toContainEqual(expect.objectContaining({
        id: `media:source-image:parent:${resourceId}`,
        detail: "指定的教材原图未进入对应课堂页面",
      }));

    fileAssetFindFirst.mockResolvedValue(null);
    expect((await auditCourseGeneratedResources(course.id, { course, classroom })).issues)
      .toContainEqual(expect.objectContaining({
        id: "media:image:figure",
        detail: "媒体文件不存在或无法读取",
      }));
  });

  it("checks that a ready adaptive resource points to a readable classroom", async () => {
    const course = {
      id: "course-adaptive",
      aiLearningClassroomId: "main-classroom",
      content: {
        _openmaicSceneOutlines: [],
        adaptiveLearningPlan: {
          enabled: true,
          branches: [{
            id: "branch",
            title: "拓展资源",
            enabled: true,
            status: "teacher-confirmed",
            preparedResource: { status: "ready", classroomId: "missing-adaptive" },
          }],
        },
      },
    } as unknown as Course;
    const classroom = {
      id: "main-classroom", createdAt: "2026-09-22", stage: {}, scenes: [],
    } as unknown as PersistedClassroomData;
    readClassroom.mockResolvedValue(null);

    const { auditCourseGeneratedResources } = await import("./resource-audit-server");
    const audit = await auditCourseGeneratedResources(course.id, { course, classroom });

    expect(readClassroom).toHaveBeenCalledTimes(1);
    expect(audit.issues).toContainEqual(expect.objectContaining({
      id: "adaptive:branch",
      detail: "个性化学习课堂不存在或没有可播放页面",
    }));
  });

  it("reads remote narration through the SSRF-safe transport with a timeout", async () => {
    const course = {
      id: "course-remote",
      aiLearningClassroomId: "classroom-remote",
      content: { _openmaicSceneOutlines: [] },
    } as unknown as Course;
    const classroom = {
      id: "classroom-remote",
      createdAt: "2026-09-22T00:00:00.000Z",
      stage: {},
      scenes: [{
        id: "scene",
        title: "远程语音",
        type: "slide",
        order: 0,
        actions: [{
          id: "speech",
          type: "speech",
          text: "远程语音",
          audioUrl: "https://media.example.test/speech.wav",
          speechAlignment: { version: "test", status: "aligned", textHash: "text", audioHash: "audio", spans: [] },
        }],
      }],
    } as unknown as PersistedClassroomData;
    remoteFetch.mockResolvedValue(new Response(Buffer.from(wavBytes()), {
      status: 200,
      headers: { "content-type": "audio/wav", "content-length": String(wavBytes().byteLength) },
    }));

    const { auditCourseGeneratedResources } = await import("./resource-audit-server");
    const audit = await auditCourseGeneratedResources(course.id, { course, classroom });

    expect(audit.issues.filter((issue) => issue.type === "tts")).toEqual([]);
    expect(createSsrfSafeDispatcher).toHaveBeenCalledWith("https://media.example.test/speech.wav");
    expect(remoteFetch).toHaveBeenCalledWith("https://media.example.test/speech.wav", expect.objectContaining({
      redirect: "manual",
      signal: expect.any(AbortSignal),
    }));
    expect(closeRemoteConnection).toHaveBeenCalledTimes(1);
  });
});

function wavBytes(): Uint8Array {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 40, true);
  bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8_000, true);
  view.setUint32(28, 8_000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  bytes.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, 4, true);
  bytes.set([128, 128, 128, 128], 44);
  return bytes;
}
