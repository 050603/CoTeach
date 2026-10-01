import { describe, expect, it, vi } from 'vitest';
import type { TeachingBlueprint, TeachingExplanationNode } from '@/lib/session/types';
import { applyReviewedOutlinesToTeachingBlueprint, generateTeachingBlueprint, revalidateStoredTeachingBlueprint, teachingBlueprintToOutlines,
  TEACHING_BLUEPRINT_COMPILED_BRIEF_VERSION, type TeachingBlueprintInput } from './teaching-blueprint';
import { REFERENCE_LECTURE_TYPOGRAPHY } from '@/lib/openmaic/generation/slide-presentation-typography';

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
  function teacherFinalFixture() {
    const saved = blueprint();
    const section = saved.sections[0]!;
    const current = section.pages[0]!;
    current.introducesNodeIds = ['definition', 'mechanism'];
    current.presentationItems = [{ text: '新信息与认知结构的变化', nodeIds: ['definition', 'mechanism'], role: 'heading' }];
    current.keyPoints = current.presentationItems.map((item) => item.text);
    section.pages.push({ ...current, id: 'later-page', title: '在案例中辨认结构变化',
      introducesNodeIds: ['example', 'boundary'], deepensNodeIds: [], referencesNodeIds: ['definition'],
      presentationItems: [{ text: '从身体结构观察理解的变化', nodeIds: ['example', 'definition'], role: 'case-observation' }],
      keyPoints: ['从身体结构观察理解的变化'],
    });
    const input: TeachingBlueprintInput = {
      contentReviewMode: 'teacher-final',
      courseTitle: '同化与顺应', subject: '教育学', grade: '大学', projectContext: '',
      learningObjectives: [section.learningObjective], totalDurationSec: 400,
      assessmentMode: 'adaptive', generationMode: 'standard',
      knowledgePoints: [{ id: 'kp', name: '同化与顺应', description: definition, level: 'core', teachingDepth: 'detailed' }],
      sourceContext: `${definition}\n${example}`,
    };
    return { saved, input };
  }

  const sourceCases = [
    { name: 'selected embodied stages', labels: ['前期分析阶段', '核心要素设计阶段', '教学过程实施阶段', '教学评价阶段'],
      selected: [1, 2], semantics: 'ordered-steps' as const,
      partialTeaching: '身体设计把关键概念与学生的身体体验结合。教师在创设的情境中正向引导身体体验，使体验与预定的认知目标保持一致。' },
    { name: 'selected canonical principles and their conditions', labels: [
      '发挥身体认知的主体性,让学生亲身参与学习活动', '让学生学习的思维和过程变得直观可视',
      '创设多维的物理环境和教学情境', '注重身心环境交互学习活动的设计',
      '注重教学目标、资源、交互过程的动态生成性',
    ], selected: [0, 4], semantics: 'enumerated-items' as const,
    partialTeaching: '发挥身体认知的主体性。教师应关注互动中的新思路与新体验，不能完全放弃既定目标与内容。' },
  ];

  function sourceFixture(sourceCase = sourceCases[0]!) {
    const { saved, input } = teacherFinalFixture();
    const source = {
      resourceId: 'actual-adopted-source', required: false, coveragePolicy: 'authored-scope' as const,
      knowledgePointIds: ['kp'], scope: 'knowledge-point' as const, sequenceSemantics: sourceCase.semantics,
      orderedSteps: sourceCase.labels.map((label, index) => ({ label, excerpt: `说明${label}的实际教学含义。`, sourceBlockId: `source-${index}` })),
    };
    input.sourceSequences = [source];
    input.sourceContext += `\n${source.orderedSteps.map((step) => `${step.label}：${step.excerpt}`).join('\n')}`;
    saved.sections[0]!.units[0]!.explanationNodes![0]!.content += ` ${sourceCase.partialTeaching}`;
    saved.sections[0]!.pages[0]!.sourceSequenceUses = [{ resourceId: source.resourceId, coverage: 'selected',
      sourceStepIds: sourceCase.selected.map((index) => source.orderedSteps[index]!.sourceBlockId) }];
    return { saved, input, source, sourceCase };
  }

  it.each(sourceCases)('rejects the same missing $name at generation and teacher-final checkpoint validation', async (sourceCase) => {
    const { saved, input, source } = sourceFixture(sourceCase);
    const before = structuredClone(saved);
    const result = revalidateStoredTeachingBlueprint(saved, input);
    expect(result.blueprint).toBeUndefined();
    sourceCase.selected.forEach((index) => expect(result.issues.join('；')).toContain(source.orderedSteps[index]!.label));
    const ai = vi.fn().mockResolvedValue(JSON.stringify(saved));
    await expect(generateTeachingBlueprint(input, ai)).rejects.toThrow(source.orderedSteps[sourceCase.selected[0]!]!.label);
    expect(ai).toHaveBeenCalledOnce();
    expect(saved).toEqual(before);
  });

  it.each(sourceCases)('accepts complete spoken teaching of $name with concise unchanged display', async (sourceCase) => {
    const { saved, input, source } = sourceFixture(sourceCase);
    const page = saved.sections[0]!.pages[0]!;
    const displayBefore = structuredClone(page.presentationItems);
    saved.sections[0]!.units[0]!.explanationNodes![0]!.content += ` ${sourceCase.selected
      .map((index) => `${source.orderedSteps[index]!.label}：${source.orderedSteps[index]!.excerpt}`).join(' ')}`;
    expect(revalidateStoredTeachingBlueprint(saved, input).issues).toEqual([]);
    const ai = vi.fn().mockResolvedValue(JSON.stringify(saved));
    const generated = await generateTeachingBlueprint(input, ai);
    expect(ai).toHaveBeenCalledOnce();
    expect(generated.sections[0]!.pages[0]!.presentationItems?.map((item) => item.text))
      .toEqual(displayBefore?.map((item) => item.text));
    const outline = teachingBlueprintToOutlines(generated, '使用简体中文')[0]!;
    sourceCase.selected.forEach((index) => {
      expect(outline.teachingBrief?.explanation).toContain(source.orderedSteps[index]!.label);
      expect(outline.keyPoints.join('；')).not.toContain(source.orderedSteps[index]!.label);
    });
    expect(page.presentationItems).toEqual(displayBefore);
  });

  it('requires a declaration only when an actual owned new page already teaches the complete source list', async () => {
    const { saved, input, source } = sourceFixture();
    const page = saved.sections[0]!.pages[0]!;
    page.sourceSequenceUses = [];
    saved.sections[0]!.units[0]!.explanationNodes![0]!.content += ` ${source.orderedSteps.map((step) => step.label).join('→')}。`;
    expect(revalidateStoredTeachingBlueprint(saved, input).issues.join('；')).toContain('须声明 sourceSequenceUses');
    const rejected = vi.fn().mockResolvedValue(JSON.stringify(saved));
    await expect(generateTeachingBlueprint(input, rejected)).rejects.toThrow('须声明 sourceSequenceUses');
    page.sourceSequenceUses = [{ resourceId: source.resourceId, coverage: 'complete' }];
    expect(revalidateStoredTeachingBlueprint(saved, input).issues).toEqual([]);
    const accepted = vi.fn().mockResolvedValue(JSON.stringify(saved));
    await expect(generateTeachingBlueprint(input, accepted)).resolves.toBeDefined();
  });

  it('does not broaden source review to an untouched legacy teacher page in a partially refreshed course', () => {
    const { saved, input } = sourceFixture();
    delete saved.sections[0]!.pages[0]!.presentationItems;
    const before = structuredClone(saved);
    expect(revalidateStoredTeachingBlueprint(saved, input).issues).toEqual([]);
    expect(saved).toEqual(before);
  });

  it('validates actual adopted brief source identities for new display contracts in teacher-final mode', () => {
    const { saved, input } = teacherFinalFixture();
    const outlines = teachingBlueprintToOutlines(saved, '使用简体中文').filter((outline) => outline.type === 'slide');
    const page = saved.sections[0]!.pages[0]!;
    page.sectionPlanVersion = 'accepted-source-plan';
    page.sourcePageIds = [page.id];
    page.plannedTiming = outlines[0]!.plannedTiming;
    page.targetDurationSec = outlines[0]!.targetDurationSec;
    page.teachingBrief = { ...outlines[0]!.teachingBrief!, teachingPlan: { ...outlines[0]!.teachingBrief!.teachingPlan!,
      sourceSequenceUses: [{ resourceId: 'unknown-brief-source', coverage: 'complete' }] } };
    page.sourceSequenceUses = [];
    const result = revalidateStoredTeachingBlueprint(saved, input);
    expect(result.blueprint).toBeUndefined();
    expect(result.issues.join('；')).toContain('未知、重复或不属于本页知识点的来源');
  });

  it('revalidates current owned and actually taught prior display references in a saved teacher-final draft', () => {
    const { saved, input } = teacherFinalFixture();
    const before = structuredClone(saved);
    const result = revalidateStoredTeachingBlueprint(saved, input);
    expect(result.issues).toEqual([]);
    expect(result.blueprint?.sections).toEqual(before.sections);
    expect(saved).toEqual(before);
  });

  it.each(['future', 'unexecuted'] as const)('rejects a saved teacher-final display that borrows a %s node', (availability) => {
    const { saved, input } = teacherFinalFixture();
    const section = saved.sections[0]!;
    if (availability === 'unexecuted') section.pages[1]!.introducesNodeIds = ['boundary'];
    section.pages[0]!.referencesNodeIds = ['example'];
    section.pages[0]!.presentationItems = [{ text: '在小鱼案例中观察认知变化', nodeIds: ['example'], role: 'case-observation' }];
    const before = structuredClone(saved);
    const result = revalidateStoredTeachingBlueprint(saved, input);
    expect(result.blueprint).toBeUndefined();
    expect(result.issues.join('；')).toContain('尚未实际讲授');
    expect(saved).toEqual(before);
  });

  it('retains the existing teacher-final compatibility for saved pages without independent display items', () => {
    const { saved, input } = teacherFinalFixture();
    saved.sections[0]!.pages.forEach((page) => { delete page.presentationItems; });
    saved.sections[0]!.pages[0]!.referencesNodeIds = ['example'];
    const before = structuredClone(saved);
    const result = revalidateStoredTeachingBlueprint(saved, input);
    expect(result.issues).toEqual([]);
    expect(result.blueprint?.sections).toEqual(before.sections);
    expect(saved).toEqual(before);
  });

  it.each([false, true])('revalidates a partially refreshed saved blueprint without rewriting the untouched page or teaching (visual continuation: %s)', (visualContinuation) => {
    const original = blueprint();
    const section = original.sections[0]!;
    section.pages.forEach((page) => {
      page.taskConnection = { mode: 'none', rationale: '用理论与具体案例解释认知变化。' };
      page.caseObservation = { kind: 'generated-image', imageWouldHelp: true,
        subjects: ['小鱼想象的鱼形牛', '真实牛'], composition: '并排观察两种身体结构',
        observableDifference: '比较小鱼想象的牛与真实牛的身体结构、两只角和四条腿',
        reason: '观察身体结构差异以理解原有认知结构与新信息冲突。' };
    });
    section.pages.push({ ...section.pages[0]!, id: 'accepted-old-page', title: '案例细节回看',
      keyPoints: ['牛有两只角、四条腿，先辨认这些可见特征。'],
      introducesNodeIds: [], deepensNodeIds: ['example'], referencesNodeIds: ['definition'],
      resourceNeeds: [], visualRelationship: undefined,
      caseObservation: { kind: 'none', imageWouldHelp: false, observableDifference: '',
        reason: '本页复用此前已建立的可见特征，无需新增观察图片。' },
    });
    const compiled = teachingBlueprintToOutlines(original, '使用简体中文').filter((outline) => outline.type === 'slide');
    section.pages.forEach((page, index) => {
      page.sectionPlanVersion = 'accepted-measurement';
      page.sourcePageIds = [visualContinuation ? section.pages[0]!.id : page.id];
      page.plannedTiming = compiled[index]!.plannedTiming;
      page.targetDurationSec = compiled[index]!.targetDurationSec;
      page.teachingBrief = { ...compiled[index]!.teachingBrief!, designVersion: 'teaching-blueprint-v3-compiled-v21-observation-evidence',
        teachingPlan: { ...compiled[index]!.teachingBrief!.teachingPlan!, presentationTypography: undefined } };
    });
    if (visualContinuation) {
      section.pages[1]!.deepensNodeIds = [];
      section.pages[1]!.referencesNodeIds = [];
      Object.assign(section.pages[1]!.teachingBrief!.teachingPlan!, { introduces: [], deepens: [], references: [] });
    }
    const refreshedIndex = visualContinuation ? 1 : 0;
    const untouchedIndex = visualContinuation ? 0 : 1;
    const refreshed = section.pages[refreshedIndex]!;
    refreshed.presentationItems = [
      { text: '同化：借助已有认知结构解释新信息', nodeIds: ['definition'], role: 'comparison' },
      { text: '顺应：面对新信息冲突，调整认知结构', nodeIds: ['definition', 'mechanism'], role: 'comparison' },
    ];
    refreshed.keyPoints = refreshed.presentationItems.map((item) => item.text);
    // The refresh synchronizes display but keeps the accepted teaching and
    // prior compiled version; the shared compiler performs that local upgrade.
    Object.assign(refreshed.teachingBrief!.teachingPlan!, {
      presentationItems: refreshed.presentationItems,
      presentationContent: refreshed.keyPoints,
      visibleContent: refreshed.keyPoints,
    });
    const before = structuredClone(original);
    const input: TeachingBlueprintInput = {
      courseTitle: '同化与顺应', subject: '教育学', grade: '大学', projectContext: '',
      learningObjectives: [section.learningObjective], totalDurationSec: 400,
      assessmentMode: 'adaptive', generationMode: 'standard',
      knowledgePoints: [{ id: 'kp', name: '同化与顺应', description: definition, level: 'core', teachingDepth: 'detailed' }],
      sourceContext: `${definition}\n${example}`,
    };
    const validated = revalidateStoredTeachingBlueprint(original, input);
    expect(validated.issues).toEqual([]);
    expect(original).toEqual(before);
    const result = validated.blueprint!;
    expect(result.sections[0]!.pages[untouchedIndex]).toEqual(before.sections[0]!.pages[untouchedIndex]);
    expect(result.sections[0]!.units).toEqual(before.sections[0]!.units);
    expect(result.budget).toEqual(before.budget);
    const upgraded = result.sections[0]!.pages[refreshedIndex]!;
    expect(upgraded.plannedTiming).toEqual(before.sections[0]!.pages[refreshedIndex]!.plannedTiming);
    expect(upgraded.teachingBrief).toMatchObject({ designVersion: TEACHING_BLUEPRINT_COMPILED_BRIEF_VERSION,
      explanation: before.sections[0]!.pages[refreshedIndex]!.teachingBrief!.explanation,
      teachingPlan: { presentationContent: refreshed.keyPoints, presentationTypography: REFERENCE_LECTURE_TYPOGRAPHY } });
    const outlines = teachingBlueprintToOutlines(result, '使用简体中文');
    expect(outlines[refreshedIndex]!.keyPoints).toEqual(refreshed.keyPoints);
    expect(outlines[untouchedIndex]!.teachingBrief).toBe(result.sections[0]!.pages[untouchedIndex]!.teachingBrief);
  });

  it('upgrades an adopted slide from its new items even when the old brief still contains prior display text', () => {
    const original = blueprint();
    const compiled = teachingBlueprintToOutlines(original, '使用简体中文')[0]!;
    const page = original.sections[0]!.pages[0]!;
    page.sectionPlanVersion = 'accepted-legacy';
    page.teachingBrief = { ...compiled.teachingBrief!, designVersion: 'previous-contract' };
    page.presentationItems = [{ text: '新信息与认知结构：兼容或冲突', nodeIds: ['definition'], role: 'heading' }];
    page.keyPoints = page.presentationItems.map((item) => item.text);
    const before = structuredClone(page.teachingBrief);
    const upgraded = teachingBlueprintToOutlines(original, '使用简体中文')[0]!;
    expect(upgraded.keyPoints).toEqual(page.keyPoints);
    expect(upgraded.teachingBrief?.designVersion).toBe(TEACHING_BLUEPRINT_COMPILED_BRIEF_VERSION);
    expect(upgraded.teachingBrief?.teachingPlan?.visibleContent).toEqual(page.keyPoints);
    expect(upgraded.teachingBrief?.explanation).toBe(before.explanation);
    expect(page.teachingBrief).toEqual(before);
  });

  it('preserves the adopted interactive task conditions when its display contract is upgraded', () => {
    const original = blueprint();
    const compiled = teachingBlueprintToOutlines(original, '使用简体中文')[0]!;
    const page = original.sections[0]!.pages[0]!;
    page.type = 'interactive';
    page.sectionPlanVersion = 'accepted-interactive';
    const taskConditions = ['操作目标：辨认四条腿与鱼形身体的差异', '保持观察对象和原始情境不变'];
    page.teachingBrief = { ...compiled.teachingBrief!, designVersion: 'previous-contract', teachingPlan: {
      ...compiled.teachingBrief!.teachingPlan!, visibleContent: taskConditions,
    } };
    page.presentationItems = [{ text: '观察身体结构', nodeIds: ['example'], role: 'case-observation' }];
    page.keyPoints = page.presentationItems.map((item) => item.text);
    const upgraded = teachingBlueprintToOutlines(original, '使用简体中文')[0]!;
    expect(upgraded.teachingBrief?.teachingPlan?.visibleContent).toEqual(taskConditions);
    expect(upgraded.teachingBrief?.teachingPlan?.presentationContent).toEqual(page.keyPoints);
    expect(upgraded.teachingBrief?.explanation).toBe(compiled.teachingBrief!.explanation);
  });

  it('keeps authored display points through unchanged confirmation without losing source teaching or visuals', () => {
    const original = blueprint();
    original.sections[0]!.pages[0]!.presentationItems = points.map((text, index) => ({
      text, nodeIds: [index === 0 ? 'definition' : 'mechanism'], role: 'comparison',
    }));
    const first = teachingBlueprintToOutlines(original, '使用简体中文');
    const firstPage = first.find((page) => page.id === 'page')!;
    expect(firstPage.keyPoints).toEqual(points);
    expect(firstPage.teachingBrief?.teachingPlan?.visibleContent).toEqual(points);
    expect(firstPage.teachingBrief?.explanation).toContain(definition);
    let adopted = original;

    for (let pass = 0; pass < 3; pass += 1) {
      adopted = applyReviewedOutlinesToTeachingBlueprint(adopted, teachingBlueprintToOutlines(adopted, '使用简体中文'));
      const compiled = teachingBlueprintToOutlines(adopted, '使用简体中文');
      const page = compiled.find((candidate) => candidate.id === 'page')!;
      expect(adopted.sections[0]!.pages[0]!.keyPoints).toEqual(points);
      expect(page.keyPoints).toEqual(points);
      expect(page.teachingBrief?.teachingPlan?.presentationContent).toEqual(points);
      expect(page.teachingBrief?.teachingPlan?.presentationItems).toEqual(original.sections[0]!.pages[0]!.presentationItems);
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
    original.sections[0]!.pages[0]!.presentationItems = points.map((text) => ({
      text, nodeIds: ['definition'], role: 'comparison',
    }));
    const outlines = teachingBlueprintToOutlines(original, '使用简体中文');
    const edited = ['同化时认知结构保持不变。', '顺应由新信息与旧结构冲突触发，并改组旧结构。'];
    const reviewed = outlines.map((outline) => outline.id === 'page' ? { ...outline, keyPoints: edited } : outline);
    expect(reviewed[0]!.teachingBrief?.teachingPlan?.presentationContent).toEqual(points);

    const adopted = applyReviewedOutlinesToTeachingBlueprint(original, reviewed);
    const page = teachingBlueprintToOutlines(adopted, '使用简体中文')[0]!;
    expect(adopted.sections[0]!.pages[0]!.keyPoints).toEqual(edited);
    expect(page.keyPoints).toEqual(edited);
    expect(page.teachingBrief?.teachingPlan?.presentationContent).toEqual(edited);
    expect(page.teachingBrief?.teachingPlan?.visibleContent).toEqual(edited);
    expect(page.teachingBrief?.explanation).toContain(definition);
    expect(adopted.sections[0]!.pages[0]!.presentationItems).toBeUndefined();
    expect(page.teachingBrief?.teachingPlan?.presentationItems).toBeUndefined();
    expect(page.teachingBrief?.explanation).toBe(outlines[0]!.teachingBrief?.explanation);
    expect(page.visualIntent).toEqual(outlines[0]!.visualIntent);
    expect(original.sections[0]!.pages[0]!.keyPoints).toEqual(points);
  });

  it.each([undefined, []])('preserves the full visible fallback in accepted legacy plans without display points (%s)', (presentationContent) => {
    const original = blueprint();
    const compiled = teachingBlueprintToOutlines(original, '使用简体中文')[0]!;
    const page = original.sections[0]!.pages[0]!;
    const legacyVisible = [definition, ...points];
    page.sectionPlanVersion = 'accepted-legacy';
    page.teachingBrief = { ...compiled.teachingBrief!, teachingPlan: {
      ...compiled.teachingBrief!.teachingPlan!, visibleContent: legacyVisible, presentationContent,
    } };

    const legacy = teachingBlueprintToOutlines(original, '使用简体中文')[0]!;
    expect(legacy.keyPoints).toEqual(legacyVisible);
    expect(legacy.keyPoints).toContain(definition);
    expect(legacy.teachingBrief).toBe(page.teachingBrief);
    expect(legacy.visualIntent).toEqual(compiled.visualIntent);
  });
});
