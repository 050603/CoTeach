import { describe, expect, it } from 'vitest';
import type { SceneOutline, GeneratedSlideContent } from '@/lib/openmaic/types/generation';
import { assertSourceSequencesInOutlines, type FigureSequenceContract } from './course-visual-binding';
import { findSourceContentIssues, findSectionSourceContentIssues } from '@/lib/course-generation/source-content-acceptance';
import { mergeSourceSequenceUses, normalizeSourceSequenceUses, scopeSourceSequenceContracts, type SourceSequenceUse } from './source-sequence-use';

const source = (id: string, labels: string[]): FigureSequenceContract => ({ resourceId: id,
  required: false, coveragePolicy: 'authored-scope', scope: 'knowledge-point',
  knowledgePointIds: ['topic'], sequenceSemantics: 'ordered-steps',
  orderedSteps: labels.map((label, index) => ({ label, sourceBlockId: `${id}-${index}` })) });
const first = source('book-a', ['观察', '猜想', '验证']);
const second = source('book-b', ['猜想', '观察', '验证']);
function outline(text: string, uses: SourceSequenceUse[]): SceneOutline {
  return { id: 'p1', order: 0, type: 'slide', title: '探究路径', description: text,
    keyPoints: [text], knowledgePointIds: ['topic'], generationPurpose: 'knowledge-teaching',
    teachingBrief: { schemaVersion: 1, explanation: text, examples: [], conditions: [], evidence: [],
      assessmentFocus: '根据证据检验猜想', teachingPlan: { purpose: '解释实际路径', priorKnowledge: '',
        newContent: text, learnerQuestion: '', reasoningSteps: [], takeaway: text,
        visibleContent: [text], narrationFocus: [text], sourceSequenceUses: uses } } };
}
function content(text: string): GeneratedSlideContent {
  return { elements: [{ id: 't', type: 'text', content: text, left: 60, top: 140, width: 800, height: 120 }] } as GeneratedSlideContent;
}

