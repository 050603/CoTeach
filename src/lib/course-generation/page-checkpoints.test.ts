import { describe, expect, it } from "vitest";
import type { SceneOutline } from "@openmaic/lib/types/generation";
import type { Scene } from "@openmaic/lib/types/stage";
import {
  fingerprintSceneOutline,
  fingerprintGenerationValue,
  restoreSceneStageAttemptCount,
  restoreSceneStageCheckpoint,
  SCENE_STAGE_CHECKPOINT_VERSION,
  restoreSceneCheckpoint,
  type PageCheckpointSnapshot,
  type SceneStageCheckpointSnapshot,
  type SceneStageAttemptSnapshot,
} from "./page-checkpoints";

const outline: SceneOutline = {
  id: "page-1",
  type: "slide",
  title: "认识人工智能",
  description: "解释人工智能的基本含义",
  keyPoints: ["定义", "边界"],
  estimatedDuration: 180,
  order: 0,
  stageKey: "ai-learning",
};

const scene = {
  id: "scene-1",
  stageId: "old-stage",
  outlineId: outline.id,
  type: "slide",
  title: outline.title,
  order: 0,
  content: {
    type: "slide",
    canvas: {
      id: "canvas-1",
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: {},
      elements: [],
    },
  },
  actions: [],
  createdAt: 1,
  updatedAt: 1,
} as unknown as Scene;

describe("course-generation page checkpoints", () => {
  it("uses a stable fingerprint independent of object key insertion order", () => {
    const reordered = {
      title: outline.title,
      id: outline.id,
      order: outline.order,
      estimatedDuration: outline.estimatedDuration,
      keyPoints: outline.keyPoints,
      description: outline.description,
      type: outline.type,
      stageKey: outline.stageKey,
    } as SceneOutline;
    expect(fingerprintSceneOutline(reordered)).toBe(fingerprintSceneOutline(outline));
  });

  it("restores only an exact outline match and rebinds it to the current stage", () => {
    const checkpoint: PageCheckpointSnapshot = {
      pageKey: outline.id,
      outlineFingerprint: fingerprintSceneOutline(outline),
      scene,
    };
    const restored = restoreSceneCheckpoint(outline, checkpoint, "new-stage");
    expect(restored).toMatchObject({
      id: "scene-1",
      stageId: "new-stage",
      outlineId: "page-1",
      title: outline.title,
      order: 0,
    });
  });

  it("rejects stale or structurally incompatible pages", () => {
    const checkpoint: PageCheckpointSnapshot = {
      pageKey: outline.id,
      outlineFingerprint: fingerprintSceneOutline(outline),
      scene,
    };
    expect(restoreSceneCheckpoint({ ...outline, keyPoints: ["新的知识边界"] }, checkpoint, "stage")).toBeNull();
    expect(restoreSceneCheckpoint(outline, { ...checkpoint, scene: { ...scene, type: "quiz" } as Scene }, "stage")).toBeNull();
  });

  it("restores partial work only for the exact outline, model and upstream input", () => {
    const checkpoint: SceneStageCheckpointSnapshot = {
      schemaVersion: SCENE_STAGE_CHECKPOINT_VERSION,
      pageKey: outline.id,
      stage: "actions" as const,
      outlineFingerprint: fingerprintSceneOutline(outline),
      modelFingerprint: "model-a",
      inputFingerprint: fingerprintGenerationValue({ elements: ["accepted-content"] }),
      payload: { actions: [{ id: "speech-1", type: "speech", text: "讲稿" }] },
    };
    const inputFingerprint = fingerprintGenerationValue({ elements: ["accepted-content"] });
    expect(restoreSceneStageCheckpoint({
      outline,
      checkpoint,
      stage: "actions",
      modelFingerprint: "model-a",
      inputFingerprint,
    })).toEqual(checkpoint.payload);
    expect(restoreSceneStageCheckpoint({
      outline,
      checkpoint,
      stage: "actions",
      modelFingerprint: "model-b",
      inputFingerprint,
    })).toBeNull();
    expect(restoreSceneStageCheckpoint({
      outline,
      checkpoint,
      stage: "actions",
      modelFingerprint: "model-a",
      inputFingerprint: fingerprintGenerationValue({ elements: ["changed-content"] }),
    })).toBeNull();
  });

  it("invalidates new completed-page checkpoints when the model or course input changes", () => {
    const checkpoint: PageCheckpointSnapshot = {
      pageKey: outline.id,
      outlineFingerprint: fingerprintSceneOutline(outline),
      modelFingerprint: "model-a",
      inputFingerprint: "input-a",
      scene,
    };
    expect(restoreSceneCheckpoint(
      outline,
      checkpoint,
      "stage",
      "model-a",
      "input-a",
    )).not.toBeNull();
    expect(restoreSceneCheckpoint(
      outline,
      checkpoint,
      "stage",
      "model-b",
      "input-a",
    )).toBeNull();
    expect(restoreSceneCheckpoint(
      outline,
      checkpoint,
      "stage",
      "model-a",
      "input-b",
    )).toBeNull();
  });

  it("restores only the matching persisted stage attempt budget", () => {
    const checkpoint: SceneStageAttemptSnapshot = {
      schemaVersion: SCENE_STAGE_CHECKPOINT_VERSION,
      pageKey: outline.id,
      stage: "narration",
      outlineFingerprint: fingerprintSceneOutline(outline),
      modelFingerprint: "model-a",
      inputFingerprint: "actions-a",
      attemptsStarted: 2,
    };
    expect(restoreSceneStageAttemptCount({
      outline,
      checkpoint,
      stage: "narration",
      modelFingerprint: "model-a",
      inputFingerprint: "actions-a",
    })).toBe(2);
    expect(restoreSceneStageAttemptCount({
      outline,
      checkpoint,
      stage: "narration",
      modelFingerprint: "model-a",
      inputFingerprint: "actions-b",
    })).toBe(0);
  });
});
