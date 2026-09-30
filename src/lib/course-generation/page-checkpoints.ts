import { createHash } from "node:crypto";
import type { SceneOutline } from "@openmaic/lib/types/generation";
import type { Scene } from "@openmaic/lib/types/stage";

export type PageCheckpointSnapshot = {
  pageKey: string;
  outlineFingerprint: string;
  /** Added in v2. Missing values identify a legacy completed-page checkpoint. */
  modelFingerprint?: string;
  inputFingerprint?: string;
  scene: Scene;
};

export const SCENE_STAGE_CHECKPOINT_VERSION = 1;
export type SceneGenerationCheckpointStage =
  | "content"
  | "reviewed-content"
  | "actions"
  | "narration";

export type SceneStageCheckpointSnapshot = {
  schemaVersion: typeof SCENE_STAGE_CHECKPOINT_VERSION;
  pageKey: string;
  stage: SceneGenerationCheckpointStage;
  outlineFingerprint: string;
  modelFingerprint: string;
  inputFingerprint?: string;
  payload: unknown;
};

export type SceneStageAttemptSnapshot = {
  schemaVersion: typeof SCENE_STAGE_CHECKPOINT_VERSION;
  pageKey: string;
  stage: SceneGenerationCheckpointStage;
  outlineFingerprint: string;
  modelFingerprint: string;
  inputFingerprint?: string;
  attemptsStarted: number;
  /** A response is not committed until the stage checkpoint has been saved. */
  status?: "started" | "response" | "failed" | "aborted";
  executionId?: string;
  /** At most one model call can be replayed after a process interruption. */
  interruptedReplays?: number;
};

export function canReplayInterruptedSceneStageAttempt(
  checkpoint: SceneStageAttemptSnapshot | undefined,
  executionId: string | undefined,
): boolean {
  // A lost process cannot prove that an already-started request was rejected.
  // Completed raw responses can be validated locally; unknown requests require
  // an explicit teacher regeneration instead of opening a hidden paid replay.
  void checkpoint;
  void executionId;
  return false;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function fingerprintSceneOutline(outline: SceneOutline): string {
  // Display order changes when an earlier page is split. It does not change
  // this page's content, narration or resources; restore uses the new order.
  // Keep sourcePageIds and sectionPlanVersion in this hash: even an unchanged
  // page needs new narration when the teaching responsibility of its section moves.
  const semanticOutline = { ...outline } as Partial<SceneOutline>;
  delete semanticOutline.order;
  return fingerprintGenerationValue(semanticOutline);
}

export function fingerprintGenerationValue(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function restoreSceneStageCheckpoint(input: {
  outline: SceneOutline;
  checkpoint: SceneStageCheckpointSnapshot | undefined;
  stage: SceneGenerationCheckpointStage;
  modelFingerprint: string;
  inputFingerprint?: string;
}): unknown | null {
  const { checkpoint } = input;
  if (!checkpoint || checkpoint.schemaVersion !== SCENE_STAGE_CHECKPOINT_VERSION) return null;
  if (checkpoint.pageKey !== input.outline.id || checkpoint.stage !== input.stage) return null;
  if (checkpoint.outlineFingerprint !== fingerprintSceneOutline(input.outline)) return null;
  if (checkpoint.modelFingerprint !== input.modelFingerprint) return null;
  if (checkpoint.inputFingerprint !== input.inputFingerprint) return null;
  return checkpoint.payload;
}

export function restoreSceneStageAttemptCount(input: {
  outline: SceneOutline;
  checkpoint: SceneStageAttemptSnapshot | undefined;
  stage: SceneGenerationCheckpointStage;
  modelFingerprint: string;
  inputFingerprint?: string;
  executionId?: string;
}): number {
  const { checkpoint } = input;
  if (!checkpoint || checkpoint.schemaVersion !== SCENE_STAGE_CHECKPOINT_VERSION) return 0;
  if (checkpoint.pageKey !== input.outline.id || checkpoint.stage !== input.stage) return 0;
  if (checkpoint.outlineFingerprint !== fingerprintSceneOutline(input.outline)) return 0;
  if (checkpoint.modelFingerprint !== input.modelFingerprint) return 0;
  if (checkpoint.inputFingerprint !== input.inputFingerprint) return 0;
  const attemptsStarted = Number.isInteger(checkpoint.attemptsStarted) && checkpoint.attemptsStarted > 0
    ? checkpoint.attemptsStarted : 0;
  return canReplayInterruptedSceneStageAttempt(checkpoint, input.executionId)
    ? Math.max(0, attemptsStarted - 1) : attemptsStarted;
}

/** Migrate only a reconstructed legacy input hash for the exact unchanged
 * page/model/stage. Keep spent calls and interruption bookkeeping intact. */
export function migrateSceneStageAttemptInputFingerprint(input: {
  outline: SceneOutline;
  checkpoint: SceneStageAttemptSnapshot | undefined;
  stage: SceneGenerationCheckpointStage;
  modelFingerprint: string;
  inputFingerprint?: string;
  legacyInputFingerprint?: string;
}): SceneStageAttemptSnapshot | null {
  const { checkpoint } = input;
  if (!checkpoint || checkpoint.schemaVersion !== SCENE_STAGE_CHECKPOINT_VERSION
    || !input.inputFingerprint || !input.legacyInputFingerprint
    || input.legacyInputFingerprint === input.inputFingerprint
    || checkpoint.pageKey !== input.outline.id || checkpoint.stage !== input.stage
    || checkpoint.outlineFingerprint !== fingerprintSceneOutline(input.outline)
    || checkpoint.modelFingerprint !== input.modelFingerprint
    || checkpoint.inputFingerprint !== input.legacyInputFingerprint) return null;
  return { ...checkpoint, inputFingerprint: input.inputFingerprint };
}

function isScene(value: unknown): value is Scene {
  if (!value || typeof value !== "object") return false;
  const scene = value as Partial<Scene>;
  return typeof scene.id === "string"
    && typeof scene.type === "string"
    && typeof scene.title === "string"
    && Boolean(scene.content && typeof scene.content === "object")
    && Array.isArray(scene.actions);
}

export function restoreSceneCheckpoint(
  outline: SceneOutline,
  checkpoint: PageCheckpointSnapshot | undefined,
  stageId: string,
  modelFingerprint?: string,
  inputFingerprint?: string,
): Scene | null {
  if (!checkpoint || checkpoint.pageKey !== outline.id) return null;
  if (checkpoint.outlineFingerprint !== fingerprintSceneOutline(outline)) return null;
  if (modelFingerprint !== undefined && checkpoint.modelFingerprint !== modelFingerprint) return null;
  if (inputFingerprint !== undefined && checkpoint.inputFingerprint !== inputFingerprint) return null;
  if (!isScene(checkpoint.scene)) return null;
  if (checkpoint.scene.type !== outline.type || checkpoint.scene.content.type !== outline.type) return null;
  return {
    ...checkpoint.scene,
    stageId,
    outlineId: outline.id,
    title: outline.title,
    order: outline.order,
    updatedAt: Date.now(),
  } as Scene;
}
