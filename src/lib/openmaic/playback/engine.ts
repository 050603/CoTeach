/**
 * Playback Engine - Unified state machine for lecture playback and live discussion
 *
 * Consumes Scene.actions[] directly via ActionEngine.
 * No intermediate compile step — actions are executed as-is.
 *
 * State machine:
 *
 *                  start()                  pause()
 *   idle ──────────────────→ playing ──────────────→ paused
 *     ▲                         ▲                       │
 *     │                         │  resume()             │
 *     │                         └───────────────────────┘
 *     │
 *     │  handleEndDiscussion()
 *     │                         confirmDiscussion()
 *     │                         / handleUserInterrupt()
 *     │                              │
 *     │                              ▼         pause()
 *     └──────────────────────── live ──────────────→ paused
 *                                 ▲                    │
 *                                 │ resume / user msg  │
 *                                 └────────────────────┘
 */

import type { Scene } from '@openmaic/lib/types/stage';
import type { Action, SpeechAction, DiscussionAction } from '@openmaic/lib/types/action';
import type {
  EngineMode,
  TopicState,
  PlaybackEngineCallbacks,
  PlaybackSnapshot,
  TriggerEvent,
  Effect,
  ActivityGate,
  ActivityPurpose,
  ActivityCompletionReason,
} from './types';
import type { AudioPlayer } from '@openmaic/lib/utils/audio-player';
import { ActionEngine } from '@openmaic/lib/action/engine';
import { resolvePlaybackCursor } from './engine-cursor';
import { useCanvasStore } from '@openmaic/lib/store/canvas';
import { useSettingsStore } from '@openmaic/lib/store/settings';
import { isTTSProviderEnabled } from '@openmaic/lib/audio/provider-enablement';
import { createLogger } from '@openmaic/lib/logger';
import { normalizeStudentActivityPause } from '@openmaic/lib/generation/activity-gate';

export function shouldUseBrowserNativeTtsFallback(options: {
  hasText: boolean;
  ttsEnabled: boolean;
  browserNativeEnabled: boolean;
  speechSynthesisAvailable: boolean;
}): boolean {
  return (
    options.hasText
    && options.ttsEnabled
    && options.browserNativeEnabled
    && options.speechSynthesisAvailable
  );
}

const log = createLogger('PlaybackEngine');

/**
 * If more than 30% of characters are CJK, treat the text as Chinese.
 * Intentionally low: mixed Chinese text often contains punctuation,
 * numbers, and short Latin fragments (e.g. "AI课堂").
 */
const CJK_LANG_THRESHOLD = 0.3;

export class PlaybackEngine {
  private scenes: Scene[] = [];
  private sceneIndex: number = 0;
  private actionIndex: number = 0;
  private mode: EngineMode = 'idle';
  private consumedDiscussions: Set<string> = new Set();

  // Discussion state save
  private savedSceneIndex: number | null = null;
  private savedActionIndex: number | null = null;

  // Discussion topic state
  private currentTopicState: TopicState | null = null;

  // Dependencies
  private audioPlayer: AudioPlayer;
  private actionEngine: ActionEngine;
  private callbacks: PlaybackEngineCallbacks;

  // Scene identity (for snapshot validation)
  private sceneId: string | undefined;

  // Internal state
  private currentTrigger: TriggerEvent | null = null;
  private triggerDelayTimer: ReturnType<typeof setTimeout> | null = null;
  // Reading-time timer for speech actions without pre-generated audio (TTS disabled)
  private speechTimer: ReturnType<typeof setTimeout> | null = null;
  private speechTimerStart: number = 0; // Date.now() when timer was scheduled
  // Browser-native TTS state (Web Speech API)
  private browserTTSActive: boolean = false;
  private browserTTSChunks: string[] = []; // sentence-level chunks for sequential playback
  private browserTTSChunkIndex: number = 0; // current chunk being spoken
  private browserTTSPausedChunks: string[] = []; // remaining chunks saved on pause (for cancel+re-speak)
  private browserTTSTotalChars: number = 0;
  private browserTTSBaseChars: number = 0;
  private browserTTSPausedBaseChars: number = 0;
  private speechTimerRemaining: number = 0; // remaining ms (set on pause)
  private speechTimerIsActivityPause: boolean = false;
  private speechTimerIsTimelinePause: boolean = false;
  private activeActivity: ActivityGate | null = null;
  private seekVersion = 0;
  private pendingSpeechStartRatio = 0;

