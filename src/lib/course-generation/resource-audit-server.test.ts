import { mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import type { PersistedClassroomData } from "@/lib/openmaic/server/classroom-storage";
import { SOURCE_SEQUENCE_POLICY_VERSION } from "@/lib/textbook/figure-sequence";

const getCourse = vi.fn();
const readClassroom = vi.fn();
const resolveDurableCourseSceneOutlines = vi.fn();
const remoteFetch = vi.fn();
const createSsrfSafeDispatcher = vi.fn();
const closeRemoteConnection = vi.fn();
const fileAssetFindFirst = vi.fn();
const textbookFigureFindMany = vi.fn();
const textbookRetrievalFindMany = vi.fn();
const textbookBlockFindMany = vi.fn();

vi.mock("@/lib/session/server-store", () => ({ getCourse }));
vi.mock("@/lib/db/client", () => ({ prisma: {
  fileAsset: { findFirst: fileAssetFindFirst },
  textbookFigure: { findMany: textbookFigureFindMany },
  textbookRetrievalItem: { findMany: textbookRetrievalFindMany },
  textbookSourceBlock: { findMany: textbookBlockFindMany },
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
    textbookRetrievalFindMany.mockReset();
    textbookBlockFindMany.mockReset();
    textbookRetrievalFindMany.mockResolvedValue([]);
    textbookBlockFindMany.mockResolvedValue([]);
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

    const continuedCourse = structuredClone(course);
    continuedCourse.content._openmaicSceneOutlines = [{ id: "parent", type: "slide" }] as Course["content"]["_openmaicSceneOutlines"];
    const continuedClassroom = structuredClone(classroom);
    continuedClassroom.scenes[0]!.outlineId = "parent";
    continuedClassroom.scenes[1]!.outlineId = "parent--continuation-2";
    expect((await auditCourseGeneratedResources(course.id, {
      course: continuedCourse, classroom: continuedClassroom,
    })).issues.filter((issue) => issue.type === "media")).toEqual([]);

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
  it("finds an adopted original even when both blueprint and outline forgot its requirement", async () => {
    const figureId = "figure-32";
    const assetId = "11111111-1111-4111-8111-111111111111";
    textbookFigureFindMany.mockImplementation(async ({ include }: { include?: unknown }) => include
      ? [{ id: figureId, fileAssetId: assetId, status: "AVAILABLE", position: 1,
        fileAsset: { mimeType: "image/png", deletedAt: null },
        revision: { textbook: { title: "课程教材" } }, section: { title: "项目式教学" } }]
      : [{ id: figureId, fileAssetId: assetId, status: "AVAILABLE" }]);
    const course = {
      id: "course-original", aiLearningClassroomId: "classroom-original",
      content: {
        knowledgePoints: [{ id: "kp-project", evidenceItemIds: ["item-project"], sourceKnowledgePointIds: ["source-project"] }],
        courseEvidence: {
          mappings: [{ status: "partial", sourceKnowledgePointId: "source-project", evidenceItemIds: ["item-project"] }],
          items: [{ id: "item-project", source: { textbookTitle: "课程教材", revisionId: "revision-1", sectionPath: [], sourceBlockIds: [] },
            figureRefs: [{ figureId, relation: "source-block-direct", direct: true }] }],
        },
        teachingBlueprint: { sections: [{ pages: [{ id: "project-page", title: "项目式教学", type: "slide",
          knowledgePointIds: ["kp-project"] }] }] },
        _openmaicSceneOutlines: [{ id: "project-page", title: "项目式教学", type: "slide",
          knowledgePointIds: [] }],
      },
    } as unknown as Course;
    const classroom = { id: "classroom-original", createdAt: "2026-09-30", stage: {},
      scenes: [{ id: "project-page", outlineId: "project-page", title: "项目式教学", type: "slide",
        order: 0, content: { type: "slide", canvas: { elements: [] } }, actions: [] }],
    } as unknown as PersistedClassroomData;
    const { auditCourseGeneratedResources } = await import("./resource-audit-server");
    const audit = await auditCourseGeneratedResources(course.id, { course, classroom });
    expect(audit.issues).toContainEqual(expect.objectContaining({
      id: expect.stringMatching(/^media:source-image:project-page:textbook_fig_/),
      detail: "指定的教材原图未进入对应课堂页面",
    }));
    const noOutline = structuredClone(course);
    noOutline.content._openmaicSceneOutlines = [];
    expect((await auditCourseGeneratedResources(course.id, { course: noOutline, classroom })).issues)
      .toContainEqual(expect.objectContaining({
        id: expect.stringMatching(/^media:source-image:project-page:textbook_fig_/),
        detail: "指定教材原图的讲解页不在当前课程大纲中",
      }));
    const unassigned = structuredClone(course);
    unassigned.content.teachingBlueprint!.sections[0]!.pages[0]!.knowledgePointIds = [];
    const noOwner = await auditCourseGeneratedResources(course.id, { course: unassigned, classroom });
    expect(noOwner.issues).toContainEqual(expect.objectContaining({
      id: expect.stringMatching(/^media:source-image:unassigned:textbook_fig_/),
      detail: expect.stringContaining('缺少对应知识讲解页'),
    }));
  });

  it('checks the actual selected image page rather than redefining it from the first knowledge-point match', async () => {
    const figureId = 'figure-32';
    const resourceId = `textbook_fig_${createHash('sha256').update(figureId).digest('hex').slice(0, 12)}`;
    textbookFigureFindMany.mockImplementation(async ({ include }: { include?: unknown }) => include
      ? [{ id: figureId, fileAssetId: 'asset-32', status: 'AVAILABLE', position: 1,
        fileAsset: { mimeType: 'image/png', deletedAt: null },
        revision: { textbook: { title: '课程教材' } }, section: { title: '项目式教学' } }]
      : [{ id: figureId, fileAssetId: 'asset-32', status: 'AVAILABLE' }]);
    const course = { id: 'misplaced', aiLearningClassroomId: 'misplaced-classroom', content: {
      knowledgePoints: [{ id: 'kp-project', evidenceItemIds: ['e'] }],
      courseEvidence: { items: [{ id: 'e', source: { revisionId: 'revision-1', sectionPath: [] },
        figureRefs: [{ figureId, relation: 'source-block-direct', direct: true }] }], mappings: [] },
      teachingBlueprint: { sections: [{ pages: [
        { id: 'wrong', outlineId: 'wrong', type: 'slide', knowledgePointIds: [],
          resourceNeeds: [{ kind: 'source-image', assetId: resourceId, required: true }] },
        { id: 'right', outlineId: 'right', type: 'slide', knowledgePointIds: ['kp-project'],
          resourceNeeds: [] },
      ] }] },
      _openmaicSceneOutlines: [{ id: 'wrong', type: 'slide', knowledgePointIds: [] },
        { id: 'right', type: 'slide', knowledgePointIds: ['kp-project'] }],
    } } as unknown as Course;
    const classroom = { id: 'misplaced-classroom', stage: {}, scenes: [
      { id: 'scene-wrong', outlineId: 'wrong', type: 'slide', order: 0,
        content: { type: 'slide', canvas: { elements: [{ id: 'image', type: 'image',
          src: '/api/uploads/asset-32' }] } }, actions: [] },
      { id: 'scene-right', outlineId: 'right', type: 'slide', order: 1,
        content: { type: 'slide', canvas: { elements: [] } }, actions: [] },
    ] } as unknown as PersistedClassroomData;
    await saveReadableTestImage('asset-32');
    const { auditCourseGeneratedResources } = await import('./resource-audit-server');
    const audit = await auditCourseGeneratedResources(course.id, { course, classroom }, { reviewContent: false });
    expect(audit.issues.filter((issue) => issue.type === 'media')).toEqual([]);
  });

  it('rejects five-step course content independently of the stored image requirement', async () => {
    const figureId = 'figure-32';
    textbookFigureFindMany.mockImplementation(async ({ include }: { include?: unknown }) => include
      ? [{ id: figureId, fileAssetId: 'asset-32', status: 'AVAILABLE', position: 247,
        fileAsset: { mimeType: 'image/png', deletedAt: null },
        revision: { textbook: { title: '人工智能教学' } }, section: { title: '项目式教学' } }]
      : [{ id: figureId, fileAssetId: 'asset-32', status: 'AVAILABLE' }]);
    const labels = ['选择项目', '制定计划', '活动探究', '制作作品', '成果交流', '活动评价'];
    const evidence = { items: [{ id: 'e', source: { textbookTitle: '人工智能教学',
      revisionId: 'revision-1', sectionPath: [] },
      figureRefs: [{ figureId, relation: 'source-block-direct', direct: true }],
      figureSequences: [{ figureId, kind: 'ordered-steps',
        steps: labels.map((label, index) => ({ label, sourceBlockId: `block-${index}` })) }] }],
      mappings: [{ sourceKnowledgePointId: 'upstream', evidenceItemIds: ['e'], status: 'partial' }] };
    const course = { id: 'course-six', aiLearningClassroomId: 'classroom-six', content: {
      knowledgePoints: [{ id: 'kp-six', evidenceItemIds: ['e'], sourceKnowledgePointIds: ['upstream'] }],
      courseEvidence: evidence,
      teachingBlueprint: { sections: [{ units: [], pages: [{ id: 'page-six', outlineId: 'page-six',
        type: 'slide', knowledgePointIds: ['kp-six'], unitIds: [],
        description: '项目式教学有五个基本流程环节', keyPoints: labels.slice(0, 5),
        teachingObjective: '说明五个环节', resourceNeeds: [] }] }] },
      _openmaicSceneOutlines: [{ id: 'page-six', type: 'slide',
        generationPurpose: 'knowledge-teaching', knowledgePointIds: ['kp-six'],
        description: '五个流程环节', keyPoints: labels.slice(0, 5) }],
    } } as unknown as Course;
    const classroom = { id: 'classroom-six', createdAt: '2026-09-30', stage: {}, scenes: [{
      id: 'scene-six', outlineId: 'page-six', title: '项目式教学', type: 'slide', order: 0,
      content: { type: 'slide', canvas: { elements: [{ id: 'flow', type: 'shape',
        text: { content: '<p>五个环节</p>' } }] } }, actions: [{ id: 'speech', type: 'speech',
        text: '把五个环节按顺序排开' }],
    }] } as unknown as PersistedClassroomData;
    const { auditCourseGeneratedResources } = await import('./resource-audit-server');
    const audit = await auditCourseGeneratedResources(course.id, { course, classroom });
    expect(audit.issues.filter((issue) => issue.type === 'source-consistency').map((issue) => issue.id))
      .toEqual(expect.arrayContaining([
        expect.stringMatching(/:blueprint$/), expect.stringMatching(/:outline$/),
        expect.stringMatching(/:classroom$/),
      ]));
  });

  it('also catches an omitted final step for a source list with no illustration', async () => {
    const labels = ['确定问题', '收集证据', '形成结论'];
    const course = { id: 'course-list', aiLearningClassroomId: 'classroom-list', content: {
      knowledgePoints: [{ id: 'kp-list', evidenceItemIds: ['e-list'] }],
      courseEvidence: { items: [{ id: 'e-list', source: { revisionId: 'revision-1', sectionPath: [] },
        sourceSequencesResolved: true, figureSequencesResolved: true,
        sourceSequences: [{ anchorSourceBlockId: 'first', kind: 'ordered-steps',
          steps: labels.map((label, index) => ({ label, sourceBlockId: `b-${index}` })) }] }], mappings: [] },
      teachingBlueprint: { sections: [{ units: [], pages: [{ id: 'page-list', outlineId: 'page-list',
        type: 'slide', knowledgePointIds: ['kp-list'], unitIds: [],
        description: '确定问题、收集证据两个步骤', keyPoints: labels.slice(0, 2),
        teachingObjective: '说明两个步骤' }] }] },
      _openmaicSceneOutlines: [{ id: 'page-list', type: 'slide',
        generationPurpose: 'knowledge-teaching', knowledgePointIds: ['kp-list'],
        description: '确定问题、收集证据两个步骤', keyPoints: labels.slice(0, 2) }],
    } } as unknown as Course;
    const classroom = { id: 'classroom-list', createdAt: '2026-09-30', stage: {}, scenes: [{
      id: 'scene-list', outlineId: 'page-list', title: '证据流程', type: 'slide', order: 0,
      content: { type: 'slide', canvas: { elements: [{ id: 'steps', type: 'text',
        content: '<p>确定问题、收集证据</p>' }] } }, actions: [],
    }] } as unknown as PersistedClassroomData;
    const { auditCourseGeneratedResources } = await import('./resource-audit-server');
    const audit = await auditCourseGeneratedResources(course.id, { course, classroom });
    expect(audit.issues.filter((issue) => issue.type === 'source-consistency').map((issue) => issue.id))
      .toEqual(expect.arrayContaining([
        expect.stringMatching(/:blueprint$/), expect.stringMatching(/:outline$/),
        expect.stringMatching(/:classroom$/),
      ]));
  });

  it('skips all source-content inspection during automatic resource checks but retains it for an explicit review', async () => {
    const fixture = sequenceAuditFixture([{ id: 'source', labels: ['确定问题', '收集证据', '形成结论'] }]);
    const speech = fixture.classroom.scenes[0]!.actions?.[0];
    if (speech?.type === 'speech') speech.text = '流程有两个步骤：确定问题、收集证据、形成结论';
    const checks = await import('@/lib/textbook/course-visual-binding');
    const blueprintCheck = vi.spyOn(checks, 'findBlueprintFigureSequenceIssues');
    const knowledgeCheck = vi.spyOn(checks, 'findKnowledgeSourceSequenceIssues');
    const sequenceCheck = vi.spyOn(checks, 'inspectFigureSequence');
    try {
      const { auditCourseGeneratedResources } = await import('./resource-audit-server');
      const automatic = await auditCourseGeneratedResources(fixture.course.id, fixture, { reviewContent: false });
      expect(blueprintCheck).not.toHaveBeenCalled();
      expect(knowledgeCheck).not.toHaveBeenCalled();
      expect(sequenceCheck).not.toHaveBeenCalled();
      expect(automatic.issues.filter((issue) => issue.type === 'source-consistency')).toEqual([]);
      expect(automatic.issues.some((issue) => issue.type === 'tts')).toBe(true);

      const manual = await auditCourseGeneratedResources(fixture.course.id, fixture);
      expect(blueprintCheck).toHaveBeenCalled();
      expect(knowledgeCheck).toHaveBeenCalled();
      expect(sequenceCheck).toHaveBeenCalled();
      expect(manual.issues).toContainEqual(expect.objectContaining({
        type: 'source-consistency', detail: expect.stringContaining('写成 2 个环节'),
      }));
    } finally {
      blueprintCheck.mockRestore();
      knowledgeCheck.mockRestore();
      sequenceCheck.mockRestore();
    }
  });

  it('keeps unselected textbook figures as references in an explicit authoring plan', async () => {
    const fixture = sequenceAuditFixture([{ id: 'reference', figureId: 'figure-shared', labels: ['分析目标', '收集证据'] }]);
    fixture.course.content.teachingBlueprint!.sections[0]!.pages[0]!.sourceSequenceUses = [];
    const { auditCourseGeneratedResources } = await import('./resource-audit-server');
    const automatic = await auditCourseGeneratedResources(fixture.course.id, fixture, { reviewContent: false });
    expect(automatic.issues.filter((issue) => issue.type === 'media' || issue.type === 'source-consistency')).toEqual([]);
    expect(fileAssetFindFirst).not.toHaveBeenCalled();
  });

  it.each(['need', 'reference', 'observation', 'suggestion'] as const)(
    'checks a later page’s actual %s selection and still detects a missing selected image', async (selection) => {
      const fixture = sequenceAuditFixture([
        { id: 'overview', figureId: 'figure-shared', labels: ['分析目标', '收集证据'] },
        { id: 'chosen', labels: ['规划活动', '评价结果'] },
      ]);
      const resourceId = `textbook_fig_${createHash('sha256').update('figure-shared').digest('hex').slice(0, 12)}`;
      fixture.course.content.teachingBlueprint!.sections[0]!.pages[0]!.sourceSequenceUses = [];
      const chosen = fixture.course.content._openmaicSceneOutlines![1]!;
      if (selection === 'need') chosen.teachingBrief = { resourceNeeds: [{ kind: 'source-image', assetId: resourceId, required: true }] } as typeof chosen.teachingBrief;
      if (selection === 'reference') chosen.visualIntent!.resourceRefs = [{ kind: 'source-image', resourceId, required: true, reason: '观察实际采用的原图' }];
      if (selection === 'observation') Object.assign(chosen, { caseObservation: { kind: 'source-image', resourceIds: [resourceId] } });
      if (selection === 'suggestion') chosen.suggestedImageIds = [resourceId];
      await saveReadableTestImage('asset-shared');
      const scene = fixture.classroom.scenes[1]!;
      if (scene.content.type === 'slide') scene.content.canvas.elements.push({
        id: 'chosen-figure', type: 'image', src: '/api/uploads/asset-shared',
      } as typeof scene.content.canvas.elements[number]);
      const { auditCourseGeneratedResources } = await import('./resource-audit-server');
      const automatic = await auditCourseGeneratedResources(fixture.course.id, fixture, { reviewContent: false });
      expect(automatic.issues.filter((issue) => issue.type === 'media')).toEqual([]);

      if (scene.content.type === 'slide') scene.content.canvas.elements = scene.content.canvas.elements
        .filter((element) => element.id !== 'chosen-figure');
      const missing = await auditCourseGeneratedResources(fixture.course.id, fixture, { reviewContent: false });
      expect(missing.issues.filter((issue) => issue.type === 'media')).toEqual([
        expect.objectContaining({ id: `media:source-image:page-chosen:${resourceId}`,
          detail: '指定的教材原图未进入对应课堂页面' }),
      ]);
    },
  );

  it('checks every actual selected page and fails unreadable selected image files during automatic checks', async () => {
    const fixture = sequenceAuditFixture([
      { id: 'first', figureId: 'figure-shared', labels: ['分析目标', '收集证据'] },
      { id: 'second', labels: ['规划活动', '评价结果'] },
    ]);
    const resourceId = `textbook_fig_${createHash('sha256').update('figure-shared').digest('hex').slice(0, 12)}`;
    fixture.course.content.teachingBlueprint!.sections[0]!.pages[0]!.sourceSequenceUses = [];
    fixture.course.content._openmaicSceneOutlines!.forEach((outline) => { outline.suggestedImageIds = [resourceId]; });
    await saveReadableTestImage('asset-shared');
    const scene = fixture.classroom.scenes[1]!;
    if (scene.content.type === 'slide') scene.content.canvas.elements.push({
      id: 'chosen-figure', type: 'image', src: '/api/uploads/asset-shared',
    } as typeof scene.content.canvas.elements[number]);
    const { auditCourseGeneratedResources } = await import('./resource-audit-server');
    const missingPage = await auditCourseGeneratedResources(fixture.course.id, fixture, { reviewContent: false });
    expect(missingPage.issues.filter((issue) => issue.id.startsWith('media:source-image:'))).toEqual([
      expect.objectContaining({ id: `media:source-image:page-first:${resourceId}` }),
    ]);
    fileAssetFindFirst.mockResolvedValue(null);
    const missingFile = await auditCourseGeneratedResources(fixture.course.id, fixture, { reviewContent: false });
    expect(missingFile.issues).toContainEqual(expect.objectContaining({
      id: `media:source-image:page-second:${resourceId}`, detail: '媒体文件不存在或无法读取',
    }));
  });

  it('audits a required six-step original and other complete source lists using their own counts', async () => {
    const fixture = sequenceAuditFixture([
      { id: 'project', figureId: 'figure-shared', labels: ['选择项目', '制定计划', '活动探究', '制作作品', '成果交流', '活动评价'] },
      { id: 'inquiry', labels: ['创设情境', '自主探究', '解释点拨', '拓展延伸', '评价反思'] },
      { id: 'principles', heading: '教学设计原则', labels: ['发挥身体认知的主体性', '让学习过程直观可视',
        '创设多维环境', '设计身心交互', '重视动态生成'] },
    ]);
    const { auditCourseGeneratedResources } = await import('./resource-audit-server');
    const audit = () => auditCourseGeneratedResources(fixture.course.id, fixture);
    expect((await audit()).issues.filter((issue) => issue.type === 'source-consistency')).toEqual([]);

    const inquiry = fixture.classroom.scenes[1]!;
    const inquirySpeech = inquiry.actions?.[0];
    if (inquirySpeech?.type === 'speech') inquirySpeech.text = '探究式有六个步骤：创设情境、自主探究、解释点拨、拓展延伸、评价反思';
    expect((await audit()).issues).toContainEqual(expect.objectContaining({
      id: 'content:source-sequence:page-project:source-sequence:anchor-inquiry:classroom',
      type: 'source-consistency', detail: expect.stringContaining('写成 6 个环节'),
    }));

    if (inquirySpeech?.type === 'speech') inquirySpeech.text = '';
    const principle = fixture.classroom.scenes[2]!;
    const principleSpeech = principle.actions?.[0];
    if (principleSpeech?.type === 'speech') principleSpeech.text = '教学设计有四条原则：发挥身体认知的主体性、让学习过程直观可视、创设多维环境、设计身心交互、重视动态生成';
    expect((await audit()).issues).toContainEqual(expect.objectContaining({
      id: 'content:source-sequence:page-project:source-sequence:anchor-principles:classroom',
      type: 'source-consistency', detail: expect.stringContaining('教材正文清单为 5 条'),
    }));
  });

  it('preserves separate seven-step and four-stage diagrams and reports an incorrect narration count', async () => {
    const four = ['前期分析阶段', '核心要素设计阶段', '教学过程实施阶段', '教学评价阶段'];
    const fixture = sequenceAuditFixture([
      { id: 'seven', labels: ['教学目标分析', '情境创设', '信息资源设计', '自主学习设计', '协作学习环境设计', '学习效果评价设计', '强化练习设计'] },
      { id: 'four', labels: four },
    ]);
    const { auditCourseGeneratedResources } = await import('./resource-audit-server');
    const audit = () => auditCourseGeneratedResources(fixture.course.id, fixture);
    expect((await audit()).issues.filter((issue) => issue.type === 'source-consistency')).toEqual([]);

    const fourScene = fixture.classroom.scenes[1]!;
    const fourSpeech = fourScene.actions?.[0];
    if (fourSpeech?.type === 'speech') fourSpeech.text = `框架有七个阶段：${four.join('、')}`;
    expect((await audit()).issues).toContainEqual(expect.objectContaining({
      id: 'content:source-sequence:page-seven:source-sequence:anchor-four:classroom',
      type: 'source-consistency', detail: expect.stringContaining('写成 7 个环节'),
    }));

    if (fourSpeech?.type === 'speech') fourSpeech.text = '';
    const diagram = fixture.course.content._openmaicSceneOutlines![1]!.visualIntent!.diagram!;
    [diagram.nodes[0], diagram.nodes[1]] = [diagram.nodes[1]!, diagram.nodes[0]!];
    expect((await audit()).issues).toContainEqual(expect.objectContaining({
      id: 'content:source-sequence:page-seven:source-sequence:anchor-four:outline',
      type: 'source-consistency', detail: expect.stringContaining('未保留教材的 4 个步骤顺序'),
    }));
  });

  it('keeps a complete source process across continuation pages and still rejects an omitted final step', async () => {
    const fixture = sequenceAuditFixture([{ id: 'split', labels: ['确定问题', '收集证据', '形成结论'] }]);
    const first = fixture.classroom.scenes[0]!;
    first.content = { type: 'slide', canvas: { elements: [{ id: 'first', type: 'text',
      content: '<p>确定问题、收集证据</p>' }] } } as typeof first.content;
    first.actions = [];
    const continuation = { ...structuredClone(first), id: 'continued-scene',
      outlineId: 'page-split--continuation-2', order: 1,
      content: { type: 'slide', canvas: { elements: [{ id: 'last', type: 'text', content: '<p>形成<strong>结论</strong></p>' }] } },
    } as unknown as PersistedClassroomData['scenes'][number];
    fixture.classroom.scenes.push(continuation);
    const { auditCourseGeneratedResources } = await import('./resource-audit-server');
    expect((await auditCourseGeneratedResources(fixture.course.id, fixture)).issues
      .filter((issue) => issue.type === 'source-consistency')).toEqual([]);
    fixture.classroom.scenes.pop();
    expect((await auditCourseGeneratedResources(fixture.course.id, fixture)).issues)
      .toContainEqual(expect.objectContaining({
        id: 'content:source-sequence:page-split:source-sequence:anchor-split:classroom',
        type: 'source-consistency', detail: expect.stringContaining('遗漏教材步骤：形成结论'),
      }));
  });
  it('verifies complete source statements rendered in native table cells', async () => {
    const labels = ['选择适合项目式教学模式的教学内容', '检查知识传授与活动实践的平衡', '使用问题与证据 A&B 进行评价'];
    const fixture = sequenceAuditFixture([{ id: 'table-source', labels }]);
    const scene = fixture.classroom.scenes[0]!;
    scene.actions = [];
    scene.content = { type: 'slide', canvas: { elements: [{ id: 'source-table', type: 'table',
      data: labels.map((label, index) => [{ id: `cell-${index}`, text: `<p>${label.replace('&', '&amp;')}</p>` }]),
    }] } } as typeof scene.content;
    const { auditCourseGeneratedResources } = await import('./resource-audit-server');
    expect((await auditCourseGeneratedResources(fixture.course.id, fixture)).issues
      .filter((issue) => issue.type === 'source-consistency')).toEqual([]);

    if (scene.content.type === 'slide') {
      const table = scene.content.canvas.elements[0];
      if (table?.type === 'table') table.data[1]![0]!.text = '活动安排';
    }
    expect((await auditCourseGeneratedResources(fixture.course.id, fixture)).issues)
      .toContainEqual(expect.objectContaining({
        id: 'content:source-sequence:page-table-source:source-sequence:anchor-table-source:classroom',
        detail: expect.stringContaining('遗漏教材步骤：检查知识传授与活动实践的平衡'),
      }));
  });
});

async function saveReadableTestImage(assetId: string): Promise<void> {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).png().toBuffer();
  const uploadDir = path.join(CLASSROOMS_DIR, 'uploads');
  await mkdir(uploadDir, { recursive: true });
  await writeFile(path.join(uploadDir, 'selected.png'), png);
  vi.stubEnv('UPLOAD_DIR', uploadDir);
  fileAssetFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) => where.id === assetId
    ? { storageKey: 'selected.png', mimeType: 'image/png', size: BigInt(png.length) } : null);
}

