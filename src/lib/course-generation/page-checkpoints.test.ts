import { describe, expect, it } from "vitest";
import type { SceneOutline } from "@openmaic/lib/types/generation";
import type { Scene } from "@openmaic/lib/types/stage";
import {
  fingerprintSceneOutline,
  fingerprintGenerationValue,
  restoreSceneStageAttemptCount,
  migrateSceneStageAttemptInputFingerprint,
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
  it("reuses page content when preceding layout splits change only its display order", () => {
    expect(fingerprintSceneOutline({ ...outline, order: 12 })).toBe(fingerprintSceneOutline(outline));
    expect(fingerprintSceneOutline({ ...outline, title: "教学内容已改变" })).not.toBe(fingerprintSceneOutline(outline));
  });

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

  it("invalidates all page stages when its section plan or assigned sources change", () => {
    const revised = { ...outline, sectionPlanVersion: "section-v1", sourcePageIds: [outline.id] };
    const oldFingerprint = fingerprintSceneOutline(revised);
    const pageCheckpoint = { pageKey: outline.id, outlineFingerprint: oldFingerprint, scene };
    for (const changed of [
      { ...revised, sectionPlanVersion: "section-v2" },
      { ...revised, sourcePageIds: [outline.id, "page-2"] },
    ]) {
      expect(restoreSceneCheckpoint(changed, pageCheckpoint, "stage")).toBeNull();
      for (const stage of ["content", "actions", "narration"] as const) {
        const checkpoint: SceneStageCheckpointSnapshot & SceneStageAttemptSnapshot = { schemaVersion: SCENE_STAGE_CHECKPOINT_VERSION, pageKey: outline.id,
          outlineFingerprint: oldFingerprint, stage, modelFingerprint: "model", payload: {}, attemptsStarted: 2 };
        expect(restoreSceneStageCheckpoint({ outline: changed, checkpoint, stage, modelFingerprint: "model" })).toBeNull();
        expect(restoreSceneStageAttemptCount({ outline: changed, checkpoint, stage, modelFingerprint: "model" })).toBe(0);
      }
    }
    expect(fingerprintSceneOutline({ ...outline, sourcePageIds: undefined, sectionPlanVersion: undefined }))
      .toBe(fingerprintSceneOutline(outline));
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

  it("does not let a legacy completed page impersonate the current contract cache", () => {
    const legacy: PageCheckpointSnapshot = {
      pageKey: outline.id,
      outlineFingerprint: fingerprintSceneOutline(outline),
      scene,
    };
    expect(restoreSceneCheckpoint(outline, legacy, "stage", "model-a", "contract-v3")).toBeNull();
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

  it("never restores a spent request allowance after a process restart", () => {
    const checkpoint: SceneStageAttemptSnapshot = {
      schemaVersion: SCENE_STAGE_CHECKPOINT_VERSION,
      pageKey: outline.id,
      stage: "content",
      outlineFingerprint: fingerprintSceneOutline(outline),
      modelFingerprint: "model-a",
      inputFingerprint: "content-a",
      attemptsStarted: 2,
      status: "response",
      executionId: "old-execution",
      interruptedReplays: 0,
    };
    const restore = (candidate: SceneStageAttemptSnapshot, executionId: string) => restoreSceneStageAttemptCount({
      outline,
      checkpoint: candidate,
      stage: "content",
      modelFingerprint: "model-a",
      inputFingerprint: "content-a",
      executionId,
    });
    expect(restore(checkpoint, "old-execution")).toBe(2);
    expect(restore(checkpoint, "new-execution")).toBe(2);
    expect(restore({ ...checkpoint, status: "started" }, "new-execution")).toBe(2);
    expect(restore({ ...checkpoint, status: "aborted" }, "new-execution")).toBe(2);
    expect(restore({ ...checkpoint, status: "failed" }, "new-execution")).toBe(2);
    expect(restore({ ...checkpoint, interruptedReplays: 1 }, "new-execution")).toBe(2);
    expect(restore({ ...checkpoint, inputFingerprint: "different-content" }, "new-execution")).toBe(0);
  });

  it('migrates exact old prepared-progression attempts without resetting failures or interruption consumption', () => {
    const old: SceneStageAttemptSnapshot = { schemaVersion: 1, pageKey: outline.id, stage: 'content',
      outlineFingerprint: fingerprintSceneOutline(outline), modelFingerprint: 'model-a',
      inputFingerprint: 'old-prepared-progression', attemptsStarted: 3, status: 'failed',
      executionId: 'old-worker', interruptedReplays: 1 };
    const identity = { outline, checkpoint: old, stage: 'content' as const, modelFingerprint: 'model-a',
      inputFingerprint: 'confirmed-request-progression', legacyInputFingerprint: 'old-prepared-progression' };
    const migrated = migrateSceneStageAttemptInputFingerprint(identity)!;
    expect(migrated).toEqual({ ...old, inputFingerprint: identity.inputFingerprint });
    expect(restoreSceneStageAttemptCount({ ...identity, checkpoint: migrated, executionId: 'new-worker' })).toBe(3);
    const second = migrateSceneStageAttemptInputFingerprint({ ...identity, checkpoint: { ...old, attemptsStarted: 2 } })!;
    expect(restoreSceneStageAttemptCount({ ...identity, checkpoint: second, executionId: 'new-worker' })).toBe(2);
    expect(migrateSceneStageAttemptInputFingerprint({ ...identity, legacyInputFingerprint: 'unrelated' })).toBeNull();
    expect(migrateSceneStageAttemptInputFingerprint({ ...identity, modelFingerprint: 'another-model' })).toBeNull();
    expect(migrateSceneStageAttemptInputFingerprint({ ...identity, outline: { ...outline, keyPoints: ['new-responsibility'] } })).toBeNull();
    // A truly recompiled responsibility gets a new outline hash, rather than
    // taking an exhausted unchanged page's calls under a different input hash.
    expect(restoreSceneStageAttemptCount({ ...identity, outline: { ...outline, sectionPlanVersion: 'new-plan' },
      checkpoint: migrated, executionId: 'new-worker' })).toBe(0);
  });
});
