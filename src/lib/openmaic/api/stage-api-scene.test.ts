import { describe, expect, it } from "vitest";
import { createSceneAPI } from "./stage-api-scene";
import type { StageStore } from "./stage-api-types";
import type { Scene, Stage } from "@openmaic/lib/types/stage";
import { buildTtsTimingPlan } from "@openmaic/lib/audio/tts-timing";

function createStore() {
  let state = {
    stage: { id: "stage-1", name: "test" } as Stage,
    scenes: [] as Scene[],
    currentSceneId: null as string | null,
    mode: "playback" as const,
  };
  const store: StageStore = {
    getState: () => state,
    setState: (partial) => {
      state = { ...state, ...partial };
    },
    subscribe: () => () => undefined,
  };
  return { store, getState: () => state };
}

describe("createSceneAPI PBL metadata", () => {
  it("persists explicit routing metadata instead of dropping it", () => {
    const { store, getState } = createStore();
    const api = createSceneAPI(store);

    const result = api.create({
      type: "slide",
      title: "知识讲解",
      stageKey: "ai-learning",
      stageLabel: "AI 授知",
      audience: "student",
      generationPurpose: "knowledge-teaching",
      companionIds: ["explainer"],
      companionPrompt: "解释并追问",
      activityId: "activity-1",
      lectureSectionId: "section-1",
      lectureSectionTitle: "训练集与测试集",
      teachingUnitIds: ["unit-isolation"],
      assessmentUnitIds: ["unit-isolation", "unit-leakage"],
      segmentIndex: 1,
      segmentCount: 2,
      segmentRole: "mechanism",
      segmentGroupId: "section-1-pages",
      resourceTypes: ["ppt"],
    });

    expect(result.success).toBe(true);
    expect(getState().scenes[0]).toMatchObject({
      stageKey: "ai-learning",
      stageLabel: "AI 授知",
      audience: "student",
      generationPurpose: "knowledge-teaching",
      companionIds: ["explainer"],
      companionPrompt: "解释并追问",
      activityId: "activity-1",
      lectureSectionId: "section-1",
      lectureSectionTitle: "训练集与测试集",
      teachingUnitIds: ["unit-isolation"],
      assessmentUnitIds: ["unit-isolation", "unit-leakage"],
      segmentIndex: 1,
      segmentCount: 2,
      segmentRole: "mechanism",
      segmentGroupId: "section-1-pages",
      resourceTypes: ["ppt"],
    });
  });

  it("persists the executable per-page timing plan for runtime telemetry", () => {
    const { store, getState } = createStore();
    const api = createSceneAPI(store);
    const timingPlan = buildTtsTimingPlan({
      targetDurationSec: 100,
      activityTargetDurationSec: 180,
      providerId: "qwen-tts",
      modelId: "qwen3-tts-flash",
      voiceId: "Serena",
      naturalSpeedLocked: true,
      pageKind: "interactive",
      readingThinkingSec: 25,
      operationSec: 50,
      studentActivitySec: 75,
      transitionSec: 5,
    });

    const result = api.create({
      type: "interactive",
      title: "变量模拟",
      targetDurationSec: 180,
      timingPlan,
    });

    expect(result.success).toBe(true);
    expect(getState().scenes[0].timingPlan).toEqual(timingPlan);
  });
});
