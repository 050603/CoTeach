import { describe, expect, it } from 'vitest';
import type {
  TeachingBlueprintPage,
  TeachingBlueprintUnit,
  TeachingExplanationNode,
} from '@/lib/session/types';
import { projectTeachingPageContent } from './teaching-page-content';

function node(overrides: Partial<TeachingExplanationNode> = {}): TeachingExplanationNode {
  return {
    id: 'concept',
    kind: 'concept',
    content: '教学支架是在学习者独立完成任务之前提供的支持，支持随学习进展逐步调整并撤除。',
    knowledgePointIds: ['kp-scaffold'],
    prerequisiteNodeIds: [],
    provenance: 'course-source',
    ...overrides,
  };
}

function unit(overrides: Partial<TeachingBlueprintUnit> = {}): TeachingBlueprintUnit {
  return {
    id: 'scaffold',
    title: '教学支架',
    knowledgePointIds: ['kp-scaffold'],
    learningOutcome: '说明支持应如何随学生能力变化',
    explanation: '单元全文不直接等同于本页教学责任。',
    mechanism: '',
    workedExample: '',
    conditions: [],
    misconceptions: [],
    sourceKind: 'course-source',
    evidenceQuotes: [],
    explanationNodes: [node()],
    ...overrides,
  };
}

function page(overrides: Partial<TeachingBlueprintPage> = {}): TeachingBlueprintPage {
  return {
    id: 'page-scaffold',
    title: '教学支架的调整',
    type: 'slide',
    unitIds: ['scaffold'],
    knowledgePointIds: ['kp-scaffold'],
    description: '讲解支架的支持作用与撤除条件',
    keyPoints: ['教学支架提供暂时支持，并随学生能力提升逐渐撤除。'],
    teachingObjective: '能够判断何时调整和撤除支架',
    introducesNodeIds: ['concept'],
    deepensNodeIds: [],
    referencesNodeIds: [],
    ...overrides,
  };
}

describe('projectTeachingPageContent', () => {
  it('keeps the authored core point on screen and the complete definition in the teaching channel', () => {
    const source = node().content;
    const authored = page();
    const projected = projectTeachingPageContent({ units: [unit()] }, authored);

    expect(projected.presentationContent).toEqual(authored.keyPoints);
    expect(projected.presentationContent).not.toContain(source);
    expect(projected.explanation).toEqual([source]);
    expect(projected.introducedConceptDefinitions).toEqual([source]);
    expect(projected.visibleContent).toEqual(authored.keyPoints);
    expect(projected.visibleContent).not.toContain(source);
  });

  it('retains complete owned conditions and mechanisms without adding unowned source prose to the display', () => {
    const mechanism = node({
      id: 'adjustment', kind: 'mechanism',
      content: '教学支架是可调节的；教学支架具有暂时性和渐消性，不能替代学生独立解决问题。',
    });
    const boundary = node({ id: 'boundary', kind: 'condition', content: '学生尚不能独立完成任务时保留必要支持。' });
    const unowned = node({ id: 'other-page', content: '另页负责完整比较三种评价方式。' });
    const authored = page({ deepensNodeIds: ['adjustment', 'boundary'] });
    const projected = projectTeachingPageContent({ units: [unit({
      explanationNodes: [node(), mechanism, boundary, unowned],
    })] }, authored);

    expect(projected.presentationContent).toEqual(authored.keyPoints);
    expect(projected.reasoningSteps).toEqual([mechanism.content, boundary.content]);
    expect(projected.ownedNodes.map((owned) => owned.id)).toEqual(['concept', 'adjustment', 'boundary']);
    expect(projected.explanation).not.toContain(unowned.content);
    expect(projected.visibleContent).not.toContain(unowned.content);
  });

  it('preserves authored order and separate conditions instead of fuzzy matching them into one point', () => {
    const points = [
      ' 学生不能独立完成任务时，保留必要支持。 ',
      '学生能够独立完成任务时，撤除额外支持。',
      '学生不能独立完成任务时，保留必要支持。',
      '支持可以调整；支持也应逐渐撤除。',
      '',
    ];
    const projected = projectTeachingPageContent({ units: [unit()] }, page({ keyPoints: points }));

    expect(projected.presentationContent).toEqual([
      points[0].trim(), points[1], points[3],
    ]);
    expect(points[0]).toMatch(/^ /);
  });

  it('includes owned cross-unit deepening in teaching meaning but excludes referenced-only nodes', () => {
    const previous = unit({ id: 'earlier', explanationNodes: [node({
      id: 'prior-condition', kind: 'condition', content: '此前的支架只在任务难度超出独立能力时使用。',
    }), node({ id: 'reference-only', content: '此前已经讲授的其他概念。' })] });
    const authored = page({ deepensNodeIds: ['prior-condition'], referencesNodeIds: ['reference-only'] });
    const projected = projectTeachingPageContent({ units: [previous, unit()] }, authored);

    expect(projected.ownedNodes.map((owned) => owned.id)).toEqual(['concept', 'prior-condition']);
    expect(projected.reasoningSteps).toEqual([previous.explanationNodes![0].content]);
    expect(projected.presentationContent).toEqual(authored.keyPoints);
  });

  it('keeps independent task conditions in teaching meaning and the authored task points in presentation', () => {
    const authored = page({
      type: 'interactive',
      keyPoints: ['比较初学者与熟练者所需的支持，并说明调整依据。'],
      learningTask: {
        learnerAction: '分别为两名学生选择支持方式。',
        newContribution: '根据独立能力调整支持。',
        reasoningFocus: '为什么同一任务需要不同支架？',
        caseUse: 'independent',
        changedConditions: ['学生已有能力不同。'],
        preservedConditions: ['任务目标和评价标准相同。'],
      },
    });
    const projected = projectTeachingPageContent({ units: [unit()] }, authored);

    expect(projected.presentationContent).toEqual(authored.keyPoints);
    expect(projected.visibleContent).toEqual(expect.arrayContaining([
      node().content,
      authored.learningTask!.learnerAction,
      ...authored.learningTask!.changedConditions,
      ...authored.learningTask!.preservedConditions,
    ]));
  });

  it('preserves legacy node identity without inventing a slide presentation for section-wide meaning', () => {
    const legacy = unit({ explanationNodes: undefined, mechanism: '依据学生表现调整支持，再逐渐撤除。' });
    const projected = projectTeachingPageContent({ units: [legacy] }, page({
      introducesNodeIds: ['scaffold:legacy-explanation'],
    }));
    const sectionOnly = projectTeachingPageContent({ units: [legacy] });

    expect(projected.ownedNodes[0].id).toBe('scaffold:legacy-explanation');
    expect(projected.reasoningSteps).toEqual([legacy.mechanism]);
    expect(projected.presentationContent).toEqual(page().keyPoints);
    expect(sectionOnly.explanation).toEqual([legacy.mechanism]);
    expect(sectionOnly.presentationContent).toEqual([]);
  });
});
