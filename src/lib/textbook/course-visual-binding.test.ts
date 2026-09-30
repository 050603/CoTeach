import { describe, expect, it } from 'vitest';
import { bindKnowledgeSourceSequenceReferences, resolveCourseSourceSequenceContracts } from './course-evidence-types';
import type { SceneOutline } from '@/lib/openmaic/types/generation';
import type { CourseEvidenceSnapshot, CourseTextbookFigureResource } from './course-evidence-types';
import {
  assertRequiredTextbookFiguresAvailable,
  bindRequiredTextbookFiguresToOutlines,
  bindRequiredTextbookFiguresToBlueprint,
  findBlueprintFigureSequenceIssues,
  assertSourceSequencesInOutlines,
  inspectFigureSequence,
  findKnowledgeSourceSequenceIssues,
} from './course-visual-binding';
import type { TeachingBlueprint } from '@/lib/session/types';
import { teachingBlueprintToOutlines } from '@/lib/course-design/teaching-blueprint';
import realFirstDraft from './__fixtures__/teaching-methods-first-draft.json';

const pages: SceneOutline[] = [
  {
    id: 'first', type: 'slide', title: '首次完整讲解', description: '解释机制', keyPoints: ['机制'], order: 0,
    generationPurpose: 'knowledge-teaching', knowledgePointIds: ['kp-1'],
  },
  {
    id: 'review', type: 'slide', title: '复习', description: '回顾机制', keyPoints: ['复习'], order: 1,
    generationPurpose: 'knowledge-teaching', knowledgePointIds: ['kp-1'],
    suggestedImageIds: ['textbook_fig_1'],
  },
];

const resource: CourseTextbookFigureResource = {
  id: 'textbook_fig_1', figureId: 'figure-1', assetId: 'asset-1', src: '/api/uploads/asset-1',
  pageNumber: 12, description: '教材原图；观察案例中的关键差异', relation: 'direct',
  required: true, evidenceItemIds: ['evidence-1'], knowledgePointIds: ['kp-1'],
  sourceTitle: '人工智能教学', status: 'available',
};

function sequenceBlueprint(labels: readonly string[]): TeachingBlueprint {
  return {
    schemaVersion: 3, inputFingerprint: 'sequence-fixture', assessmentMode: 'adaptive',
    createdAt: '2026-09-30T00:00:00Z',
    budget: { totalDurationSec: 300, teachingDurationSec: 220, learnerActivityDurationSec: 20,
      assessmentDurationSec: 60, teachingRatio: 220 / 300, assessmentRatio: 0.2 },
    sections: [{
      id: 'sequence-section', title: '教材完整条目', order: 0,
      learningObjective: '解释教材条目', knowledgePointIds: ['kp-1'],
      sharedContext: { learningPurpose: '理解教材的完整说明', caseId: 'source-list', caseFacts: [],
        fixedWording: [], stableTerms: [], conceptBoundaries: [] },
      units: [{
        id: 'unit-1', title: '教材条目', knowledgePointIds: ['kp-1'], learningOutcome: '解释全部条目',
        explanation: labels.join('，'), mechanism: '依据条目解释课堂活动', workedExample: '',
        conditions: [], misconceptions: [], sourceKind: 'course-source', evidenceQuotes: [],
        explanationNodes: [{ id: 'owned-node', kind: 'concept', content: labels.join('，'),
          knowledgePointIds: ['kp-1'], prerequisiteNodeIds: [], provenance: 'course-source' }],
      }],
      pages: [{
        id: 'sequence-page', type: 'slide', title: '教材完整条目', unitIds: ['unit-1'],
        knowledgePointIds: ['kp-1'], introducesNodeIds: ['owned-node'], deepensNodeIds: [],
        referencesNodeIds: [], description: '理解教材中的条目及其含义', teachingObjective: '解释每个条目',
        keyPoints: [...labels],
      }],
      assessmentFocus: ['依据条目分析课堂活动'], understandingCriteria: {
        goals: ['解释完整条目'], answerEssentials: [...labels], misconceptions: [], supportingUnitIds: ['unit-1'],
      },
      teachingDurationSec: 220, learnerActivityDurationSec: 20, assessmentDurationSec: 60,
    }],
  };
}

