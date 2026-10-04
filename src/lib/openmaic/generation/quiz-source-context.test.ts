import { describe, expect, it, vi } from 'vitest';
import type { SceneOutline } from '@/lib/openmaic/types/generation';
import { formatCourseEvidenceContext, type CourseEvidenceSnapshot } from '@/lib/textbook/course-evidence-types';
import { generateSceneContent } from './scene-generator';
import { quizOriginalTeachingSources, quizSupplementarySourceContext } from './quiz-source-context';

const original = `随机抽样减少人为选择偏差，但不保证每个样本都没有随机误差。${'完整原文中的解释与案例，保持全部事实和必要条件。'.repeat(800)}`;
const nextSection = '下一节独立主题的完整教材原文。';
const evidence: CourseEvidenceSnapshot = {
  schemaVersion: 2, version: 1, fingerprint: 'book-evidence', createdAt: '2026-10-03',
  retrievalMode: 'hybrid', selections: [{ revisionId: 'book-v1', primary: true, sectionIds: [] }], warnings: [],
  items: ['adopted-a', 'adopted-b', 'unadopted'].map((id) => ({
    id, kind: 'source-block', title: id, content: id === 'unadopted' ? nextSection : original,
    source: { textbookId: 'book', textbookTitle: '统计教材', revisionId: 'book-v1', revisionVersion: 1,
      sectionPath: ['抽样'], sourceBlockId: id === 'unadopted' ? 'later-block' : 'original-block',
      quote: id === 'unadopted' ? nextSection : original },
    completeSourceBlocks: [{ sourceBlockId: id === 'unadopted' ? 'later-block' : 'original-block',
      content: id === 'unadopted' ? nextSection : original }],
    sourceSequences: [{ anchorSourceBlockId: 'list', kind: 'ordered-steps', steps: [
      { label: '确定总体', sourceBlockId: 'list-1', excerpt: '先界定总体和个体。' },
      { label: '随机抽取', sourceBlockId: 'list-2', excerpt: '随后根据已确定的抽取规则选择样本。' },
    ] }],
  })),
  mappings: Array.from({ length: 40 }, (_, index) => ({
    sourceKnowledgePointId: `mapped-${index}`, sourceKnowledgePointName: '抽样', status: 'direct',
    evidenceItemIds: ['adopted-a', 'adopted-b', 'unadopted'], rationale: '保留原文',
  })),
};
const quiz: SceneOutline = { id: 'quiz', type: 'quiz', title: '抽样 · 节末小测', order: 1,
  description: '判断随机抽样的条件', keyPoints: ['选择偏差与随机误差'], knowledgePointIds: ['sampling'],
  quizConfig: { questionCount: 1, difficulty: 'medium', questionTypes: ['short_answer'] } };
const sources = { sourceEvidence: evidence,
  sourceKnowledgePoints: [{ id: 'sampling', evidenceItemIds: ['adopted-a', 'adopted-b'] }] };

describe('quiz original source context', () => {
  it('shares complete adopted passages while retaining each evidence identity and original sequence', () => {
    const result = quizOriginalTeachingSources(quiz, sources);
    expect(Object.values(result.catalog.texts).filter((text) => text === original)).toHaveLength(1);
    expect(Object.values(result.catalog.texts)).not.toContain(nextSection);
    expect(result.scope?.originalSourceRefs).toHaveLength(2);
    const adopted = Object.values(result.catalog.sources) as Array<{
      evidenceId: string; revisionId: string; primary: boolean;
      passages: Array<{ sourceBlockId: string; textRef: string }>;
      originalSequences: Array<{ steps: Array<{ labelRef: string; explanationRef: string }> }>;
    }>;
    expect(adopted.map((source) => source.evidenceId)).toEqual(['adopted-a', 'adopted-b']);
    for (const source of adopted) {
      expect(source).toMatchObject({ revisionId: 'book-v1', primary: true });
      expect(source.passages[0]?.sourceBlockId).toBe('original-block');
      expect(result.catalog.texts[source.passages[0]!.textRef]).toBe(original);
      expect(source.originalSequences[0]?.steps.map((step) => [result.catalog.texts[step.labelRef], result.catalog.texts[step.explanationRef]]))
        .toEqual([['确定总体', '先界定总体和个体。'], ['随机抽取', '随后根据已确定的抽取规则选择样本。']]);
    }
  });

  it.each([false, true])('removes only the same rendered evidence, retaining teacher and supplementary sources (deduplicated=%s)', (deduplicateItems) => {
    const context = formatCourseEvidenceContext(evidence, { deduplicateItems });
    const teacher = '教师要求：结合指定班级的抽样案例分析。';
    const supplementary = '教师补充资料：保留原始观察数据和边界条件。';
    const result = quizSupplementarySourceContext([teacher, context, supplementary].join('\n\n'), evidence);
    expect(result).toContain(teacher);
    expect(result).toContain(supplementary);
    expect(result).not.toContain(nextSection);
    expect(result).not.toContain(context);
  });

  it('retains unstructured sources and evidence from a different immutable source version', () => {
    const context = formatCourseEvidenceContext(evidence);
    expect(quizSupplementarySourceContext(context)).toBe(context);
    expect(quizSupplementarySourceContext(context, { ...evidence,
      items: evidence.items.map((item) => ({ ...item, source: { ...item.source, revisionId: 'book-v2' } })) })).toBe(context);
  });

  it('honors an explicit empty adoption without reintroducing the course-wide textbook', () => {
    const result = quizOriginalTeachingSources(quiz, { ...sources,
      sourceKnowledgePoints: [{ id: 'sampling', evidenceItemIds: [] }] });
    expect(result.scope?.originalSourceRefs).toEqual([]);
    expect(result.catalog.texts).toEqual({});
    expect(quizSupplementarySourceContext(formatCourseEvidenceContext(evidence), evidence)).toBe('');
  });

  it('keeps the actual quiz call below the provider limit with full adopted originals and supplementary input', async () => {
    const context = formatCourseEvidenceContext(evidence);
    expect(context.length).toBeGreaterThan(1_000_000);
    const ai = vi.fn().mockResolvedValue(JSON.stringify([{ id: 'q1', type: 'short_answer',
      question: '随机抽样能保证样本没有随机误差吗？', referenceAnswer: '不能。',
      analysis: '随机抽样减少人为选择偏差，仍然可能出现随机误差。', knowledgePointIds: ['sampling'], points: 10 }]));
    const result = await generateSceneContent(quiz, ai, { ...sources,
      userRequirements: { requirement: '根据实际讲授范围出题', teachingSourceContext: `教师的补充原始数据必须保留。\n\n${context}` } });
    const [system, prompt] = ai.mock.calls[0]!;
    expect(system.length + prompt.length).toBeLessThan(1_000_000);
    expect(prompt).toContain(original);
    expect(prompt.split(original)).toHaveLength(2);
    expect(prompt).toContain('教师的补充原始数据必须保留。');
    expect(prompt).toContain('adopted-a');
    expect(prompt).toContain('adopted-b');
    expect(prompt).not.toContain(nextSection);
    expect(result && 'questions' in result && result.questions).toHaveLength(1);
    expect(ai).toHaveBeenCalledOnce();
  });
});
