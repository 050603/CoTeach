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
import { makeScene, type Scene, type ScenePatch, type SceneContent, type InteractiveContent, type SlideContent } from '@openmaic/lib/types/stage';
import type { GeneratedSlideContent, SceneOutline } from '@openmaic/lib/types/generation';
import { CURRENT_SLIDE_CONTENT_SCHEMA_VERSION } from '@openmaic/lib/edit/slide-schema';
import { isEqual } from 'lodash';
import { validateAction } from '@openmaic/dsl';
import { whiteboardBlocks, replaceWhiteboardSteps } from '@openmaic/lib/edit/whiteboard-blocks';
import type { WhiteboardPatch } from '@openmaic/lib/edit/whiteboard-patch';
import type { NarrationPatch } from '@openmaic/lib/agent/tools/regenerate-scene-actions';
import { hasProtectedTeachingVisualEdits } from '@openmaic/lib/edit/teaching-visual-edits';
import { sameSceneExceptOrder, type SceneRangeTransaction } from './scene-range-transaction';

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
      ...(gen.theme ? { theme: gen.theme } : {}),
      // Visual ownership belongs to the newly compiled elements. Keeping the
      // previous mappings would bind editing controls to an unrelated scene.
      teachingVisual: gen.teachingVisual,
      presentationProjection: gen.presentationProjection,
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
  /** Explicit historical-page redesign, including independent page narration. */
  visualRedesign?: {
    before: { content: SceneContent; actions: Action[] };
    pages: Array<{ outline: SceneOutline; content: GeneratedSlideContent; actions: Action[] }>;
  };
  error?: string;
}

