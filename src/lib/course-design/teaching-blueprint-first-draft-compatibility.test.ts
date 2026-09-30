import { describe, expect, it, vi } from 'vitest';
import fixture from './__fixtures__/teaching-methods-blueprint-first-draft.json';
import { buildTeachingBlueprintPrompt, generateTeachingBlueprint, teachingBlueprintToOutlines,
  validateTeachingBlueprintBudget, validateTeachingBlueprintDraft, type TeachingBlueprintInput } from './teaching-blueprint';

function sample() {
  const section = structuredClone(fixture.section);
  const nodes = new Set(section.units.flatMap((unit) => unit.explanationNodes.map((node) => node.id)));
  // Isolate this real final section without pretending earlier sections are
  // present. Definitions, teaching ownership and the empty quiz stay verbatim.
  section.pages.forEach((page) => { page.referencesNodeIds = page.referencesNodeIds.filter((id) => nodes.has(id)); });
  section.units.forEach((unit) => { unit.requirementIds = []; unit.difficultyStrategies = []; });
  const input: TeachingBlueprintInput = {
    courseTitle: '教学方法', subject: '教育学', grade: '大学', learningObjectives: ['解释并比较两种方法'],
    projectContext: '设计人工智能教案', totalDurationSec: 600, assessmentMode: 'adaptive', generationMode: 'standard',
    knowledgePoints: [{ ...fixture.point, teachingRole: 'core-concept', level: 'core', teachingDepth: 'detailed',
      parentKnowledgePointIds: [], sourceSequenceReferences: [] }],
    sourceContext: section.units.flatMap((unit) => unit.evidenceQuotes).join('\n'),
  };
  return { input, candidate: { authoringContract: 'blueprint-v1', sections: [section] } };
}

describe('first-draft blueprint compatibility from the real teaching-methods response', () => {
  it('replays distinct source-backed definitions and folds only the empty terminal placeholder into one formal quiz', async () => {
    const { input, candidate } = sample();
    const original = structuredClone(candidate);
    const aiCall = vi.fn();
    const blueprint = await generateTeachingBlueprint(input, aiCall, { repairFrom: { candidate, issues: [] } });
    expect(aiCall).not.toHaveBeenCalled();
    expect(candidate).toEqual(original);
    expect(blueprint.sections[0]!.pages).toHaveLength(3);
    expect(blueprint.sections[0]!.assessmentFocus).toContain('检验两种方法的区别和选择。');
    expect(blueprint.sections[0]!.units[0]!.explanationNodes?.map((node) => node.content))
      .toEqual(candidate.sections[0]!.units[0]!.explanationNodes.map((node) => node.content));
    const outlines = teachingBlueprintToOutlines(blueprint, '使用简体中文');
    expect(outlines.filter((page) => page.type === 'quiz')).toHaveLength(1);
    expect(outlines.find((page) => page.type === 'quiz')).toMatchObject({
      knowledgePointIds: ['kp-6'], assessmentUnitIds: [blueprint.sections[0]!.units[0]!.id],
      quizConfig: expect.objectContaining({ questionCount: expect.any(Number) }),
    });
    expect(validateTeachingBlueprintBudget(blueprint, outlines)).toEqual([]);
    const prompt = buildTeachingBlueprintPrompt(input);
    expect(prompt.system).toContain('禁止 widgetType=quiz');
    expect(prompt.user).toContain('"requiredDefinitionNames":["支架式教学法","抛锚式教学法"]');
    expect(prompt.user).toContain('无需输出“小测”page');
  });

  it.each(['nonempty widget', 'new teaching node', 'not terminal', 'authored question', 'malformed body'])
    ('refuses to discard a quiz with %s', (mutation) => {
      const { input, candidate } = sample();
      const pages = candidate.sections[0]!.pages;
      const quiz = pages.at(-1)!;
      if (mutation === 'nonempty widget') quiz.widgetOutline = { questions: ['必须保留的真实题干'] };
      if (mutation === 'new teaching node') quiz.introducesNodeIds = ['u6-node1'];
      if (mutation === 'not terminal') pages.unshift(pages.pop()!);
      if (mutation === 'authored question') quiz.keyPoints = ['哪一种方法先提供临时支架？'];
      if (mutation === 'malformed body') Object.assign(quiz, { keyPoints: '不能因非数组而丢掉的真实题干' });
      expect(validateTeachingBlueprintDraft(candidate, input).issues.join('；')).toContain('不能作为互动页静默丢弃');
    });

  it.each(['missing definition', 'heading only', 'not taught', 'unconfirmed split'])
    ('rejects a combined concept with %s', (mutation) => {
      const { input, candidate } = sample();
      const section = candidate.sections[0]!;
      const node = section.units[0]!.explanationNodes.find((entry) => entry.id === 'u6-node3')!;
      if (mutation === 'missing definition') node.kind = 'example';
      if (mutation === 'heading only') node.content = '抛锚式教学法';
      if (mutation === 'not taught') section.pages.forEach((page) => {
        page.introducesNodeIds = page.introducesNodeIds.filter((id) => id !== node.id);
        page.deepensNodeIds = page.deepensNodeIds.filter((id) => id !== node.id);
      });
      if (mutation === 'unconfirmed split') input.knowledgePoints = input.knowledgePoints.map((point) => ({
        ...point, sourceKnowledgePointNames: ['支架式与抛锚式教学法'],
      }));
      expect(validateTeachingBlueprintDraft(candidate, input).issues.join('；')).toMatch(/核心概念.*(?:缺少|未由任何页面)/u);
    });
});
