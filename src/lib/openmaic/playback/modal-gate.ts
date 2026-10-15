import type { PlaybackModalBlockDetail } from './activity-events';
import type { EngineMode } from './types';

interface ModalEngine {
  getMode(): EngineMode;
  pause(): void;
  resume(): void;
}

interface ModalAudio {
  isPlaying(): boolean;
  hasActiveAudio(): boolean;
  pause(): void;
  resume(): void;
}

export type PlaybackModalGateState<T> = {
  sources: ReadonlySet<string>;
  restore: { engine: T; sceneId: string; audioWasPlaying: boolean } | null;
};

export function createPlaybackModalGateState<T>(): PlaybackModalGateState<T> {
  return { sources: new Set(), restore: null };
}

/** Pure state projection; only an opted-in, unchanged lecture may resume. */
export function transitionPlaybackModalGate<T>(
  state: PlaybackModalGateState<T>,
  detail: PlaybackModalBlockDetail,
  context: { engine: T | null; sceneId: string | null; mode: EngineMode; active: boolean; audioPlaying: boolean },
): { state: PlaybackModalGateState<T>; pause: boolean; resume: boolean; resumeAudio: boolean } {
  if (!detail.source) return { state, pause: false, resume: false, resumeAudio: false };
  if (detail.blocked) {
    const sources = new Set(state.sources);
    sources.add(detail.source);
    let restore = state.restore;
    if (!state.sources.size && detail.restorePlayback && context.engine && context.sceneId
      && context.mode === 'playing' && context.active) {
      restore = { engine: context.engine, sceneId: context.sceneId, audioWasPlaying: context.audioPlaying };
    }
    // Other overlays retain their established requirement to continue manually.
    if (!detail.restorePlayback) restore = null;
    return { state: { sources, restore }, pause: true, resume: false, resumeAudio: false };
  }
  if (!state.sources.has(detail.source)) return { state, pause: false, resume: false, resumeAudio: false };
  const sources = new Set(state.sources);
  sources.delete(detail.source);
  if (sources.size) return { state: { sources, restore: state.restore }, pause: false, resume: false, resumeAudio: false };
  const restore = state.restore;
  const resume = Boolean(restore && restore.engine === context.engine && restore.sceneId === context.sceneId
    && context.mode === 'paused' && context.active);
  return { state: { sources, restore: null }, pause: false, resume,
    resumeAudio: resume && Boolean(restore?.audioWasPlaying) };
}

/** Apply the projection to the actual media as well as the lecture state machine. */
export function applyPlaybackModalBlock<T extends ModalEngine>(
  state: PlaybackModalGateState<T>,
  detail: PlaybackModalBlockDetail,
  context: { engine: T | null; sceneId: string | null; active: boolean; audio: ModalAudio },
): { state: PlaybackModalGateState<T>; paused: boolean; resumed: boolean } {
  const transition = transitionPlaybackModalGate(state, detail, {
    ...context, mode: context.engine?.getMode() ?? 'idle', audioPlaying: context.audio.isPlaying(),
  });
  if (transition.pause) {
    const mode = context.engine?.getMode();
    if (mode === 'playing' || mode === 'live') context.engine?.pause();
    // Engine.pause intentionally skips media while showing a trigger card.
    // A modal must also freeze that media and cancel pending metadata starts.
    context.audio.pause();
  }
  if (transition.resume) {
    context.engine?.resume();
    if (transition.resumeAudio && context.engine?.getMode() === 'playing'
      && context.audio.hasActiveAudio() && !context.audio.isPlaying()) context.audio.resume();
  }
  return { state: transition.state, paused: transition.pause, resumed: transition.resume };
}
