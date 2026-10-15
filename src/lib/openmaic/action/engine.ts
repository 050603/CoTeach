/**
 * ActionEngine — Unified execution layer for all agent actions.
 *
 * Replaces the 28 Vercel AI SDK tools in ai-tools.ts with a single engine
 * that both online (streaming) and offline (playback) paths share.
 *
 * Two execution modes:
 * - Fire-and-forget: spotlight, laser — dispatch and return immediately
 * - Synchronous: speech, whiteboard, discussion — await completion
 */

import type { StageStore } from '@openmaic/lib/api/stage-api';
import { createStageAPI } from '@openmaic/lib/api/stage-api';
import { whiteboardIdForScene } from '@openmaic/lib/api/stage-api-whiteboard';
import { useCanvasStore } from '@openmaic/lib/store/canvas';
import { useWhiteboardHistoryStore } from '@openmaic/lib/store/whiteboard-history';
import { useWhiteboardPagesStore } from '@openmaic/lib/store/whiteboard-pages';
import { useMediaGenerationStore, isMediaPlaceholder } from '@openmaic/lib/store/media-generation';
import type { AudioPlayer } from '@openmaic/lib/utils/audio-player';
import type {
  Action,
  SpotlightAction,
  LaserAction,
  SpeechAction,
  PlayVideoAction,
  WbDeleteAction,
  WbEditCodeAction,
  WidgetHighlightAction,
  WidgetSetStateAction,
  WidgetAnnotationAction,
  WidgetRevealAction,
  WhiteboardAction,
} from '@openmaic/lib/types/action';
import {
  editWhiteboardCodeElement,
  whiteboardActionToElement,
  type WhiteboardDrawAction,
} from '@openmaic/lib/whiteboard/projection';
import { createLogger } from '@openmaic/lib/logger';

const log = createLogger('ActionEngine');

// ==================== Helpers ====================

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==================== ActionEngine ====================

/** A laser is a short pointer cue; spotlights are cleared by narration lifecycle. */
const LASER_DEFAULT_DURATION_MS = 2500;

type RuntimeLaserAction = LaserAction & {
  /** Playback owns this cue's lifetime through the narration clock. */
  timelineControlled?: boolean;
};

function laserDuration(action: LaserAction): number {
  if (action.duration !== undefined) return action.duration;
  return action.waypoints?.length
    ? Math.min(8000, Math.max(LASER_DEFAULT_DURATION_MS, (action.waypoints.length + 1) * 1400))
    : LASER_DEFAULT_DURATION_MS;
}

/** Callback for sending messages to widget iframe */
export type WidgetMessageCallback = (type: string, payload: Record<string, unknown>) => void;

export class ActionEngine {
  private stageStore: StageStore;
  private stageAPI: ReturnType<typeof createStageAPI>;
  private audioPlayer: AudioPlayer | null;
  private effectTimer: ReturnType<typeof setTimeout> | null = null;
  private activeEffect: SpotlightAction | LaserAction | null = null;
  private effectTimerStartedAt = 0;
  private effectTimerRemaining = 0;
  private effectGeneration = 0;
  private widgetMessageCallback: WidgetMessageCallback | null = null;
  private whiteboardVersion = 0;

  constructor(
    stageStore: StageStore,
    audioPlayer?: AudioPlayer | null,
    widgetMessageCallback?: WidgetMessageCallback | null,
  ) {
    this.stageStore = stageStore;
    this.stageAPI = createStageAPI(stageStore);
    this.audioPlayer = audioPlayer ?? null;
    this.widgetMessageCallback = widgetMessageCallback ?? null;
  }

  /** Set callback for sending messages to widget iframe */
  setWidgetMessageCallback(callback: WidgetMessageCallback | null): void {
    this.widgetMessageCallback = callback;
  }

