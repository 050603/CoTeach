import { produce } from 'immer';
import { isEqual } from 'lodash';
import type { TeachingVisualMetadata } from '@openmaic/dsl';
import type { SlideContent } from '@openmaic/lib/types/stage';

export type TeachingVisualComponentState = TeachingVisualMetadata['components'][number];

const SLIDE_EDIT_SKIP = new Set(['elements', 'animations', 'teachingVisual']);
const NORMALIZATION_KEYS = new Set(['width', 'height']);

export function getTeachingVisualComponentForElement(
  content: SlideContent,
  elementId: string,
): TeachingVisualComponentState | undefined {
  return content.canvas.teachingVisual?.components.find((component) =>
    component.elementIds.includes(elementId),
  );
}

export function hasProtectedTeachingVisualEdits(content: SlideContent): boolean {
  const visual = content.canvas.teachingVisual;
  return !!visual && (
    !!visual.modifiedSlide || !!visual.manualElementIds?.length ||
    visual.components.some((component) => component.locked || component.modified)
  );
}

/**
 * Record teacher changes independently of the semantic scene. The scene still
 * contains the original source-grounded teaching facts; it must not be
 * rewritten from edited labels. Deleted IDs remain as tombstones so a later
 * composition cannot resurrect something the teacher removed.
 */
export function markTeachingVisualEdits(
  previous: SlideContent,
  next: SlideContent,
): SlideContent {
  const visual = previous.canvas.teachingVisual ?? next.canvas.teachingVisual;
  if (!visual || previous === next) return next;

  const previousById = new Map(previous.canvas.elements.map((element) => [element.id, element]));
  const nextById = new Map(next.canvas.elements.map((element) => [element.id, element]));
  const changed = new Set<string>();
  for (const [id, element] of previousById) {
    if (!isEqual(element, nextById.get(id))) changed.add(id);
  }
  for (const id of nextById.keys()) {
    if (!previousById.has(id)) changed.add(id);
  }

  // Compare relative order only among surviving elements: deleting one item
  // must not mark every following, unchanged component as teacher-edited.
  const previousOrder = previous.canvas.elements.filter((element) => nextById.has(element.id));
  const nextOrder = next.canvas.elements.filter((element) => previousById.has(element.id));
  previousOrder.forEach((element, index) => {
    if (nextOrder[index]?.id !== element.id) changed.add(element.id);
  });

  const previousCanvas = previous.canvas as unknown as Record<string, unknown>;
  const nextCanvas = next.canvas as unknown as Record<string, unknown>;
  const modifiedSlide = [...new Set([...Object.keys(previousCanvas), ...Object.keys(nextCanvas)])]
    .some((key) => !SLIDE_EDIT_SKIP.has(key) && !isEqual(previousCanvas[key], nextCanvas[key]));
  if (!changed.size && !modifiedSlide) return next;

  return produce(next, (draft) => {
    draft.canvas.teachingVisual ??= structuredClone(visual);
    const metadata = draft.canvas.teachingVisual;
    const ownedIds = new Set(metadata.components.flatMap((component) => component.elementIds));
    for (const component of metadata.components) {
      if (component.elementIds.some((id) => changed.has(id))) component.modified = true;
    }
    const manualIds = new Set(metadata.manualElementIds ?? []);
    for (const id of changed) {
      if (!ownedIds.has(id)) manualIds.add(id);
    }
    if (manualIds.size) metadata.manualElementIds = [...manualIds];
    if (modifiedSlide) metadata.modifiedSlide = true;
  });
}

/** Rich text input is debounced and often arrives outside a pointer gesture. */
export function isRendererUserEdit(
  previous: SlideContent,
  next: SlideContent,
  pointerGesture: boolean,
): boolean {
  if (pointerGesture) return true;
  if (previous.canvas.elements.length !== next.canvas.elements.length) return true;
  for (let index = 0; index < previous.canvas.elements.length; index++) {
    const before = previous.canvas.elements[index];
    const after = next.canvas.elements[index];
    if (!after || before.id !== after.id) return true;
    const left = before as unknown as Record<string, unknown>;
    const right = after as unknown as Record<string, unknown>;
    if ([...new Set([...Object.keys(left), ...Object.keys(right)])].some((key) =>
      !NORMALIZATION_KEYS.has(key) && !isEqual(left[key], right[key]),
    )) return true;
  }
  const left = previous.canvas as unknown as Record<string, unknown>;
  const right = next.canvas as unknown as Record<string, unknown>;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].some((key) =>
    !SLIDE_EDIT_SKIP.has(key) && !isEqual(left[key], right[key]),
  );
}

