import type { SceneOutline } from '@openmaic/lib/types/generation';
import type { Scene } from '@openmaic/lib/types/stage';

/**
 * Resolve a scene's generation outline by stable identity (`outlineId`) rather
 * than by the mutable `order`.
 *
 * Pro-mode insert / reorder / delete rebalances `scene.order` while the
 * persisted `outlines` array keeps the original generation plan, so matching an
 * outline by `order` attaches **another slide's** outline (wrong title / type /
 * key points) to the scene being edited once the deck has been reordered.
 * Matching by the stamped `outlineId` is reorder-stable.
 *
 * Scenes built before `outlineId` existed, or freshly inserted scenes that have
 * no originating outline, fall back to an outline derived from the scene itself
 * — never another slide's outline.
 */
export function resolveSceneOutline(scene: Scene, outlines: SceneOutline[]): SceneOutline {
  const matched = outlines.find((outline) => outline.id === (scene.outlineId || scene.id));
  const metadata: Partial<SceneOutline> = {};
  for (const key of ['stageKey', 'stageLabel', 'audience', 'generationPurpose', 'companionIds',
    'companionPrompt', 'activityId', 'parentActivityId', 'lectureSectionId', 'lectureSectionTitle',
    'detailKind', 'knowledgePointIds', 'teachingUnitIds', 'assessmentUnitIds', 'targetDurationSec',
    'segmentIndex', 'segmentCount', 'segmentRole', 'segmentGroupId', 'ttsPolicy', 'timingPlan',
    'resourceTypes', 'narrationMode', 'teachingToolPlan'] as const) {
    // Assign through the common metadata shape: the key and value remain paired.
    if (scene[key] !== undefined) Object.assign(metadata, { [key]: scene[key] });
  }
  return {
    ...(matched ?? {
      id: scene.id,
      type: scene.type,
      title: scene.title,
      description: '',
      keyPoints: [],
      order: scene.order,
    }),
    ...metadata,
    title: scene.title,
    order: scene.order,
    ...(scene.targetDurationSec !== undefined ? { estimatedDuration: scene.targetDurationSec } : {}),
  };
}
