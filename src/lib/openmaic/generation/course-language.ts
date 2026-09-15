import type { Action } from '@openmaic/lib/types/action';

export type CourseLanguageLocale = 'zh-CN' | 'en-US' | 'other';

export interface CourseLanguagePolicy {
  locale: CourseLanguageLocale;
  directive: string;
  source: 'explicit' | 'generated' | 'course-content' | 'tts' | 'fallback';
}

export interface NarrationLanguageIssue {
  actionId: string;
  text: string;
  reason: string;
}

export const ZH_CN_COURSE_LANGUAGE_DIRECTIVE = [
  'Deliver the entire course in Simplified Chinese.',
  'All learner-facing slide text, quiz copy, interactive labels, and every speech narration segment must be written in natural Simplified Chinese.',
  'Keep English only for unavoidable proper nouns, standard abbreviations, code, or terms whose English form is itself being taught, and explain the term in Chinese in the same context.',
  'Never switch a complete sentence or a complete narration segment to English.',
].join(' ');

const EN_US_COURSE_LANGUAGE_DIRECTIVE =
  'Deliver the entire course, including every speech narration segment, in English.';

function compact(value: string | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? '';
}

function localeFromDirective(value: string): CourseLanguageLocale | undefined {
  if (/简体中文|中文|汉语|普通话|simplified\s+chinese|mandarin|zh[-_]?cn/i.test(value)) {
    return 'zh-CN';
  }
  if (/英语|英文|\benglish\b|en[-_](?:us|gb)/i.test(value)) return 'en-US';
  return undefined;
}

function languageCounts(value: string): { han: number; latinLetters: number } {
  const normalized = value
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/`[^`]*`/g, ' ');
  return {
    han: normalized.match(/\p{Script=Han}/gu)?.length ?? 0,
    latinLetters: normalized.match(/[A-Za-z]/g)?.length ?? 0,
  };
}

function localeFromCourseText(value: string): CourseLanguageLocale | undefined {
  const { han, latinLetters } = languageCounts(value);
  if (han >= 8 && han * 2 >= latinLetters) return 'zh-CN';
  if (latinLetters >= 30 && latinLetters > han * 3) return 'en-US';
  return undefined;
}

function directiveForLocale(locale: CourseLanguageLocale, original = ''): string {
  if (locale === 'zh-CN') {
    return [ZH_CN_COURSE_LANGUAGE_DIRECTIVE, compact(original)]
      .filter((value, index, values) => value && values.indexOf(value) === index)
      .join(' ');
  }
  if (locale === 'en-US') {
    return [EN_US_COURSE_LANGUAGE_DIRECTIVE, compact(original)]
      .filter((value, index, values) => value && values.indexOf(value) === index)
      .join(' ');
  }
  return compact(original) || 'Teach in the language that matches the confirmed course content.';
}

/**
 * Confirmed-outline generation skips the upstream outline model, so it cannot
 * rely on that model to return `languageDirective`. Resolve the language once
 * at the classroom boundary and reuse the same directive for page content,
 * actions, persisted stage metadata, and the TTS preflight.
 */
export function resolveCourseLanguagePolicy(input: {
  explicitDirective?: string;
  generatedDirective?: string;
  ttsLanguage?: string;
  requirement?: string;
  courseTitle?: string;
  outlineText?: ReadonlyArray<string | undefined>;
}): CourseLanguagePolicy {
  const explicit = compact(input.explicitDirective);
  if (explicit) {
    const locale = localeFromDirective(explicit);
    if (locale) {
      return { locale, directive: directiveForLocale(locale, explicit), source: 'explicit' };
    }
  }

  const generated = compact(input.generatedDirective);
  if (generated) {
    const locale = localeFromDirective(generated);
    if (locale) {
      return { locale, directive: directiveForLocale(locale, generated), source: 'generated' };
    }
  }
  const originalDirective = explicit || generated;

  const courseText = [input.courseTitle, input.requirement, ...(input.outlineText ?? [])]
    .filter(Boolean)
    .join('\n');
  const inferred = localeFromCourseText(courseText);
  if (inferred) {
    return {
      locale: inferred,
      directive: directiveForLocale(inferred, originalDirective),
      source: 'course-content',
    };
  }

  const ttsLocale = /^zh(?:[-_]|$)/i.test(input.ttsLanguage ?? '')
    ? 'zh-CN'
    : /^en(?:[-_]|$)/i.test(input.ttsLanguage ?? '')
      ? 'en-US'
      : undefined;
  if (ttsLocale) {
    return {
      locale: ttsLocale,
      directive: directiveForLocale(ttsLocale, originalDirective),
      source: 'tts',
    };
  }
  return {
    locale: 'other',
    directive: directiveForLocale('other', originalDirective),
    source: 'fallback',
  };
}

function meaningfulEnglishWords(value: string): string[] {
  const matches = value
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/`[^`]*`/g, ' ')
    .match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/g) ?? [];
  return matches.filter((word) => !(word.length <= 4 && word === word.toUpperCase()));
}

function longestEnglishClause(value: string): number {
  const runs = value.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*(?:[\s,;:'"()\-]+[A-Za-z]+(?:[-'][A-Za-z]+)*)+/g) ?? [];
  return runs.reduce(
    (longest, run) => Math.max(longest, meaningfulEnglishWords(run).length),
    0,
  );
}

/** Conservative detector: Chinese narration may contain normal English terms,
 * but a whole English sentence/segment is never sent to a zh-CN TTS voice. */
export function auditNarrationLanguage(
  actions: ReadonlyArray<Action> | undefined,
  locale: string | undefined,
): NarrationLanguageIssue[] {
  if (!/^zh(?:[-_]|$)/i.test(locale ?? '')) return [];
  return (actions ?? []).flatMap((action) => {
    if (action.type !== 'speech' || !action.text?.trim()) return [];
    const text = action.text.trim();
    const { han, latinLetters } = languageCounts(text);
    const englishWords = meaningfulEnglishWords(text);
    const allEnglishSentence = han === 0 && englishWords.length >= 2;
    const englishClause = longestEnglishClause(text) >= 5;
    const englishDominant = englishWords.length >= 8 && latinLetters > Math.max(24, han * 2);
    if (!allEnglishSentence && !englishClause && !englishDominant) return [];
    return [{
      actionId: action.id,
      text,
      reason: allEnglishSentence
        ? '完整讲稿段落为英文'
        : englishClause
          ? '讲稿包含完整的英文从句'
          : '讲稿中的英文内容明显多于中文解释',
    }];
  });
}

export function narrationLanguageRepairDirective(
  policy: CourseLanguagePolicy,
  issues: ReadonlyArray<NarrationLanguageIssue>,
): string {
  return [
    policy.directive,
    `LANGUAGE CORRECTION: the previous action draft contained ${issues.length} narration segment(s) in the wrong language.`,
    'Rewrite every speech segment in natural Simplified Chinese while preserving the page facts, action order, element references, teaching-tool actions, and approximate narration duration.',
    'Do not translate code, standard abbreviations, formulas, or proper nouns; explain them in Chinese around the original term.',
  ].join(' ');
}
