import { describe, expect, it, vi } from 'vitest';
import fixture from './__fixtures__/blueprint-definition-ownership-first-draft.json';
import { buildTeachingBlueprintPrompt, generateTeachingBlueprint, revalidateStoredTeachingBlueprint,
  teachingBlueprintToOutlines, validateTeachingBlueprintDraft, type TeachingBlueprintInput } from './teaching-blueprint';

function sample(kind: 'concept' | 'orphan') {
  const { point, unit, page } = structuredClone(fixture[kind]);
  // Isolate the exact authored unit and page. Earlier units and the image
  // registry are outside this local contract test, not removed from the course.
  unit.requirementIds = [];
  unit.difficultyStrategies = [];
  const ids = new Set(unit.explanationNodes.map((node) => node.id));
  unit.explanationNodes.forEach((node) => {
    node.prerequisiteNodeIds = node.prerequisiteNodeIds.filter((id) => ids.has(id));
  });
  page.referencesNodeIds = page.referencesNodeIds.filter((id) => ids.has(id));
  page.caseObservation = { kind: 'none', subjects: [], observableDifference: '',
    reason: '本测试仅隔离定义与节点归属，原课图片由完整重放核对。', composition: '', resourceIds: [] };
  const input: TeachingBlueprintInput = {
    courseTitle: '教学理论', subject: '教育学', grade: '大学', learningObjectives: [unit.learningOutcome],
    totalDurationSec: 1_200, projectContext: '', assessmentMode: 'adaptive', generationMode: 'standard',
    knowledgePoints: [{ ...point, teachingRole: kind === 'concept' ? 'core-concept' : 'detail-concept',
      level: 'core', teachingDepth: 'detailed' }],
    sourceContext: unit.evidenceQuotes.join('\n'),
  };
  const candidate = { authoringContract: 'blueprint-v1', sections: [{
    title: unit.title, learningObjective: unit.learningOutcome,
    sharedContext: { learningPurpose: unit.learningOutcome, caseId: '', caseFacts: [], fixedWording: [],
      stableTerms: [point.name], conceptBoundaries: ['既要说清概念含义，也要说明其适用条件。'] },
    units: [unit], pages: [page], assessmentFocus: [unit.learningOutcome],
    understandingCriteria: { goals: [unit.learningOutcome], answerEssentials: [point.description],
      misconceptions: ['不能只记名称而忽略必要条件。'], supportingUnitIds: [unit.id] },
  }] };
  return { input, candidate };
}

