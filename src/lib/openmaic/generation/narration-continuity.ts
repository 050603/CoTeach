import type { Action } from '@openmaic/lib/types/action';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import type { SceneGenerationContext } from './pipeline-types';

function sectionIdentity(outline: SceneOutline): string {
  return outline.parentActivityId
    || outline.stageKey
    || outline.segmentGroupId
    || '__course__';
}

function summarizeOutline(outline: SceneOutline | undefined): string | undefined {
  if (!outline) return undefined;
  return [outline.description, ...(outline.keyPoints ?? [])]
    .map((item) => item?.trim())
    .filter(Boolean)
    .join('；')
    .slice(0, 600) || outline.title;
}

/** Build continuity metadata before concurrent scene workers start. */
export function buildNarrationContext(
  outlines: ReadonlyArray<SceneOutline>,
  index: number,
): SceneGenerationContext {
  const safeIndex = Math.max(0, Math.min(index, Math.max(0, outlines.length - 1)));
  const current = outlines[safeIndex];
  const previous = safeIndex > 0 ? outlines[safeIndex - 1] : undefined;
  const sectionPosition = safeIndex === 0
    ? 'course-first'
    : previous && current && sectionIdentity(previous) !== sectionIdentity(current)
      ? 'section-first'
      : 'continuation';

  return {
    pageIndex: safeIndex + 1,
    totalPages: outlines.length,
    allTitles: outlines.map((outline) => outline.title),
    previousSpeeches: [],
    sectionPosition,
    previousPageTitle: previous?.title,
    previousPageSummary: summarizeOutline(previous),
    currentTeachingObjective: summarizeOutline(current),
    narrationMode: current?.narrationMode ?? 'standalone-course',
  };
}

const REPEATED_OPENING_PREFIX = /^(?:(?:大家好|同学们好|各位同学(?:好)?)[，,。.!！、\s]*|同学们[，,]\s*(?:今天|这节课|本节课)[^。！？!?]*[。！？!?\s]*|欢迎(?:大家|各位同学|同学们)?(?:来到|参加|进入)[^。！？!?]*[。！？!?\s]*|(?:hello|hi)\s+(?:everyone|class|students)[,.!\s]*|welcome(?:\s+everyone|\s+class|\s+students)?[^.!?]*[.!?\s]*)+/i;

export function stripRepeatedNarrationOpening(text: string): string {
  return text.replace(REPEATED_OPENING_PREFIX, '').trimStart();
}

const FORMAL_FAREWELL_PHRASE = /(?:感谢(?:大家|同学们)?(?:的)?(?:聆听|观看|参与)|谢谢(?:大家|同学们)?|(?:我们)?(?:下次课|下节课|下次|下一堂课)再见|同学们再见|再见)/i;
const FALSE_SESSION_REFERENCE = /(?:在)?(?:上一节课|上节课|上一堂课|上次课|上次课程)(?:中|里)?/g;
const FALSE_FUTURE_SESSION_REFERENCE = /(?:在)?(?:下(?:一)?节课|下(?:一)?堂课|下一课|下次课|下一次课)(?:中|里)?/g;
const FALSE_FUTURE_SESSION_REFERENCE_EN = /\b(?:in\s+)?(?:the\s+)?next\s+(?:class|lesson|session)\b/gi;
const FALSE_PREVIOUS_PAGE_LEARNING = /(?:在)?(?:上一页|前一页)(?:中|里)?[，,\s]*我们(?:已经)?(?:看到了?|了解了?|学习了?|认识了?|回顾了?)/g;
const FALSE_PREVIOUS_PAGE_REFERENCE = /(?:在)?(?:上一页|前一页)(?:中|里)?/g;
const COURSE_GREETING = /(?:大家好|同学们好|各位同学好|欢迎(?:大家|各位同学|同学们)?来到)/i;

export function normalizeCourseFirstOpening(text: string): string {
  const independentOpening = text
    .replace(FALSE_PREVIOUS_PAGE_LEARNING, '这节课我们先来了解')
    .replace(FALSE_PREVIOUS_PAGE_REFERENCE, '在本节课中');
  return COURSE_GREETING.test(independentOpening)
    ? independentOpening
    : `同学们好，欢迎来到今天的课堂。${independentOpening.trimStart()}`;
}

