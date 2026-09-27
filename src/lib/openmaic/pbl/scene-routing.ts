import type { Scene } from "@openmaic/lib/types/stage";

/**
 * The only scenes that belong to the student's AI classroom in the new PBL
 * mode. Keeping this predicate in the shared OpenMAIC layer prevents the
 * student filter, server-side classroom split, and TTS pipeline from drifting
 * apart.
 */
export function isStudentAiLearningScene(
  scene: Pick<Scene, "stageKey" | "audience" | "generationPurpose">,
): boolean {
  return (
    scene.audience === "student" &&
    scene.stageKey === "ai-learning" &&
    scene.generationPurpose === "knowledge-teaching"
  );
}

export function hasPblRoutingMetadata(
  scene: Pick<Scene, "stageKey" | "stageLabel" | "audience" | "generationPurpose">,
): boolean {
  return Boolean(
    scene.stageKey || scene.stageLabel || scene.audience || scene.generationPurpose,
  );
}

/** Shared playback/progress boundary, including classrooms predating routing metadata. */
export function selectStudentLearningScenes<T extends Pick<Scene, "stageKey" | "audience" | "generationPurpose">>(scenes: T[]): T[] {
  const routed = scenes.some(scene => Boolean(scene.stageKey || scene.audience || scene.generationPurpose));
  return routed ? scenes.filter(isStudentAiLearningScene) : scenes;
}