  constructor(
    scenes: Scene[],
    actionEngine: ActionEngine,
    audioPlayer: AudioPlayer,
    callbacks: PlaybackEngineCallbacks = {},
  ) {
    // Current classrooms may contain the legacy order where platform widget
    // actions perform the task before the student activity gate. Normalize at
    // playback time as well as generation time so the fix applies immediately.
    this.scenes = scenes.map((scene) => (
      scene.type === 'interactive' && scene.actions
        ? { ...scene, actions: normalizeStudentActivityPause(scene.actions) }
        : scene
    ));
    this.sceneId = scenes[0]?.id;
    this.actionEngine = actionEngine;
    this.audioPlayer = audioPlayer;
    this.callbacks = callbacks;
  }

  // ==================== Public API ====================

  /** Get the current engine mode */
  getMode(): EngineMode {
    return this.mode;
  }

  /** Complete the current student activity early. Duplicate/stale events are ignored. */
  completeActivity(sceneId: string, purpose?: ActivityPurpose): boolean {
    const activity = this.activeActivity;
    if (!activity || activity.sceneId !== sceneId) return false;
    if (purpose && activity.purpose !== purpose) return false;
    return this.finishActivity('user');
  }

  /** Export a serializable playback snapshot */
  getSnapshot(): PlaybackSnapshot {
    return {
      sceneIndex: this.sceneIndex,
      actionIndex: this.actionIndex,
      consumedDiscussions: [...this.consumedDiscussions],
      sceneId: this.sceneId,
    };
  }

  /** Restore playback position from a snapshot */
  restoreFromSnapshot(snapshot: PlaybackSnapshot): void {
    this.sceneIndex = snapshot.sceneIndex;
    this.actionIndex = snapshot.actionIndex;
    this.consumedDiscussions = new Set(snapshot.consumedDiscussions);
  }

  /** idle → playing (from beginning) */
  start(): void {
    if (this.mode !== 'idle') {
      log.warn('Cannot start: not idle, current mode:', this.mode);
      return;
    }

    this.sceneIndex = 0;
    this.actionIndex = 0;
    this.setMode('playing');
    this.processNext();
  }

  /** idle → playing (continue from current position, e.g. after discussion end) */
  continuePlayback(): void {
    if (this.mode !== 'idle') {
      log.warn('Cannot continue: not idle, current mode:', this.mode);
      return;
    }
    this.setMode('playing');
    this.processNext();
  }

  /** Restart playback from one exact speech cue in the current scene. */
  playSpeechAt(actionIndex: number, startRatio: number = 0): boolean {
    const scene = this.scenes[0];
    const action = scene?.actions?.[actionIndex];
    if (!action || action.type !== 'speech' || !action.text.trim()) return false;

    this.stop();
    const seekVersion = ++this.seekVersion;
    this.sceneIndex = 0;
    this.actionIndex = actionIndex;
    this.pendingSpeechStartRatio = Math.max(0, Math.min(0.999, startRatio));
    this.setMode('playing');
    void this.actionEngine.restoreWhiteboard((scene.actions ?? []).slice(0, actionIndex))
      .then(() => {
        if (this.mode === 'playing' && this.seekVersion === seekVersion) this.processNext();
      })
      .catch((cause) => {
        if (this.seekVersion !== seekVersion) return;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        log.error('Whiteboard timeline restore failed:', error);
        this.setMode('idle');
        this.callbacks.onError?.(error);
      });
    return true;
  }

