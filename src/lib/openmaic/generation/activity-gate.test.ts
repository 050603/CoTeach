import { describe, expect, it } from 'vitest';
import type { Action } from '@openmaic/lib/types/action';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import {
  addPageTimingPauses,
  addStudentActivityPause,
  normalizeSlideActivityPause,
  normalizeStudentActivityPause,
} from './activity-gate';

describe('addStudentActivityPause', () => {
  it('waits for the learner before automatic widget demonstrations', () => {
    const outline = {
      type: 'interactive',
      timingPlan: { studentActivitySec: 90 },
    } as SceneOutline;
    const actions = [
      { id: 'intro', type: 'speech', text: '先观察演示' },
      { id: 'demo', type: 'widget_setState', state: { speed: 2 } },
      { id: 'feedback', type: 'speech', text: '总结你的发现' },
    ] as Action[];

    const result = addStudentActivityPause(outline, actions);

    expect(result.map((action) => action.id)).toEqual([
      'intro',
      expect.stringMatching(/^activity_pause_/),
      'demo',
      'feedback',
    ]);
  });

  it('adds a closing feedback line when the generated script only has an introduction', () => {
    const outline = {
      type: 'quiz',
      timingPlan: { studentActivitySec: 60 },
    } as SceneOutline;
    const result = addStudentActivityPause(outline, [
      { id: 'intro', type: 'speech', text: '请完成测验' },
    ] as Action[]);

    expect(result).toHaveLength(3);
    expect(result[1]).toMatchObject({
      type: 'speech',
      activityPausePurpose: 'quiz',
      activityPauseSec: 60,
    });
    expect(result[2]).toMatchObject({ type: 'speech', title: '测验反馈与过渡' });
  });

  it('migrates an existing late gate ahead of state-changing widget actions', () => {
    const legacyActions = [
      { id: 'intro', type: 'speech', text: '先观察' },
      { id: 'gate', type: 'speech', text: '', activityPauseSec: 90, activityPausePurpose: 'interaction' },
      { id: 'demo', type: 'widget_setState', state: { speed: 2 } },
      { id: 'feedback', type: 'speech', text: '现在请你操作' },
    ] as Action[];

    expect(normalizeStudentActivityPause(legacyActions).map((action) => action.id)).toEqual([
      'intro', 'gate', 'demo', 'feedback',
    ]);
  });

  it('keeps a control highlight before the activity gate and clamps unsafe waits', () => {
    const legacyActions = [
      { id: 'intro', type: 'speech', text: '请拖动滑块并观察结果' },
      { id: 'focus', type: 'widget_highlight', target: '#speed-slider' },
      { id: 'demo', type: 'widget_reveal', target: '#answer' },
      { id: 'gate', type: 'speech', text: '', activityPauseSec: 5, activityPausePurpose: 'interaction' },
      { id: 'feedback', type: 'speech', text: '比较你的结果' },
    ] as Action[];

    const result = normalizeStudentActivityPause(legacyActions);

    expect(result.map((action) => action.id)).toEqual([
      'intro', 'focus', 'gate', 'demo', 'feedback',
    ]);
    expect(result[2]).toMatchObject({ activityPauseSec: 30 });
  });

  it('preserves a modeled student task longer than the legacy global cap', () => {
    const outline = {
      type: 'interactive',
      timingPlan: { studentActivitySec: 2400 },
    } as SceneOutline;

    const result = addStudentActivityPause(outline, [
      { id: 'intro', type: 'speech', text: 'Complete the multi-step task.' },
      { id: 'feedback', type: 'speech', text: 'Review the result.' },
    ] as Action[]);

    expect(result[1]).toMatchObject({
      activityPauseSec: 2400,
      activityPausePurpose: 'interaction',
      activityPauseSource: 'page-timing',
    });
  });

  it('preserves an explicitly planned short learner task instead of padding the page', () => {
    const outline = {
      type: 'interactive',
      timingPlan: { studentActivitySec: 12 },
    } as SceneOutline;

    const result = addStudentActivityPause(outline, [
      { id: 'intro', type: 'speech', text: 'Make one selection.' },
      { id: 'feedback', type: 'speech', text: 'Check the result.' },
    ] as Action[]);

    expect(result[1]).toMatchObject({
      activityPauseSec: 12,
      activityPauseSource: 'page-timing',
    });
  });

  it('keeps slide reading time passive and after all narration', () => {
    const outline = {
      type: 'slide',
      timingPlan: { studentActivitySec: 19, transitionSec: 5 },
    } as SceneOutline;

    const result = addPageTimingPauses(outline, [
      { id: 'intro', type: 'speech', text: '先介绍问题。' },
      { id: 'focus', type: 'spotlight', elementId: 'answer' },
      { id: 'explanation', type: 'speech', text: '再完整解释。' },
    ] as Action[]);

    expect(result.map((action) => action.id)).toEqual([
      'intro',
      'focus',
      'explanation',
      expect.stringMatching(/^learner_reflection_/),
      expect.stringMatching(/^page_transition_/),
    ]);
    expect(result[3]).toMatchObject({
      type: 'speech',
      text: '',
      timelinePauseSec: 19,
      timelinePausePurpose: 'learner-reflection',
    });
    expect(result.some((action) => 'activityPauseSec' in action)).toBe(false);
  });

  it('places passive thinking time after the prompt on a variant slide', () => {
    const outline = {
      type: 'slide',
      teachingBrief: {
        pageTask: { caseUse: 'variant' },
      },
      timingPlan: { studentActivitySec: 12, transitionSec: 3 },
    } as SceneOutline;

    const result = addPageTimingPauses(outline, [
      { id: 'prompt', type: 'speech', text: '只改这一项，请先判断主要改变了什么。' },
      { id: 'explanation', type: 'speech', text: '现在说明判断理由。' },
    ] as Action[]);

    expect(result.map((action) => action.id)).toEqual([
      'prompt',
      expect.stringMatching(/^learner_reflection_/),
      'explanation',
      expect.stringMatching(/^page_transition_/),
    ]);
    expect(result[1]).toMatchObject({
      timelinePauseSec: 12,
      timelinePausePurpose: 'learner-reflection',
    });
  });

  it('migrates a persisted slide activity gate behind narration without showing an operation', () => {
    const result = normalizeSlideActivityPause([
      { id: 'intro', type: 'speech', text: '先介绍问题。' },
      {
        id: 'legacy-gate',
        type: 'speech',
        text: '',
        activityPauseSec: 19,
        activityPausePurpose: 'interaction',
        activityPauseSource: 'page-timing',
      },
      { id: 'focus', type: 'spotlight', elementId: 'answer' },
      { id: 'explanation', type: 'speech', text: '再完整解释。' },
      {
        id: 'transition',
        type: 'speech',
        text: '',
        timelinePauseSec: 5,
        timelinePausePurpose: 'page-transition',
      },
    ] as Action[]);

    expect(result.map((action) => action.id)).toEqual([
      'intro',
      'focus',
      'explanation',
      'legacy-gate',
      'transition',
    ]);
    expect(result[3]).toMatchObject({
      timelinePauseSec: 19,
      timelinePausePurpose: 'learner-reflection',
    });
    expect(result[3]).not.toHaveProperty('activityPauseSec');
    expect(result[3]).not.toHaveProperty('activityPausePurpose');
  });

  it('adds a fixed page-transition pause after all generated actions', () => {
    const outline = {
      type: 'slide',
      timingPlan: { studentActivitySec: 0, transitionSec: 4 },
    } as SceneOutline;

    const result = addPageTimingPauses(outline, [
      { id: 'speech', type: 'speech', text: 'Page explanation.' },
      { id: 'focus', type: 'laser', elementId: 'summary' },
    ] as Action[]);

    expect(result.at(-1)).toMatchObject({
      type: 'speech',
      text: '',
      timelinePauseSec: 4,
      timelinePausePurpose: 'page-transition',
    });
  });
});
