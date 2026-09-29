export type PlaybackActivityPurpose = 'quiz-submit' | 'quiz' | 'interaction';

export interface PlaybackActivityEventDetail {
  sceneId: string;
  purpose: PlaybackActivityPurpose;
}

export const PLAYBACK_ACTIVITY_COMPLETE_EVENT = 'openmaic:playback-activity-complete';
export const PLAYBACK_ACTIVITY_RESET_EVENT = 'openmaic:playback-activity-reset';
export const PLAYBACK_MODAL_BLOCK_EVENT = 'openmaic:playback-modal-block';

export interface PlaybackModalBlockDetail {
  blocked: boolean;
  source: string;
}

const completedActivities = new Set<string>();

function activityKey(detail: PlaybackActivityEventDetail): string {
  return `${detail.sceneId}:${detail.purpose}`;
}

export function isPlaybackActivityComplete(detail: PlaybackActivityEventDetail): boolean {
  return completedActivities.has(activityKey(detail));
}

function dispatchActivityEvent(type: string, detail: PlaybackActivityEventDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<PlaybackActivityEventDetail>(type, { detail }));
}

export function dispatchPlaybackActivityComplete(detail: PlaybackActivityEventDetail): void {
  completedActivities.add(activityKey(detail));
  dispatchActivityEvent(PLAYBACK_ACTIVITY_COMPLETE_EVENT, detail);
}

export function dispatchPlaybackActivityReset(detail: PlaybackActivityEventDetail): void {
  completedActivities.delete(activityKey(detail));
  dispatchActivityEvent(PLAYBACK_ACTIVITY_RESET_EVENT, detail);
}

export function dispatchPlaybackModalBlock(detail: PlaybackModalBlockDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<PlaybackModalBlockDetail>(PLAYBACK_MODAL_BLOCK_EVENT, { detail }));
}