  /** playing → paused | live → paused (abort SSE, truncate, topic pending) */
  pause(): void {
    if (this.mode === 'playing') {
      // Cancel pending timers
      if (this.triggerDelayTimer) {
        clearTimeout(this.triggerDelayTimer);
        this.triggerDelayTimer = null;
        // processNext advances the cursor before showing a delayed trigger.
        // Rewind so resume schedules that trigger again instead of skipping it.
        this.actionIndex = Math.max(0, this.actionIndex - 1);
      }
      if (this.speechTimer) {
        // Save remaining time so resume() can reschedule
        this.speechTimerRemaining = Math.max(
          0,
          this.speechTimerRemaining - (Date.now() - this.speechTimerStart),
        );
        clearTimeout(this.speechTimer);
        this.speechTimer = null;
      }
      this.setMode('paused');
      // Freeze TTS — but skip if waiting on ProactiveCard (no active speech)
      if (!this.currentTrigger) {
        if (this.browserTTSActive) {
          // Cancel+re-speak pattern: save remaining chunks for resume.
          // speechSynthesis.pause()/resume() is broken on Firefox, so we
          // cancel now and re-speak from current chunk onward on resume.
          this.browserTTSPausedChunks = this.browserTTSChunks.slice(this.browserTTSChunkIndex);
          this.browserTTSPausedBaseChars =
            this.browserTTSBaseChars +
            this.browserTTSChunks
              .slice(0, this.browserTTSChunkIndex)
              .reduce((total, chunk) => total + chunk.length, 0);
          window.speechSynthesis?.cancel();
          // Note: cancel fires onerror('canceled'), which we ignore (see playBrowserTTSChunk)
        } else if (this.audioPlayer.isPlaying()) {
          this.audioPlayer.pause();
        }
      }
    } else if (this.mode === 'live') {
      this.setMode('paused');
      this.currentTopicState = 'pending';
      // Caller is responsible for aborting SSE
    } else {
      log.warn('Cannot pause: mode is', this.mode);
    }
  }

  /** paused → playing (TTS resume) | paused (in discussion) → live */
  resume(): void {
    if (this.mode !== 'paused') {
      log.warn('Cannot resume: not paused, mode is', this.mode);
      return;
    }

    if (this.currentTopicState === 'pending') {
      // Resume discussion → live
      this.currentTopicState = 'active';
      this.setMode('live');
    } else if (this.currentTrigger) {
      // Waiting on ProactiveCard — just resume mode, don't touch audio
      this.setMode('playing');
    } else {
      // Resume lecture
      this.setMode('playing');
      if (this.browserTTSPausedChunks.length > 0) {
        // Browser TTS was paused via cancel — re-speak remaining chunks
        this.browserTTSActive = true;
        this.browserTTSChunks = this.browserTTSPausedChunks;
        this.browserTTSChunkIndex = 0;
        this.browserTTSBaseChars = this.browserTTSPausedBaseChars;
        this.browserTTSPausedChunks = [];
        this.playBrowserTTSChunk();
      } else if (this.audioPlayer.hasActiveAudio()) {
        // Audio is paused — resume it; TTS onend will call processNext
        this.audioPlayer.resume();
      } else if (this.speechTimerRemaining > 0) {
        // Reading timer was paused — reschedule with remaining time
        this.speechTimerStart = Date.now();
        this.speechTimer = setTimeout(() => {
          if (this.speechTimerIsActivityPause) {
            this.finishActivity('timeout');
          } else if (this.speechTimerIsTimelinePause) {
            this.speechTimer = null;
            this.speechTimerRemaining = 0;
            this.speechTimerIsTimelinePause = false;
            if (this.mode === 'playing') this.processNext();
          } else {
            this.speechTimer = null;
            this.speechTimerRemaining = 0;
            this.callbacks.onSpeechEnd?.();
            if (this.mode === 'playing') this.processNext();
          }
        }, this.speechTimerRemaining);
      } else {
        // TTS finished while paused, continue to next event
        this.processNext();
      }
    }
  }

  /** → idle */
  stop(): void {
    this.seekVersion++;
    // Set mode BEFORE stopping audio to prevent spurious processNext from
    // synchronous onend callbacks (see handleUserInterrupt for details).
    this.setMode('idle');
    this.audioPlayer.stop();
    this.cancelBrowserTTS();
    this.actionEngine.clearEffects();
    if (this.triggerDelayTimer) {
      clearTimeout(this.triggerDelayTimer);
      this.triggerDelayTimer = null;
    }
    if (this.speechTimer) {
      clearTimeout(this.speechTimer);
      this.speechTimer = null;
    }
    this.speechTimerRemaining = 0;
    this.speechTimerIsActivityPause = false;
    this.speechTimerIsTimelinePause = false;
    this.activeActivity = null;
    this.sceneIndex = 0;
    this.actionIndex = 0;
    this.savedSceneIndex = null;
    this.savedActionIndex = null;
    this.currentTopicState = null;
    this.currentTrigger = null;
    this.pendingSpeechStartRatio = 0;
  }

