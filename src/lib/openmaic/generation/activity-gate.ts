import type { Action } from '@openmaic/lib/types/action';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import { nanoid } from 'nanoid';

type ActivityPauseSpeechAction = Extract<Action, { type: 'speech' }> & {
  activityPauseSec: number;
  activityPausePurpose: 'interaction' | 'quiz-submit' | 'quiz';
  activityPauseSource?: 'page-timing';
  /** Canonical interactive speech is complete before the learner begins. */
  activityPausePosition?: 'after-narration';
};

type TimelinePauseSpeechAction = Extract<Action, { type: 'speech' }> & {
  timelinePauseSec: number;
  timelinePausePurpose: 'page-transition' | 'learner-reflection';
  timelinePauseSource?: 'page-timing';
};

export const MIN_STUDENT_ACTIVITY_SEC = 30;
export const MAX_STUDENT_ACTIVITY_SEC = 1800;

function isActivityPause(action: Action): action is ActivityPauseSpeechAction {
  return action.type === 'speech' && Number.isFinite(
    Number((action as Action & { activityPauseSec?: number }).activityPauseSec),
  ) && Number((action as Action & { activityPauseSec?: number }).activityPauseSec) > 0;
}

function isTimelinePause(action: Action): action is TimelinePauseSpeechAction {
  return action.type === 'speech'
    && (action as Action & { timelinePausePurpose?: unknown }).timelinePausePurpose === 'page-transition'
    && Number.isFinite(
      Number((action as Action & { timelinePauseSec?: number }).timelinePauseSec),
    )
    && Number((action as Action & { timelinePauseSec?: number }).timelinePauseSec) > 0;
}

function isPageTimingActivityPause(action: Action): action is ActivityPauseSpeechAction {
  return isActivityPause(action) && action.activityPauseSource === 'page-timing';
}

function hasThreeQuizNarrationPhases(actions: Action[]): boolean {
  const phases = actions.flatMap((action) => action.type === 'speech' && action.quizNarrationPhase
    ? [action.quizNarrationPhase] : []);
  const ordered = phases.filter((phase, index) => phase !== phases[index - 1]);
  return ordered.length === 3
    && ordered[0] === 'intro'
    && ordered[1] === 'review-guidance'
    && ordered[2] === 'handoff';
}

function normalizeThreePhaseQuizPauses(actions: Action[]): Action[] {
  const submit = actions.find((action): action is ActivityPauseSpeechAction =>
    isActivityPause(action) && action.activityPausePurpose === 'quiz-submit');
  const review = actions.find((action): action is ActivityPauseSpeechAction =>
    isActivityPause(action) && action.activityPausePurpose === 'quiz');
  if (!submit || !review) return actions;
  const withoutGates = actions.filter((action) => action !== submit && action !== review);
  const normalizeGate = (gate: ActivityPauseSpeechAction): ActivityPauseSpeechAction => ({
    ...gate,
    activityPauseSec: gate.activityPauseSource === 'page-timing'
      ? normalizePlannedStudentActivitySec(gate.activityPauseSec)
      : clampStudentActivitySec(gate.activityPauseSec),
  });
  const result: Action[] = [];
  const lastIntro = withoutGates.findLastIndex((action) => action.type === 'speech'
    && action.quizNarrationPhase === 'intro');
  const lastReview = withoutGates.findLastIndex((action) => action.type === 'speech'
    && action.quizNarrationPhase === 'review-guidance');
  for (const [index, action] of withoutGates.entries()) {
    result.push(action);
    if (index === lastIntro) result.push(normalizeGate(submit));
    if (index === lastReview) result.push(normalizeGate(review));
  }
  return result;
}

function createSlideReflectionPause(
  seconds: number,
  source?: ActivityPauseSpeechAction,
): TimelinePauseSpeechAction {
  const base = source
    ? (() => {
        const {
          activityPauseSec: _activityPauseSec,
          activityPausePurpose: _activityPausePurpose,
          activityPauseSource: _activityPauseSource,
          ...rest
        } = source;
        return rest;
      })()
    : {
        id: `learner_reflection_${nanoid(8)}`,
        type: 'speech' as const,
        text: '',
      };
  return {
    ...base,
    title: '学生阅读与思考',
    timelinePauseSec: normalizePlannedStudentActivitySec(seconds),
    timelinePausePurpose: 'learner-reflection',
    timelinePauseSource: 'page-timing',
  };
}

