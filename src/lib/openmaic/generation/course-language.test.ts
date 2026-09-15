import { describe, expect, it } from 'vitest';
import type { Action } from '@openmaic/lib/types/action';
import {
  auditNarrationLanguage,
  narrationLanguageRepairDirective,
  resolveCourseLanguagePolicy,
  ZH_CN_COURSE_LANGUAGE_DIRECTIVE,
} from './course-language';

function speech(id: string, text: string): Action {
  return { id, type: 'speech', text };
}

describe('course language policy', () => {
  it('locks confirmed Chinese outlines to Simplified Chinese when no outline model ran', () => {
    const policy = resolveCourseLanguagePolicy({
      requirement: '为七年级学生讲解生态系统中的能量流动',
      courseTitle: '生态系统',
      outlineText: ['能量沿食物链单向流动，并在营养级之间逐级递减。'],
      ttsLanguage: 'zh-CN',
    });
    expect(policy).toMatchObject({ locale: 'zh-CN', source: 'course-content' });
    expect(policy.directive).toContain('every speech narration segment');
    expect(policy.directive).toContain('Simplified Chinese');
  });

  it('strengthens an explicit Chinese directive and preserves the original constraint', () => {
    const policy = resolveCourseLanguagePolicy({
      explicitDirective: '使用中文，并保留术语 Transformer。',
      ttsLanguage: 'en-US',
    });
    expect(policy.locale).toBe('zh-CN');
    expect(policy.directive).toContain(ZH_CN_COURSE_LANGUAGE_DIRECTIVE);
    expect(policy.directive).toContain('Transformer');
  });

  it('does not mistake the upstream English fallback sentence for an English course', () => {
    const policy = resolveCourseLanguagePolicy({
      generatedDirective: 'Teach in the language that matches the user requirement.',
      requirement: '为初中生系统讲解光合作用',
      outlineText: ['光能转化为化学能，并储存在有机物中。'],
      ttsLanguage: 'zh-CN',
    });
    expect(policy).toMatchObject({ locale: 'zh-CN', source: 'course-content' });
    expect(policy.directive).toContain('Simplified Chinese');
  });

  it('allows embedded proper nouns but rejects complete English narration for zh-CN TTS', () => {
    const actions = [
      speech('ok', '这一页用 Transformer 解释注意力机制，AI 只是标准缩写。'),
      speech('wrong', 'Today we will explore how attention changes the representation of each token.'),
    ];
    expect(auditNarrationLanguage(actions, 'zh-CN')).toEqual([
      expect.objectContaining({ actionId: 'wrong', reason: '完整讲稿段落为英文' }),
    ]);
    expect(auditNarrationLanguage(actions, 'en-US')).toEqual([]);
  });

  it('rejects a short complete English sentence before Chinese TTS', () => {
    expect(auditNarrationLanguage([
      speech('short-english', 'Hello everyone.'),
    ], 'zh-CN')).toEqual([
      expect.objectContaining({ actionId: 'short-english', reason: '完整讲稿段落为英文' }),
    ]);
  });

  it('builds a bounded repair instruction that preserves non-language behavior', () => {
    const policy = resolveCourseLanguagePolicy({ explicitDirective: '使用中文。' });
    const directive = narrationLanguageRepairDirective(policy, [{
      actionId: 'speech-1',
      text: 'Let us begin with an example.',
      reason: '完整讲稿段落为英文',
    }]);
    expect(directive).toContain('Rewrite every speech segment');
    expect(directive).toContain('preserving the page facts, action order, element references');
  });
});
