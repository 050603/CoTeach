import type { PlaybackSyncState } from "@openmaic/components/stage-experience";

export const RESOURCE_PLAYER_CHANNEL = "openpbl-resource-player-v1";

export interface ResourcePlayerConfiguration {
  classroomId: string;
  sceneId?: string;
  experience: "teacher-resource" | "projected-readonly";
  playbackState?: PlaybackSyncState;
  interactionState?: Record<string, unknown> | null;
}

export function isResourceConfiguration(value: unknown): value is ResourcePlayerConfiguration {
  if (!value || typeof value !== "object") return false;
  const config = value as ResourcePlayerConfiguration;
  return typeof config.classroomId === "string" && config.classroomId.length > 0
    && (config.sceneId === undefined || typeof config.sceneId === "string")
    && (config.experience === "teacher-resource" || config.experience === "projected-readonly")
    && (config.playbackState === undefined || (isResourcePlayback(config.playbackState) && Number.isFinite(config.playbackState.version)))
    && (config.interactionState == null || (typeof config.interactionState === "object" && !Array.isArray(config.interactionState)));
}

export function isResourcePlayback(value: unknown): value is Omit<PlaybackSyncState, "version"> {
  if (!value || typeof value !== "object") return false;
  const state = value as PlaybackSyncState;
  const snapshot = state.snapshot;
  return ["idle", "playing", "paused", "live"].includes(state.engineMode)
    && Boolean(snapshot) && Number.isFinite(snapshot.sceneIndex) && Number.isFinite(snapshot.actionIndex)
    && (snapshot.sceneId === undefined || typeof snapshot.sceneId === "string")
    && Array.isArray(snapshot.consumedDiscussions) && snapshot.consumedDiscussions.every(id => typeof id === "string");
}

export function resourceIdentity(config: ResourcePlayerConfiguration): string {
  return JSON.stringify([config.classroomId, config.sceneId ?? null, config.experience]);
}
