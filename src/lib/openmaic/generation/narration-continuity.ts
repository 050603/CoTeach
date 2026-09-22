import type { Action } from '@openmaic/lib/types/action';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import type { SceneGenerationContext } from './pipeline-types';
import { normalizeNarrationPunctuation } from './narration-punctuation';

type CourseEndingDisposition = 'verified-course-end' | 'continues' | 'pbl-stage-handoff' | 'partial-preview';

export interface NarrationContinuityContext extends SceneGenerationContext {
  nextPageTitle?: string;
  nextPageType?: SceneOutline['type'];
  nextStageKey?: string;
  nextStageLabel?: string;
  endingDisposition: CourseEndingDisposition;
  outgoingHandoff?: string;
}

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

function isAiLecturePage(outline: SceneOutline | undefined): boolean {
  return Boolean(outline
    && outline.narrationMode !== 'embedded-segment'
    && outline.audience !== 'teacher'
    && (outline.stageKey === 'ai-learning' || outline.generationPurpose === 'knowledge-teaching'));
}

function stageLabel(outline: SceneOutline | undefined): string | undefined {
  if (!outline) return undefined;
  if (outline.stageLabel?.trim()) return outline.stageLabel.trim();
  return ({
    launch: '项目启动',
    'ai-learning': '知识讲授',
    make: '项目实践',
    'project-practice': '项目实践',
    showcase: '成果展示',
    reflection: '学习反思',
  } as Record<string, string>)[outline.stageKey ?? ''];
}

