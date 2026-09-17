/**
 * Playback Types - Types for lecture playback and live discussion engine
 */

import type { PlaybackSnapshot } from '@openmaic/lib/utils/playback-storage';
import type { LaserWaypoint, VisualTargetSelector } from '@openmaic/lib/types/action';

export type { PlaybackSnapshot };

/** Visual effects (for onEffectFire callback) */
export type Effect =
  | {
      kind: 'spotlight';
      targetId: string;
      selector?: VisualTargetSelector;
      speechId?: string;
      endSpeechId?: string;
      dimOpacity?: number;
    }
  | {
      kind: 'laser';
      targetId: string;
      selector?: VisualTargetSelector;
      waypoints?: LaserWaypoint[];
      speechId?: string;
      color?: string;
      duration?: number;
    };

/** Engine mode state machine */
export type EngineMode = 'idle' | 'playing' | 'paused' | 'live';

/** Discussion topic state */
export type TopicState = 'active' | 'pending' | 'closed';

export type ActivityPurpose = 'quiz' | 'interaction';
export type ActivityCompletionReason = 'timeout' | 'user';

export interface ActivityGate {
  sceneId: string;
  purpose: ActivityPurpose;
  durationSec: number;
}

/** Trigger event (for proactive discussion card) */
export interface TriggerEvent {
  id: string;
  question: string;
  prompt?: string;
  agentId?: string;
}

/** Playback engine callbacks */
export interface PlaybackEngineCallbacks {
  onModeChange?: (mode: EngineMode) => void;
  onSceneChange?: (sceneId: string) => void;
  onSpeechStart?: (
    text: string,
    cue?: { sceneId: string; actionIndex: number },
  ) => void;
  /** Reading position within the active lecture speech, normalized to 0-1. */
  onSpeechProgress?: (progress: number) => void;
  onSpeechEnd?: () => void;
  onError?: (error: Error) => void;
  onTextDelta?: (content: string) => void;
  onSpeakerChange?: (role: string) => void;
  onEffectFire?: (effect: Effect) => void;
  onActivityStart?: (activity: ActivityGate) => void;
  onActivityComplete?: (activity: ActivityGate, reason: ActivityCompletionReason) => void;

  // Proactive discussion
  onProactiveShow?: (trigger: TriggerEvent) => void;
  onProactiveHide?: () => void;

  // Discussion lifecycle
  onDiscussionConfirmed?: (topic: string, prompt?: string, agentId?: string) => void;
  onDiscussionEnd?: () => void;
  onUserInterrupt?: (text: string) => void;

  // Topic / Transcript
  onTopicStart?: (type: 'lecture' | 'discussion', title: string) => void;
  onTopicAppend?: (role: string, text: string) => void;
  onTopicEnd?: () => void;

  // Progress tracking (for persistence)
  onProgress?: (snapshot: PlaybackSnapshot) => void;

  /** Check if a given agent is in the user's selected list (for skipping discussion actions) */
  isAgentSelected?: (agentId: string) => boolean;

  /** Get current playback speed multiplier (e.g. 1, 1.5, 2) */
  getPlaybackSpeed?: () => number;

  onComplete?: () => void;
}