export interface RegenerateApplyContext {
  scenes: Scene[];
  outlines: SceneOutline[];
  /** Client-owned send-time state, independent of the returned tool payload. */
  requestScene?: Scene;
  requestOutline?: SceneOutline;
  requestStoredOutline?: SceneOutline;
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
    sceneRange?: SceneRangeTransaction;
  } | null;
  /** Partial scene update to apply, or null if nothing should change. */
  patch: ScenePatch | null;
  /** Replaces the original page and inserts its siblings in one store update. */
  sceneRange?: SceneRangeTransaction;
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
  context?: RegenerateApplyContext,
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

  if (details.visualRedesign) {
    if (toolName !== 'regenerate_scene') {
      return { snapshot: null, patch: null, error: '只有指定页面重设计可以应用拆分页。' };
    }
    return planVisualRedesign(details, context);
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
    if (details.content.continuationPages?.length) {
      return {
        snapshot: null, patch: null,
        error: '拆页结果缺少独立讲稿和可恢复的教学计划，已保留当前页面。请重新进行图解重设计。',
      };
    }
    if (scene?.content.type === 'slide' && hasProtectedTeachingVisualEdits(scene.content as SlideContent)) {
      return {
        snapshot: null,
        patch: null,
        error: '这页包含已锁定或手动修改的图解，已保留当前页面和讲稿。可直接编辑，或为其余构件换构图。',
      };
    }
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

function planVisualRedesign(
  details: RegenerateDetails,
  context?: RegenerateApplyContext,
): RegenerateApplyPlan {
  const fail = (error: string): RegenerateApplyPlan => ({ snapshot: null, patch: null, error });
  const scene = context?.scenes.find((item) => item.id === details.sceneId);
  const redesign = details.visualRedesign;
  if (!scene || scene.content.type !== 'slide' || !redesign ||
      !Array.isArray(redesign.pages) || !redesign.pages.length || redesign.pages.length > 3 ||
      !redesign.before || !Array.isArray(redesign.before.actions)) {
    return fail('图解重设计结果不完整，已保留当前页面。');
  }
  if (!context?.requestScene || scene.order !== context.requestScene.order || !sameSceneExceptOrder(scene, context.requestScene) ||
      !isEqual(scene.content, redesign.before.content) ||
      !isEqual(scene.actions ?? [], redesign.before.actions)) {
    return fail('这页在 AI 重设计期间已被修改，已保留你的最新页面和讲稿。请重新提出编辑要求。');
  }
  if (hasProtectedTeachingVisualEdits(scene.content)) {
    return fail('这页包含已锁定或手动修改的图解，已保留当前页面和讲稿。可直接编辑，或为其余构件换构图。');
  }
  const oldOutline = scene.outlineId
    ? context.outlines.find((outline) => outline.id === scene.outlineId)
    : undefined;
  if ((oldOutline || context.requestStoredOutline) && (!oldOutline || !context.requestStoredOutline ||
      !isEqual(oldOutline, { ...context.requestStoredOutline, order: oldOutline.order }))) {
    return fail('这页的教学计划在 AI 重设计期间已被修改，已保留当前课程。');
  }
  const oldDuration = scene.targetDurationSec ?? context.requestOutline?.targetDurationSec ??
    context.requestOutline?.estimatedDuration;
  const pages = redesign.pages;
  if (pages.some((page) => !page || typeof page !== 'object' || !page.outline || !page.content)) {
    return fail('拆页结果不完整，已保留当前页面。');
  }
  if (pages.length > 1 && !(typeof oldDuration === 'number' && Number.isFinite(oldDuration) && oldDuration > 0)) {
    return fail('原页缺少可核对的教学时长，无法安全拆页，已保留当前页面。');
  }
  const durationTotal = pages.reduce((sum, page) => sum + (page.outline?.targetDurationSec ?? page.outline?.estimatedDuration ?? 0), 0);
  if (oldDuration !== undefined && (!Number.isFinite(durationTotal) || Math.abs(durationTotal - oldDuration) > 0.01)) {
    return fail('拆页总时长与原页不一致，已保留当前页面和讲稿。');
  }
  const sourceOutlineId = scene.outlineId ?? context.requestOutline?.id ?? scene.id;
  if (pages[0]?.outline?.id !== sourceOutlineId) {
    return fail('重设计没有保留原页的教学计划身份，已保留当前页面。');
  }
  const pageIds = new Set<string>();
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    const outline = page.outline;
    const visual = page.content?.teachingVisual;
    const duration = outline?.targetDurationSec ?? outline?.estimatedDuration;
    if (!outline || !outline.id || outline.type !== 'slide' || !outline.title?.trim() ||
        pageIds.has(outline.id) || !Array.isArray(page.content?.elements) || !page.content.elements.length ||
        page.content.continuationPages?.length || visual?.scene?.designVersion !== 'teaching-visual-v2' ||
        !Array.isArray(visual.scene.pages) || !visual.scene.pages.some((item) => item?.id === visual.pageId) ||
        (pages.length > 1 && (outline.segmentIndex !== index + 1 || outline.segmentCount !== pages.length ||
          !outline.segmentGroupId || outline.segmentGroupId !== pages[0].outline.segmentGroupId)) ||
        (duration !== undefined && (!Number.isFinite(duration) || duration <= 0))) {
      return fail('拆分页缺少完整图解、顺序或教学计划，已保留当前页面。');
    }
    pageIds.add(outline.id);
    if (page.content.elements.some((element) => !element || typeof element.id !== 'string' || !element.id)) {
      return fail('拆分页包含缺少身份的对象，已保留当前页面。');
    }
    const elementIds = new Set(page.content.elements.map((element) => element.id));
    const actionIds = new Set<string>();
    if (elementIds.size !== page.content.elements.length || !Array.isArray(page.actions) ||
        !page.actions.some((action) => action?.type === 'speech' && typeof action.text === 'string' && action.text.trim()) ||
        page.actions.some((action) => {
          if (!validateAction(action).valid || !action.id || actionIds.has(action.id)) return true;
          actionIds.add(action.id);
          if (action.type === 'laser' || action.type === 'spotlight' || action.type === 'play_video') {
            if (!elementIds.has(action.elementId)) return true;
            if (action.type === 'laser' && action.waypoints?.some((waypoint) => !elementIds.has(waypoint.elementId))) return true;
          }
          return false;
        })) {
      return fail('拆分页缺少独立有效讲稿或播放目标，已保留当前页面和音频。');
    }
    if (page.actions.some((action) => (action.type === 'laser' || action.type === 'spotlight') &&
      action.speechId && !page.actions.some((speech) => speech.type === 'speech' && speech.id === action.speechId))) {
      return fail('拆分页的讲稿指向失效，已保留当前页面。');
    }
  }
  const now = Date.now();
  const sourceCanvas = scene.content.canvas;
  const afterScenes = pages.map((page, index) => {
    const outline = page.outline;
    const id = index === 0 ? scene.id : nanoid();
    const metadata: Record<string, unknown> = {
      timingPlan: outline.timingPlan,
      teachingToolPlan: outline.teachingToolPlan,
      segmentIndex: outline.segmentIndex,
      segmentCount: outline.segmentCount,
      segmentRole: outline.segmentRole,
      segmentGroupId: outline.segmentGroupId,
    };
    for (const key of ['stageKey', 'stageLabel', 'audience', 'generationPurpose', 'companionIds',
      'companionPrompt', 'activityId', 'parentActivityId', 'lectureSectionId', 'lectureSectionTitle',
      'detailKind', 'knowledgePointIds', 'teachingUnitIds', 'assessmentUnitIds', 'ttsPolicy',
      'resourceTypes', 'narrationMode'] as const) {
      if (outline[key] !== undefined) metadata[key] = outline[key];
    }
    const actions = page.actions.map((action): Action => {
      if (action.type !== 'speech') return { ...action };
      const next = { ...action, audioInvalidated: true };
      delete next.audioId;
      delete next.audioUrl;
      delete next.audioDurationSec;
      delete next.speechAlignment;
      return next;
    });
    const existingCanvas = { ...sourceCanvas, ...(index > 0 ? { id: nanoid() } : {}) };
    return makeScene({
      ...scene, ...metadata, id, outlineId: outline.id, title: outline.title,
      order: scene.order + index,
      targetDurationSec: outline.targetDurationSec ?? outline.estimatedDuration,
      actions, whiteboards: undefined, narrationRevision: undefined,
      createdAt: index === 0 ? scene.createdAt : now, updatedAt: now,
    }, toRuntimeSlideContent(page.content, existingCanvas));
  });
  const sceneRange: SceneRangeTransaction = {
    sceneId: scene.id, stageId: scene.stageId,
    before: { scenes: [scene], outlines: oldOutline ? [oldOutline] : [] },
    after: { scenes: afterScenes, outlines: pages.map((page, index) => ({ ...page.outline, order: scene.order + index })) },
  };
  return {
    snapshot: { sceneId: scene.id, content: scene.content, actions: scene.actions ?? [], sceneRange },
    patch: null, sceneRange,
  };
}
