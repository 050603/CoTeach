import type { Action } from '@openmaic/lib/types/action';
import { getSpeechPause } from '@openmaic/lib/utils/speech-pause';

export { isActivityPauseAction } from '@openmaic/lib/utils/speech-pause';
export type { ActivityPauseAction } from '@openmaic/lib/utils/speech-pause';

export type ActionTrigger = 'sceneStart' | 'previousCompleted';
export type ActionCompletion =
  | 'speechEnded'
  | 'timelinePauseEnded'
  | 'activityCompleted'
  | 'immediate'
  | 'widgetSettled'
  | 'discussionConfirmed'
  | 'videoEnded'
  | 'whiteboardFinished';

export interface ActionTriggerDiagnostic {
  trigger: ActionTrigger;
  completion: ActionCompletion;
  fallbackSec?: number;
  durationSec?: number;
  purpose?: string;
}

export function getActionTriggerDiagnostic(
  action: Action,
  actionIndex: number,
): ActionTriggerDiagnostic {
  const trigger: ActionTrigger = actionIndex === 0 ? 'sceneStart' : 'previousCompleted';

  const pause = getSpeechPause(action);
  if (pause?.kind === 'timeline') {
    return {
      trigger,
      completion: 'timelinePauseEnded',
      durationSec: pause.seconds,
      purpose: pause.purpose,
    };
  }
  if (pause) {
    return {
      trigger,
      completion: 'activityCompleted',
      fallbackSec: pause.seconds,
      purpose: pause.purpose ?? 'interaction',
    };
  }

  if (action.type === 'speech') return { trigger, completion: 'speechEnded' };
  if (action.type === 'spotlight' || action.type === 'laser') {
    return { trigger, completion: 'immediate' };
  }
  if (action.type.startsWith('widget_')) return { trigger, completion: 'widgetSettled' };
  if (action.type === 'discussion') return { trigger, completion: 'discussionConfirmed' };
  if (action.type === 'play_video') return { trigger, completion: 'videoEnded' };
  return { trigger, completion: 'whiteboardFinished' };
}
