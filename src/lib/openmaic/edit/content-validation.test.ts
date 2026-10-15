import { describe, expect, it } from 'vitest';
import type { Action } from '@openmaic/lib/types/action';
import type { Scene } from '@openmaic/lib/types/stage';
import { sceneHasIssues, validateActions, validateScene } from './content-validation';

const action = (value: Record<string, unknown>): Action => value as unknown as Action;
const scene = (actions?: Action[]): Scene => ({ id: 'scene', type: 'slide', actions }) as Scene;

describe('editor content validation', () => {
  it('accepts narration mixed with activity, reflection and transition waits without changing actions', () => {
    const actions = [
      action({ id: 'intro', type: 'speech', text: '先观察图中的关系。' }),
      action({ id: 'activity', type: 'speech', text: '', activityPauseSec: 90, activityPausePurpose: 'interaction' }),
      action({ id: 'quiz-submit', type: 'speech', text: '', activityPauseSec: 60, activityPausePurpose: 'quiz-submit' }),
      action({ id: 'quiz-review', type: 'speech', text: '', activityPauseSec: 30, activityPausePurpose: 'quiz' }),
      action({ id: 'reflection', type: 'speech', text: '  ', timelinePauseSec: 12.5, timelinePausePurpose: 'learner-reflection' }),
      action({ id: 'transition', type: 'speech', text: '', timelinePauseSec: 0.25, timelinePausePurpose: 'page-transition' }),
      action({ id: 'target', type: 'laser', elementId: 'diagram' }),
      action({ id: 'outro', type: 'speech', text: '继续下一部分。' }),
    ];
    const before = structuredClone(actions);

    expect(validateActions(actions)).toEqual([]);
    expect(validateScene(scene(actions))).toEqual([]);
    expect(sceneHasIssues(scene(actions))).toBe(false);
    expect(actions).toEqual(before);
  });

  it.each(['activityPauseSec', 'timelinePauseSec'])('rejects invalid %s on an empty narration action', (field) => {
    const invalidValues = [undefined, null, 0, -1, NaN, Infinity, -Infinity, '30'];
    for (const value of invalidValues) {
      const empty = action({ id: 'empty', type: 'speech', text: '', [field]: value });
      expect(validateActions([empty]), `${field}=${String(value)}`).toEqual([
        { kind: 'emptySpeech', actionId: 'empty' },
      ]);
    }
  });

  it('accepts a valid wait when the other pause field is invalid', () => {
    expect(validateActions([
      action({ id: 'activity', type: 'speech', text: '', activityPauseSec: 30, timelinePauseSec: NaN }),
      action({ id: 'timeline', type: 'speech', text: '', activityPauseSec: Infinity, timelinePauseSec: 2 }),
    ])).toEqual([]);
  });

  it('keeps genuine empty narration, unbound cues and empty discussion diagnoses in action order', () => {
    expect(validateActions([
      action({ id: 'empty', type: 'speech', text: ' \n ' }),
      action({ id: 'missing', type: 'speech' }),
      action({ id: 'laser', type: 'laser', elementId: '  ', activityPauseSec: 30 }),
      action({ id: 'spotlight', type: 'spotlight', elementId: '' }),
      action({ id: 'discussion', type: 'discussion', topic: '\t' }),
    ])).toEqual([
      { kind: 'emptySpeech', actionId: 'empty' },
      { kind: 'emptySpeech', actionId: 'missing' },
      { kind: 'unboundCue', actionId: 'laser' },
      { kind: 'unboundCue', actionId: 'spotlight' },
      { kind: 'emptyDiscussion', actionId: 'discussion' },
    ]);
  });

  it('continues to diagnose scenes with no actions', () => {
    expect(validateScene(scene())).toEqual([{ kind: 'emptyActions' }]);
    expect(sceneHasIssues(scene([]))).toBe(true);
  });
});
