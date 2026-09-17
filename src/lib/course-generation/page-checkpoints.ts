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
};

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
  return fingerprintGenerationValue(outline);
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
}): number {
  const { checkpoint } = input;
  if (!checkpoint || checkpoint.schemaVersion !== SCENE_STAGE_CHECKPOINT_VERSION) return 0;
  if (checkpoint.pageKey !== input.outline.id || checkpoint.stage !== input.stage) return 0;
  if (checkpoint.outlineFingerprint !== fingerprintSceneOutline(input.outline)) return 0;
  if (checkpoint.modelFingerprint !== input.modelFingerprint) return 0;
  if (checkpoint.inputFingerprint !== input.inputFingerprint) return 0;
  return Number.isInteger(checkpoint.attemptsStarted) && checkpoint.attemptsStarted > 0
    ? checkpoint.attemptsStarted
    : 0;
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
  if (checkpoint.modelFingerprint !== undefined && checkpoint.modelFingerprint !== modelFingerprint) return null;
  if (checkpoint.inputFingerprint !== undefined && checkpoint.inputFingerprint !== inputFingerprint) return null;
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