/**
 * Migrate generated slide waits from an interactive gate to a passive pause at
 * the end of the narrated content. This keeps the planned page duration while
 * ensuring a normal slide never interrupts narration to request an operation.
 */
export function normalizeSlideActivityPause(actions: Action[]): Action[] {
  const gateIndex = actions.findIndex(isPageTimingActivityPause);
  if (gateIndex < 0) return actions;

  const gate = actions[gateIndex];
  if (!isPageTimingActivityPause(gate)) return actions;
  const withoutGate = actions.filter((_, index) => index !== gateIndex);
  const transitionIndex = withoutGate.findIndex(isTimelinePause);
  const insertionIndex = transitionIndex >= 0 ? transitionIndex : withoutGate.length;
  const pause = createSlideReflectionPause(gate.activityPauseSec, gate);
  return [
    ...withoutGate.slice(0, insertionIndex),
    pause,
    ...withoutGate.slice(insertionIndex),
  ];
}

function getStudentActivityInsertionIndex(actions: Action[], afterNarration = false): number {
  const speechIndex = afterNarration
    ? actions.findLastIndex((action) => action.type === 'speech' && Boolean(action.text.trim()))
    : actions.findIndex((action) => action.type === 'speech');
  if (speechIndex < 0) return 0;

  // A highlight may point learners to the control they should use. Every
  // state-changing/revealing action must wait until the learner has acted.
  let insertionIndex = speechIndex + 1;
  while (actions[insertionIndex]?.type === 'widget_highlight') {
    insertionIndex += 1;
  }
  return insertionIndex;
}

function clampStudentActivitySec(seconds: number): number {
  return Math.min(
    MAX_STUDENT_ACTIVITY_SEC,
    Math.max(MIN_STUDENT_ACTIVITY_SEC, Math.round(seconds)),
  );
}

function normalizePlannedStudentActivitySec(seconds: number): number {
  return Math.max(1, Math.round(seconds));
}

/**
 * Normalize older generated classrooms whose gate was placed after automatic
 * widget changes. The only platform action allowed before the gate is a
 * highlight that points to the learner-controlled UI.
 */
export function normalizeStudentActivityPause(actions: Action[]): Action[];
export function normalizeStudentActivityPause(actions: undefined): undefined;
export function normalizeStudentActivityPause(actions: Action[] | undefined): Action[] | undefined;
export function normalizeStudentActivityPause(actions: Action[] | undefined): Action[] | undefined {
  if (!actions) return actions;
  if (hasThreeQuizNarrationPhases(actions)) return normalizeThreePhaseQuizPauses(actions);
  const gateIndex = actions.findIndex(isActivityPause);
  if (gateIndex < 0) return actions;

  const originalGate = actions[gateIndex];
  if (!isActivityPause(originalGate)) return actions;
  const gate = {
    ...originalGate,
    activityPauseSec: originalGate.activityPauseSource === 'page-timing'
      ? normalizePlannedStudentActivitySec(originalGate.activityPauseSec)
      : clampStudentActivitySec(originalGate.activityPauseSec),
  };
  const withoutGate = actions.filter((_, index) => index !== gateIndex);
  const insertionIndex = getStudentActivityInsertionIndex(withoutGate, gate.activityPausePosition === 'after-narration');
  if (
    gateIndex === insertionIndex
    && gate.activityPauseSec === originalGate.activityPauseSec
  ) {
    return actions;
  }
  return [
    ...withoutGate.slice(0, insertionIndex),
    gate,
    ...withoutGate.slice(insertionIndex),
  ];
}

/**
 * Put the learner-controlled wait immediately after the guidance speech and
 * optional control highlight. Automatic widget changes happen only after the
 * learner has completed the page task.
 */