describe('required textbook figure binding', () => {
  it('accepts the real first draft with an equivalent quoted action and two independent lists sharing an ending', () => {
    const evidence = realFirstDraft.evidence as CourseEvidenceSnapshot;
    expect(findKnowledgeSourceSequenceIssues([realFirstDraft.point], evidence)).toEqual([]);
    const missing = { ...realFirstDraft.point, keyInfo: realFirstDraft.point.keyInfo.replace('→抛锚', '') };
    expect(findKnowledgeSourceSequenceIssues([missing], evidence).join('；')).toContain('遗漏教材步骤：进行“抛锚”');
    const reversed = { ...realFirstDraft.point,
      keyInfo: realFirstDraft.point.keyInfo.replace('创设情境→抛锚→自主探索', '抛锚→创设情境→自主探索') };
    expect(findKnowledgeSourceSequenceIssues([reversed], evidence).join('；')).toContain('6 个步骤顺序');
  });

  it('matches complete diagram labels to source-licensed quoted action spellings without losing a step', () => {
    const orderedSteps = ['创设情境', '进行“抛锚”', '自主探索', '拓展延伸', '讨论交流', '效果评价']
      .map((label) => ({ label }));
    const statements = ['教学过程是创设情境、进行抛锚、自主探索、拓展延伸、讨论交流、效果评价。'];
    for (const action of ['进行“抛锚”', '进行抛锚', '抛锚']) {
      const diagramLabels = orderedSteps.map((step, index) => index === 1 ? action : step.label);
      expect(inspectFigureSequence({ orderedSteps, statements, diagramLabels, requireCompleteText: true })).toEqual([]);
    }
    const complete = orderedSteps.map((step, index) => index === 1 ? '进行抛锚' : step.label);
    expect(inspectFigureSequence({ orderedSteps, statements, diagramLabels: complete.filter((_, index) => index !== 1),
      requireCompleteText: true })).toContain('辅助顺序图未完整保留教材的 6 个步骤');
    const reversed = [...complete];
    [reversed[1], reversed[2]] = [reversed[2]!, reversed[1]!];
    expect(inspectFigureSequence({ orderedSteps, statements, diagramLabels: reversed, requireCompleteText: true }))
      .toContain('辅助顺序图未保留教材的 6 个步骤顺序');
    for (const unrelated of ['抛锚式教学法', '进行抛锚式教学法', '抛锚后评价']) {
      expect(inspectFigureSequence({ orderedSteps, statements,
        diagramLabels: complete.map((label, index) => index === 1 ? unrelated : label), requireCompleteText: true }))
        .toContain('辅助顺序图未完整保留教材的 6 个步骤');
    }
  });

  it('derives diagram aliases from any quoted source action while retaining unquoted action requirements', () => {
    const quoted = ['观察', '进行“归纳”', '验证'].map((label) => ({ label }));
    for (const action of ['进行归纳', '归纳']) {
      expect(inspectFigureSequence({ orderedSteps: quoted, statements: [],
        diagramLabels: ['观察', action, '验证'] })).toEqual([]);
    }
    const literal = ['观察', '进行归纳', '验证'].map((label) => ({ label }));
    expect(inspectFigureSequence({ orderedSteps: literal, statements: [], diagramLabels: ['观察', '归纳', '验证'] }))
      .toContain('辅助顺序图未完整保留教材的 3 个步骤');
    const constrained = ['观察', '独立归纳', '验证'].map((label) => ({ label }));
    expect(inspectFigureSequence({ orderedSteps: constrained, statements: [], diagramLabels: ['观察', '归纳', '验证'] }))
      .toContain('辅助顺序图未完整保留教材的 3 个步骤');
  });

  it('rejects a five-stage diagram when the adopted original and text have six', () => {
    const sixStages = ['选择项目', '制定计划', '活动探究', '制作作品', '成果交流', '活动评价'];
    const sourceFigure = { ...resource, orderedSteps: sixStages.map((label, index) => ({
      label, sourceBlockId: `block-${index + 1}`,
    })) };
    const fiveStagePage: SceneOutline = {
      ...pages[0]!, description: '项目式教学有五个基本流程环节',
      keyPoints: [sixStages.slice(0, 5).join('、')],
      visualIntent: { representation: 'native-diagram', observationGoal: '查看流程',
        diagram: { topology: 'sequence', nodes: sixStages.slice(0, 5).map((label, index) => ({
          id: `n-${index}`, label,
        })), edges: [], annotation: '五个环节' } },
    };
    expect(() => bindRequiredTextbookFiguresToOutlines([fiveStagePage], [sourceFigure]))
      .toThrow(/遗漏教材步骤|写成 5 个环节/);
    const corrected: SceneOutline = { ...fiveStagePage, description: '项目式教学有六个基本流程环节',
      keyPoints: [sixStages.join('、')], visualIntent: { ...fiveStagePage.visualIntent!,
        diagram: { ...fiveStagePage.visualIntent!.diagram!,
          nodes: sixStages.map((label, index) => ({ id: `n-${index}`, label })),
          annotation: '六个环节' } } };
    expect(bindRequiredTextbookFiguresToOutlines([corrected], [sourceFigure])[0]?.suggestedImageIds)
      .toContain(sourceFigure.id);
    expect(bindRequiredTextbookFiguresToOutlines([{ ...corrected, title: '无关标题编辑' }], [sourceFigure]))
      .toHaveLength(1);
  });

  it('finds a stale blueprint even if its required image declaration is removed', () => {
    const orderedSteps = ['选择项目', '制定计划', '活动探究', '制作作品', '成果交流', '活动评价']
      .map((label) => ({ label }));
    const blueprint = { sections: [{ units: [], pages: [{ id: 'page-1', type: 'slide',
      knowledgePointIds: ['kp-1'], unitIds: [], description: '五个基本流程环节',
      teachingObjective: '认识五个环节', keyPoints: ['选择项目、制定计划、活动探究、制作作品、成果交流'],
      visualRelationship: { diagram: { nodes: orderedSteps.slice(0, 5).map((step) => ({ label: step.label })) } },
      resourceNeeds: [],
    }] }] } as unknown as Pick<TeachingBlueprint, 'sections'>;
    expect(findBlueprintFigureSequenceIssues(blueprint, [{ resourceId: 'figure-32',
      knowledgePointIds: ['kp-1'], required: true, orderedSteps }]).map((issue) => issue.detail).join('；'))
      .toContain('活动评价');
  });

  it('rejects complete raw unit text when canonical items disappear from the executable page', () => {
    const labels = [
      '发挥身体认知的主体性,让学生亲身参与学习活动',
      '让学生学习的思维和过程变得直观可视',
      '创设多维的物理环境和教学情境',
      '注重身心环境交互学习活动的设计',
      '注重教学目标、资源、交互过程的动态生成性',
    ];
    const contracts = [{ resourceId: 'embodied-principles', required: true, knowledgePointIds: ['kp-1'],
      scope: 'knowledge-point' as const, sequenceSemantics: 'enumerated-items' as const,
      orderedSteps: labels.map((label) => ({ label })) }];
    const blueprint = sequenceBlueprint(labels);
    const unit = blueprint.sections[0]!.units[0]!;
    const page = blueprint.sections[0]!.pages[0]!;
    unit.explanationNodes![0]!.content = `具身认知的教学设计原则：发挥身体认知的主体性并引导反思，`
      + `让学习的思维和过程直观可视，${labels.slice(2).join('，')}。`;
    page.keyPoints = [unit.explanationNodes![0]!.content];
    const issues = () => findBlueprintFigureSequenceIssues(blueprint, contracts).map((issue) => issue.detail).join('；');
    expect(issues()).toContain(labels[0]);
    expect(issues()).toContain(labels[1]);
    expect(findBlueprintFigureSequenceIssues(blueprint, contracts)[0]?.missingCanonicalLabels)
      .toEqual(labels.slice(0, 2));
    expect(() => assertSourceSequencesInOutlines(teachingBlueprintToOutlines(blueprint, ''), contracts))
      .toThrow('遗漏教材条目');

    // Required definitions take precedence over similar keyPoints. Fixing
    // only the raw page text must not hide the incomplete compiled content.
    page.keyPoints = [`具身认知的教学设计原则：${labels.join('，')}。`];
    expect(issues()).toContain(labels[0]);
    expect(() => assertSourceSequencesInOutlines(teachingBlueprintToOutlines(blueprint, ''), contracts))
      .toThrow('遗漏教材条目');

    unit.explanationNodes![0]!.content = page.keyPoints[0]!;
    expect(findBlueprintFigureSequenceIssues(blueprint, contracts)).toEqual([]);
    const compiled = teachingBlueprintToOutlines(blueprint, '');
    expect(() => assertSourceSequencesInOutlines(compiled, contracts)).not.toThrow();
    expect(compiled[0]).toMatchObject({ id: page.id, knowledgePointIds: ['kp-1'],
      teachingBrief: { teachingPlan: { introduces: ['owned-node'], deepens: [] } } });
  });

  it('requires figure steps on nodes actually developed by the figure page', () => {
    const labels = ['确定问题', '收集证据', '形成结论'];
    const blueprint = sequenceBlueprint(labels);
    const unit = blueprint.sections[0]!.units[0]!;
    const page = blueprint.sections[0]!.pages[0]!;
    unit.explanationNodes![0]!.content = labels.slice(0, 2).join('，');
    unit.explanationNodes!.push({ id: 'referenced-node', kind: 'concept', content: labels[2]!,
      prerequisiteNodeIds: [], provenance: 'course-source', knowledgePointIds: ['kp-1'] });
    page.keyPoints = labels.slice(0, 2);
    page.referencesNodeIds = ['referenced-node'];
    const figure = { ...resource, orderedSteps: labels.map((label, index) => ({ label, sourceBlockId: `b-${index}` })) };
    const contracts = [{ resourceId: figure.id, required: true, knowledgePointIds: figure.knowledgePointIds,
      orderedSteps: figure.orderedSteps }];
    expect(findBlueprintFigureSequenceIssues(blueprint, contracts).map((issue) => issue.detail))
      .toEqual(['遗漏教材步骤：形成结论']);
    expect(() => bindRequiredTextbookFiguresToOutlines(teachingBlueprintToOutlines(blueprint, ''), [figure]))
      .toThrow('形成结论');
    page.deepensNodeIds = ['referenced-node'];
    page.referencesNodeIds = [];
    expect(findBlueprintFigureSequenceIssues(blueprint, contracts)).toEqual([]);
    expect(() => bindRequiredTextbookFiguresToOutlines(teachingBlueprintToOutlines(blueprint, ''), [figure]))
      .not.toThrow();
  });

  it('locates a shared source-list repair on the page explaining its items', () => {
    const labels = ['身体参与学习', '思维过程可视', '创设多维情境'];
    const blueprint = sequenceBlueprint(labels);
    const section = blueprint.sections[0]!;
    const unit = section.units[0]!;
    const principlesPage = section.pages[0]!;
    unit.explanationNodes![0]!.content = labels.slice(1).join('，');
    principlesPage.keyPoints = labels.slice(1);
    section.units.unshift({ ...structuredClone(unit), id: 'theory-unit', title: '具身认知理论',
      knowledgePointIds: ['kp-theory'], explanation: '认知由身体、大脑与环境共同产生',
      explanationNodes: [{ id: 'theory-node', kind: 'concept', content: '认知由身体、大脑与环境共同产生',
        knowledgePointIds: ['kp-theory'], prerequisiteNodeIds: [], provenance: 'course-source' }] });
    section.pages.unshift({ ...structuredClone(principlesPage), id: 'theory-page', title: '具身认知理论',
      unitIds: ['theory-unit'], knowledgePointIds: ['kp-theory'], introducesNodeIds: ['theory-node'],
      keyPoints: ['认知由身体、大脑与环境共同产生'] });
    const contracts = [{ resourceId: 'shared-principles', required: true,
      knowledgePointIds: ['kp-theory', 'kp-1'], scope: 'knowledge-point' as const,
      sequenceSemantics: 'enumerated-items' as const, orderedSteps: labels.map((label) => ({ label })) }];
    expect(findBlueprintFigureSequenceIssues(blueprint, contracts)).toEqual([{
      resourceId: 'shared-principles', pageId: principlesPage.id, sectionIndex: 0, pageIndex: 1,
      detail: '遗漏教材条目：身体参与学习',
      missingCanonicalLabels: ['身体参与学习'],
    }]);
    expect(() => assertSourceSequencesInOutlines(teachingBlueprintToOutlines(blueprint, ''), contracts))
      .toThrow('身体参与学习');
    unit.explanationNodes![0]!.content = labels.join('，');
    expect(findBlueprintFigureSequenceIssues(blueprint, contracts)).toEqual([]);
    expect(() => assertSourceSequencesInOutlines(teachingBlueprintToOutlines(blueprint, ''), contracts)).not.toThrow();
    expect(section.pages[0]!.introducesNodeIds).toEqual(['theory-node']);

    const figureContract = { ...contracts[0]!, resourceId: 'first-page-figure', scope: 'single-page' as const };
    expect(findBlueprintFigureSequenceIssues(blueprint, [figureContract])[0]?.pageId).toBe('theory-page');
  });

  it('uses the accepted section brief instead of discarded original nodes or keyPoints', () => {
    const labels = ['确定问题', '收集证据', '形成结论'];
    const blueprint = sequenceBlueprint(labels);
    const page = blueprint.sections[0]!.pages[0]!;
    const contracts = [{ resourceId: 'accepted-source', required: true, knowledgePointIds: ['kp-1'],
      scope: 'knowledge-point' as const, orderedSteps: labels.map((label) => ({ label })) }];
    page.teachingBrief = structuredClone(teachingBlueprintToOutlines(blueprint, '')[0]!.teachingBrief!);
    page.teachingBrief.explanation = labels.slice(0, 2).join('，');
    page.teachingBrief.teachingPlan!.visibleContent = labels.slice(0, 2);
    page.sectionPlanVersion = 'accepted-section-plan';
    expect(findBlueprintFigureSequenceIssues(blueprint, contracts).map((issue) => issue.detail))
      .toEqual(['遗漏教材步骤：形成结论']);
    expect(() => assertSourceSequencesInOutlines(teachingBlueprintToOutlines(blueprint, ''), contracts))
      .toThrow('形成结论');

    page.sectionPlanVersion = undefined;
    expect(findBlueprintFigureSequenceIssues(blueprint, contracts)).toEqual([]);
    expect(() => assertSourceSequencesInOutlines(teachingBlueprintToOutlines(blueprint, ''), contracts)).not.toThrow();

    page.sectionPlanVersion = 'accepted-section-plan';
    page.teachingBrief.explanation = labels.join('，');
    page.teachingBrief.teachingPlan!.visibleContent = [...labels];
    expect(findBlueprintFigureSequenceIssues(blueprint, contracts)).toEqual([]);
    expect(() => assertSourceSequencesInOutlines(teachingBlueprintToOutlines(blueprint, ''), contracts)).not.toThrow();
  });

  it('preserves the compiler legacy-node fallback and its actual text priority', () => {
    const labels = ['确定问题', '收集证据', '形成结论'];
    const blueprint = sequenceBlueprint(labels);
    const unit = blueprint.sections[0]!.units[0]!;
    const page = blueprint.sections[0]!.pages[0]!;
    unit.explanationNodes = undefined;
    unit.mechanism = labels.slice(0, 2).join('，');
    page.introducesNodeIds = [`${unit.id}:legacy-explanation`];
    page.keyPoints = labels.slice(0, 2);
    const contracts = [{ resourceId: 'legacy-source', required: true, knowledgePointIds: ['kp-1'],
      scope: 'knowledge-point' as const, orderedSteps: labels.map((label) => ({ label })) }];
    expect(findBlueprintFigureSequenceIssues(blueprint, contracts).map((issue) => issue.detail))
      .toEqual(['遗漏教材步骤：形成结论']);
    expect(() => assertSourceSequencesInOutlines(teachingBlueprintToOutlines(blueprint, ''), contracts))
      .toThrow('形成结论');
    for (const fallback of ['mechanism', 'explanation', 'learningOutcome'] as const) {
      unit.mechanism = '';
      unit.explanation = '';
      unit.learningOutcome = '';
      unit[fallback] = labels.join('，');
      expect(findBlueprintFigureSequenceIssues(blueprint, contracts)).toEqual([]);
      expect(() => assertSourceSequencesInOutlines(teachingBlueprintToOutlines(blueprint, ''), contracts)).not.toThrow();
    }
  });

  it('validates a source list across multiple knowledge pages without a figure', () => {
    const contract = { resourceId: 'source-sequence:first', required: true,
      knowledgePointIds: ['kp-1'], scope: 'knowledge-point' as const,
      orderedSteps: ['确定问题', '收集证据', '形成结论'].map((label) => ({ label })) };
    const first = { ...pages[0]!, description: '先确定问题，再收集证据', keyPoints: ['确定问题', '收集证据'] };
    const second = { ...pages[1]!, description: '最后形成结论', keyPoints: ['形成结论'] };
    expect(() => assertSourceSequencesInOutlines([first, second], [contract])).not.toThrow();
    expect(() => assertSourceSequencesInOutlines([first], [contract])).toThrow('形成结论');
  });

  it('reports each missing canonical label intact for partial repair progress', () => {
    const labels = ['识别学习目标', '分析目标、资源、活动的关系', '保留条件、边界与评价依据'];
    const blueprint = sequenceBlueprint(labels);
    const unit = blueprint.sections[0]!.units[0]!;
    const page = blueprint.sections[0]!.pages[0]!;
    const contracts = [{ resourceId: 'source-with-punctuation', required: true, knowledgePointIds: ['kp-1'],
      scope: 'knowledge-point' as const, sequenceSemantics: 'enumerated-items' as const,
      orderedSteps: labels.map((label) => ({ label })) }];
    unit.explanationNodes![0]!.content = labels[0]!;
    page.keyPoints = [labels[0]!];
    expect(findBlueprintFigureSequenceIssues(blueprint, contracts)[0]?.missingCanonicalLabels)
      .toEqual(labels.slice(1));
    unit.explanationNodes![0]!.content += `，${labels[1]}`;
    expect(findBlueprintFigureSequenceIssues(blueprint, contracts)[0]?.missingCanonicalLabels)
      .toEqual([labels[2]]);

    unit.explanationNodes![0]!.content = labels.join('，');
    page.description = '该清单包含四条建议';
    const countIssue = findBlueprintFigureSequenceIssues(blueprint, contracts)[0]!;
    expect(countIssue.detail).toBe('写成 4 条，教材正文清单为 3 条');
    expect(countIssue).not.toHaveProperty('missingCanonicalLabels');
  });

  it('keeps the complete-step gate for an explicit complete claim with legacy source metadata', () => {
    const evidence = { items: [{ id: 'legacy-evidence', source: { revisionId: 'revision' },
      sourceSequences: [{ anchorSourceBlockId: 'legacy-source', kind: 'ordered-steps',
        steps: ['确定问题', '收集证据', '形成结论'].map((label, index) => ({ label, sourceBlockId: `b-${index}` })) }],
    }] } as unknown as CourseEvidenceSnapshot;
    const point = { id: 'kp-1', name: '探究流程', description: '完整流程是先确定问题，再收集证据',
      keyInfo: '', evidenceItemIds: ['legacy-evidence'] };
    expect(findKnowledgeSourceSequenceIssues([point], evidence)).toEqual([
      '知识点“探究流程”与教材完整步骤不一致：遗漏教材步骤：形成结论',
    ]);
    expect(findKnowledgeSourceSequenceIssues([{ ...point, keyInfo: '最后形成结论' }], evidence)).toEqual([]);
  });

  it('keeps concise knowledge summaries separate from complete canonical source references', () => {
    const labels = ['教学目标分析', '情境创设', '信息资源设计', '自主学习设计', '协作学习环境设计', '学习效果评价设计', '强化练习设计'];
    const evidence: CourseEvidenceSnapshot = {
      schemaVersion: 2, version: 4, fingerprint: 'adopted-source-v4', createdAt: '2026-09-30T00:00:00Z',
      selections: [], mappings: [], warnings: [], retrievalMode: 'hybrid', items: [{
        id: 'design-flow', kind: 'source-block', title: '建构主义教学设计', content: '完整七步原文',
        source: { textbookId: 'book', textbookTitle: '教学设计', revisionId: 'revision', revisionVersion: 1,
          sectionPath: ['建构主义教学设计步骤'] },
        sourceSequences: [{ anchorSourceBlockId: 'seven-step-source', kind: 'ordered-steps',
          steps: labels.map((label, index) => ({ label, sourceBlockId: `step-${index}`,
            excerpt: `${label}的完整解释与条件。` })) }],
      }],
    };
    const point = { id: 'kp-design', name: '建构主义教学实施：情境、协作与七步设计流程',
      description: '教材给出目标分析、情境创设、信息资源设计、自主学习、协作环境、效果评价和强化练习七个设计步骤。',
      keyInfo: '七步流程把理论原则转成可操作的教案骨架。', evidenceItemIds: ['design-flow'] };
    const [bound] = bindKnowledgeSourceSequenceReferences([point], evidence);

    expect(bound.description).toBe(point.description);
    expect(bound.sourceSequenceReferences?.[0]).toMatchObject({
      resourceId: 'source-sequence:seven-step-source', sourceEvidenceFingerprint: evidence.fingerprint,
      sourceEvidenceVersion: evidence.version, evidenceItemIds: ['design-flow'],
    });
    expect(bound.sourceSequenceReferences?.[0].orderedSteps).toEqual(evidence.items[0].sourceSequences![0].steps);
    expect(findKnowledgeSourceSequenceIssues([point], evidence)).toEqual([]);
    expect(findKnowledgeSourceSequenceIssues([bound], evidence)).toEqual([]);
    expect(findKnowledgeSourceSequenceIssues([{ ...bound,
      description: point.description.replace('七个设计步骤', '六个设计步骤'),
    }], evidence).join('；')).toContain('写成 6 个环节');

    const incomplete = { ...bound, description: `完整流程是${labels.slice(0, 6).join('、')}等步骤。` };
    expect(findKnowledgeSourceSequenceIssues([incomplete], evidence).join('；')).toContain('遗漏教材步骤：强化练习设计');
    const reversed = { ...bound, description: `基本流程是${[...labels].reverse().join('、')}。` };
    expect(findKnowledgeSourceSequenceIssues([reversed], evidence).join('；')).toContain('未保留教材的 7 个步骤顺序');
    const proseOrder = { ...bound, description: '先信息资源设计，然后情境创设，后续还需其他设计工作。' };
    expect(findKnowledgeSourceSequenceIssues([proseOrder], evidence).join('；')).toContain('未保留教材的 7 个步骤顺序');

    const forged = structuredClone(bound);
    forged.sourceSequenceReferences![0].orderedSteps.pop();
    expect(findKnowledgeSourceSequenceIssues([forged], evidence).join('；')).toContain('来源列表身份、版本或完整条目');
    const stale = structuredClone(bound);
    stale.sourceSequenceReferences![0].sourceEvidenceFingerprint = 'older-source';
    expect(findKnowledgeSourceSequenceIssues([stale], evidence).join('；')).toContain('来源列表身份、版本或完整条目');

    const sameListFromFigure = structuredClone(evidence);
    sameListFromFigure.items[0].figureSequences = [{ figureId: 'same-seven-step-list', kind: 'ordered-steps',
      steps: sameListFromFigure.items[0].sourceSequences![0].steps }];
    const falseCompleteClaim = bindKnowledgeSourceSequenceReferences([{ ...point,
      description: '完整流程是先确立目的，再展开自主活动。',
    }], sameListFromFigure);
    expect(falseCompleteClaim[0].sourceSequenceReferences).toHaveLength(2);
    expect(findKnowledgeSourceSequenceIssues(falseCompleteClaim, sameListFromFigure).join('；'))
      .toContain('遗漏教材步骤');

    const contracts = resolveCourseSourceSequenceContracts(evidence, [bound]);
    const missingExecution = sequenceBlueprint(labels.slice(0, 2));
    missingExecution.sections[0].knowledgePointIds = ['kp-design'];
    missingExecution.sections[0].pages[0].knowledgePointIds = ['kp-design'];
    expect(findBlueprintFigureSequenceIssues(missingExecution, contracts).map((issue) => issue.detail).join('；'))
      .toContain('遗漏教材步骤：信息资源设计、自主学习设计、协作学习环境设计、学习效果评价设计、强化练习设计');
    expect(() => assertSourceSequencesInOutlines(teachingBlueprintToOutlines(missingExecution, ''), contracts))
      .toThrow(/遗漏教材步骤/);
  });

  it('checks each adopted list against its own quantities on a shared knowledge point', () => {
    const seven = ['教学目标分析', '情境创设', '信息资源设计', '自主学习设计', '协作学习环境设计', '学习效果评价设计', '强化练习设计'];
    const four = ['前期分析阶段', '核心要素设计阶段', '教学过程实施阶段', '教学评价阶段'];
    const contracts = [seven, four].map((labels, index) => ({
      resourceId: `source-${index}`, required: true, knowledgePointIds: ['kp-1'],
      scope: 'knowledge-point' as const, orderedSteps: labels.map((label) => ({ label })),
    }));
    const sequencePages = [
      { ...pages[0]!, description: `教学设计有七个步骤：${seven.join('、')}`, keyPoints: seven },
      { ...pages[1]!, description: `教学框架分为四个阶段：${four.join('、')}`, keyPoints: four },
    ];
    expect(() => assertSourceSequencesInOutlines(sequencePages, contracts)).not.toThrow();
    const blueprint = { sections: [{ units: [], pages: sequencePages.map((page) => ({
      ...page, unitIds: [], teachingObjective: page.description,
    })) }] } as unknown as Pick<TeachingBlueprint, 'sections'>;
    expect(findBlueprintFigureSequenceIssues(blueprint, contracts)).toEqual([]);
    const mistaken = structuredClone(blueprint);
    mistaken.sections[0]!.pages[1]!.description = `教学框架分为七个阶段：${four.join('、')}`;
    expect(findBlueprintFigureSequenceIssues(mistaken, contracts).map((issue) => issue.detail))
      .toContain('写成 7 个环节，教材原图与原文均为 4 个');
  });

  it('distinguishes a total across stage checklists from a wrong count for one named stage', () => {
    const stageLists = [
      { name: '设计阶段', labels: ['选择合适教学内容', '平衡知识与活动', '分解复杂任务', '技术支持认知'] },
      { name: '实施阶段', labels: ['监督项目过程', '合理安排小组分工'] },
      { name: '评价阶段', labels: ['明确作品评价标准', '评价学习过程', '关注反思与改进'] },
    ];
    const contracts = stageLists.map((stage) => ({ resourceId: `source-${stage.name}`, required: true,
      knowledgePointIds: ['kp-1'], scope: 'knowledge-point' as const,
      sequenceSemantics: 'enumerated-items' as const, orderedSteps: stage.labels.map((label) => ({ label })) }));
    const parent = { resourceId: 'source-stages', required: true, knowledgePointIds: ['kp-1'],
      scope: 'knowledge-point' as const, orderedSteps: stageLists.map((stage) => ({ label: stage.name })) };
    const stageText = stageLists.map((stage) => `${stage.name}：${stage.labels.join('、')}`);
    const complete: SceneOutline = { ...pages[0]!, description: '逐阶段解释清单', keyPoints: stageText,
      visualIntent: { representation: 'table', observationGoal: '比较阶段与建议',
        rationale: '表格呈现三个阶段与九条建议的对应关系。' } };
    expect(() => assertSourceSequencesInOutlines([complete], [parent, ...contracts])).not.toThrow();
    expect(() => assertSourceSequencesInOutlines([{ ...complete,
      visualIntent: { ...complete.visualIntent!, rationale: '各阶段合计九条建议。' } }], contracts))
      .not.toThrow();
    // Even a partially adopted hierarchy cannot make its complete parent's
    // total a claim about the only adopted child checklist.
    expect(() => assertSourceSequencesInOutlines([complete], [parent, contracts[0]!])).not.toThrow();

    const blueprint = sequenceBlueprint(stageLists.flatMap((stage) => stage.labels));
    const page = blueprint.sections[0]!.pages[0]!;
    page.keyPoints = stageText;
    page.visualRelationship = { kind: 'comparison', description: '按阶段比较建议', readingOrder: [],
      preferredForm: 'table', rationale: complete.visualIntent!.rationale! };
    expect(findBlueprintFigureSequenceIssues(blueprint, [parent, ...contracts])).toEqual([]);
    expect(() => assertSourceSequencesInOutlines(teachingBlueprintToOutlines(blueprint, ''), [parent, ...contracts]))
      .not.toThrow();

    const wrongStage = { ...complete, description: '设计阶段有五条建议。' };
    expect(() => assertSourceSequencesInOutlines([wrongStage], [parent, ...contracts]))
      .toThrow('写成 5 条，教材正文清单为 4 条');
    // An explicit stage header in the actual page also provides context for
    // older contracts that did not persist a parent sequence.
    expect(() => assertSourceSequencesInOutlines([wrongStage], contracts))
      .toThrow('写成 5 条，教材正文清单为 4 条');
    page.description = wrongStage.description;
    expect(findBlueprintFigureSequenceIssues(blueprint, [parent, ...contracts]).map((issue) => issue.detail))
      .toEqual(['写成 5 条，教材正文清单为 4 条']);
  });

  it('requires unique source evidence for a generic count and still rejects incomplete lists', () => {
    const four = ['选择合适教学内容', '平衡知识与活动', '分解复杂任务', '技术支持认知'];
    const two = ['监督项目过程', '合理安排小组分工'];
    const contracts = [four, two].map((labels, index) => ({ resourceId: `source-${index}`, required: true,
      knowledgePointIds: ['kp-1'], scope: 'knowledge-point' as const, sequenceSemantics: 'enumerated-items' as const,
      orderedSteps: labels.map((label) => ({ label })) }));
    const complete = { ...pages[0]!, description: '表格列出六条建议。', keyPoints: [...four, ...two] };
    expect(() => assertSourceSequencesInOutlines([complete], contracts)).not.toThrow();
    expect(() => assertSourceSequencesInOutlines([{ ...complete, keyPoints: [...four.slice(0, 3), ...two] }], contracts))
      .toThrow('遗漏教材条目：技术支持认知');
    const explicit = { ...complete, description: `这组有五条建议：${four.join('、')}。`
      + `另一组有两条建议：${two.join('、')}。` };
    expect(() => assertSourceSequencesInOutlines([explicit], contracts))
      .toThrow('写成 5 条，教材正文清单为 4 条');
    expect(() => assertSourceSequencesInOutlines([{ ...pages[0]!, description: '本清单有五条建议。', keyPoints: four }], [contracts[0]!]))
      .toThrow('写成 5 条，教材正文清单为 4 条');
  });

  it('retains quantity ownership for a complete source that contains a shared smaller sequence', () => {
    const three = ['确定问题', '收集证据', '形成结论'];
    const six = [...three, '验证结论', '成果交流', '活动评价'];
    const related = [three, six].map((labels) => ({ orderedSteps: labels.map((label) => ({ label })) }));
    const statements = ['共有六个步骤', six.join('、')];
    expect(inspectFigureSequence({ orderedSteps: related[0]!.orderedSteps, statements,
      relatedSequences: related, requireCompleteText: true })).toEqual([]);
    expect(inspectFigureSequence({ orderedSteps: related[1]!.orderedSteps, statements,
      relatedSequences: related, requireCompleteText: true })).toEqual([]);
    expect(inspectFigureSequence({ orderedSteps: related[1]!.orderedSteps,
      statements: ['共有五个步骤', six.join('、')], relatedSequences: related, requireCompleteText: true }))
      .toContain('写成 5 个环节，教材原图与原文均为 6 个');
  });

  it('keeps source processes independent from a different required figure on the same page', () => {
    const six = ['选择项目', '制定计划', '活动探究', '制作作品', '成果交流', '活动评价'];
    const five = ['创设情境', '自主探究', '解释点拨', '拓展延伸', '评价反思'];
    const source = { resourceId: 'inquiry', required: true, knowledgePointIds: ['kp-1'],
      scope: 'knowledge-point' as const, orderedSteps: five.map((label) => ({ label })) };
    const figure = { ...resource, orderedSteps: six.map((label, index) => ({ label, sourceBlockId: `b-${index}` })) };
    const combined: SceneOutline = { ...pages[0]!,
      description: `项目式有六个步骤：${six.join('、')}；探究式有五个步骤：${five.join('、')}`,
      keyPoints: [...six, ...five], visualIntent: { representation: 'native-diagram', observationGoal: '观察项目式流程',
        diagram: { topology: 'sequence', nodes: six.map((label, index) => ({ id: `n-${index}`, label })), edges: [] } },
    };
    expect(() => bindRequiredTextbookFiguresToOutlines([combined], [figure], [source])).not.toThrow();
    expect(() => assertSourceSequencesInOutlines([combined], [source], [figure])).not.toThrow();
    expect(() => assertSourceSequencesInOutlines([{ ...combined,
      description: `探究式有六个步骤：${five.join('、')}` }], [source], [figure]))
      .toThrow('写成 6 个环节');
  });

  it('preserves every checklist item without interpreting advice as a process diagram', () => {
    const advice = ['留出探索空间', '让知识直观可视', '提供认知支架'];
    const contract = { resourceId: 'advice', required: true, knowledgePointIds: ['kp-1'],
      scope: 'knowledge-point' as const, sequenceSemantics: 'enumerated-items' as const,
      orderedSteps: advice.map((label) => ({ label })) };
    const complete: SceneOutline = { ...pages[0]!, description: '三条建议各自对应一个环节要解决的问题。',
      keyPoints: advice, visualIntent: { representation: 'native-diagram', observationGoal: '观察支撑关系',
        diagram: { topology: 'sequence', nodes: [...advice].reverse().map((label, index) => ({ id: `n-${index}`, label })),
          edges: [] } } };
    expect(() => assertSourceSequencesInOutlines([complete], [contract])).not.toThrow();
    expect(() => assertSourceSequencesInOutlines([{ ...complete, keyPoints: advice.slice(0, 2) }], [contract]))
      .toThrow('遗漏教材条目：提供认知支架');
  });

  it('ignores references to remaining steps and warnings while rejecting a wrong complete count', () => {
    const labels = ['教学目标分析', '情境创设', '信息资源设计', '自主学习设计', '协作学习环境设计', '学习效果评价设计', '强化练习设计'];
    expect(inspectFigureSequence({ orderedSteps: labels.map((label) => ({ label })),
      statements: ['目标分析是起点，后面六个步骤围绕它推进，避免写成六个环节。', labels.join('、')],
      requireCompleteText: true })).toEqual([]);
    expect(inspectFigureSequence({ orderedSteps: labels.map((label) => ({ label })),
      statements: ['教学设计有六个步骤', labels.join('、')], requireCompleteText: true }))
      .toContain('写成 6 个环节，教材原图与原文均为 7 个');
  });

  it('keeps remembered counts from an earlier topic out of the current source list', () => {
    const orderedSteps = ['设计阶段', '实施阶段', '评价阶段'].map((label) => ({ label }));
    const introduction = '四阶段框架帮我们理清了设计的顺序，可开发资源包时，问题往往出在更具体的地方。'
      + '这些情况不会因为你记住四个阶段就自动消失，所以我们需要在定稿之前有一份逐条核对的清单。'
      + '这份清单叫项目实施的关键反思建议，它覆盖设计、实施、评价三个阶段。';
    const statements = [introduction, '设计阶段：选择教学内容。', '实施阶段：监督项目过程。', '评价阶段：关注过程表现。'];
    expect(inspectFigureSequence({ orderedSteps, statements, requireCompleteText: true })).toEqual([]);
    expect(inspectFigureSequence({ orderedSteps,
      statements: ['上一页介绍过四个阶段，今天的清单分为三个阶段：设计阶段、实施阶段、评价阶段。'],
      requireCompleteText: true })).toEqual([]);
    expect(inspectFigureSequence({ orderedSteps,
      statements: ['上一页的教学框架分为四个阶段。', ...statements.slice(1)], requireCompleteText: true })).toEqual([]);
    expect(inspectFigureSequence({ orderedSteps,
      statements: ['这份清单包含四个阶段：设计阶段、实施阶段、评价阶段。'], requireCompleteText: true }))
      .toContain('写成 4 个环节，教材原图与原文均为 3 个');
    expect(inspectFigureSequence({ orderedSteps,
      statements: [introduction, '本清单有四个阶段。', ...statements.slice(1)], requireCompleteText: true }))
      .toContain('写成 4 个环节，教材原图与原文均为 3 个');
    // Reading a correct old framework cannot repair missing or reversed
    // content in the currently taught source.
    expect(inspectFigureSequence({ orderedSteps, statements: [introduction, ...statements.slice(1, 3)],
      requireCompleteText: true })).toContain('遗漏教材步骤：评价阶段');
    expect(inspectFigureSequence({ orderedSteps, statements, requireCompleteText: true,
      diagramLabels: ['设计阶段', '评价阶段', '实施阶段'] }))
      .toContain('辅助顺序图未保留教材的 3 个步骤顺序');
  });

  it('retains direct source assertions during review and uses the same ownership rule for enumerated advice', () => {
    const orderedSteps = ['设计阶段', '实施阶段', '评价阶段'].map((label) => ({ label }));
    for (const assertion of ['回顾时记住本清单的四个阶段。', '上一页说明本清单包含四个阶段。',
      '记住四个阶段：设计阶段、实施阶段、评价阶段。',
      '上一页讲的设计阶段、实施阶段、评价阶段共四个阶段。']) {
      expect(inspectFigureSequence({ orderedSteps, statements: [assertion, ...orderedSteps.map((step) => step.label)],
        requireCompleteText: true })).toContain('写成 4 个环节，教材原图与原文均为 3 个');
    }
    // There need not be a second contract for an earlier topic to remain a
    // reference, and its count need not use any particular pair of numerals.
    const advice = ['选择内容', '关注过程', '提供支架'].map((label) => ({ label }));
    const statements = ['之前学过七条建议，现在这份清单包含三条建议：选择内容、关注过程、提供支架。'];
    expect(inspectFigureSequence({ orderedSteps: advice, statements, sequenceSemantics: 'enumerated-items',
      requireCompleteText: true })).toEqual([]);
    expect(inspectFigureSequence({ orderedSteps: advice, statements: ['本清单包含七条建议。', '选择内容、关注过程、提供支架。'],
      sequenceSemantics: 'enumerated-items', requireCompleteText: true }))
      .toContain('写成 7 条，教材正文清单为 3 条');
    expect(inspectFigureSequence({ orderedSteps, statements: ['本清单包含四个阶段。'] }))
      .toContain('写成 4 个环节，教材原图与原文均为 3 个');
  });

  it('keeps a selected transfer subset separate from a previously taught complete source process', () => {
    const orderedSteps = ['搭脚手架', '进入情境', '独立探索', '协作学习', '效果评价'].map((label) => ({ label }));
    const introduction = '第一个环节是搭脚手架，明确任务。第二个环节是进入情境，分析问题。'
      + '第三个环节是独立探索，学生调整条件并测试，教师逐步减少提示。';
    const transferred = '把这三个环节放进一份简案，就能看出选用理由、活动流程和预期表现之间的关系。';
    const full = { statements: ['完整过程有五个环节。', orderedSteps.map((step) => step.label).join('、')] };
    const subset = { statements: [introduction, transferred] };
    expect(inspectFigureSequence({ orderedSteps, statements: [], contentGroups: [full, subset], requireCompleteText: true })).toEqual([]);
    // A local example cannot replace source facts missing from the course.
    expect(inspectFigureSequence({ orderedSteps, statements: [], contentGroups: [subset], requireCompleteText: true }))
      .toContain('遗漏教材步骤：协作学习、效果评价');
    expect(inspectFigureSequence({ orderedSteps, statements: [], contentGroups: [
      { ...full, diagramLabels: ['搭脚手架', '独立探索', '进入情境', '协作学习', '效果评价'] }, subset,
    ], requireCompleteText: true })).toContain('辅助顺序图未保留教材的 5 个步骤顺序');
  });

  it('recognizes explicit subset selection without weakening assertions about the full process', () => {
    const orderedSteps = ['确定目标', '提出问题', '收集证据', '比较结果', '反思改进'].map((label) => ({ label }));
    const full = orderedSteps.map((step) => step.label);
    for (const selection of ['先选取三个步骤用于迁移练习。', '只展示其中三个步骤：确定目标、提出问题、收集证据。',
      '先演示前三个步骤，再讨论它们的用途。', '将这三个步骤应用于另一个情境。',
      '选取三个步骤组成完整的练习示例。']) {
      expect(inspectFigureSequence({ orderedSteps, statements: [...full, selection], requireCompleteText: true })).toEqual([]);
    }
    for (const assertion of ['这三个环节构成完整流程。', '这三个环节构成全部流程。', '这三个环节构成基本流程。',
      '所选三个步骤就是全部步骤。', '选取三个步骤构成完整的教学流程。',
      '整体流程有三个步骤。', '将这三个基本流程用于迁移练习。']) {
      expect(inspectFigureSequence({ orderedSteps, statements: [...full, assertion], requireCompleteText: true }))
        .toContain('写成 3 个环节，教材原图与原文均为 5 个');
    }
    const advice = orderedSteps.map((_, index) => ({ label: `建议${index + 1}` }));
    expect(inspectFigureSequence({ orderedSteps: advice, statements: [...advice.map((step) => step.label), '选取三条建议用于本次练习。'],
      sequenceSemantics: 'enumerated-items', requireCompleteText: true })).toEqual([]);
    expect(inspectFigureSequence({ orderedSteps: advice, statements: [...advice.map((step) => step.label), '这三条建议构成完整清单。'],
      sequenceSemantics: 'enumerated-items', requireCompleteText: true })).toContain('写成 3 条，教材正文清单为 5 条');
  });

  it('does not let another complete diagram hide a reversed sequence', () => {
    const orderedSteps = ['确定问题', '收集证据', '形成结论'].map((label) => ({ label }));
    expect(inspectFigureSequence({ orderedSteps, statements: [], contentGroups: [
      { statements: orderedSteps.map((step) => step.label), diagramLabels: orderedSteps.map((step) => step.label) },
      { statements: [], diagramLabels: ['收集证据', '确定问题', '形成结论'] },
    ], requireCompleteText: true })).toContain('辅助顺序图未保留教材的 3 个步骤顺序');
    expect(inspectFigureSequence({ orderedSteps, statements: [], contentGroups: [
      { statements: ['确定问题', '收集证据'], diagramLabels: ['确定问题', '收集证据'] },
      { statements: ['形成结论'], diagramLabels: ['形成结论'] },
    ], requireCompleteText: true })).toEqual([]);
    expect(inspectFigureSequence({ orderedSteps, statements: [], contentGroups: [
      { statements: ['形成结论'], diagramLabels: ['形成结论'] },
      { statements: ['确定问题', '收集证据'], diagramLabels: ['确定问题', '收集证据'] },
    ], requireCompleteText: true })).toContain('辅助顺序图未保留教材的 3 个步骤顺序');
  });
  it('moves a required original to the first full teaching page and records the adopted intent', () => {
    const result = bindRequiredTextbookFiguresToOutlines(pages, [resource]);
    expect(result[0]).toMatchObject({
      suggestedImageIds: ['textbook_fig_1'],
      visualIntent: {
        representation: 'source-image',
        resourceRefs: [{ resourceId: 'textbook_fig_1', kind: 'source-image', required: true }],
      },
    });
    expect(result[1]?.suggestedImageIds).toBeUndefined();
  });

  it('keeps a measured original on the sibling that actually owns its full teaching sequence', () => {
    const labels = ['选择项目', '制定计划', '活动探究', '制作作品', '成果交流', '活动评价'];
    const blueprint = sequenceBlueprint(labels);
    const section = blueprint.sections[0]!;
    const original = section.pages[0]!;
    const brief = (text: string) => ({ schemaVersion: 1 as const, explanation: text,
      teachingPlan: { purpose: '讲清本页内容', priorKnowledge: '', newContent: text,
        learnerQuestion: '', reasoningSteps: [], takeaway: text, visibleContent: [text],
        narrationFocus: [text] }, examples: [], conditions: [], evidence: [], assessmentFocus: '' });
    Object.assign(original, { sourcePageIds: ['original-page'], sectionPlanVersion: 'measured-plan',
      keyPoints: ['项目式教学的定义'], teachingBrief: brief('项目式教学以完成作品组织学习。') });
    const flow = { ...structuredClone(original), id: 'flow-page', title: '项目式教学的完整流程',
      keyPoints: [labels.join('、')], teachingBrief: brief(labels.join('、')) };
    section.pages.push(flow);
    const figure = { ...resource, orderedSteps: labels.map((label, index) => ({ label, sourceBlockId: `step-${index}` })) };
    const contract = { resourceId: figure.id, required: true, knowledgePointIds: ['kp-1'],
      orderedSteps: figure.orderedSteps, scope: 'single-page' as const };
    expect(findBlueprintFigureSequenceIssues(blueprint, [contract])).toEqual([]);
    const bound = bindRequiredTextbookFiguresToBlueprint(blueprint, [figure]);
    expect(bound.sections[0]!.pages[0]!.resourceNeeds ?? []).toEqual([]);
    expect(bound.sections[0]!.pages[1]!.resourceNeeds).toContainEqual(expect.objectContaining({
      kind: 'source-image', assetId: figure.id, required: true }));
    const outlines = bindRequiredTextbookFiguresToOutlines(teachingBlueprintToOutlines(bound, ''), [figure]);
    expect(outlines.find((page) => page.id === original.id)?.suggestedImageIds ?? []).toEqual([]);
    expect(outlines.find((page) => page.id === flow.id)?.suggestedImageIds).toContain(figure.id);
    expect(outlines.find((page) => page.id === flow.id)?.teachingBrief?.explanation).toContain(labels.join('、'));

    const reversed = structuredClone(blueprint);
    reversed.sections[0]!.pages[1]!.teachingBrief = brief([...labels].reverse().join(' → '));
    reversed.sections[0]!.pages[1]!.keyPoints = [[...labels].reverse().join(' → ')];
    expect(findBlueprintFigureSequenceIssues(reversed, [contract]).map((issue) => issue.detail).join('；'))
      .toContain('6 个步骤顺序');
    for (const reason of ['different source', 'different plan', 'only metadata', 'unmeasured']) {
      const invalid = structuredClone(blueprint);
      const candidate = invalid.sections[0]!.pages[1]!;
      if (reason === 'different source') candidate.sourcePageIds = ['other-original'];
      if (reason === 'different plan') candidate.sectionPlanVersion = 'other-plan';
      if (reason === 'only metadata') {
        candidate.teachingBrief = brief('本页只讲作品定义。');
        candidate.keyPoints = [];
        candidate.description = labels.join('、');
      }
      if (reason === 'unmeasured') {
        delete invalid.sections[0]!.pages[0]!.sectionPlanVersion;
        invalid.sections[0]!.pages[0]!.introducesNodeIds = [];
        invalid.sections[0]!.pages[0]!.deepensNodeIds = [];
      }
      expect(findBlueprintFigureSequenceIssues(invalid, [contract])[0]?.pageId).toBe(original.id);
    }
  });

  it('preserves a native relationship view and combines it with the required source image', () => {
    const result = bindRequiredTextbookFiguresToOutlines([{ ...pages[0]!, visualIntent: {
      observationGoal: '比较机制关系', representation: 'native-diagram', rationale: '关系图更清楚',
    } }], [resource]);
    expect(result[0]?.visualIntent).toMatchObject({
      observationGoal: '比较机制关系', representation: 'mixed', rationale: '关系图更清楚',
    });
  });

  it('fails before generation when no teaching slide can own a mandatory original', () => {
    expect(() => bindRequiredTextbookFiguresToOutlines([{ ...pages[0]!, type: 'interactive' }], [resource]))
      .toThrow('没有可绑定的首次知识讲解页');
  });

  it('blocks completion when a mandatory original is unavailable', () => {
    expect(() => assertRequiredTextbookFiguresAvailable([{
      ...resource,
      assetId: undefined,
      src: undefined,
      status: 'unavailable',
      failureReason: '教材图片文件已删除',
    }])).toThrow('课程不能标记为完整生成');
  });
});