  /** User clicks "Join" on ProactiveCard → save cursor → live */
  confirmDiscussion(): void {
    if (!this.currentTrigger) {
      log.warn('confirmDiscussion called but no trigger');
      return;
    }

    // Mark consumed so it won't re-trigger on replay
    this.consumedDiscussions.add(this.currentTrigger.id);

    // Save lecture state — keep actionIndex as-is (past the discussion).
    // Discussions are placed after all speech actions, so the preceding
    // speech was already fully played; no need to replay it.
    this.savedSceneIndex = this.sceneIndex;
    this.savedActionIndex = this.actionIndex;

    // Enter live mode
    this.currentTopicState = 'active';
    this.setMode('live');

    // Notify callbacks
    this.callbacks.onProactiveHide?.();
    this.callbacks.onDiscussionConfirmed?.(
      this.currentTrigger.question,
      this.currentTrigger.prompt,
      this.currentTrigger.agentId,
    );
    this.currentTrigger = null;
  }

  /** User clicks "Skip" on ProactiveCard → consumed → processNext */
  skipDiscussion(): void {
    if (this.currentTrigger) {
      this.consumedDiscussions.add(this.currentTrigger.id);
      this.currentTrigger = null;
    }
    this.callbacks.onProactiveHide?.();

    if (this.mode === 'playing') {
      this.processNext();
    }
  }

  /** End discussion → restore lecture → idle (user clicks "start" to continue) */
  handleEndDiscussion(): void {
    this.actionEngine.clearEffects();
    this.currentTopicState = 'closed';

    // Close whiteboard if it was open during the discussion
    useCanvasStore.getState().setWhiteboardOpen(false);

    this.callbacks.onDiscussionEnd?.();

    // Restore lecture state
    this.restoreSavedLectureState();

    this.setMode('idle');
  }

  /**
   * Exit live discussion mode after a request failure without treating it as a
   * normal discussion end. The chat session stays retryable; this only restores
   * the playback engine to a coherent non-live state.
   */
  handleDiscussionError(): void {
    const hasSavedLectureState = this.savedSceneIndex !== null && this.savedActionIndex !== null;
    const isLiveTopic =
      this.mode === 'live' || (this.mode === 'paused' && this.currentTopicState === 'pending');

    if (!isLiveTopic && !hasSavedLectureState) {
      return;
    }

    this.actionEngine.clearEffects();
    useCanvasStore.getState().setWhiteboardOpen(false);
    this.currentTopicState = 'closed';
    this.currentTrigger = null;
    this.restoreSavedLectureState();
    this.setMode('idle');
  }

  /** User sends a message during playback → interrupt → live mode */
  handleUserInterrupt(text: string): void {
    if (this.mode === 'playing' || this.mode === 'paused') {
      // Save lecture state BEFORE stopping audio — actionIndex was already
      // incremented by processNext, so subtract 1 to replay the interrupted
      // sentence when resuming.  Guard against overwriting a previously saved
      // position (e.g. live → paused → new message).
      if (this.savedSceneIndex === null) {
        this.savedSceneIndex = this.sceneIndex;
        this.savedActionIndex = Math.max(0, this.actionIndex - 1);
      }

      // Cancel pending trigger delay
      if (this.triggerDelayTimer) {
        clearTimeout(this.triggerDelayTimer);
        this.triggerDelayTimer = null;
      }
    }

    // Set mode BEFORE stopping audio — speechSynthesis.cancel() may fire the
    // onend callback synchronously, and the processNext guard checks
    // `this.mode === 'playing'`.  Setting mode first prevents a spurious
    // processNext that would advance actionIndex past the interrupted speech.
    this.currentTopicState = 'active';
    this.setMode('live');
    this.audioPlayer.stop();
    this.cancelBrowserTTS();
    this.callbacks.onUserInterrupt?.(text);
  }

  /** Whether all remaining actions have been consumed (no speech left to play) */
  isExhausted(): boolean {
    if (this.activeActivity) return false;
    let si = this.sceneIndex;
    let ai = this.actionIndex;
    while (si < this.scenes.length) {
      const actions = this.scenes[si].actions || [];
      while (ai < actions.length) {
        const action = actions[ai];
        // Consumed discussions don't count as remaining work
        if (action.type === 'discussion' && this.consumedDiscussions.has(action.id)) {
          ai++;
          continue;
        }
        return false;
      }
      si++;
      ai = 0;
    }
    return true;
  }

  // ==================== Private ====================

  private setMode(mode: EngineMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.callbacks.onModeChange?.(mode);
  }

  private restoreSavedLectureState(): void {
    if (this.savedSceneIndex !== null && this.savedActionIndex !== null) {
      this.sceneIndex = this.savedSceneIndex;
      this.actionIndex = this.savedActionIndex;
    }
    this.savedSceneIndex = null;
    this.savedActionIndex = null;
  }