export function addStudentActivityPause(outline: SceneOutline, actions: Action[]): Action[] {
  const configuredActivitySec = Math.round(outline.timingPlan?.studentActivitySec ?? 0);
  if (outline.type === 'quiz' && hasThreeQuizNarrationPhases(actions)) {
    // Both waits share the existing activity allocation. Their durations are
    // planning metadata; the learner's submit and confirmation complete them.
    const totalSec = Math.max(2, configuredActivitySec || 60);
    const reviewSec = Math.max(1, Math.floor(totalSec / 4));
    const submitSec = totalSec - reviewSec;
    const submitGate: ActivityPauseSpeechAction = {
      id: `quiz_submit_pause_${nanoid(8)}`,
      type: 'speech',
      title: '学生读题、思考与作答',
      text: '',
      activityPauseSec: submitSec,
      activityPausePurpose: 'quiz-submit',
      activityPauseSource: 'page-timing',
    };
    const reviewGate: ActivityPauseSpeechAction = {
      id: `quiz_review_pause_${nanoid(8)}`,
      type: 'speech',
      title: '学生阅读解析并确认理解',
      text: '',
      activityPauseSec: reviewSec,
      activityPausePurpose: 'quiz',
      activityPauseSource: 'page-timing',
    };
    return normalizeThreePhaseQuizPauses([...actions, submitGate, reviewGate]);
  }
  if (configuredActivitySec <= 0) return actions;
  const activityPauseSec = normalizePlannedStudentActivitySec(configuredActivitySec);

  // Slide pages use passive thinking time because they expose no learner-controlled
  // operation. A variant or independent task pauses after the prompt segment so
  // the learner can decide before hearing the explanation; other slides retain
  // their end-of-page reflection time.
  if (outline.type === 'slide') {
    const caseUse = outline.teachingBrief?.pageTask?.caseUse;
    if (!outline.teachingBrief?.manuscript && (caseUse === 'variant' || caseUse === 'independent')
      && actions.filter((action) => action.type === 'speech' && action.text.trim()).length >= 2) {
      const insertionIndex = getStudentActivityInsertionIndex(actions);
      return [
        ...actions.slice(0, insertionIndex),
        createSlideReflectionPause(activityPauseSec),
        ...actions.slice(insertionIndex),
      ];
    }
    return [...actions, createSlideReflectionPause(activityPauseSec)];
  }

  const normalizedActions = outline.teachingBrief?.manuscript || actions.filter((action) => action.type === 'speech').length >= 2
    ? actions
    : [
        ...actions,
        {
          id: `activity_feedback_${nanoid(8)}`,
          type: 'speech' as const,
          title: outline.type === 'quiz' ? '测验反馈与过渡' : '活动反馈与过渡',
          text: outline.type === 'quiz'
            ? '提交后，请对照页面解析检查自己的推理依据，确认需要巩固的步骤，再继续后面的学习。'
            : '完成阅读或操作后，把观察到的信息和当前知识点联系起来，再带着这个证据进入下一部分。',
        },
      ];

  const pauseAction: ActivityPauseSpeechAction = {
    id: `activity_pause_${nanoid(8)}`,
    type: 'speech',
    title: outline.type === 'quiz' ? '学生读题、思考与作答' : '学生阅读、操作与观察',
    text: '',
    activityPauseSec,
    activityPausePurpose: outline.type === 'quiz' ? 'quiz' : 'interaction',
    activityPauseSource: 'page-timing',
    ...(outline.type === 'interactive' && outline.teachingBrief?.manuscript
      ? { activityPausePosition: 'after-narration' as const } : {}),
  };

  const insertionIndex = getStudentActivityInsertionIndex(normalizedActions, pauseAction.activityPausePosition === 'after-narration');
  return normalizeStudentActivityPause([
    ...normalizedActions.slice(0, insertionIndex),
    pauseAction,
    ...normalizedActions.slice(insertionIndex),
  ]);
}

/**
 * Add the fixed page-change interval after all narration and learner work.
 * Unlike an activity gate, this pause is not learner-completable and never
 * appears as a task in the classroom UI.
 */
export function addPageTransitionPause(outline: SceneOutline, actions: Action[]): Action[] {
  const transitionSec = Math.max(0, Math.round(outline.timingPlan?.transitionSec ?? 0));
  if (transitionSec <= 0) return actions;

  const transitionAction: TimelinePauseSpeechAction = {
    id: `page_transition_${nanoid(8)}`,
    type: 'speech',
    title: '页面切换',
    text: '',
    timelinePauseSec: transitionSec,
    timelinePausePurpose: 'page-transition',
  };
  const withoutExistingTransition = actions.filter((action) => !isTimelinePause(action));
  return [...withoutExistingTransition, transitionAction];
}

/** Apply both learner-completable work time and the fixed page transition. */
export function addPageTimingPauses(outline: SceneOutline, actions: Action[]): Action[] {
  return addPageTransitionPause(outline, addStudentActivityPause(outline, actions));
}