function sequenceAuditFixture(sequences: Array<{ id: string; labels: string[]; heading?: string; figureId?: string }>): {
  course: Course; classroom: PersistedClassroomData;
} {
  const pages = sequences.map((sequence) => {
    const diagram = { topology: 'sequence', nodes: sequence.labels.map((label, index) => ({ id: `${sequence.id}-${index}`, label })), edges: [] };
    const description = `${sequence.heading ?? '教学流程'}有${sequence.labels.length}${sequence.heading ? '条原则' : '个步骤'}：${sequence.labels.join('、')}`;
    return { id: `page-${sequence.id}`, outlineId: `page-${sequence.id}`, type: 'slide', title: sequence.id,
      knowledgePointIds: ['kp-shared'], unitIds: [], keyPoints: sequence.labels, description,
      teachingObjective: description, visualRelationship: { kind: 'sequence', description, diagram },
      visualIntent: { representation: 'native-diagram', observationGoal: '查看本序列', diagram } };
  });
  const course = { id: 'shared-course', aiLearningClassroomId: 'shared-classroom', content: {
    knowledgePoints: [{ id: 'kp-shared', evidenceItemIds: sequences.map((sequence) => `item-${sequence.id}`) }],
    courseEvidence: { mappings: [], items: sequences.map((sequence) => {
      const steps = sequence.labels.map((label, index) => ({ label, sourceBlockId: `block-${sequence.id}-${index}` }));
      return { id: `item-${sequence.id}`, content: sequence.labels.join('、'),
        source: { revisionId: 'revision', sectionPath: [sequence.heading ?? '教学流程'] },
        sourceSequencesResolved: true, sourceSequencePolicyVersion: SOURCE_SEQUENCE_POLICY_VERSION, figureSequencesResolved: true,
        ...(sequence.figureId ? {
          figureRefs: [{ figureId: sequence.figureId, direct: true, relation: 'source-block-direct' }],
          figureSequences: [{ figureId: sequence.figureId, kind: 'ordered-steps', steps }],
        } : { sourceSequences: [{ anchorSourceBlockId: `anchor-${sequence.id}`, kind: 'ordered-steps', steps }] }),
      };
    }) },
    teachingBlueprint: { sections: [{ units: [], pages }] },
    _openmaicSceneOutlines: structuredClone(pages).map((page) => ({ ...page, generationPurpose: 'knowledge-teaching' })),
  } } as unknown as Course;
  const classroom = { id: 'shared-classroom', stage: {}, scenes: pages.map((page, index) => ({
    id: `scene-${index}`, outlineId: page.id, type: 'slide', order: index, title: page.title,
    content: { type: 'slide', canvas: { elements: [{ id: `text-${index}`, type: 'text', content: `<p>${page.description}</p>` },
      ...page.visualIntent.diagram.nodes.map((node) => ({ id: node.id, type: 'shape', text: { content: node.label } }))] } },
    actions: [{ id: `speech-${index}`, type: 'speech', text: page.description }],
  })) } as unknown as PersistedClassroomData;
  const figure = sequences.find((sequence) => sequence.figureId);
  if (figure) textbookFigureFindMany.mockImplementation(async ({ include }: { include?: unknown }) => include
    ? [{ id: figure.figureId, fileAssetId: 'asset-shared', status: 'AVAILABLE', position: 1,
      fileAsset: { mimeType: 'image/png', deletedAt: null }, revision: { textbook: { title: '课程教材' } },
      section: { title: '教学流程' } }]
    : [{ id: figure.figureId, fileAssetId: 'asset-shared', status: 'AVAILABLE' }]);
  return { course, classroom };
}

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