  private finishActivity(reason: ActivityCompletionReason): boolean {
    const activity = this.activeActivity;
    if (!activity) return false;

    this.activeActivity = null;
    if (this.speechTimer) {
      clearTimeout(this.speechTimer);
      this.speechTimer = null;
    }
    this.speechTimerRemaining = 0;
    this.speechTimerIsActivityPause = false;
    this.speechTimerIsTimelinePause = false;
    this.callbacks.onActivityComplete?.(activity, reason);
    if (this.mode === 'playing') queueMicrotask(() => this.processNext());
    return true;
  }

  /**
   * Get the current action, or null if playback is complete.
   * Advances sceneIndex automatically when a scene's actions are exhausted.
   * A scene with no actions yields one synthetic dwell beat (so the slide still
   * shows) instead of being skipped — see {@link resolvePlaybackCursor}.
   */
  private getCurrentAction(): { action: Action; sceneId: string } | null {
    const res = resolvePlaybackCursor(this.scenes, this.sceneIndex, this.actionIndex);
    if (!res) return null;
    this.sceneIndex = res.sceneIndex;
    this.actionIndex = res.actionIndex;
    return { action: res.action, sceneId: res.sceneId };
  }

  /**
   * Core processing loop: consume the next action.
   */
  private async processNext(): Promise<void> {
    if (this.mode !== 'playing') return;

    // Check for scene boundary (fire scene change callback at start of each new scene)
    if (this.actionIndex === 0 && this.sceneIndex < this.scenes.length) {
      const scene = this.scenes[this.sceneIndex];
      this.actionEngine.clearEffects();
      this.callbacks.onSceneChange?.(scene.id);
      this.callbacks.onSpeakerChange?.('teacher');
    }

    const current = this.getCurrentAction();
    if (!current) {
      // All scenes complete
      this.actionEngine.clearEffects();
      this.setMode('idle');
      this.callbacks.onComplete?.();
      return;
    }

    const { action, sceneId } = current;

    // Notify progress BEFORE advancing the cursor so the snapshot points at
    // the current action.  On restore the same action will be replayed — this
    // is the desired behaviour for speech (user may have only heard half).
    this.callbacks.onProgress?.(this.getSnapshot());

    this.actionIndex++;

    switch (action.type) {
      case 'speech': {
        const speechAction = action as SpeechAction;
        const speechStartRatio = this.pendingSpeechStartRatio;
        this.pendingSpeechStartRatio = 0;
        const timelinePauseSec = Number(
          (speechAction as SpeechAction & {
            timelinePauseSec?: number;
            timelinePausePurpose?: 'page-transition';
          }).timelinePauseSec,
        );
        if (Number.isFinite(timelinePauseSec) && timelinePauseSec > 0) {
          const pauseMs = timelinePauseSec * 1000;
          this.speechTimerStart = Date.now();
          this.speechTimerRemaining = pauseMs;
          this.speechTimerIsActivityPause = false;
          this.speechTimerIsTimelinePause = true;
          this.speechTimer = setTimeout(() => {
            this.speechTimer = null;
            this.speechTimerRemaining = 0;
            this.speechTimerIsTimelinePause = false;
            if (this.mode === 'playing') this.processNext();
          }, pauseMs);
          break;
        }
        const activityPauseSec = Number(
          (speechAction as SpeechAction & { activityPauseSec?: number }).activityPauseSec,
        );
        if (Number.isFinite(activityPauseSec) && activityPauseSec > 0) {
          const configuredPurpose = (speechAction as SpeechAction & {
            activityPausePurpose?: ActivityPurpose;
          }).activityPausePurpose;
          const sceneType = this.scenes[this.sceneIndex]?.type;
          const purpose: ActivityPurpose =
            configuredPurpose === 'quiz' || configuredPurpose === 'interaction'
              ? configuredPurpose
              : sceneType === 'quiz'
                ? 'quiz'
                : 'interaction';
          const pauseMs = activityPauseSec * 1000;
          this.activeActivity = { sceneId, purpose, durationSec: activityPauseSec };
          this.speechTimerStart = Date.now();
          this.speechTimerRemaining = pauseMs;
          this.speechTimerIsActivityPause = true;
          this.speechTimerIsTimelinePause = false;
          this.speechTimer = setTimeout(() => {
            this.finishActivity('timeout');
          }, pauseMs);
          this.callbacks.onActivityStart?.(this.activeActivity);
          break;
        }
        this.callbacks.onSpeechStart?.(speechAction.text, {
          sceneId,
          actionIndex: this.actionIndex - 1,
        });
        this.callbacks.onSpeechProgress?.(speechStartRatio);

        // onEnded → processNext; if paused, resume() will call processNext
        this.audioPlayer.onEnded(() => {
          this.callbacks.onSpeechProgress?.(1);
          this.callbacks.onSpeechEnd?.();
          if (this.mode === 'playing') {
            this.processNext();
          }
        });

        // Estimated reading time when no pre-generated audio (TTS disabled).
        // CJK text: ~150ms/char (one char ≈ one word).
        // Non-CJK text: ~240ms/word (≈250 WPM).
        // Min 2s. Cancelled on pause; resume() calls processNext directly.
        const scheduleReadingTimer = () => {
          const text = speechAction.text;
          const cjkCount = (
            text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []
          ).length;
          const isCJK = cjkCount > text.length * 0.3;
          const speed = this.callbacks.getPlaybackSpeed?.() ?? 1;
          const rawMs = isCJK
            ? Math.max(2000, text.length * 150)
            : Math.max(2000, text.split(/\s+/).filter(Boolean).length * 240);
          const readingMs = rawMs / speed;
          this.speechTimerStart = Date.now();
          this.speechTimerRemaining = readingMs;
          this.speechTimerIsActivityPause = false;
          this.speechTimerIsTimelinePause = false;
          this.speechTimer = setTimeout(() => {
            this.speechTimer = null;
            this.speechTimerRemaining = 0;
            this.callbacks.onSpeechEnd?.();
            if (this.mode === 'playing') this.processNext();
          }, readingMs);
        };

        // A speech line with no text (e.g. a freshly inserted blank slide's
        // seeded clip, or one the user cleared) has nothing to synthesize —
        // route it straight to the reading timer for a short dwell. Speaking an
        // empty SpeechSynthesisUtterance doesn't reliably fire onend in Chromium,
        // which would hang playback on that slide.
        const hasText = !!speechAction.text.trim();
        const playSpeechFallback = () => {
          const settings = useSettingsStore.getState();
          const browserNativeEnabled = isTTSProviderEnabled(
            'browser-native-tts',
            settings.ttsProvidersConfig?.['browser-native-tts'],
          );
          if (shouldUseBrowserNativeTtsFallback({
            hasText,
            ttsEnabled: settings.ttsEnabled,
            browserNativeEnabled,
            speechSynthesisAvailable: typeof window !== 'undefined' && Boolean(window.speechSynthesis),
          })) {
            this.playBrowserTTS(speechAction);
          } else {
            scheduleReadingTimer();
          }
        };

        this.audioPlayer
          .play(speechAction.audioId || '', speechAction.audioUrl, speechStartRatio)
          .then((audioStarted) => {
            if (!audioStarted) {
              if (this.scenes[this.sceneIndex]?.ttsPolicy === 'target-duration') {
                const error = new Error(`课堂语音资源缺失：${speechAction.id}`);
                log.error(error.message);
                this.setMode('idle');
                this.callbacks.onError?.(error);
                return;
              }
              // Server-generated audio can still be pending when a newly
              // created classroom opens. Fall back to the explicitly enabled
              // browser voice regardless of which server provider is selected.
              playSpeechFallback();
            }
          })
          .catch((err) => {
            log.error('TTS error:', err);
            const error = err instanceof Error ? err : new Error(String(err));
            this.callbacks.onError?.(error);
            // Browser-native TTS is an explicit configured provider, not fake
            // narration. If it is disabled, stop and surface the real media
            // failure instead of silently advancing on a reading timer.
            const settings = useSettingsStore.getState();
            const browserNativeEnabled = isTTSProviderEnabled(
              'browser-native-tts',
              settings.ttsProvidersConfig?.['browser-native-tts'],
            );
            if (browserNativeEnabled) playSpeechFallback();
            else this.setMode('idle');
          });
        break;
      }

      case 'spotlight':
      case 'laser': {
        // Fire-and-forget visual effects via ActionEngine
        void this.executeActionSafely(action);
        this.callbacks.onEffectFire?.({
          kind: action.type,
          targetId: action.elementId,
          ...(action.type === 'spotlight'
            ? { dimOpacity: action.dimOpacity }
            : { color: action.color }),
        } as Effect);
        // Don't block — continue immediately (use queueMicrotask to avoid
        // stack overflow from deep synchronous recursion when many consecutive
        // spotlight/laser actions appear in sequence)
        queueMicrotask(() => this.processNext());
        break;
      }

      case 'discussion': {
        const discussionAction = action as DiscussionAction;
        // Check if already consumed
        if (this.consumedDiscussions.has(discussionAction.id)) {
          this.processNext();
          return;
        }
        // Skip if the discussion's agent isn't in the user's selected list
        if (
          discussionAction.agentId &&
          this.callbacks.isAgentSelected &&
          !this.callbacks.isAgentSelected(discussionAction.agentId)
        ) {
          this.consumedDiscussions.add(discussionAction.id);
          this.processNext();
          return;
        }

        // 3s delay before showing ProactiveCard (allows previous speech to finish naturally)
        const trigger: TriggerEvent = {
          id: discussionAction.id,
          question: discussionAction.topic,
          prompt: discussionAction.prompt,
          agentId: discussionAction.agentId,
        };

        this.triggerDelayTimer = setTimeout(() => {
          this.triggerDelayTimer = null;
          if (this.mode !== 'playing') return; // Cancelled if user paused/stopped
          this.currentTrigger = trigger;
          this.callbacks.onProactiveShow?.(trigger);
          // Engine pauses here — user calls confirmDiscussion() or skipDiscussion()
        }, 3000);
        break;
      }

      case 'play_video':
      case 'wb_open':
      case 'wb_draw_text':
      case 'wb_draw_image':
      case 'wb_draw_shape':
      case 'wb_draw_chart':
      case 'wb_draw_latex':
      case 'wb_draw_table':
      case 'wb_draw_line':
      case 'wb_draw_code':
      case 'wb_edit_code':
      case 'wb_clear':
      case 'wb_delete':
      case 'wb_close':
      case 'widget_highlight':
      case 'widget_setState':
      case 'widget_annotation':
      case 'widget_reveal': {
        // Synchronous actions — await completion, then continue
        await this.executeActionSafely(action);
        if (this.mode === 'playing') {
          this.processNext();
        }
        break;
      }

      default:
        // Unknown action, skip
        this.processNext();
        break;
    }
  }