  /** Clean up timers when the engine is no longer needed */
  dispose(): void {
    this.whiteboardVersion++;
    useCanvasStore.getState().setWhiteboardClearing(false);
    if (this.effectTimer) {
      clearTimeout(this.effectTimer);
      this.effectTimer = null;
    }
    this.activeEffect = null;
    this.effectTimerRemaining = 0;
  }

  /**
   * Execute a single action.
   * Fire-and-forget actions return immediately.
   * Synchronous actions return a Promise that resolves when the action is complete.
   */
  async execute(action: Action): Promise<void> {
    if (action.type === 'wb_open' || action.type.startsWith('wb_draw_')) this.ensureWhiteboardPageKey(action.id);
    // Auto-open whiteboard if a draw/clear/delete action is attempted while it's closed
    if (action.type.startsWith('wb_') && action.type !== 'wb_open' && action.type !== 'wb_close') {
      await this.ensureWhiteboardOpen();
    }

    switch (action.type) {
      // Fire-and-forget
      case 'spotlight':
        this.executeSpotlight(action);
        return;
      case 'laser':
        this.executeLaser(action);
        return;
      // Synchronous — Video
      case 'play_video':
        return this.executePlayVideo(action as PlayVideoAction);

      // Synchronous
      case 'speech':
        return this.executeSpeech(action);
      case 'wb_open':
        return this.executeWbOpen();
      case 'wb_draw_text':
      case 'wb_draw_image':
      case 'wb_draw_shape':
      case 'wb_draw_chart':
      case 'wb_draw_latex':
      case 'wb_draw_table':
      case 'wb_draw_line':
      case 'wb_draw_code':
        return this.executeWbDraw(action);
      case 'wb_edit_code':
        return this.executeWbEditCode(action as WbEditCodeAction);
      case 'wb_clear':
        return this.executeWbClear(action.id);
      case 'wb_delete':
        return this.executeWbDelete(action as WbDeleteAction);
      case 'wb_close':
        return this.executeWbClose();
      case 'discussion':
        // Discussion lifecycle is managed externally via engine callbacks
        return;

      // Widget actions — post message to iframe
      case 'widget_highlight':
        return this.executeWidgetHighlight(action as WidgetHighlightAction);
      case 'widget_setState':
        return this.executeWidgetSetState(action as WidgetSetStateAction);
      case 'widget_annotation':
        return this.executeWidgetAnnotation(action as WidgetAnnotationAction);
      case 'widget_reveal':
        return this.executeWidgetReveal(action as WidgetRevealAction);
    }
  }

  /** Clear all active visual effects */
  clearEffects(): void {
    if (this.effectTimer) {
      clearTimeout(this.effectTimer);
      this.effectTimer = null;
    }
    this.activeEffect = null;
    this.effectTimerRemaining = 0;
    this.effectGeneration++;
    useCanvasStore.getState().clearAllEffects();
  }

  /** Hide the current cue while preserving its remaining lifetime for resume. */
  pauseEffects(): void {
    if (this.effectTimer) {
      clearTimeout(this.effectTimer);
      this.effectTimer = null;
      this.effectTimerRemaining = Math.max(
        0,
        this.effectTimerRemaining - (Date.now() - this.effectTimerStartedAt),
      );
    }
    useCanvasStore.getState().clearAllEffects();
  }

  /** Restore the cue that belongs to the paused narration. */
  resumeEffects(): void {
    const effect = this.activeEffect;
    if (!effect) return;
    if (
      effect.type === 'laser'
      && !(effect as RuntimeLaserAction).timelineControlled
      && this.effectTimerRemaining <= 0
    ) {
      this.clearEffects();
      return;
    }
    this.renderEffect(effect);
    if (effect.type === 'laser' && !(effect as RuntimeLaserAction).timelineControlled) {
      this.scheduleLaserClear(this.effectTimerRemaining);
    }
  }