export function stripFormalNarrationFarewell(text: string): string {
  const match = FORMAL_FAREWELL_PHRASE.exec(text);
  if (!match || match.index === undefined) return text.trimEnd();
  return text.slice(0, match.index).replace(/[，,\s]+$/, '').trimEnd();
}

export function rewriteFalseFutureSessionReferences(text: string): string {
  return text
    .replace(FALSE_FUTURE_SESSION_REFERENCE, '接下来')
    .replace(FALSE_FUTURE_SESSION_REFERENCE_EN, 'later in this lesson');
}

function endsCompleteNarrationSentence(text: string): boolean {
  return /[。！？!?；;.](?:[”’"'）)】\]》」』]*)$/.test(text.trim());
}

function hasSpeechControlMetadata(action: Extract<Action, { type: 'speech' }>): boolean {
  const controlled = action as Extract<Action, { type: 'speech' }> & {
    activityPauseSec?: number;
    timelinePauseSec?: number;
  };
  return Boolean(
    controlled.audioId
    || controlled.audioUrl
    || controlled.activityPauseSec
    || controlled.timelinePauseSec,
  );
}

function joinNarrationFragments(left: string, right: string): string {
  const trimmedLeft = left.trimEnd();
  const trimmedRight = right.trimStart();
  const needsSpace = /[A-Za-z0-9]$/.test(trimmedLeft) && /^[A-Za-z0-9]/.test(trimmedRight);
  return `${trimmedLeft}${needsSpace ? ' ' : ''}${trimmedRight}`;
}

/** Merge adjacent comma-ended speech actions into complete semantic units. */
export function mergeFragmentedNarrationActions(actions: ReadonlyArray<Action>): Action[] {
  const merged: Action[] = [];
  for (const action of actions) {
    const previous = merged.at(-1);
    if (
      action.type === 'speech'
      && action.text.trim()
      && previous?.type === 'speech'
      && previous.text.trim()
      && !endsCompleteNarrationSentence(previous.text)
      && !hasSpeechControlMetadata(previous)
      && !hasSpeechControlMetadata(action)
    ) {
      merged[merged.length - 1] = {
        ...previous,
        text: joinNarrationFragments(previous.text, action.text),
      };
      continue;
    }
    merged.push({ ...action });
  }
  return merged;
}

/** Deterministic final guard for model outputs that ignore the continuity prompt. */
export function enforceNarrationContinuity(
  actions: ReadonlyArray<Action>,
  context?: SceneGenerationContext,
): Action[] {
  if (!context) return actions.map((action) => ({ ...action }));
  const speechIndexes = actions.flatMap((action, index) => action.type === 'speech' ? [index] : []);
  const firstSpeechIndex = speechIndexes[0];
  const lastSpeechIndex = speechIndexes.at(-1);
  const shouldStripOpening = context.narrationMode === 'embedded-segment'
    || context.sectionPosition !== 'course-first';
  const normalized = actions.map((action, index) => {
    if (action.type !== 'speech') return { ...action };
    let cleaned = context.pageIndex > 1
      ? action.text.replace(FALSE_SESSION_REFERENCE, '刚才')
      : action.text;
    if (
      index === firstSpeechIndex
      && context.sectionPosition === 'course-first'
      && context.narrationMode === 'standalone-course'
    ) {
      cleaned = normalizeCourseFirstOpening(cleaned);
    }
    if (index === firstSpeechIndex && shouldStripOpening) {
      cleaned = stripRepeatedNarrationOpening(cleaned);
    }
    if (index === lastSpeechIndex && context.narrationMode === 'embedded-segment') {
      const withoutFarewell = stripFormalNarrationFarewell(cleaned);
      if (withoutFarewell !== cleaned) {
        cleaned = withoutFarewell
          ? `${withoutFarewell} 接下来，让我们继续后面的学习。`
          : '接下来，让我们继续后面的学习。';
      }
    }
    if (
      context.narrationMode === 'embedded-segment'
      || context.pageIndex < context.totalPages
    ) {
      cleaned = rewriteFalseFutureSessionReferences(cleaned);
    }
    return {
      ...action,
      text: cleaned || context.currentTeachingObjective || context.allTitles[context.pageIndex - 1] || action.text,
    };
  });
  return context.narrationMode === 'embedded-segment'
    ? mergeFragmentedNarrationActions(normalized)
    : normalized;
}