  private async executeActionSafely(action: Action): Promise<void> {
    try {
      await this.actionEngine.execute(action);
    } catch (error) {
      log.error(`Playback action failed [${action.type}:${action.id}]:`, error);
    }
  }

  // ==================== Browser Native TTS ====================

  /**
   * Split text into sentence-level chunks for sequential playback.
   * Chrome has a bug where utterances >~15s are silently cut off and onend
   * never fires, causing the engine to hang. Chunking avoids this.
   */
  private splitIntoChunks(text: string): string[] {
    // Split on sentence-ending punctuation (Latin + CJK) and newlines
    const chunks = text
      .split(/(?<=[.!?。！？\n])\s*/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (chunks.length > 0) return chunks;
    // Blank/whitespace text → no chunks (so playBrowserTTSChunk finishes cleanly
    // instead of speaking an empty utterance that never fires onend). Otherwise
    // the text had no sentence punctuation — speak it as one chunk.
    return text.trim() ? [text] : [];
  }

  /**
   * Play text using the Web Speech API (browser-native TTS).
   * Splits text into sentence-level chunks to avoid Chrome's ~15s cutoff.
   * Uses cancel+re-speak for pause/resume (Firefox compatibility).
   */
  private playBrowserTTS(speechAction: SpeechAction): void {
    this.browserTTSChunks = this.splitIntoChunks(speechAction.text);
    this.browserTTSChunkIndex = 0;
    this.browserTTSPausedChunks = [];
    this.browserTTSTotalChars = Math.max(
      1,
      this.browserTTSChunks.reduce((total, chunk) => total + chunk.length, 0),
    );
    this.browserTTSBaseChars = 0;
    this.browserTTSPausedBaseChars = 0;
    this.browserTTSActive = true;
    this.playBrowserTTSChunk();
  }

  /** Speak the current chunk; on completion, advance to next or finish. */
  private async playBrowserTTSChunk(): Promise<void> {
    if (this.browserTTSChunkIndex >= this.browserTTSChunks.length) {
      // All chunks done
      this.browserTTSActive = false;
      this.browserTTSChunks = [];
      this.callbacks.onSpeechProgress?.(1);
      this.callbacks.onSpeechEnd?.();
      if (this.mode === 'playing') this.processNext();
      return;
    }

    const settings = useSettingsStore.getState();
    const chunkText = this.browserTTSChunks[this.browserTTSChunkIndex];
    const chunkStart =
      this.browserTTSBaseChars +
      this.browserTTSChunks
        .slice(0, this.browserTTSChunkIndex)
        .reduce((total, chunk) => total + chunk.length, 0);
    const utterance = new SpeechSynthesisUtterance(chunkText);

    // Apply settings
    const speed = this.callbacks.getPlaybackSpeed?.() ?? 1;
    // The course planner sizes narration for the provider's normal rate.
    // Only the student's explicit playback-speed control may alter it here.
    const baseRate = speed;
    utterance.rate = baseRate;
    utterance.volume = settings.ttsMuted ? 0 : (settings.ttsVolume ?? 1);

    // Ensure voices are loaded (Chrome loads them asynchronously)
    const voices = await this.ensureVoicesLoaded();

    // Set voice: try user's configured voice, fall back to auto-detect language
    let voiceFound = false;
    if (settings.ttsVoice && settings.ttsVoice !== 'default') {
      const voice = voices.find((v) => v.voiceURI === settings.ttsVoice);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
        voiceFound = true;
      }
    }
    if (!voiceFound) {
      // No usable voice configured — detect text language so the browser
      // auto-selects an appropriate voice.
      const cjkRatio =
        chunkText.length > 0
          ? (chunkText.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length / chunkText.length
          : 0;
      utterance.lang = cjkRatio > CJK_LANG_THRESHOLD ? 'zh-CN' : 'en-US';
    }

    utterance.onboundary = (event) => {
      const charIndex = Math.max(0, Math.min(chunkText.length, event.charIndex));
      this.callbacks.onSpeechProgress?.(
        Math.min(1, (chunkStart + charIndex) / this.browserTTSTotalChars),
      );
    };

    utterance.onend = () => {
      this.callbacks.onSpeechProgress?.(
        Math.min(1, (chunkStart + chunkText.length) / this.browserTTSTotalChars),
      );
      this.browserTTSChunkIndex++;
      if (this.mode === 'playing') {
        this.playBrowserTTSChunk(); // next chunk
      }
    };

    utterance.onerror = (event) => {
      // 'canceled' is expected when stop/pause is called — not a real error
      if (event.error !== 'canceled') {
        log.warn('Browser TTS chunk error:', event.error);
        // Skip failed chunk, try next
        this.browserTTSChunkIndex++;
        if (this.mode === 'playing') {
          this.playBrowserTTSChunk();
        }
      }
      // On 'canceled': do nothing — pause handler already saved state
    };

    // Chrome bug workaround: cancel() before speak() to clear stale synthesis
    // state that can produce garbled/broken audio output.
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  /**
   * Wait for speechSynthesis voices to load (Chrome loads them asynchronously).
   * Caches result so subsequent calls return immediately.
   */
  private cachedVoices: SpeechSynthesisVoice[] | null = null;
  private async ensureVoicesLoaded(): Promise<SpeechSynthesisVoice[]> {
    if (this.cachedVoices && this.cachedVoices.length > 0) {
      return this.cachedVoices;
    }

    let voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      this.cachedVoices = voices;
      return voices;
    }

    // Chrome: voices load asynchronously — wait for the voiceschanged event
    await new Promise<void>((resolve) => {
      const onVoicesChanged = () => {
        window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
        resolve();
      };
      window.speechSynthesis.addEventListener('voiceschanged', onVoicesChanged);
      // Timeout after 2s to avoid hanging
      setTimeout(() => {
        window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
        resolve();
      }, 2000);
    });

    voices = window.speechSynthesis.getVoices();
    this.cachedVoices = voices;
    return voices;
  }

  /** Cancel any active browser-native TTS */
  private cancelBrowserTTS(): void {
    if (this.browserTTSActive) {
      this.browserTTSActive = false;
      this.browserTTSChunks = [];
      this.browserTTSChunkIndex = 0;
      this.browserTTSPausedChunks = [];
      this.browserTTSTotalChars = 0;
      this.browserTTSBaseChars = 0;
      this.browserTTSPausedBaseChars = 0;
      window.speechSynthesis?.cancel();
    }
  }
}
