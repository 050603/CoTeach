import { nanoid } from 'nanoid';
import type { Slide, SlideTheme, PPTElement } from '@openmaic/dsl';
import type { Scene, SlideContent } from '@openmaic/lib/types/stage';
import type { Action } from '@openmaic/lib/types/action';
import { createElementIdMap } from '@openmaic/lib/utils/element';
import { CURRENT_SLIDE_CONTENT_SCHEMA_VERSION } from '@openmaic/lib/edit/slide-schema';

const DEFAULT_THEME: SlideTheme = {
  backgroundColor: '#ffffff',
  themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4'],
  fontColor: '#333333',
  fontName: 'Microsoft YaHei',
  outline: { color: '#d14424', width: 2, style: 'solid' },
  shadow: { h: 0, v: 0, blur: 10, color: '#000000' },
};

/**
 * Build a fresh blank slide scene for `+ Add slide` in the Pro mode rail.
 * Matches the SceneBuilder default theme so user-added slides look the
 * same as AI-generated ones until customized.
 *
 * Starts with NO actions: the playback engine dwells on a zero-action scene
 * (showing the slide for a short beat) rather than skipping it, so a fresh
 * slide is playable without seeding a meaningless empty speech clip. The empty
 * script timeline surfaces inline as a "fill me in" cue for the user / MAIC
 * Agent instead.
 */
export function createBlankSlideScene(
  stageId: string,
  title: string,
  order: number,
  neighbor?: Scene,
): Scene {
  const slide: Slide = {
    id: nanoid(),
    viewportSize: 1000,
    viewportRatio: 0.5625,
    theme: DEFAULT_THEME,
    elements: [],
    background: { type: 'solid', color: '#ffffff' },
  };

  const content: SlideContent = {
    type: 'slide',
    schemaVersion: CURRENT_SLIDE_CONTENT_SCHEMA_VERSION,
    canvas: slide,
  };

  const actions: Action[] = [];

  return {
    id: nanoid(),
    stageId,
    type: 'slide',
    title,
    order,
    content,
    actions,
    ...(neighbor ? {
      stageKey: neighbor.stageKey,
      stageLabel: neighbor.stageLabel,
      audience: neighbor.audience,
      generationPurpose: neighbor.generationPurpose,
      parentActivityId: neighbor.parentActivityId,
      knowledgePointIds: neighbor.knowledgePointIds?.slice(),
      ttsPolicy: neighbor.ttsPolicy,
    } : {}),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Build a duplicate of an existing slide scene. Deep-clones the slide
 * payload and reassigns every element id (and group id) so React keys +
 * downstream selection state can't collide with the source slide while
 * grouped elements keep sharing a new common group id. The new scene
 * gets a fresh scene id; caller is responsible for placing it in the
 * scenes array (via `insertSceneAfter`).
 */
export function duplicateSlideScene(source: Scene, copySuffix: string, order: number): Scene {
  if (source.type !== 'slide') {
    throw new Error('duplicateSlideScene: source scene is not a slide');
  }
  const sourceContent = structuredClone(source.content) as SlideContent;
  const { elIdMap, groupIdMap } = createElementIdMap(sourceContent.canvas.elements);
  const clonedElements: PPTElement[] = sourceContent.canvas.elements.map((element) => ({
    ...element,
    id: elIdMap[element.id],
    ...(element.groupId ? { groupId: groupIdMap[element.groupId] } : {}),
  }));

  const clonedSlide: Slide = {
    ...sourceContent.canvas,
    id: nanoid(),
    elements: clonedElements,
    animations: sourceContent.canvas.animations
      ?.filter((animation) => Boolean(elIdMap[animation.elId]))
      .map((animation) => ({ ...animation, id: nanoid(), elId: elIdMap[animation.elId] })),
  };

  const content: SlideContent = {
    ...sourceContent,
    schemaVersion: CURRENT_SLIDE_CONTENT_SCHEMA_VERSION,
    canvas: clonedSlide,
  };

  const title = copySuffix ? `${source.title} ${copySuffix}` : source.title;

  // Clone the playback actions too: reseed each action id (so the copy doesn't
  // share audio-cache keys / React keys with the source), remap element-bound
  // cues onto the cloned element ids, and drop the stale audioId so the copy
  // re-derives / regenerates its own narration audio.
  const clonedActions = duplicateActions(source.actions, elIdMap);

  return {
    ...source,
    id: nanoid(),
    // A duplicate is NOT generated from the source's outline, so it must not
    // inherit `outlineId` — otherwise the editor agent would resolve the copy's
    // context to the original slide's outline. Cleared so resolveSceneOutline
    // falls back to the copy's own title / content.
    outlineId: undefined,
    title,
    order,
    content,
    actions: clonedActions,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function duplicateActions(actions: Action[] | undefined, canvasIds: Record<string, string> = {}): Action[] | undefined {
  const boardIds = new Map<string, string>();
  const groups = new Map<string, string>();
  for (const action of actions ?? []) {
    if (action.type.startsWith('wb_draw_') && 'elementId' in action && action.elementId && !boardIds.has(action.elementId)) boardIds.set(action.elementId, nanoid());
    if (action.groupId && !groups.has(action.groupId)) groups.set(action.groupId, nanoid());
  }
  return actions?.map((action) => {
    const next: Action = { ...structuredClone(action), id: nanoid() };
    if (next.groupId) next.groupId = groups.get(next.groupId);
    if ('elementId' in next && next.elementId) {
      next.elementId = next.type.startsWith('wb_') ? boardIds.get(next.elementId) ?? next.elementId : canvasIds[next.elementId] ?? next.elementId;
    }
    if (next.type === 'wb_draw_line') {
      for (const anchor of [next.startAnchor, next.endAnchor]) {
        if (anchor) anchor.elementId = boardIds.get(anchor.elementId) ?? anchor.elementId;
      }
    }
    if (next.type === 'speech') {
      delete next.audioId;
      delete next.audioUrl;
    }
    return next;
  });
}

/** Duplicating a quiz/interactive page gets independent action and outline
 * identity too; its original questions/HTML remain deep-cloned content. */
export function duplicateScene(source: Scene, copySuffix: string, order: number): Scene {
  if (source.type === 'slide') return duplicateSlideScene(source, copySuffix, order);
  const copy = structuredClone(source);
  return {
    ...copy,
    id: nanoid(),
    outlineId: undefined,
    title: copySuffix ? `${source.title} ${copySuffix}` : source.title,
    order,
    actions: duplicateActions(copy.actions),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as Scene;
}