  /**
   * Rebuild the current scene's board as a projection of the action timeline.
   * This is used by subtitle seeking: content after the target disappears,
   * content before it is restored exactly once, and normal playback can then
   * continue without duplicate elements.
   */
  async restoreWhiteboard(actions: ReadonlyArray<Action>): Promise<void> {
    const wb = this.getActiveWhiteboard();
    if (!wb.success || !wb.data) {
      throw new Error('Unable to restore the active whiteboard');
    }
    this.retainCurrentWhiteboard(false);
    const scope = this.whiteboardScope();
    if (scope) useWhiteboardPagesStore.getState().resetCurrentPage(scope.stageId, scope.sceneId);
    this.stageAPI.whiteboard.update({ elements: [] }, wb.data.id);
    useCanvasStore.getState().setWhiteboardClearing(false);
    useCanvasStore.getState().setWhiteboardOpen(false, true);
    this.executeWhiteboardTimeline(actions.filter((action): action is WhiteboardAction => action.type.startsWith('wb_')));
  }

  /** Apply one media-clock batch atomically, without adding animation delays to speech. */
  executeWhiteboardTimeline(actions: ReadonlyArray<WhiteboardAction>): void {
    this.whiteboardVersion++;
    useCanvasStore.getState().setWhiteboardClearing(false);
    const wb = this.getActiveWhiteboard();
    if (!wb.success || !wb.data) throw new Error('Unable to update the active whiteboard');
    for (const action of actions) {
      this.clearEffects();
      if (action.type === 'wb_close') {
        this.retainCurrentWhiteboard(true);
        useCanvasStore.getState().setWhiteboardOpen(false, true);
        continue;
      }
      useCanvasStore.getState().setWhiteboardOpen(true, true);
      if (action.type === 'wb_open') { this.ensureWhiteboardPageKey(action.id); continue; }
      if (action.type === 'wb_clear') {
        this.retainCurrentWhiteboard(true);
        this.stageAPI.whiteboard.update({ elements: [] }, wb.data.id);
        this.startWhiteboardPage(action.id);
        useCanvasStore.getState().setWhiteboardClearing(false);
      } else if (action.type === 'wb_delete') {
        this.stageAPI.whiteboard.deleteElement(action.elementId, wb.data.id);
      } else if (action.type === 'wb_edit_code') {
        const element = this.stageAPI.whiteboard.getElement(action.elementId, wb.data.id).data;
        if (element?.type === 'code') {
          this.stageAPI.whiteboard.updateElement(editWhiteboardCodeElement(element, action), wb.data.id);
        }
      } else {
        this.ensureWhiteboardPageKey(action.id);
        const element = whiteboardActionToElement(action);
        if (element) this.stageAPI.whiteboard.addElement(element, wb.data.id);
      }
    }
  }

  private async waitForWhiteboardVisual(ms: number): Promise<void> {
    await delay(ms);
  }

  /** Schedule a token-guarded clear so an old timer cannot erase a newer cue. */
  private scheduleLaserClear(duration: number): void {
    if (this.effectTimer) {
      clearTimeout(this.effectTimer);
    }
    const generation = this.effectGeneration;
    this.effectTimerStartedAt = Date.now();
    this.effectTimerRemaining = duration;
    this.effectTimer = setTimeout(() => {
      if (generation !== this.effectGeneration) return;
      useCanvasStore.getState().clearAllEffects();
      this.effectTimer = null;
      this.activeEffect = null;
      this.effectTimerRemaining = 0;
    }, duration);
  }

  // ==================== Fire-and-forget ====================

  private executeSpotlight(action: SpotlightAction): void {
    this.replaceEffect(action);
  }

  private executeLaser(action: LaserAction): void {
    const previousTarget = this.activeEffect?.type === 'laser'
      ? {
          elementId: this.activeEffect.elementId,
          selector: this.activeEffect.selector,
        }
      : undefined;
    this.replaceEffect(action, previousTarget);
  }

