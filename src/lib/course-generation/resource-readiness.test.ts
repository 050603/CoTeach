import { describe, expect, it } from "vitest";
import type { SceneOutline } from "@/lib/openmaic/types/generation";
import type { Scene } from "@/lib/openmaic/types/stage";
import {
  findMissingTeachingToolResources,
  findMissingTtsResources,
  repairMissingTeachingToolResources,
} from "./resource-readiness";

const outline = {
  id: "slide-1",
  title: "概念关系讲解",
  type: "slide",
  order: 0,
  teachingToolPlan: [{
    id: "plan-1",
    tool: "whiteboard",
    trigger: "作答前",
    purpose: "回顾判断标准",
    content: ["判断标准"],
    required: true,
  }],
} as SceneOutline;

const scene = {
  id: "scene-1",
  outlineId: "slide-1",
  title: "概念关系讲解",
  order: 0,
  type: "slide",
  ttsPolicy: "target-duration",
  actions: [{ id: "speech-1", type: "speech", text: "开始测验" }],
} as Scene;

describe("course resource readiness", () => {
  it("reports a required planned action that is absent from the generated scene", () => {
    expect(findMissingTeachingToolResources([outline], [scene])).toMatchObject([{
      title: "概念关系讲解",
      tool: "whiteboard",
    }]);
  });

  it("reports only narrated speech actions without configured audio", () => {
    const withEmptyTransition = {
      ...scene,
      actions: [
        ...scene.actions!,
        { id: "transition", type: "speech" as const, text: "" },
        { id: "ready", type: "speech" as const, text: "已有音频", audioUrl: "/ready.wav" },
      ],
    };
    expect(findMissingTtsResources([withEmptyTransition])).toEqual([{
      kind: "tts",
      sceneId: "scene-1",
      actionId: "speech-1",
      title: "概念关系讲解",
    }]);
  });

  it("does not fabricate a missing planned action during resource repair", () => {
    const repaired = repairMissingTeachingToolResources([outline], [scene]);
    expect(repaired.changed).toBe(false);
    expect(findMissingTeachingToolResources([outline], repaired.scenes)).toHaveLength(1);
    expect(repaired.scenes[0]?.actions?.some((action) => action.type === "wb_draw_text")).toBe(false);
  });

  it("treats a functional interactive page as the planned interactive widget", () => {
    const interactiveOutline = {
      id: "interactive-1",
      title: "提示词互动实践",
      type: "interactive",
      order: 0,
      teachingToolPlan: [{
        id: "widget-plan",
        tool: "interactive-widget",
        trigger: "讲解后",
        purpose: "让学生实际操作",
        content: ["输入提示词并观察结果"],
        required: true,
      }],
    } as SceneOutline;
    const interactiveScene = {
      id: "interactive-scene",
      outlineId: "interactive-1",
      title: "提示词互动实践",
      order: 0,
      type: "interactive",
      content: {
        type: "interactive",
        url: "",
        html: "<!doctype html><html><body><textarea></textarea><button>运行</button><script>document.querySelector('button')</script></body></html>",
      },
      actions: [{ id: "speech", type: "speech", text: "请开始操作。" }],
    } as Scene;

    expect(findMissingTeachingToolResources([interactiveOutline], [interactiveScene])).toEqual([]);
  });

  it("still reports a planned widget when the interactive content is empty", () => {
    const interactiveOutline = {
      id: "interactive-1",
      title: "提示词互动实践",
      type: "interactive",
      order: 0,
      teachingToolPlan: [{
        id: "widget-plan",
        tool: "interactive-widget",
        trigger: "讲解后",
        purpose: "让学生实际操作",
        content: ["输入提示词并观察结果"],
        required: true,
      }],
    } as SceneOutline;
    const emptyScene = {
      id: "interactive-scene",
      outlineId: "interactive-1",
      title: "提示词互动实践",
      order: 0,
      type: "interactive",
      content: { type: "interactive", url: "", html: "<html><body></body></html>" },
      actions: [{ id: "speech", type: "speech", text: "请开始操作。" }],
    } as Scene;

    expect(findMissingTeachingToolResources([interactiveOutline], [emptyScene])).toMatchObject([{
      title: "提示词互动实践",
      tool: "interactive-widget",
    }]);
  });
});
