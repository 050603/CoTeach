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

/** Default duration (ms) before fire-and-forget effects auto-clear */
const EFFECT_AUTO_CLEAR_MS = 5000;

/** Callback for sending messages to widget iframe */
export type WidgetMessageCallback = (type: string, payload: Record<string, unknown>) => void;

export class ActionEngine {
  private stageStore: StageStore;
  private stageAPI: ReturnType<typeof createStageAPI>;
  private audioPlayer: AudioPlayer | null;
  private effectTimer: ReturnType<typeof setTimeout> | null = null;
  private widgetMessageCallback: WidgetMessageCallback | null = null;
  private restoringWhiteboard = false;

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
    if (this.effectTimer) {
      clearTimeout(this.effectTimer);
      this.effectTimer = null;
    }
  }

  /**
   * Execute a single action.
   * Fire-and-forget actions return immediately.
   * Synchronous actions return a Promise that resolves when the action is complete.
   */
  async execute(action: Action): Promise<void> {
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
        return this.executeWbClear();
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
    useCanvasStore.getState().clearAllEffects();
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
    this.stageAPI.whiteboard.update({ elements: [] }, wb.data.id);
    useCanvasStore.getState().setWhiteboardClearing(false);
    useCanvasStore.getState().setWhiteboardOpen(false);
    this.restoringWhiteboard = true;
    try {
      for (const action of actions) {
        if (action.type.startsWith('wb_')) await this.execute(action);
      }
    } finally {
      this.restoringWhiteboard = false;
    }
  }

  private async waitForWhiteboardVisual(ms: number): Promise<void> {
    if (!this.restoringWhiteboard) await delay(ms);
  }

  /** Schedule auto-clear for fire-and-forget effects */
  private scheduleEffectClear(): void {
    if (this.effectTimer) {
      clearTimeout(this.effectTimer);
    }
    this.effectTimer = setTimeout(() => {
      useCanvasStore.getState().clearAllEffects();
      this.effectTimer = null;
    }, EFFECT_AUTO_CLEAR_MS);
  }

  // ==================== Fire-and-forget ====================

  private executeSpotlight(action: SpotlightAction): void {
    useCanvasStore.getState().setSpotlight(action.elementId, {
      dimness: action.dimOpacity ?? 0.5,
    });
    this.scheduleEffectClear();
  }

  private executeLaser(action: LaserAction): void {
    useCanvasStore.getState().setLaser(action.elementId, {
      color: action.color ?? '#ff0000',
    });
    this.scheduleEffectClear();
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

  private async executeWbClear(): Promise<void> {
    const wb = this.getActiveWhiteboard();
    if (!wb.success || !wb.data) return;

    const elementCount = wb.data.elements?.length || 0;
    if (elementCount === 0) return;

    // Timeline restoration must not pollute the learner's manual undo history.
    if (!this.restoringWhiteboard) {
      useWhiteboardHistoryStore.getState().pushSnapshot(wb.data.elements!);
    }

    // Trigger cascade exit animation
    if (!this.restoringWhiteboard) useCanvasStore.getState().setWhiteboardClearing(true);

    // Wait for cascade: base 380ms + 55ms per element, capped at 1400ms
    const animMs = Math.min(380 + elementCount * 55, 1400);
    await this.waitForWhiteboardVisual(animMs);

    // Actually remove elements
    this.stageAPI.whiteboard.update({ elements: [] }, wb.data.id);
    useCanvasStore.getState().setWhiteboardClearing(false);
  }

  private async executeWbClose(): Promise<void> {
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