function correspondingComponent(
  component: TeachingVisualComponentState,
  candidates: TeachingVisualComponentState[],
): TeachingVisualComponentState | undefined {
  const exact = candidates.find((candidate) => candidate.id === component.id && candidate.kind === component.kind);
  if (exact) return exact;
  if (!component.sourceContentIds.length) return undefined;
  const matches = candidates.filter((candidate) => candidate.kind === component.kind &&
    isEqual([...candidate.sourceContentIds].sort(), [...component.sourceContentIds].sort()));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Merge a new composition while freezing teacher-owned components and objects.
 * If their ownership cannot be mapped safely, retain the executable draft.
 * Whole-slide regeneration also keeps its narration when this guard applies.
 */
export function preserveTeachingVisualEdits(
  previous: SlideContent,
  generated: SlideContent,
): SlideContent {
  if (!hasProtectedTeachingVisualEdits(previous)) return generated;
  const previousVisual = previous.canvas.teachingVisual!;
  const generatedVisual = generated.canvas.teachingVisual;
  if (!generatedVisual) return previous;

  const protectedComponents = previousVisual.components.filter((component) => component.locked || component.modified);
  const replacements = protectedComponents.map((component) => ({
    previous: component,
    generated: correspondingComponent(component, generatedVisual.components),
  }));
  if (replacements.some((replacement) => !replacement.generated)) return previous;

  return produce(generated, (draft) => {
    const metadata = draft.canvas.teachingVisual!;
    for (const replacement of replacements) {
      const oldState = replacement.previous;
      const newState = replacement.generated!;
      const replacingIds = new Set(newState.elementIds);
      const originalIds = new Set(oldState.elementIds);
      const keptElements = previous.canvas.elements.filter((element) => originalIds.has(element.id));
      const insertionIndex = draft.canvas.elements.findIndex((element) => replacingIds.has(element.id));
      draft.canvas.elements = draft.canvas.elements.filter((element) =>
        !replacingIds.has(element.id) && !originalIds.has(element.id));
      draft.canvas.elements.splice(insertionIndex < 0 ? draft.canvas.elements.length : insertionIndex, 0,
        ...structuredClone(keptElements));
      const stateIndex = metadata.components.findIndex((component) => component.id === newState.id);
      metadata.components[stateIndex] = { ...structuredClone(oldState), id: newState.id };
    }

    const manualIds = new Set(previousVisual.manualElementIds ?? []);
    draft.canvas.elements = draft.canvas.elements.filter((element) => !manualIds.has(element.id));
    previous.canvas.elements.forEach((element, index) => {
      if (manualIds.has(element.id)) {
        draft.canvas.elements.splice(Math.min(index, draft.canvas.elements.length), 0, structuredClone(element));
      }
    });
    if (manualIds.size) metadata.manualElementIds = [...manualIds];
    if (previousVisual.modifiedSlide) {
      const previousCanvas = previous.canvas as unknown as Record<string, unknown>;
      const canvas = draft.canvas as unknown as Record<string, unknown>;
      for (const key of Object.keys(canvas)) {
        if (!SLIDE_EDIT_SKIP.has(key) && !(key in previousCanvas)) delete canvas[key];
      }
      for (const key of Object.keys(previousCanvas)) {
        if (!SLIDE_EDIT_SKIP.has(key)) canvas[key] = structuredClone(previousCanvas[key]);
      }
      metadata.modifiedSlide = true;
    }
    const liveIds = new Set(draft.canvas.elements.map((element) => element.id));
    const protectedIds = new Set(protectedComponents.flatMap((component) => component.elementIds));
    const protectedSources = new Set(protectedComponents.flatMap((component) => component.sourceContentIds));
    if (draft.canvas.presentationProjection) {
      const mapping = draft.canvas.presentationProjection.elementIdsBySource;
      for (const [sourceId, elementIds] of Object.entries(previous.canvas.presentationProjection?.elementIdsBySource ?? {})) {
        if (protectedSources.has(sourceId) || elementIds.some((id) => protectedIds.has(id))) {
          mapping[sourceId] = elementIds.filter((id) => liveIds.has(id));
        }
      }
      for (const sourceId of Object.keys(mapping)) mapping[sourceId] = mapping[sourceId].filter((id) => liveIds.has(id));
    }
    draft.canvas.animations = [
      ...(draft.canvas.animations ?? []).filter((animation) => liveIds.has(animation.elId) && !protectedIds.has(animation.elId) && !manualIds.has(animation.elId)),
      ...(previous.canvas.animations ?? []).filter((animation) => liveIds.has(animation.elId) && (protectedIds.has(animation.elId) || manualIds.has(animation.elId))),
    ];
  });
}
