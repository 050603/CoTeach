import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import type { PersistedClassroomData } from "@/lib/openmaic/server/classroom-storage";

const getCourse = vi.fn();
const readClassroom = vi.fn();
const resolveDurableCourseSceneOutlines = vi.fn();

vi.mock("@/lib/session/server-store", () => ({ getCourse }));
vi.mock("@/lib/openmaic/server/classroom-storage", () => ({ readClassroom }));
vi.mock("@/lib/course-generation/course-resource-outlines", () => ({
  resolveDurableCourseSceneOutlines,
}));

describe("final course resource audit", () => {
  beforeEach(() => {
    getCourse.mockReset();
    readClassroom.mockReset();
    resolveDurableCourseSceneOutlines.mockImplementation(async (_courseId, outlines) => outlines);
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
});