function naturalTitle(title: string): string {
  return title.replace(/^[《“\"]|[》”\"]$/g, '').trim();
}

function nextStepHandoff(current: SceneOutline | undefined, next: SceneOutline | undefined): {
  disposition: CourseEndingDisposition;
  handoff?: string;
  nextStageKey?: string;
  nextStageLabel?: string;
} {
  if (next) {
    if (next.type === 'quiz') {
      return {
        disposition: 'continues',
        handoff: `接下来通过“${naturalTitle(next.title)}”检验理解，再根据反馈继续学习。`,
        ...(next.stageKey ? { nextStageKey: next.stageKey } : {}),
        ...(stageLabel(next) ? { nextStageLabel: stageLabel(next) } : {}),
      };
    }
    const crossesStage = Boolean(next.stageKey && current?.stageKey && next.stageKey !== current.stageKey);
    if (next.type === 'pbl' || crossesStage) {
      const label = stageLabel(next) || naturalTitle(next.title);
      return {
        disposition: 'continues',
        handoff: `接下来进入${label}，把刚才形成的认识用于具体任务。`,
        ...(next.stageKey ? { nextStageKey: next.stageKey } : {}),
        ...(label ? { nextStageLabel: label } : {}),
      };
    }
    return {
      disposition: 'continues',
      ...(next.stageKey ? { nextStageKey: next.stageKey } : {}),
      ...(stageLabel(next) ? { nextStageLabel: stageLabel(next) } : {}),
    };
  }
  // The new-system AI resource is one stage of a larger PBL course. Its
  // generated outline may intentionally contain only the AI-learning pages,
  // while the classroom still continues into the confirmed practice stage.
  if (current?.stageKey === 'ai-learning' && current.narrationMode !== 'embedded-segment') {
    return {
      disposition: 'pbl-stage-handoff',
      handoff: '接下来进入项目实践，把刚才形成的认识用于具体任务。',
      nextStageKey: 'make',
      nextStageLabel: '项目实践',
    };
  }
  return { disposition: 'verified-course-end' };
}

/** Build continuity metadata before concurrent scene workers start. */
export function buildNarrationContext(
  outlines: ReadonlyArray<SceneOutline>,
  index: number,
  options?: { courseTitle?: string },
): NarrationContinuityContext {
  const safeIndex = Math.max(0, Math.min(index, Math.max(0, outlines.length - 1)));
  const current = outlines[safeIndex];
  const previous = safeIndex > 0 ? outlines[safeIndex - 1] : undefined;
  const next = safeIndex < outlines.length - 1 ? outlines[safeIndex + 1] : undefined;
  const firstAiLectureIndex = outlines.findIndex(isAiLecturePage);
  const isFirstAiLecture = firstAiLectureIndex >= 0 && safeIndex === firstAiLectureIndex;
  const sectionPosition = (safeIndex === 0 && (current?.order ?? 0) === 0) || isFirstAiLecture
    ? 'course-first'
    : previous && current && sectionIdentity(previous) !== sectionIdentity(current)
      ? 'section-first'
      : 'continuation';
  const nextStep = nextStepHandoff(current, next);
  const looksLikePartialPreview = !next && outlines.length === 1 && (current?.order ?? 0) > 0;
  const endingDisposition = looksLikePartialPreview
    ? 'partial-preview'
    : nextStep.disposition;

  return {
    pageIndex: safeIndex + 1,
    totalPages: outlines.length,
    allTitles: outlines.map((outline) => outline.title),
    previousSpeeches: [],
    ...(options?.courseTitle?.trim() ? { courseTitle: options.courseTitle.trim() } : {}),
    sectionPosition,
    previousPageTitle: previous?.title,
    previousPageSummary: summarizeOutline(previous),
    currentTeachingObjective: summarizeOutline(current),
    narrationMode: current?.narrationMode ?? 'standalone-course',
    ...(next?.title ? { nextPageTitle: next.title } : {}),
    ...(next ? { nextPageType: next.type } : {}),
    ...(nextStep.nextStageKey ? { nextStageKey: nextStep.nextStageKey } : {}),
    ...(nextStep.nextStageLabel ? { nextStageLabel: nextStep.nextStageLabel } : {}),
    ...(nextStep.handoff ? { outgoingHandoff: nextStep.handoff } : {}),
    endingDisposition,
  };
}

const REPEATED_OPENING_PREFIX = /^(?:(?:大家好|同学们好|各位同学(?:好)?)[，,。.!！、\s]*|同学们[，,]\s*(?:今天|这节课|本节课)[^。！？!?]*[。！？!?\s]*|欢迎(?:大家|各位同学|同学们)?(?:来到|参加|进入)[^。！？!?]*[。！？!?\s]*|(?:hello|hi)\s+(?:everyone|class|students)[,.!\s]*|welcome(?:\s+everyone|\s+class|\s+students)?[^.!?]*[.!?\s]*)+/i;

export function stripRepeatedNarrationOpening(text: string): string {
  return text.replace(REPEATED_OPENING_PREFIX, '').trimStart();
}

const TRAILING_FAREWELL_BLOCK = /(?:[，,、；;\s]*(?:感谢(?:大家|同学们)?(?:(?:的)?(?:认真)?(?:聆听|观看|参与))?|谢谢(?:大家|同学们)?|(?:我们)?(?:下次课|下节课|下次|下一堂课)再见|同学们再见|再见)[。！!?.；;，,\s]*)+$/i;
const TRAILING_COURSE_ENDING = /(?:[，,、；;\s]*(?:(?:今天|本节|本次|这节)(?:的)?(?:课程|课|学习)(?:就)?(?:到这里|告一段落|结束)|(?:今天|本节|本次|这节)(?:就)?先到这里)[。！!?.；;，,\s]*)+$/i;
const FALSE_SESSION_REFERENCE = /(?:在)?(?:上一节课|上节课|上一堂课|上次课|上次课程)(?:中|里)?/g;
const FALSE_FUTURE_SESSION_REFERENCE = /(?:在)?(?:下(?:一)?节课|下(?:一)?堂课|下一课|下次课|下一次课)(?:中|里)?/g;
const FALSE_FUTURE_SESSION_REFERENCE_EN = /\b(?:in\s+)?(?:the\s+)?next\s+(?:class|lesson|session)\b/gi;
const FALSE_PREVIOUS_PAGE_LEARNING = /(?:在)?(?:上一页|前一页)(?:中|里)?[，,\s]*我们(?:已经)?(?:看到了?|了解了?|学习了?|认识了?|回顾了?)/g;
const FALSE_PREVIOUS_PAGE_REFERENCE = /(?:在)?(?:上一页|前一页)(?:中|里)?/g;
const COURSE_GREETING = /(?:大家好|同学们好|各位同学好|欢迎(?:大家|各位同学|同学们)?来到|\b(?:hello|hi)\s+(?:everyone|class|students)\b|\bwelcome(?:\s+everyone|\s+class|\s+students)?\b)/i;
const FORMAL_COURSE_CLOSING = /(?:(?:今天|本节|本次|这节)(?:的)?(?:课程|课|学习)(?:就)?(?:到这里|告一段落|结束)|感谢(?:大家|同学们)?(?:的)?(?:聆听|观看|参与)|谢谢(?:大家|同学们)?|同学们再见|(?:下次课|下节课|下次|下一堂课)再见|\bgoodbye\b|\bsee you\b)[。！？!?.\s]*$/i;

export function normalizeCourseFirstOpening(text: string, courseTitle?: string): string {
  const independentOpening = text
    .replace(FALSE_PREVIOUS_PAGE_LEARNING, '这节课我们先来了解')
    .replace(FALSE_PREVIOUS_PAGE_REFERENCE, '在本节课中');
  const normalizedTitle = courseTitle?.trim().replace(/^[《“"]|[》”"]$/g, '');
  const chineseDelivery = /[\u3400-\u9fff]/.test(`${normalizedTitle ?? ''}${independentOpening}`);
  return COURSE_GREETING.test(independentOpening)
    ? independentOpening
    : chineseDelivery
      ? `同学们好，欢迎来到${normalizedTitle ? `《${normalizedTitle}》课程` : '今天的课堂'}。${independentOpening.trimStart()}`
      : `Hello everyone, welcome to ${normalizedTitle || 'today\'s class'}. ${independentOpening.trimStart()}`;
}

/** Add a formal resource ending when the final authored speech omitted one. */
export function normalizeCourseFinalClosing(text: string): string {
  const trimmed = text.trimEnd();
  const farewellCount = trimmed.match(/(?:(?:同学们)?再见|\bgoodbye\b|\bsee you\b)/gi)?.length ?? 0;
  if (FORMAL_COURSE_CLOSING.test(trimmed) && farewellCount <= 1) return trimmed;
  const base = farewellCount > 1 ? stripPrematureCourseClosing(trimmed) : trimmed;
  const separator = !base || endsCompleteNarrationSentence(base) ? '' : '。';
  return /[\u3400-\u9fff]/.test(base)
    ? `${base}${separator}${base ? ' ' : ''}请把今天形成的认识带到后续的判断与实践中。今天的课程就到这里，感谢大家的认真参与，同学们再见。`
    : `${base}${base && !endsCompleteNarrationSentence(base) ? '.' : ''}${base ? ' ' : ''}Carry today’s understanding into your next judgment or practice. That concludes today’s course. Thank you for your participation, and goodbye.`;
}

export function stripFormalNarrationFarewell(text: string): string {
  return text.replace(TRAILING_FAREWELL_BLOCK, '').replace(/[，,\s]+$/, '').trimEnd();
}

/** Remove an ending that would falsely announce completion before the course boundary. */
export function stripPrematureCourseClosing(text: string): string {
  let normalized = text.trimEnd();
  let previous: string;
  do {
    previous = normalized;
    normalized = stripFormalNarrationFarewell(normalized);
    normalized = normalized.replace(TRAILING_COURSE_ENDING, '').replace(/[，,\s]+$/, '').trimEnd();
  } while (normalized !== previous);
  return normalized;
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

function normalizeSpeechActionPunctuation(action: Action): Action {
  if (action.type !== 'speech') return { ...action };
  const text = normalizeNarrationPunctuation(action.text);
  const normalizedAction = { ...action, text };
  if (text === action.text) return normalizedAction;

  delete normalizedAction.speechAlignment;
  if (action.audioId || action.audioUrl || action.audioDurationSec) {
    delete normalizedAction.audioId;
    delete normalizedAction.audioUrl;
    delete normalizedAction.audioDurationSec;
    normalizedAction.audioInvalidated = true;
  }
  return normalizedAction;
}

function contextExtension(context: SceneGenerationContext): NarrationContinuityContext {
  if ('endingDisposition' in context) return context as NarrationContinuityContext;
  return {
    ...context,
    endingDisposition: context.pageIndex >= context.totalPages
      ? 'verified-course-end'
      : 'continues',
  };
}

function hasOutgoingHandoff(text: string, context: NarrationContinuityContext): boolean {
  const tail = text.slice(-180);
  const target = context.nextStageLabel || context.nextPageTitle;
  if (target && tail.includes(naturalTitle(target))) return true;
  if (context.nextPageType === 'quiz' && /(?:接下来|下面|随后).{0,20}(?:小测|测验|检测|练习)/.test(tail)) return true;
  if (context.nextStageKey === 'make' && /(?:接下来|下面|随后).{0,20}(?:项目实践|实践|具体任务)/.test(tail)) return true;
  return false;
}

function appendNarrationSentence(text: string, addition: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed) return addition;
  return `${trimmed}${endsCompleteNarrationSentence(trimmed) ? '' : '。'} ${addition}`;
}

function speechAnchorExists(text: string, quote: string, occurrence = 0): boolean {
  if (!quote || occurrence < 0 || !Number.isInteger(occurrence)) return false;
  let offset = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    const found = text.indexOf(quote, offset);
    if (found < 0) return false;
    offset = found + quote.length;
  }
  return true;
}

function synchronizeNarrationActions(actions: Action[]): Action[] {
  const speeches = new Map(actions.flatMap((action) => (
    action.type === 'speech' && action.text.trim() ? [[action.id, action] as const] : []
  )));
  const synchronized: Action[] = [];
  for (const action of actions) {
    if (action.type === 'speech') {
      if (action.text.trim()) synchronized.push(action);
      continue;
    }
    if (action.type !== 'spotlight' && action.type !== 'laser') {
      synchronized.push(action);
      continue;
    }
    const speech = action.speechId ? speeches.get(action.speechId) : undefined;
    if (action.speechId && !speech) continue;
    if (speech && action.speechAnchor
      && !speechAnchorExists(speech.text, action.speechAnchor.quote, action.speechAnchor.occurrence)) continue;
    if (action.type === 'spotlight' && action.endSpeechId && !speeches.has(action.endSpeechId)) {
      const { endSpeechId: _removedEndSpeechId, ...withoutInvalidEnd } = action;
      synchronized.push(withoutInvalidEnd);
      continue;
    }
    synchronized.push(action);
  }
  return synchronized;
}

/** Normalize only the real page boundary; never infer an ending from a generated subset. */
export function normalizeNarrationPageEnding(text: string, context: SceneGenerationContext): string {
  const continuity = contextExtension(context);
  if (continuity.narrationMode !== 'embedded-segment'
    && continuity.endingDisposition === 'verified-course-end') {
    return normalizeCourseFinalClosing(text);
  }
  const boundarySafeText = continuity.nextPageType === 'quiz'
    ? text.replace(/(?:现在|到这里)?(?:你|你们|大家|我们)?已经(?:完全)?掌握了?/g, '我们刚刚学习了')
    : text;
  const withoutClosing = stripPrematureCourseClosing(boundarySafeText);
  if (continuity.outgoingHandoff && !hasOutgoingHandoff(withoutClosing, continuity)) {
    return appendNarrationSentence(withoutClosing, continuity.outgoingHandoff);
  }
  if (continuity.narrationMode === 'embedded-segment' && withoutClosing !== text.trimEnd()) {
    return appendNarrationSentence(withoutClosing, '接下来，让我们继续后面的学习。');
  }
  return withoutClosing;
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
  const punctuationNormalized = actions.map(normalizeSpeechActionPunctuation);
  if (!context) return punctuationNormalized;
  const speechIndexes = punctuationNormalized.flatMap((action, index) => (
    action.type === 'speech' && action.text.trim() ? [index] : []
  ));
  const firstSpeechIndex = speechIndexes[0];
  const lastSpeechIndex = speechIndexes.at(-1);
  const shouldStripOpening = context.narrationMode === 'embedded-segment'
    || context.sectionPosition !== 'course-first';
  const normalized = punctuationNormalized.map((action, index) => {
    if (action.type !== 'speech') return { ...action };
    let cleaned = context.pageIndex > 1
      ? action.text.replace(FALSE_SESSION_REFERENCE, '刚才')
      : action.text;
    if (
      index === firstSpeechIndex
      && context.sectionPosition === 'course-first'
      && context.narrationMode === 'standalone-course'
    ) {
      cleaned = normalizeCourseFirstOpening(cleaned, context.courseTitle);
    }
    if (index === firstSpeechIndex && shouldStripOpening) {
      cleaned = stripRepeatedNarrationOpening(cleaned);
    }
    if (index === lastSpeechIndex) {
      cleaned = normalizeNarrationPageEnding(cleaned, context);
    } else if (
      contextExtension(context).endingDisposition === 'verified-course-end'
      && context.narrationMode === 'standalone-course'
    ) {
      const withoutClosing = stripPrematureCourseClosing(cleaned);
      if (withoutClosing) cleaned = withoutClosing;
    }
    if (
      context.narrationMode === 'embedded-segment'
      || context.pageIndex < context.totalPages
    ) {
      cleaned = rewriteFalseFutureSessionReferences(cleaned);
    }
    const normalizedAction = {
      ...action,
      text: cleaned,
    };
    if (cleaned !== action.text && (action.audioId || action.audioUrl || action.audioDurationSec)) {
      delete normalizedAction.audioId;
      delete normalizedAction.audioUrl;
      delete normalizedAction.audioDurationSec;
      delete normalizedAction.speechAlignment;
      normalizedAction.audioInvalidated = true;
    }
    return normalizedAction;
  });
  const synchronized = synchronizeNarrationActions(normalized);
  return context.narrationMode === 'embedded-segment'
    ? mergeFragmentedNarrationActions(synchronized)
    : synchronized;
}
