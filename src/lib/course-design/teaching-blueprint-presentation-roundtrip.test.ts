import { describe, expect, it } from 'vitest';
import type { TeachingBlueprint, TeachingExplanationNode } from '@/lib/session/types';
import { applyReviewedOutlinesToTeachingBlueprint, teachingBlueprintToOutlines } from './teaching-blueprint';

const definition = '建构主义的核心机制：同化与顺应，说的是新信息进入时认知结构可能发生的两种变化。建构主义认为儿童的认知发展是通过与环境互动逐渐自我构建和成长的过程。同化是把新的信息或经验与个体已有认知结构相融合，学生依赖已有知识框架解释和理解新的刺激，不要求对现存认知结构作根本改变；顺应是当新信息与既有知识体系不兼容或发生冲突时，调整、重组或扩展认知结构以容纳新知识。';
const mechanism = '小鱼先按鱼的形态解释牛的特征，原有结构没有改变。这些特征拼出的形象与牛的真实结构不一致，冲突出现，经青蛙引导与纠正，小鱼改组原有认知结构。';
const example = '青蛙描述牛有两只角、四条腿并在草地上吃草；小鱼把这些特征拼在鱼的形态上，经引导与纠正才更新对牛的理解。';
const boundary = '同化与顺应的区别是原有结构是否改变，不能仅用内容难度区分两种机制。';
const points = [
  '同化用已有认知结构解释新信息，原有结构不变。',
  '新信息与已有结构冲突时，顺应通过改组结构形成新理解。',
];

function blueprint(): TeachingBlueprint {
  const nodes: TeachingExplanationNode[] = [
    { id: 'definition', kind: 'term', content: definition, prerequisiteNodeIds: [] },
    { id: 'mechanism', kind: 'mechanism', content: mechanism, prerequisiteNodeIds: ['definition'] },
    { id: 'example', kind: 'example', content: example, prerequisiteNodeIds: ['mechanism'] },
    { id: 'boundary', kind: 'misconception', content: boundary, prerequisiteNodeIds: ['definition'] },
  ].map((node) => ({ ...node, knowledgePointIds: ['kp'], provenance: 'course-source' } as TeachingExplanationNode));
  return {
    schemaVersion: 3, inputFingerprint: 'presentation-roundtrip', assessmentMode: 'adaptive',
    createdAt: '2026-09-30T12:00:00.000Z',
    budget: { totalDurationSec: 400, teachingDurationSec: 345, learnerActivityDurationSec: 0,
      assessmentDurationSec: 55, teachingRatio: 345 / 400, assessmentRatio: 55 / 400 },
    sections: [{
      id: 'section', title: '同化与顺应', order: 0, knowledgePointIds: ['kp'],
      learningObjective: '依据认知结构的变化区分同化与顺应',
      sharedContext: { learningPurpose: '理解新信息与已有认知结构的关系',
        caseId: 'fish-and-cow', caseFacts: [example], fixedWording: [],
        stableTerms: ['同化', '顺应'], conceptBoundaries: [boundary] },
      units: [{
        id: 'unit', title: '同化与顺应', knowledgePointIds: ['kp'],
        learningOutcome: '判断原有认知结构是否改变', explanation: definition, mechanism,
        workedExample: example, conditions: [], misconceptions: [boundary],
        sourceKind: 'course-source', evidenceQuotes: [definition, example], explanationNodes: nodes,
      }],
      pages: [{
        id: 'page', title: '同化与顺应', type: 'slide', unitIds: ['unit'], knowledgePointIds: ['kp'],
        description: '比较新信息进入后认知结构的两种变化', keyPoints: [...points],
        teachingObjective: '区分结构不变与结构改组', introducesNodeIds: nodes.map((node) => node.id),
        deepensNodeIds: [], referencesNodeIds: [],
        resourceNeeds: [{ kind: 'image', required: true, purpose: '比较小鱼想象的牛与真实牛的结构差异',
          prompt: '比较小鱼想象的鱼形牛与真实牛', aspectRatio: '16:9' }],
        visualRelationship: { kind: 'causal', description: '新信息兼容或冲突导致不同结构变化',
          readingOrder: ['新信息', '兼容或冲突', '结构不变或改组'], preferredForm: 'mixed',
          rationale: '分支图表达认知机制，案例图提供真实外形冲突的观察依据',
          diagram: { topology: 'branch',
            nodes: [{ id: 'input', label: '新信息' }, { id: 'compatible', label: '兼容：同化' },
              { id: 'conflict', label: '冲突：顺应' }],
            edges: [{ from: 'input', to: 'compatible' }, { from: 'input', to: 'conflict' }],
            annotation: '同化保留原有结构；顺应改组原有结构。' } },
      }],
      quizOutlineId: 'section-check', assessmentFocus: ['根据结构是否改变判断认知机制'],
      understandingCriteria: { goals: ['区分同化与顺应'], answerEssentials: ['依据认知结构是否改变'],
        misconceptions: [boundary], supportingUnitIds: ['unit'] },
      teachingDurationSec: 345, learnerActivityDurationSec: 0, assessmentDurationSec: 55,
    }],
  };
}