  private replaceEffect(
    action: SpotlightAction | LaserAction,
    previousTarget?: { elementId: string; selector?: LaserAction['selector'] },
  ): void {
    if (this.effectTimer) clearTimeout(this.effectTimer);
    this.effectTimer = null;
    this.effectGeneration++;
    this.activeEffect = { ...action };
    this.effectTimerRemaining = action.type === 'laser'
      && !(action as RuntimeLaserAction).timelineControlled
      ? laserDuration(action)
      : 0;
    this.renderEffect(action, previousTarget);
    if (action.type === 'laser' && !(action as RuntimeLaserAction).timelineControlled) {
      this.scheduleLaserClear(this.effectTimerRemaining);
    }
  }

  private renderEffect(
    action: SpotlightAction | LaserAction,
    previousTarget?: { elementId: string; selector?: LaserAction['selector'] },
  ): void {
    if (action.type === 'spotlight') {
      useCanvasStore.getState().setSpotlight(action.elementId, {
        dimness: action.dimOpacity ?? 0.5,
        selector: action.selector,
      });
      return;
    }
    useCanvasStore.getState().setLaser(action.elementId, {
      color: action.color ?? '#ff0000',
      duration: laserDuration(action),
      selector: action.selector,
      waypoints: action.waypoints,
      previousTarget,
      transitionDurationMs: previousTarget ? 150 : 0,
    });
  }

  // ==================== Synchronous — Speech ====================

  private async executeSpeech(action: SpeechAction): Promise<void> {
    if (!this.audioPlayer) return;
    return new Promise<void>((resolve) => {
      this.audioPlayer!.onEnded(() => resolve());
      this.audioPlayer!.play(action.audioId || '', action.audioUrl)
        .then((audioStarted) => {
          if (!audioStarted) resolve();
        })
        .catch(() => resolve());
    });
  }

  // ==================== Synchronous — Video ====================