describe('goal-scoped textbook references', () => {
  it('does not impose a textbook contract on a course without textbooks', () => {
    const page = outline('根据观察提出可检验的猜想，并用证据判断。', []);
    expect(scopeSourceSequenceContracts([], [page])).toEqual([]);
    expect(() => assertSourceSequencesInOutlines([page], [])).not.toThrow();
    expect(findSourceContentIssues([{ outline: page, content: content(page.description) }], [])).toEqual([]);
  });

  it('keeps unused complete references intact without adding course duties', () => {
    const page = outline('观察需要区分事实与解释，不把猜想当成已发生的结果。', []);
    const scoped = scopeSourceSequenceContracts([first, second], [page]);
    expect(scoped.every((item) => !item.required)).toBe(true);
    expect(scoped[0]?.orderedSteps).toEqual(first.orderedSteps);
    expect(() => assertSourceSequencesInOutlines([page], [first, second])).not.toThrow();
  });

  it.each([first, second])('accepts either actual source path without forcing the other book', (chosen) => {
    const text = `流程包括${chosen.orderedSteps!.map((step) => step.label).join('→')}。`;
    const page = outline(text, [{ resourceId: chosen.resourceId, coverage: 'complete' }]);
    expect(scopeSourceSequenceContracts([first, second], [page]).filter((item) => item.required)
      .map((item) => item.resourceId)).toEqual([chosen.resourceId]);
    expect(() => assertSourceSequencesInOutlines([page], [first, second])).not.toThrow();
    expect(findSourceContentIssues([{ outline: page, content: content(text) }], [first, second])).toEqual([]);
  });

  it.each([
    ['流程包括观察→验证。', '遗漏教材步骤'],
    ['流程包括猜想→观察→验证。', '步骤顺序'],
    ['流程有两个步骤，包括观察→猜想→验证。', '写成 2 个环节'],
  ])('retains actual chosen source integrity for %s', (text, error) => {
    const page = outline(text, [{ resourceId: first.resourceId, coverage: 'complete' }]);
    expect(() => assertSourceSequencesInOutlines([page], [first, second])).toThrow(error);
    expect(findSourceContentIssues([{ outline: page, content: content(text) }], [first, second])[0]?.detail).toContain(error);
  });

  it('checks selected facts without requiring a whole unused framework', () => {
    const use: SourceSequenceUse = { resourceId: first.resourceId, coverage: 'selected', sourceStepIds: ['book-a-0'] };
    const page = outline('本页选讲其中的观察：记录实际现象，区分事实与解释。', [use]);
    expect(() => assertSourceSequencesInOutlines([page], [first, second])).not.toThrow();
    expect(findSourceContentIssues([{ outline: page, content: content(page.description) }], [first, second])).toEqual([]);
    const lost = content('记录现象，区分事实与解释。');
    expect(findSourceContentIssues([{ outline: page, content: lost }], [first])[0]?.missingCanonicalLabels).toEqual(['观察']);
    expect(findSectionSourceContentIssues([page], [{ outline: page, content: lost }], [first])[0]?.missingCanonicalLabels).toEqual(['观察']);
  });

  it('never treats selected fact metadata as actual explanation or native teaching', () => {
    const page = outline('有相关步骤。', [{ resourceId: first.resourceId, coverage: 'selected', sourceStepIds: ['book-a-0'] }]);
    expect(() => assertSourceSequencesInOutlines([page], [first])).toThrow('遗漏教材步骤');
    expect(findSourceContentIssues([{ outline: page, content: content('有相关步骤。') }], [first])).not.toEqual([]);
  });

  it('keeps original whole-list counts even for selected teaching', () => {
    const page = outline('流程有两个步骤，包括观察→猜想。', [{ resourceId: first.resourceId,
      coverage: 'selected', sourceStepIds: ['book-a-0', 'book-a-1'] }]);
    expect(() => assertSourceSequencesInOutlines([page], [first])).toThrow('写成 2 个环节');
  });

  it('allows an explicit selected diagram while preserving actual step order', () => {
    const page = outline('本页选讲前两个步骤，后续还有验证。', [{ resourceId: first.resourceId,
      coverage: 'selected', sourceStepIds: ['book-a-0', 'book-a-1'] }]);
    page.visualIntent = { representation: 'native-diagram', observationGoal: '辨认选讲步骤的先后', diagram: { topology: 'sequence',
      nodes: [{ id: 'n1', label: '观察' }, { id: 'n2', label: '猜想' }] } };
    page.keyPoints = ['观察→猜想'];
    page.teachingBrief!.teachingPlan!.visibleContent = ['观察→猜想'];
    expect(() => assertSourceSequencesInOutlines([page], [first])).not.toThrow();
    page.visualIntent!.diagram!.nodes.reverse();
    expect(() => assertSourceSequencesInOutlines([page], [first])).toThrow('步骤顺序');
  });

  it('retains the contract of accepted legacy checkpoints', () => {
    const page = outline('流程包括观察→猜想。', []);
    delete page.teachingBrief!.teachingPlan!.sourceSequenceUses;
    expect(() => assertSourceSequencesInOutlines([page], [first])).toThrow('遗漏教材步骤');
  });

  it('merges actual selected source duties during page redistribution without erasing complete duties', () => {
    const pages = [outline('观察', [{ resourceId: first.resourceId, coverage: 'selected', sourceStepIds: ['book-a-0'] }]),
      outline('猜想', [{ resourceId: first.resourceId, coverage: 'selected', sourceStepIds: ['book-a-1'] }])];
    expect(mergeSourceSequenceUses(pages)).toEqual([{ resourceId: first.resourceId, coverage: 'selected',
      sourceStepIds: ['book-a-0', 'book-a-1'] }]);
    pages.push(outline('完整流程', [{ resourceId: first.resourceId, coverage: 'complete' }]));
    expect(mergeSourceSequenceUses(pages)).toEqual([{ resourceId: first.resourceId, coverage: 'complete' }]);
  });

  it('validates real adopted identities for complete and selected use', () => {
    const uses = [{ resourceId: first.resourceId, coverage: 'selected', sourceStepIds: ['book-a-0'] }];
    expect(normalizeSourceSequenceUses(uses, [first], ['topic'])).toEqual({ uses, issues: [] });
    expect(normalizeSourceSequenceUses([{ resourceId: first.resourceId, coverage: 'complete' }], [first], ['topic']).issues).toEqual([]);
  });

  it.each([
    [{ resourceId: 'unknown', coverage: 'complete' }],
    [{ resourceId: first.resourceId, coverage: 'selected', sourceStepIds: [] }],
    [{ resourceId: first.resourceId, coverage: 'selected', sourceStepIds: ['book-b-0'] }],
    [{ resourceId: first.resourceId, coverage: 'selected', sourceStepIds: ['book-a-0', 'book-a-0'] }],
    [{ resourceId: first.resourceId, coverage: 'complete' }, { resourceId: first.resourceId, coverage: 'complete' }],
  ].map((uses) => ({ uses })))('rejects uncheckable or duplicate source use %j', ({ uses }) => {
    const issues = normalizeSourceSequenceUses(uses, [first], ['topic']).issues;
    expect(issues.length).toBeGreaterThan(0);
    expect(issues).not.toContain('sourceSequenceUses 必须为数组');
  });
});
