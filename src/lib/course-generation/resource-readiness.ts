import type { TeachingToolPlanItem } from "@/lib/openmaic/types/generation";
import type { Scene } from "@/lib/openmaic/types/stage";
import {
  applyPlannedTeachingToolActions,
  findMissingRequiredTeachingTools,
} from "@/lib/openmaic/generation/teaching-tool-plan";
import { normalizeWhiteboardActionLifecycle } from "@/lib/openmaic/generation/whiteboard-action-lifecycle";

export type MissingTeachingToolResource = {
  kind: "teaching-tool";
  outlineId: string;
  sceneId: string;
  title: string;
  tool: "whiteboard" | "spotlight" | "laser-pointer" | "interactive-widget";
};

export type MissingTtsResource = {
  kind: "tts";
  sceneId: string;
  actionId: string;
  title: string;
};

export type GeneratedMediaFailure = {
  type: "image" | "video";
};

/**
 * A course cover is generated and retried independently from classroom media.
 * It may need later attention, but it must never make the whole classroom,
 * image, and TTS pipeline restart from the beginning.
 */
export function summarizeGeneratedMediaReadiness(input: {
  failures: ReadonlyArray<GeneratedMediaFailure>;
  enableImageGeneration: boolean;
  enableVideoGeneration: boolean;
  coverStatus: "ready" | "failed";
}): {
  missingRequiredImageCount: number;
  missingRequiredVideoCount: number;
  coverNeedsAttention: boolean;
} {
  return {
    missingRequiredImageCount: input.enableImageGeneration
      ? input.failures.filter((failure) => failure.type === "image").length
      : 0,
    missingRequiredVideoCount: input.enableVideoGeneration
      ? input.failures.filter((failure) => failure.type === "video").length
      : 0,
    coverNeedsAttention: input.coverStatus !== "ready",
  };
}

type ResourceReadinessOutline = {
  id: string;
  title: string;
  teachingToolPlan?: TeachingToolPlanItem[];
};

export function findMissingTeachingToolResources(
  outlines: ReadonlyArray<ResourceReadinessOutline>,
  scenes: ReadonlyArray<Scene>,
): MissingTeachingToolResource[] {
  const sceneByOutlineId = new Map(scenes.map((scene) => [scene.outlineId?.trim() || scene.id, scene]));
  return outlines.flatMap((outline) => {
    const scene = sceneByOutlineId.get(outline.id);
    if (!scene) return [];
    return findMissingRequiredTeachingTools(outline, {
      sceneType: scene.type,
      content: scene.content,
      actions: scene.actions,
    }).map((tool) => ({
            kind: "teaching-tool" as const,
            outlineId: outline.id,
            sceneId: scene.id,
            title: outline.title,
            tool,
          }));
  });
}

export function findMissingTtsResources(
  scenes: ReadonlyArray<Scene>,
): MissingTtsResource[] {
  return scenes.flatMap((scene) => {
    if (scene.ttsPolicy === "none") return [];
    return (scene.actions ?? []).flatMap((action) =>
      action.type === "speech" && action.text.trim() && !action.audioUrl
        ? [{
            kind: "tts" as const,
            sceneId: scene.id,
            actionId: action.id,
            title: scene.title,
          }]
        : [],
    );
  });
}

export function repairMissingTeachingToolResources(
  outlines: ReadonlyArray<ResourceReadinessOutline>,
  scenes: ReadonlyArray<Scene>,
): { changed: boolean; scenes: Scene[] } {
  const outlineById = new Map(outlines.map((outline) => [outline.id, outline]));
  let changed = false;
  const repairedScenes = scenes.map((scene) => {
    const outline = outlineById.get(scene.outlineId?.trim() || "");
    if (!outline) return scene;
    const actions = normalizeWhiteboardActionLifecycle(
      applyPlannedTeachingToolActions(outline, scene.actions ?? []),
    );
    if (actions.length === (scene.actions ?? []).length) return scene;
    changed = true;
    return { ...scene, actions };
  });
  return { changed, scenes: repairedScenes };
}
