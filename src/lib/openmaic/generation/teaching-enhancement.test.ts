import { describe, expect, it, vi } from 'vitest';
import type { AICallFn } from './pipeline-types';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import {
  enhanceTeachingBriefs,
  hasCompleteTeachingBrief,
  normalizeTeachingEnhancement,
  withTeachingEnhancement,
} from './teaching-enhancement';

function page(id: string, order: number): SceneOutline {
  return {
    id,
    type: 'slide',
    title: `页面${order + 1}`,
    description: '解释人工智能输出与证据之间的关系。',
    keyPoints: ['流畅表达不能代替事实核验'],
    teachingObjective: '能够说明核验步骤和理由',
    order,
    generationPurpose: 'knowledge-teaching',
    parentActivityId: 'section-1',
  };
}

describe('formal course teaching enhancement', () => {
  it('treats malformed stored briefs as incomplete instead of crashing a resumed job', () => {
    const malformed = page('p1', 0);
    malformed.teachingBrief = {
      schemaVersion: 1,
      explanation: '已有解释',
      examples: undefined,
      conditions: ['已有条件'],
      evidence: [],
      assessmentFocus: '已有考查重点',
    } as unknown as NonNullable<SceneOutline['teachingBrief']>;
    expect(hasCompleteTeachingBrief(malformed)).toBe(false);
  });

  it('accepts complete page designs and keeps only exact source evidence', () => {
    const source = '指导文件要求：学生需要核验生成内容的事实与来源。';
    const briefs = normalizeTeachingEnhancement({ pages: [{
      outlineId: 'p1',
      explanation: '表达流畅来自语言模式，不能证明事实成立。',
      examples: ['核对校史年份：先标出主张，再查官方校志并记录差异。'],
      conditions: ['官网转载同一错误时，不能算作独立来源。'],
      assessmentFocus: '说明核验步骤以及每一步的理由。',
      evidenceQuotes: ['学生需要核验生成内容的事实与来源', '并不存在的原句'],
    }] }, [page('p1', 0)], source);
    const brief = briefs.get('p1');
    expect(brief?.examples).toHaveLength(1);
    expect(brief?.conditions).toHaveLength(1);
    expect(brief?.evidence).toEqual([
      { sourceId: 'course-source', quote: '学生需要核验生成内容的事实与来源' },
    ]);
  });

  it('creates one shared design call and propagates page briefs into the section quiz', async () => {
    const pages = [page('p1', 0), page('p2', 1)];
    const quiz = {
      ...page('quiz', 2),
      type: 'quiz' as const,
      quizConfig: { questionCount: 2, difficulty: 'medium' as const, questionTypes: ['short_answer' as const] },
    };
    const ai = vi.fn<AICallFn>().mockResolvedValue(JSON.stringify({ pages: pages.map((item) => ({
      outlineId: item.id,
      explanation: `${item.id} 的机制解释`,
      examples: [`${item.id} 的完整示例`],
      conditions: [`${item.id} 的适用条件`],
      assessmentFocus: `${item.id} 的解释与应用`,
      evidenceQuotes: [],
    })) }));
    const outlines = await enhanceTeachingBriefs({
      outlines: [...pages, quiz],
      courseTitle: '生成式人工智能通识',
      requirement: '面向中学生讲解人工智能核验',
      aiCall: ai,
    });
    expect(ai).toHaveBeenCalledOnce();
    expect(outlines.slice(0, 2).every(hasCompleteTeachingBrief)).toBe(true);
    expect(outlines[2]?.teachingBrief?.examples).toEqual(['p1 的完整示例', 'p2 的完整示例']);
    expect(outlines[2]?.teachingBrief?.assessmentFocus).toContain('p1 的解释与应用');
  });

  it('splits teaching design by section and reports bounded progress', async () => {
    const first = page('p1', 0);
    const second = { ...page('p2', 1), parentActivityId: 'section-2' };
    const progress: string[] = [];
    const ai = vi.fn<AICallFn>().mockImplementation(async (_system, user) => {
      const outlineId = user.includes('[p1]') ? 'p1' : 'p2';
      return JSON.stringify({ pages: [{
        outlineId,
        explanation: `${outlineId} 的机制解释`,
        examples: [`${outlineId} 的完整示例`],
        conditions: [`${outlineId} 的适用条件`],
        assessmentFocus: `${outlineId} 的解释与应用`,
        evidenceQuotes: [],
      }] });
    });
    const outlines = await enhanceTeachingBriefs({
      outlines: [first, second],
      requirement: '分小节完成教学设计',
      aiCall: ai,
      concurrency: 2,
      onProgress: ({ completedSections, totalSections }) => {
        progress.push(`${completedSections}/${totalSections}`);
      },
    });
    expect(ai).toHaveBeenCalledTimes(2);
    expect(ai.mock.calls.every(([, user]) => !(user.includes('[p1]') && user.includes('[p2]')))).toBe(true);
    expect(outlines.every(hasCompleteTeachingBrief)).toBe(true);
    expect(progress[0]).toBe('0/2');
    expect(progress.at(-1)).toBe('2/2');
  });

  it('rejects an incomplete course design instead of silently mixing enhanced and baseline pages', async () => {
    const first = page('p1', 0);
    const second = { ...page('p2', 1), parentActivityId: 'section-2' };
    const warnings: string[] = [];
    const progress: string[] = [];
    const ai = vi.fn<AICallFn>().mockImplementation(async (_system, user) => (
      user.includes('[p1]')
        ? JSON.stringify({ pages: [{
            outlineId: 'p1',
            explanation: 'p1 的机制解释',
            examples: ['p1 的完整示例'],
            conditions: ['p1 的适用条件'],
            assessmentFocus: 'p1 的解释与应用',
            evidenceQuotes: [],
          }] })
        : '{"pages":['
    ));
    await expect(enhanceTeachingBriefs({
      outlines: [first, second],
      requirement: '一个小节失败时保留其他增强结果',
      aiCall: ai,
      concurrency: 4,
      onWarning: (warning) => { warnings.push(warning); },
      onProgress: ({ completedSections, totalSections }) => {
        progress.push(`${completedSections}/${totalSections}`);
      },
    })).rejects.toThrow('教学增强未完整生成');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('页面2');
    expect(progress[0]).toBe('0/2');
    expect(progress.at(-1)).toBe('2/2');
  });

  it('keeps the system prefix stable while putting page design only in the user message', async () => {
    const first = page('p1', 0);
    first.teachingBrief = {
      schemaVersion: 1,
      explanation: '解释一', examples: ['例子一'], conditions: ['条件一'], evidence: [], assessmentFocus: '考查一',
    };
    const second = page('p2', 1);
    second.teachingBrief = {
      schemaVersion: 1,
      explanation: '解释二', examples: ['例子二'], conditions: ['条件二'], evidence: [], assessmentFocus: '考查二',
    };
    const ai = vi.fn<AICallFn>().mockResolvedValue('ok');
    await withTeachingEnhancement(ai, first, 'content')('base-system', 'base-user');
    await withTeachingEnhancement(ai, second, 'content')('base-system', 'base-user');
    expect(ai.mock.calls[0]?.[0]).toBe(ai.mock.calls[1]?.[0]);
    expect(ai.mock.calls[0]?.[0]).not.toContain('解释一');
    expect(ai.mock.calls[0]?.[1]).toContain('解释一');
    expect(ai.mock.calls[1]?.[1]).toContain('解释二');
  });
});