describe('source-faithful definition and unique unit ownership from saved first draft', () => {
  it('accepts the entire confirmed proposition with a grammatical copula and no model call', async () => {
    const { input, candidate } = sample('concept');
    const original = structuredClone(candidate);
    const ai = vi.fn();
    const blueprint = await generateTeachingBlueprint(input, ai, { repairFrom: { candidate, issues: [] } });
    expect(ai).not.toHaveBeenCalled();
    expect(candidate).toEqual(original);
    expect(blueprint.sections[0]!.units[0]!.explanationNodes?.[0]?.content)
      .toBe(fixture.concept.unit.explanationNodes[0]!.content);
    expect(revalidateStoredTeachingBlueprint(blueprint, input).issues).toEqual([]);
    expect(buildTeachingBlueprintPrompt(input).system).toContain('定义要同时讲清主题和完整主张');
  });

  it.each(['only subject', 'changed claim', 'negated claim', 'authoring task', 'only heading', 'wrong kind'])
    ('keeps the definition gate for %s', (mutation) => {
      const { input, candidate } = sample('concept');
      const node = candidate.sections[0]!.units[0]!.explanationNodes[0]!;
      if (mutation === 'only subject') node.content = '具身认知的核心观点是本节要讨论的主题，下面将说明它在课堂活动中的应用方式。';
      if (mutation === 'changed claim') node.content = node.content.replace('认知根植于身体与环境的交互', '认知只存在于大脑内部');
      if (mutation === 'negated claim') node.content = node.content.replace('核心观点是：', '核心观点不是：');
      if (mutation === 'authoring task') node.content = `请介绍${input.knowledgePoints[0]!.name}，并结合学习者特点设计讲解。`;
      if (mutation === 'only heading') node.content = input.knowledgePoints[0]!.name;
      if (mutation === 'wrong kind') node.kind = 'example';
      expect(validateTeachingBlueprintDraft(candidate, input).issues.join('；')).toContain('缺少写出概念名称');
    });

  it('applies the same proposition rule to a different topic and ASCII punctuation', () => {
    const { input, candidate } = sample('concept');
    input.knowledgePoints[0]!.name = '反馈的核心观点：输出影响后续输入';
    candidate.sections[0]!.units[0]!.explanationNodes[0]!.content =
      '反馈的核心观点是:输出影响后续输入。系统读取输出所反映的状态，再以此调整下一次输入，作用可以增强也可以抑制原有变化。';
    expect(validateTeachingBlueprintDraft(candidate, input).issues).toEqual([]);
  });

  it('projects the existing orphan verbatim into its unique unit page and compiled lecture', async () => {
    const { input, candidate } = sample('orphan');
    const original = structuredClone(candidate);
    const ai = vi.fn();
    const blueprint = await generateTeachingBlueprint(input, ai, { repairFrom: { candidate, issues: [] } });
    expect(ai).not.toHaveBeenCalled();
    expect(candidate).toEqual(original);
    const section = blueprint.sections[0]!;
    expect(section.pages[0]!.introducesNodeIds).toEqual(section.units[0]!.explanationNodes?.map((node) => node.id));
    expect(section.units[0]!.explanationNodes?.map((node) => node.content))
      .toEqual(original.sections[0]!.units[0]!.explanationNodes.map((node) => node.content));
    const outlines = teachingBlueprintToOutlines(blueprint, '使用简体中文');
    expect(JSON.stringify(outlines[0]!.teachingBrief)).toContain(fixture.orphan.unit.explanationNodes[3]!.content);
    expect(revalidateStoredTeachingBlueprint(blueprint, input).issues).toEqual([]);
  });

  it('inserts an omitted middle node without changing authored node order', () => {
    const { input, candidate } = sample('orphan');
    const section = candidate.sections[0]!;
    section.pages[0]!.introducesNodeIds = ['n9-core', 'n9-process', 'n9-example'];
    const result = validateTeachingBlueprintDraft(candidate, input);
    expect(result.issues).toEqual([]);
    expect(result.blueprint!.sections[0]!.pages[0]!.introducesNodeIds)
      .toEqual(result.blueprint!.sections[0]!.units[0]!.explanationNodes?.map((node) => node.id));
  });

  it.each(['two owners', 'references only', 'missing knowledge ownership', 'later prerequisite',
    'same-unit reversed prerequisite', 'measured page'])('does not guess an orphan with %s', (mutation) => {
    const { input, candidate } = sample('orphan');
    const section = candidate.sections[0]!;
    const page = section.pages[0]!;
    const orphan = section.units[0]!.explanationNodes[3]!;
    if (mutation === 'two owners') section.pages.push({ ...structuredClone(page), id: 'second', introducesNodeIds: [] });
    if (mutation === 'references only') page.referencesNodeIds.push(orphan.id);
    if (mutation === 'missing knowledge ownership') orphan.knowledgePointIds = [];
    if (mutation === 'measured page') Object.assign(page, { sectionPlanVersion: 1 });
    if (mutation === 'later prerequisite') {
      const laterUnit = structuredClone(section.units[0]!);
      laterUnit.id = 'later-unit';
      laterUnit.explanationNodes = [{ ...structuredClone(orphan), id: 'later-node', prerequisiteNodeIds: [] }];
      section.units.push(laterUnit);
      section.pages.push({ ...structuredClone(page), id: 'later-page', unitIds: [laterUnit.id], introducesNodeIds: ['later-node'] });
      orphan.prerequisiteNodeIds = ['later-node'];
    }
    if (mutation === 'same-unit reversed prerequisite') {
      page.introducesNodeIds = ['n9-core', 'n9-example'];
      section.units[0]!.explanationNodes[1]!.prerequisiteNodeIds = ['n9-process'];
    }
    const result = validateTeachingBlueprintDraft(candidate, input);
    expect(result.issues.join('；')).toContain('未分配给任何页面');
    expect(result.blueprint).toBeUndefined();
  });

  it('does not change accepted page ownership on stored-plan validation', async () => {
    const { input, candidate } = sample('orphan');
    const blueprint = await generateTeachingBlueprint(input, vi.fn(), { repairFrom: { candidate, issues: [] } });
    blueprint.sections[0]!.pages[0]!.introducesNodeIds = blueprint.sections[0]!.pages[0]!.introducesNodeIds!.slice(0, 3);
    expect(revalidateStoredTeachingBlueprint(blueprint, input).issues.join('；')).toContain('未分配给任何页面');
    expect(validateTeachingBlueprintDraft(blueprint, input).issues.join('；')).toContain('未分配给任何页面');
  });
});
