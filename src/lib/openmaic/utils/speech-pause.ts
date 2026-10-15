import type { Action, SpeechAction } from '@openmaic/lib/types/action';

export type ActivityPauseAction = SpeechAction & {
  activityPauseSec: number;
  activityPausePurpose?: string;
};

export type TimelinePauseAction = SpeechAction & {
  timelinePauseSec: number;
  timelinePausePurpose?: string;
};

export interface SpeechPause {
  kind: 'activity' | 'timeline';
  seconds: number;
  purpose?: string;
}

const isPositiveDuration = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

export function isActivityPauseAction(action: Action): action is ActivityPauseAction {
  return action.type === 'speech'
    && isPositiveDuration((action as ActivityPauseAction).activityPauseSec);
}

export function isTimelinePauseAction(action: Action): action is TimelinePauseAction {
  return action.type === 'speech'
    && isPositiveDuration((action as TimelinePauseAction).timelinePauseSec);
}

/** Timeline pauses take precedence when legacy data carries both pause fields. */
export function getSpeechPause(action: Action): SpeechPause | null {
  if (isTimelinePauseAction(action)) {
    return { kind: 'timeline', seconds: action.timelinePauseSec, purpose: action.timelinePausePurpose };
  }
  if (isActivityPauseAction(action)) {
    return { kind: 'activity', seconds: action.activityPauseSec, purpose: action.activityPausePurpose };
  }
  return null;
}
