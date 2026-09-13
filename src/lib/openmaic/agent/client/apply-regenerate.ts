/**
 * Pure apply logic for MAIC Agent tool results (client side).
 *
 * `regenerate_scene` returns generation-shaped slide content; the stage store
 * holds runtime `SceneContent` ({ type:'slide', canvas: Slide }). This module
 * converts between them (preserving the user's existing canvas) and decides
 * what to apply + what to snapshot for the "restore previous" button — kept
 * pure and side-effect-free so it can be unit-tested without React/Dexie.
 */
import { nanoid } from 'nanoid';
import type { Action } from '@openmaic/lib/types/action';
import type { Scene, ScenePatch, SceneContent, InteractiveContent } from '@openmaic/lib/types/stage';
import type { GeneratedSlideContent } from '@openmaic/lib/types/generation';
import { CURRENT_SLIDE_CONTENT_SCHEMA_VERSION } from '@openmaic/lib/edit/slide-schema';
import { isEqual } from 'lodash';
import { validateAction } from '@openmaic/dsl';
import { whiteboardBlocks, replaceWhiteboardSteps } from '@openmaic/lib/edit/whiteboard-blocks';
import type { WhiteboardPatch } from '@openmaic/lib/edit/whiteboard-patch';
import type { NarrationPatch } from '@openmaic/lib/agent/tools/regenerate-scene-actions';

// Mirrors the default theme minted by createSceneWithActions for fresh slides.
const DEFAULT_THEME = {
  backgroundColor: '#ffffff',
  themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4'],
  fontColor: '#333333',
  fontName: 'Microsoft YaHei',
  outline: { color: '#d14424', width: 2, style: 'solid' },
  shadow: { h: 0, v: 0, blur: 10, color: '#000000' },
};

/**
 * Convert generated slide content to runtime SlideContent, preserving the
 * scene's EXISTING canvas (id / viewport / theme) and overriding only the
 * elements + background. Mints a default canvas only when the scene has none.
 */
export function toRuntimeSlideContent(
  gen: GeneratedSlideContent,
  existingCanvas?: Record<string, unknown>,
): SceneContent {
  const base = existingCanvas ?? {
    id: nanoid(),
    viewportSize: 1000,
    viewportRatio: 0.5625,
    theme: DEFAULT_THEME,
  };
  return {
    type: 'slide',
    // schemaVersion belongs at the SlideContent top level (sibling of `canvas`),
    // where slide-defaults / createBlankSlideScene put it and migrateSlideContent
    // reads it — not inside the canvas object.
    schemaVersion: CURRENT_SLIDE_CONTENT_SCHEMA_VERSION,
    canvas: {
      ...base,
      elements: gen.elements,
      // Replacing ALL elements with freshly-minted ids strands any persisted
      // animations on `base` — they reference element ids that no longer exist
      // (mirrors how slide edit ops drop animations whose elId is deleted).
      // Every new element has a brand-new id, so nothing survives a filter;
      // clear the array.
      animations: [],
      // Only override background when defined — a regen that omits background
      // must not wipe the scene's existing background.
      ...(gen.background !== undefined ? { background: gen.background } : {}),
    },
  } as unknown as SceneContent;
}

export interface RegenerateDetails {
  sceneId?: string;
  /** Present for `regenerate_scene` (whole-slide); absent for actions-only. */
  content?: GeneratedSlideContent | null;
  /** Present for `edit_interactive_html` — the edited interactive page HTML. */
  html?: string | null;
  actions?: Action[];
  /** Present only for a scoped `edit_whiteboard` tool result. */
  whiteboardPatch?: WhiteboardPatch | null;
  narrationPatch?: NarrationPatch;
  error?: string;
}

export interface RegenerateApplyPlan {
  /** Pre-regenerate scene state to keep for restore (both regenerate tools). */
  snapshot: {
    sceneId: string;
    content: SceneContent;
    actions: Action[];
    /** True for narration-only regen — restore reverts actions only, not content. */
    actionsOnly?: boolean;
    /** Scoped before/after board steps for undo that preserves later outside edits. */
    whiteboardPatch?: WhiteboardPatch;
  } | null;
  /** Partial scene update to apply, or null if nothing should change. */
  patch: ScenePatch | null;
  /** Human-readable refusal, including a concurrently edited target board. */
  error?: string;
}

/**
 * Decide how to apply a tool result.
 * - `regenerate_scene` (content present): snapshot the current scene, then apply
 *   the converted content plus actions (actions only when non-empty — an empty
 *   array would wipe the narration).
 * - `regenerate_scene_actions` (no content): apply actions only when non-empty,
 *   and snapshot the prior narration so it can be reverted too.
 */