describe('blueprint presentation through outline confirmation', () => {
  it('keeps authored display points through unchanged confirmation without losing source teaching or visuals', () => {
    const original = blueprint();
    const first = teachingBlueprintToOutlines(original, '使用简体中文');
    const firstPage = first.find((page) => page.id === 'page')!;
    expect(firstPage.keyPoints).toEqual(points);
    expect(firstPage.teachingBrief?.teachingPlan?.visibleContent).toContain(definition);
    let adopted = original;

    for (let pass = 0; pass < 3; pass += 1) {
      adopted = applyReviewedOutlinesToTeachingBlueprint(adopted, teachingBlueprintToOutlines(adopted, '使用简体中文'));
      const compiled = teachingBlueprintToOutlines(adopted, '使用简体中文');
      const page = compiled.find((candidate) => candidate.id === 'page')!;
      expect(adopted.sections[0]!.pages[0]!.keyPoints).toEqual(points);
      expect(page.keyPoints).toEqual(points);
      expect(page.teachingBrief?.teachingPlan?.presentationContent).toEqual(points);
      expect(page.teachingBrief?.teachingPlan?.visibleContent).toEqual(firstPage.teachingBrief?.teachingPlan?.visibleContent);
      expect(page.teachingBrief?.explanation).toBe(firstPage.teachingBrief?.explanation);
      expect(page.teachingBrief?.examples).toEqual([example]);
      expect(page.teachingBrief?.conditions).toEqual([boundary]);
      expect(page.teachingBrief?.evidence).toEqual(firstPage.teachingBrief?.evidence);
      expect(page.teachingBrief?.teachingPlan?.introduces).toEqual(firstPage.teachingBrief?.teachingPlan?.introduces);
      expect(page.visualIntent).toEqual(firstPage.visualIntent);
      expect(page.mediaGenerations).toEqual(firstPage.mediaGenerations);
      expect(page.plannedTiming).toEqual(firstPage.plannedTiming);
      expect(adopted.sections[0]!.units[0]!.explanationNodes).toEqual(original.sections[0]!.units[0]!.explanationNodes);
      expect(compiled.reduce((sum, candidate) => sum + candidate.targetDurationSec!, 0)).toBe(400);
    }
    expect(original.sections[0]!.pages[0]!.keyPoints).toEqual(points);
  });

  it('adopts the teacher’s actual edited points even when the inherited brief has the earlier presentation', () => {
    const original = blueprint();
    const outlines = teachingBlueprintToOutlines(original, '使用简体中文');
    const edited = ['同化时认知结构保持不变。', '顺应由新信息与旧结构冲突触发，并改组旧结构。'];
    const reviewed = outlines.map((outline) => outline.id === 'page' ? { ...outline, keyPoints: edited } : outline);
    expect(reviewed[0]!.teachingBrief?.teachingPlan?.presentationContent).toEqual(points);

    const adopted = applyReviewedOutlinesToTeachingBlueprint(original, reviewed);
    const page = teachingBlueprintToOutlines(adopted, '使用简体中文')[0]!;
    expect(adopted.sections[0]!.pages[0]!.keyPoints).toEqual(edited);
    expect(page.keyPoints).toEqual(edited);
    expect(page.teachingBrief?.teachingPlan?.presentationContent).toEqual(edited);
    expect(page.teachingBrief?.teachingPlan?.visibleContent).toContain(definition);
    expect(page.teachingBrief?.explanation).toBe(outlines[0]!.teachingBrief?.explanation);
    expect(page.visualIntent).toEqual(outlines[0]!.visualIntent);
    expect(original.sections[0]!.pages[0]!.keyPoints).toEqual(points);
  });

  it.each([undefined, []])('preserves the full visible fallback in accepted legacy plans without display points (%s)', (presentationContent) => {
    const original = blueprint();
    const compiled = teachingBlueprintToOutlines(original, '使用简体中文')[0]!;
    const page = original.sections[0]!.pages[0]!;
    page.sectionPlanVersion = 'accepted-legacy';
    page.teachingBrief = { ...compiled.teachingBrief!, teachingPlan: {
      ...compiled.teachingBrief!.teachingPlan!, presentationContent,
    } };

    const legacy = teachingBlueprintToOutlines(original, '使用简体中文')[0]!;
    expect(legacy.keyPoints).toEqual(compiled.teachingBrief?.teachingPlan?.visibleContent);
    expect(legacy.keyPoints).toContain(definition);
    expect(legacy.teachingBrief).toBe(page.teachingBrief);
    expect(legacy.visualIntent).toEqual(compiled.visualIntent);
  });
});