  private async executePlayVideo(action: PlayVideoAction): Promise<void> {
    // Resolve the video element to a generated media reference.
    // action.elementId is the slide element ID (e.g. video_abc123), but the media
    // store is keyed by generated media refs, so we need to bridge the two.
    const placeholderId = this.resolveMediaPlaceholderId(action.elementId);

    if (placeholderId) {
      const task = useMediaGenerationStore.getState().getTask(placeholderId);
      if (task && task.status !== 'done') {
        // Wait for media to be ready (or fail)
        await new Promise<void>((resolve) => {
          const unsubscribe = useMediaGenerationStore.subscribe((state) => {
            const t = state.tasks[placeholderId];
            if (!t || t.status === 'done' || t.status === 'failed') {
              unsubscribe();
              resolve();
            }
          });
          // Check again in case it resolved between getState and subscribe
          const current = useMediaGenerationStore.getState().tasks[placeholderId];
          if (!current || current.status === 'done' || current.status === 'failed') {
            unsubscribe();
            resolve();
          }
        });

        // If failed, skip playback
        if (useMediaGenerationStore.getState().tasks[placeholderId]?.status === 'failed') {
          return;
        }
      }
    }

    useCanvasStore.getState().playVideo(action.elementId);

    // Wait until the video finishes playing, with a safety timeout to prevent
    // the playback engine from hanging indefinitely if the video element is
    // invalid or the state change is missed.
    return new Promise<void>((resolve) => {
      const MAX_VIDEO_WAIT_MS = 5 * 60 * 1000; // 5 minutes
      const timeout = setTimeout(() => {
        unsubscribe();
        log.warn(`[playVideo] Timeout waiting for video ${action.elementId} to finish`);
        resolve();
      }, MAX_VIDEO_WAIT_MS);
      const unsubscribe = useCanvasStore.subscribe((state) => {
        if (state.playingVideoElementId !== action.elementId) {
          clearTimeout(timeout);
          unsubscribe();
          resolve();
        }
      });
      if (useCanvasStore.getState().playingVideoElementId !== action.elementId) {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    });
  }

  // ==================== Helpers — Media Resolution ====================

  /**
   * Look up a video/image element's generated media reference in the current stage's scenes.
   * Returns mediaRef first, then legacy src if it's a media placeholder ID.
   */
  private resolveMediaPlaceholderId(elementId: string): string | null {
    const { scenes, currentSceneId } = this.stageStore.getState();

    // Search current scene first for efficiency, then remaining scenes
    const orderedScenes = currentSceneId
      ? [
          scenes.find((s) => s.id === currentSceneId),
          ...scenes.filter((s) => s.id !== currentSceneId),
        ]
      : scenes;

    for (const scene of orderedScenes) {
      if (!scene || scene.type !== 'slide') continue;
      const elements = (
        scene.content as {
          canvas?: { elements?: Array<{ id: string; src?: string; mediaRef?: string }> };
        }
      )?.canvas?.elements;
      if (!Array.isArray(elements)) continue;
      const el = elements.find((e: { id: string }) => e.id === elementId);
      if (el && typeof el.mediaRef === 'string') {
        return el.mediaRef;
      }
      if (el && typeof el.src === 'string' && isMediaPlaceholder(el.src)) {
        return el.src;
      }
    }
    return null;
  }

  // ==================== Synchronous — Whiteboard ====================

  private getActiveWhiteboard() {
    return this.stageAPI.whiteboard.get(
      whiteboardIdForScene(this.stageStore.getState().currentSceneId),
    );
  }

  private whiteboardScope() {
    const { stage, currentSceneId, scenes } = this.stageStore.getState();
    return stage?.id && currentSceneId ? { stageId: stage.id, sceneId: currentSceneId,
      fallbackTitle: scenes.find((scene) => scene.id === currentSceneId)?.title } : null;
  }

  private ensureWhiteboardPageKey(key: string): void {
    const scope = this.whiteboardScope();
    if (!scope) return;
    const pages = useWhiteboardPagesStore.getState();
    pages.setActiveStage(scope.stageId);
    if (!pages.getCurrentPageKey(scope.stageId, scope.sceneId)) pages.startPage(scope.stageId, scope.sceneId, key);
  }

  private startWhiteboardPage(key: string): void {
    const scope = this.whiteboardScope();
    if (scope) useWhiteboardPagesStore.getState().startPage(scope.stageId, scope.sceneId, key);
  }

  private retainCurrentWhiteboard(completed: boolean): void {
    const scope = this.whiteboardScope();
    if (!scope) return;
    const board = this.stageStore.getState().stage?.whiteboard?.find((entry) => entry.id === whiteboardIdForScene(scope.sceneId));
    if (board) useWhiteboardPagesStore.getState().retainCurrentPage({ ...scope, elements: board.elements, completed });
  }

  /** Auto-open the whiteboard if it's not already open */
  private async ensureWhiteboardOpen(): Promise<void> {
    if (!useCanvasStore.getState().whiteboardOpen) {
      await this.executeWbOpen();
    }
  }

  private async executeWbOpen(): Promise<void> {
    // Ensure a whiteboard exists
    this.getActiveWhiteboard();
    useCanvasStore.getState().setWhiteboardOpen(true);
    // Wait for open animation to complete (slow spring: stiffness 120, damping 18, mass 1.2)
    await this.waitForWhiteboardVisual(2000);
  }

  private async executeWbDraw(action: WhiteboardDrawAction): Promise<void> {
    const wb = this.getActiveWhiteboard();
    if (!wb.success || !wb.data) return;

    const element = whiteboardActionToElement(action);
    if (!element) return;
    // The Stage API resolves attachment points against the current native
    // elements and replaces an existing stable element ID in place.
    this.stageAPI.whiteboard.addElement(element, wb.data.id);
    const animMs = element.type === 'code'
      ? Math.min(800 + element.lines.length * 50, 3000)
      : 800;
    await this.waitForWhiteboardVisual(animMs);
  }

  private async executeWbEditCode(action: WbEditCodeAction): Promise<void> {
    const wb = this.getActiveWhiteboard();
    if (!wb.success || !wb.data) return;
    const result = this.stageAPI.whiteboard.getElement(action.elementId, wb.data.id);
    if (!result.success || result.data?.type !== 'code') return;
    const updated = editWhiteboardCodeElement(result.data, action);
    if (updated === result.data) return;
    this.stageAPI.whiteboard.updateElement(updated, wb.data.id);
    await this.waitForWhiteboardVisual(600);
  }

  private async executeWbDelete(action: WbDeleteAction): Promise<void> {
    const wb = this.getActiveWhiteboard();
    if (!wb.success || !wb.data) return;

    this.stageAPI.whiteboard.deleteElement(action.elementId, wb.data.id);
    await this.waitForWhiteboardVisual(300);
  }

  private async executeWbClear(pageKey: string): Promise<void> {
    const wb = this.getActiveWhiteboard();
    if (!wb.success || !wb.data) return;

    const elementCount = wb.data.elements?.length || 0;
    if (elementCount === 0) { this.startWhiteboardPage(pageKey); return; }
    this.retainCurrentWhiteboard(true);
    const version = this.whiteboardVersion;
    const scope = this.whiteboardScope();

    // Timeline restoration must not pollute the learner's manual undo history.
    useWhiteboardHistoryStore.getState().pushSnapshot(wb.data.elements!);

    // Trigger cascade exit animation
    useCanvasStore.getState().setWhiteboardClearing(true);

    // Wait for cascade: base 380ms + 55ms per element, capped at 1400ms
    const animMs = Math.min(380 + elementCount * 55, 1400);
    await this.waitForWhiteboardVisual(animMs);
    if (version !== this.whiteboardVersion || this.whiteboardScope()?.stageId !== scope?.stageId
      || this.whiteboardScope()?.sceneId !== scope?.sceneId) return;

    // Actually remove elements
    this.stageAPI.whiteboard.update({ elements: [] }, wb.data.id);
    this.startWhiteboardPage(pageKey);
    useCanvasStore.getState().setWhiteboardClearing(false);
  }

  private async executeWbClose(): Promise<void> {
    this.retainCurrentWhiteboard(true);
    useCanvasStore.getState().setWhiteboardOpen(false);
    // Wait for close animation (500ms ease-out tween)
    await this.waitForWhiteboardVisual(700);
  }

  // ==================== Widget Actions ====================

  /** Send message to widget iframe */
  private sendWidgetMessage(type: string, payload: Record<string, unknown>): void {
    if (this.widgetMessageCallback) {
      this.widgetMessageCallback(type, payload);
    } else {
      log.warn(`Widget message callback not set, cannot send: ${type}`);
    }
  }

  /** Execute widget highlight action (quick visual change) */
  private async executeWidgetHighlight(action: WidgetHighlightAction): Promise<void> {
    this.sendWidgetMessage('HIGHLIGHT_ELEMENT', {
      target: action.target,
      content: action.content,
    });
    // Quick delay for visual effect
    await delay(300);
  }

  /** Execute widget setState action */
  private async executeWidgetSetState(action: WidgetSetStateAction): Promise<void> {
    this.sendWidgetMessage('SET_WIDGET_STATE', { state: action.state, content: action.content });
    // Quick delay for state change to propagate
    await delay(300);
  }

  /** Execute widget annotation action */
  private async executeWidgetAnnotation(action: WidgetAnnotationAction): Promise<void> {
    this.sendWidgetMessage('ANNOTATE_ELEMENT', {
      target: action.target,
      content: action.content,
    });
    await delay(300);
  }

  /** Execute widget reveal action */
  private async executeWidgetReveal(action: WidgetRevealAction): Promise<void> {
    this.sendWidgetMessage('REVEAL_ELEMENT', { target: action.target, content: action.content });
    await delay(300);
  }
}
