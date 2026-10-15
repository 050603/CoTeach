import { describe, expect, it } from 'vitest';
import type { Action } from '@openmaic/lib/types/action';
import { getActionTriggerDiagnostic, isActivityPauseAction } from './action-trigger-description';

function action(value: Record<string, unknown>): Action {
  return value as unknown as Action;
}

describe('getActionTriggerDiagnostic', () => {
  it('marks the first action as scene-triggered and later actions as sequential', () => {
    expect(getActionTriggerDiagnostic(action({ id: 'a', type: 'speech', text: 'Hello' }), 0)).toMatchObject({
      trigger: 'sceneStart',
      completion: 'speechEnded',
    });
    expect(getActionTriggerDiagnostic(action({ id: 'b', type: 'speech', text: 'Next' }), 1)).toMatchObject({
      trigger: 'previousCompleted',
      completion: 'speechEnded',
    });
  });

  it('describes an activity gate as event-driven with an explicit safety timeout', () => {
    const gate = action({
      id: 'gate',
      type: 'speech',
      text: '',
      activityPauseSec: 90,
      activityPausePurpose: 'interaction',
    });

    expect(isActivityPauseAction(gate)).toBe(true);
    expect(getActionTriggerDiagnostic(gate, 1)).toEqual({
      trigger: 'previousCompleted',
      completion: 'activityCompleted',
      fallbackSec: 90,
      purpose: 'interaction',
    });
  });

  it.each(['learner-reflection', 'page-transition'])('describes a %s pause as a timed wait', (purpose) => {
    const pause = action({ id: 'pause', type: 'speech', text: '', timelinePauseSec: 2.5, timelinePausePurpose: purpose });
    expect(getActionTriggerDiagnostic(pause, 1)).toEqual({
      trigger: 'previousCompleted',
      completion: 'timelinePauseEnded',
      durationSec: 2.5,
      purpose,
    });
    expect(isActivityPauseAction(pause)).toBe(false);
  });

  it('uses timeline timing when legacy actions have both pause fields', () => {
    expect(getActionTriggerDiagnostic(action({
      id: 'pause', type: 'speech', text: '', timelinePauseSec: 2, activityPauseSec: 30,
    }), 0)).toMatchObject({ completion: 'timelinePauseEnded', durationSec: 2 });
  });

  it.each(['activityPauseSec', 'timelinePauseSec'])('does not describe invalid %s as a wait', (field) => {
    for (const value of [0, -1, NaN, Infinity, -Infinity, '30']) {
      const invalid = action({ id: 'empty', type: 'speech', text: '', [field]: value });
      expect(getActionTriggerDiagnostic(invalid, 0), `${field}=${String(value)}`).toEqual({
        trigger: 'sceneStart', completion: 'speechEnded',
      });
      expect(isActivityPauseAction(invalid)).toBe(false);
    }
  });

  it.each([
    ['spotlight', 'immediate'],
    ['laser', 'immediate'],
    ['widget_highlight', 'widgetSettled'],
    ['widget_setState', 'widgetSettled'],
    ['widget_annotation', 'widgetSettled'],
    ['widget_reveal', 'widgetSettled'],
    ['discussion', 'discussionConfirmed'],
    ['play_video', 'videoEnded'],
    ['wb_draw_text', 'whiteboardFinished'],
  ] as const)('describes %s completion as %s', (type, completion) => {
    expect(getActionTriggerDiagnostic(action({ id: type, type }), 1).completion).toBe(completion);
  });
});
