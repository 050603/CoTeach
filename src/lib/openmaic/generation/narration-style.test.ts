import { describe, expect, it, vi } from 'vitest';
import type { Action } from '@openmaic/lib/types/action';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import {
  NATURAL_NARRATION_VERSION,
  narrationStyleIssues,
  naturalizeKnowledgeNarration,
  normalizeNarrationRewrite,
} from './narration-style';

const outline: SceneOutline = {
  id: 'p1', type: 'slide', title: '流畅不等于真实', description: '解释生成机制', keyPoints: ['核验事实'], order: 0,
  generationPurpose: 'knowledge-teaching',
  teachingBrief: {
    schemaVersion: 1,
    explanation: '语言模式可以生成流畅表达，但不能验证事实。',
    examples: ['核对校史年份。'],
    conditions: ['多个转载页面不一定是独立来源。'],
    evidence: [],
    assessmentFocus: '说明核验步骤和理由。',
  },
};

describe('natural teacher narration', () => {
  it('rejects slide-production language and preserves segment identity', () => {
    expect(narrationStyleIssues([{ id: 's1', text: '这一页的核心观点是流畅不等于真实。' }])).toEqual(expect.arrayContaining([
      expect.stringContaining('页面制作视角'),
      expect.stringContaining('讲稿提纲标签'),
    ]));
    const expected = [{ id: 's1', text: '原讲稿。' }, { id: 's2', text: '原讲稿二。' }];
    expect(normalizeNarrationRewrite({ segments: [
      { id: 's1', text: '大家先想一想，表达流畅能证明事实正确吗？' },
      { id: 's2', text: '不能。我们还要回到独立来源核对姓名、年份和数据。' },
    ] }, expected).map((item) => item.id)).toEqual(['s1', 's2']);
    expect(() => normalizeNarrationRewrite({ segments: [...expected].reverse() }, expected)).toThrow(/保留 id/);
  });

  it('accepts an optimized rewrite even when it exceeds the original timing range', () => {
    const timedOutline = {
      ...outline,
      timingPlan: {
        unit: 'cjk-char', targetUnits: 100, minUnits: 90, maxUnits: 110,
      } as NonNullable<SceneOutline['timingPlan']>,
    };
    expect(normalizeNarrationRewrite(
      { segments: [{ id: 's1', text: `${'学'.repeat(70)}。${'习'.repeat(70)}。` }] },
      [{ id: 's1', text: '原讲稿。' }],
    )[0]?.text.length).toBeGreaterThan(timedOutline.timingPlan.maxUnits);
  });

  it('rewrites speech text without changing action order or non-speech actions', async () => {
    const actions: Action[] = [
      { id: 's1', type: 'speech', text: '这一页的核心观点是流畅不等于真实。' },
      { id: 'laser', type: 'laser', elementId: 'claim' },
      { id: 's2', type: 'speech', text: '资料1告诉我们要核验。' },
    ];
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ segments: [
      { id: 's1', text: '大家先看这个回答。它说得很顺，但流畅只能说明表达自然。' },
      { id: 's2', text: '判断事实是否可靠，还要找到独立来源，逐项核对姓名、年份和数据。' },
    ] }));
    const rewritten = await naturalizeKnowledgeNarration({ outline, actions, aiCall: ai });
    expect(rewritten.map((action) => action.id)).toEqual(['s1', 'laser', 's2']);
    expect(rewritten[1]).toEqual(actions[1]);
    expect(narrationStyleIssues(rewritten.flatMap((action) => action.type === 'speech'
      ? [{ id: action.id, text: action.text }]
      : []))).toEqual([]);
  });

  it('retries an invalid rewrite and requires the corrected narration', async () => {
    const actions: Action[] = [{ id: 's1', type: 'speech', text: '首遍讲稿。' }];
    const ai = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ segments: [{ id: 's1', text: '这一页的核心观点是核验。' }] }))
      .mockResolvedValueOnce(JSON.stringify({ segments: [{ id: 's1', text: '判断信息是否可靠，要回到独立来源核对事实。' }] }));
    const rewritten = await naturalizeKnowledgeNarration({ outline, actions, aiCall: ai });
    expect(ai).toHaveBeenCalledTimes(2);
    expect(ai.mock.calls[1]?.[1]).toContain('上一次结果未通过验收');
    expect(rewritten[0]).toMatchObject({ type: 'speech', text: expect.stringContaining('独立来源') });
    expect(NATURAL_NARRATION_VERSION).toBe('natural-teacher-speech-v2');
  });

  it('stops generation after two invalid rewrites instead of returning the first draft', async () => {
    const actions: Action[] = [{ id: 's1', type: 'speech', text: '首遍讲稿。' }];
    const ai = vi.fn().mockResolvedValue(JSON.stringify({
      segments: [{ id: 's1', text: '这一页的核心观点仍然是核验。' }],
    }));
    await expect(naturalizeKnowledgeNarration({ outline, actions, aiCall: ai }))
      .rejects.toThrow(/已停止课程生成/);
    expect(ai).toHaveBeenCalledTimes(2);
  });
});