export function planRegenerateApply(
  details: RegenerateDetails,
  scene: Pick<Scene, 'content' | 'actions'> | null,
  toolName?: string,
): RegenerateApplyPlan {
  const { sceneId } = details;
  if (!sceneId) return { snapshot: null, patch: null };

  if (toolName === 'edit_whiteboard') {
    const boardPatch = details.whiteboardPatch;
    const fail = (error: string): RegenerateApplyPlan => ({ snapshot: null, patch: null, error });
    if (!scene || !boardPatch || !Array.isArray(boardPatch.before) || !Array.isArray(boardPatch.steps)) {
      return fail(details.error || '白板编辑结果不完整，请重新生成。');
    }
    const block = whiteboardBlocks(scene.actions ?? []).find((item) => item.id === boardPatch.boardId);
    if (!block) return fail('这块白板已被删除或替换，AI 修改没有应用。请重新选择白板。');
    if (!isEqual(block.steps, boardPatch.before)) {
      return fail('这块白板在 AI 编辑期间已被修改，已保留你的最新内容。请重新让 AI 编辑。');
    }
    if (boardPatch.steps.some((action) => !validateAction(action).valid || action.type === 'wb_open' || action.type === 'wb_close' || (action.type !== 'speech' && !action.type.startsWith('wb_')))) {
      return fail('AI 返回了白板之外的步骤或不完整内容，修改没有应用。');
    }
    return {
      snapshot: { sceneId, content: scene.content, actions: scene.actions ?? [], actionsOnly: true, whiteboardPatch: boardPatch },
      patch: { actions: replaceWhiteboardSteps(scene.actions ?? [], boardPatch.boardId, boardPatch.steps) },
    };
  }

  // Read tools and unknown tools must never be able to smuggle in scene edits.
  if (toolName !== undefined && !['regenerate_scene', 'regenerate_scene_actions', 'edit_interactive_html'].includes(toolName)) {
    return { snapshot: null, patch: null };
  }

  if (toolName === 'regenerate_scene_actions' && details.narrationPatch) {
    const fail = (error: string): RegenerateApplyPlan => ({ snapshot: null, patch: null, error });
    const { before, speeches } = details.narrationPatch;
    if (!scene || !Array.isArray(before) || !Array.isArray(speeches) || before.length !== speeches.length || !before.length) {
      return fail('讲稿修改结果不完整，未应用。');
    }
    const currentActions = scene.actions ?? [];
    const boardIndexes = new Set(whiteboardBlocks(currentActions).flatMap((block) =>
      Array.from({ length: block.end - block.start + 1 }, (_item, index) => block.start + index),
    ));
    const currentById = new Map(currentActions.filter((_action, index) => !boardIndexes.has(index)).map((action) => [action.id, action]));
    const edited = new Map<string, Action>();
    for (let index = 0; index < speeches.length; index++) {
      const speech = speeches[index];
      if (!validateAction(speech).valid || speech.type !== 'speech' || speech.id !== before[index]?.id || edited.has(speech.id)) {
        return fail('讲稿修改包含不完整内容或白板之外的其他动作，未应用。');
      }
      if (!isEqual(currentById.get(speech.id), before[index])) {
        return fail('这段讲稿在 AI 编辑期间已被修改或移动，已保留你的最新内容。请重新让 AI 编辑。');
      }
      edited.set(speech.id, speech);
    }
    return {
      snapshot: { sceneId, content: scene.content, actions: currentActions, actionsOnly: true },
      patch: { actions: currentActions.map((action) => edited.get(action.id) ?? action) },
    };
  }

  const actions = Array.isArray(details.actions) ? details.actions : [];

  // `edit_interactive_html` carries the edited interactive-page HTML. Snapshot
  // the current scene, then write the new html onto the existing
  // InteractiveContent — preserving the page's other fields (url / widgetType /
  // widgetConfig). The iframe reloads when content.html changes.
  if (toolName === 'edit_interactive_html' && typeof details.html === 'string') {
    const prev = scene?.content as InteractiveContent | undefined;
    if (!prev || prev.type !== 'interactive') return { snapshot: null, patch: null };
    const runtime: InteractiveContent = { ...prev, html: details.html };
    const snapshot = scene
      ? { sceneId, content: scene.content, actions: scene.actions ?? [] }
      : null;
    return { snapshot, patch: { content: runtime as SceneContent } };
  }

  // Defensive: only `regenerate_scene` carries whole-slide content. When the
  // tool name is known and is anything else, treat the result as actions-only
  // (a non-regenerate tool that happens to echo a content-shaped payload must
  // not clobber the slide). Undefined toolName keeps the legacy shape-based
  // behaviour for back-compat.
  const contentAllowed = toolName === undefined || toolName === 'regenerate_scene';

  if (contentAllowed && details.content && Array.isArray(details.content.elements)) {
    const sceneContent = scene?.content as
      | { type?: string; canvas?: Record<string, unknown> }
      | undefined;
    const existingCanvas = sceneContent?.type === 'slide' ? sceneContent.canvas : undefined;
    const runtime = toRuntimeSlideContent(details.content, existingCanvas);
    const patch: ScenePatch = {
      content: runtime,
      ...(actions.length > 0 ? { actions } : {}),
    };
    const snapshot = scene
      ? { sceneId, content: scene.content, actions: scene.actions ?? [] }
      : null;
    return { snapshot, patch };
  }

  if (actions.length > 0) {
    // Narration-only regen: snapshot the prior actions so this card can offer
    // Restore too. `actionsOnly` so restore reverts ONLY the actions — the slide
    // content is unchanged here, and re-applying it would clobber later canvas
    // edits + needlessly reseed the edit session.
    const snapshot = scene
      ? { sceneId, content: scene.content, actions: scene.actions ?? [], actionsOnly: true }
      : null;
    return { snapshot, patch: { actions } };
  }
  return { snapshot: null, patch: null };
}
