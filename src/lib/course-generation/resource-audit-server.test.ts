import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import type { PersistedClassroomData } from "@/lib/openmaic/server/classroom-storage";

const getCourse = vi.fn();
const readClassroom = vi.fn();
const resolveDurableCourseSceneOutlines = vi.fn();
const remoteFetch = vi.fn();
const createSsrfSafeDispatcher = vi.fn();
const closeRemoteConnection = vi.fn();

vi.mock("@/lib/session/server-store", () => ({ getCourse }));
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
    createSsrfSafeDispatcher.mockResolvedValue({ dispatcher: {}, close: closeRemoteConnection });
  });

  afterEach(async () => {
    await rm(CLASSROOMS_DIR, { recursive: true, force: true });
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
        actions: [{ id: "speech-1", type: "speech", text: "开始测验" }],
      }],
      assetGeneration: {
        status: "partial-failure",
        requested: 1,
        completed: 0,
        failures: [{ elementId: "cover-1", type: "image", error: "provider unavailable" }],
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
          audioUrl: "/api/openmaic/classroom-media/snapshot-classroom/audio/speech.wav",
          speechAlignment: { version: "test", status: "aligned", textHash: "text", audioHash: "audio", spans: [] },
        }],
      }],
    } as unknown as PersistedClassroomData;
    const audioDir = path.join(CLASSROOMS_DIR, "snapshot-classroom", "audio");
    await mkdir(audioDir, { recursive: true });
    await writeFile(path.join(audioDir, "speech.wav"), wavBytes());

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
          canvas: { elements: [{ id: "image", type: "image", src: "/api/openmaic/classroom-media/classroom-files/media/missing.png" }] },
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
