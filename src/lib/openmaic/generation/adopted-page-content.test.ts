import { describe, expect, it } from 'vitest';
import type { SceneOutline } from '@/lib/openmaic/types/generation';
import { adoptedPageAuthoringContent } from './adopted-page-content';

const clauses = [
  '选择材料时，需要同时保留正例、反例和适用条件。',
  '设计任务时，要依据学生认知能力调整难度与复杂程度。',
  '实践应用的同时，要引导学生思考道德伦理问题。',
];
const outline: SceneOutline = {
  id: 'source-page', type: 'slide', title: '完整设计要求', order: 0,
  description: '依据条件组织教学', generationPurpose: 'knowledge-teaching',
  keyPoints: [...clauses],
  teachingBrief: {
    schemaVersion: 1, explanation: '讲解每项要求的依据与作用', examples: ['讲稿中的扩展实例'],
    conditions: [], evidence: [{ sourceId: 'private-source', quote: '仅作来源证据的原文' }],
    assessmentFocus: '判断设计是否符合条件',
    teachingPlan: {
      purpose: '完整执行要求', priorKnowledge: '', newContent: '设计约束', learnerQuestion: '',
      reasoningSteps: [], takeaway: '保留条件', visibleContent: clauses,
      presentationContent: clauses,
      narrationFocus: ['只在讲稿中展开机制'],
    },
  },
};

describe('adopted page authoring content', () => {
  it('compiles complete local display duties without adding narration or metadata', () => {
    const catalog = adoptedPageAuthoringContent(outline);
    expect(catalog.map((item) => item.text)).toEqual(clauses);
    expect(catalog.every((item) => item.required)).toBe(true);
    expect(new Set(catalog.map((item) => item.id)).size).toBe(3);
    expect(JSON.stringify(catalog)).not.toContain('private-source');
    expect(JSON.stringify(catalog)).not.toContain('讲稿中的扩展实例');
    expect(adoptedPageAuthoringContent(outline)).toEqual(catalog);
  });

  it('preserves full clauses beside concise labels and distinct qualifications', () => {
    const catalog = adoptedPageAuthoringContent({ ...outline,
      keyPoints: ['设计任务'], teachingBrief: { ...outline.teachingBrief!, teachingPlan: {
        ...outline.teachingBrief!.teachingPlan!,
        presentationContent: [...clauses, '仅在成人监督下开展实践活动。'],
      } },
    });
    expect(catalog.map((item) => item.text)).toEqual([...clauses, '仅在成人监督下开展实践活动。']);
  });

  it('leaves exact diagram labels to their compiler while retaining step explanations', () => {
    const annotation = '先提出问题，再根据证据得出结论。';
    const catalog = adoptedPageAuthoringContent({ ...outline, keyPoints: ['提出问题', annotation,
      '提出问题时，需要明确研究对象与可验证的条件。'], teachingBrief: { ...outline.teachingBrief!,
      teachingPlan: { ...outline.teachingBrief!.teachingPlan!, presentationContent: ['提出问题', annotation,
        '提出问题时，需要明确研究对象与可验证的条件。'] } },
    visualIntent: { representation: 'native-diagram', observationGoal: '观察步骤关系', diagram: {
      topology: 'sequence', nodes: [{ id: 'a', label: '提出问题' }, { id: 'b', label: '得出结论' }],
      edges: [{ from: 'a', to: 'b' }], annotation,
    } } });
    expect(catalog.map((item) => item.text)).toEqual(['提出问题时，需要明确研究对象与可验证的条件。']);
  });

  it('does not move lecture content into teacher modules or other page responsibilities', () => {
    expect(adoptedPageAuthoringContent({ ...outline, audience: 'teacher' })).toEqual([]);
    expect(adoptedPageAuthoringContent({ ...outline, generationPurpose: 'facilitation-scaffold' })).toEqual([]);
    expect(adoptedPageAuthoringContent({ ...outline, type: 'interactive' })).toEqual([]);
  });

  it('does not force historical full source passages onto the slide', () => {
    expect(adoptedPageAuthoringContent({ ...outline, teachingBrief: { ...outline.teachingBrief!,
      teachingPlan: { ...outline.teachingBrief!.teachingPlan!, presentationContent: undefined } } })).toEqual([]);
  });
});
