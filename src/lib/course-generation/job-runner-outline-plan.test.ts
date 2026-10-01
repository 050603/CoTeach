import { describe, expect, it } from 'vitest';
import type { SceneOutline } from '@/lib/openmaic/types/generation';
import type { CourseContent } from '@/lib/session/types';
import { applyVersionedOutlinePlanToCourseContent } from './job-runner';

const before: SceneOutline[] = [
  { id: 'a', type: 'slide', title: '定义', description: '说明定义', keyPoints: ['定义'], order: 0,
    lectureSectionId: 's1', lectureSectionTitle: '第一节', teachingUnitIds: ['unit'], knowledgePointIds: ['kp'],
    targetDurationSec: 120, plannedTiming: { role: 'teaching', narrationSec: 100, learnerActivitySec: 15, transitionSec: 5 } },
  { id: 'b', type: 'slide', title: '关系', description: '说明关系', keyPoints: ['关系'], order: 1,
    lectureSectionId: 's1', lectureSectionTitle: '第一节', teachingUnitIds: ['unit'], knowledgePointIds: ['kp'],
    targetDurationSec: 120, plannedTiming: { role: 'teaching', narrationSec: 100, learnerActivitySec: 15, transitionSec: 5 } },
  { id: 'quiz', type: 'quiz', title: '检测', description: '检测', keyPoints: [], order: 2,
    lectureSectionId: 's1', lectureSectionTitle: '第一节', targetDurationSec: 30 },
  { id: 'other', type: 'slide', title: '教师已确认的另一节', description: '不变', keyPoints: ['不变'], order: 3,
    lectureSectionId: 's2', targetDurationSec: 90 },
];
const after: SceneOutline[] = before.slice(0, 2).map((outline, index) => ({
  ...outline, id: `replanned-${index}`, sourcePageIds: ['a', 'b'], sectionPlanVersion: 'v2',
  title: `重新分配 ${index}`, keyPoints: [`可见责任 ${index}`], targetDurationSec: index === 0 ? 90 : 150,
  plannedTiming: { role: 'teaching', narrationSec: index === 0 ? 80 : 120,
    learnerActivitySec: index === 0 ? 5 : 25, transitionSec: 5 },
  teachingBrief: {
    schemaVersion: 1, explanation: '解释', examples: [], conditions: [], evidence: [], assessmentFocus: '理解',
    resourceNeeds: [{ kind: 'diagram', purpose: '看清关系', required: true }],
    teachingPlan: { purpose: `责任 ${index}`, priorKnowledge: '', newContent: '新认识', learnerQuestion: '',
      reasoningSteps: [], takeaway: '结论', visibleContent: [`可见责任 ${index}`], narrationFocus: ['解释'],
      introduces: [`node-${index}`], deepens: [], references: [],
      visualRelationship: { kind: 'causal', description: '原因与结果', readingOrder: ['原因', '结果'] },
      entryPoint: { kind: 'direct-explanation', object: '定义', bridge: '建立理解' } },
  },
}));
after.push({ ...before[2]!, sectionPlanVersion: 'v2' });

function courseContent(): CourseContent {
  return {
    _openmaicSceneOutlines: before, _openmaicScenesCount: before.length,
    lessonOutline: before.map((outline) => ({ id: outline.id, title: outline.title, stageKey: 'ai-learning',
      objectives: outline.keyPoints, activities: [outline.description], durationMin: 2, targetDurationSec: outline.targetDurationSec })),
    teachingBlueprint: { schemaVersion: 3, inputFingerprint: 'confirmed-input', createdAt: 'original', assessmentMode: 'adaptive',
      budget: { totalDurationSec: 360, teachingDurationSec: 290, learnerActivitySec: 40, assessmentDurationSec: 30 },
      sections: [{ id: 's1', title: '第一节', units: [{ id: 'unit', explanationNodes: [{ id: 'node-0' }, { id: 'node-1' }] }],
        teachingDurationSec: 200, learnerActivityDurationSec: 40, assessmentDurationSec: 30, quizOutlineId: 'quiz',
        pages: before.slice(0, 2).map((outline, index) => ({ id: outline.id, outlineId: outline.id, title: outline.title,
          type: 'slide', unitIds: ['unit'], knowledgePointIds: ['kp'], description: outline.description,
          keyPoints: outline.keyPoints, teachingObjective: '理解', introducesNodeIds: [`node-${index}`] })) },
      { id: 's2', title: '保留第二节', units: [], pages: [{ id: 'other' }] }],
    },
  } as unknown as CourseContent;
}

describe('persisting versioned section plans into course content', () => {
  it('synchronizes the actual new display provenance instead of inheriting items from a source page', () => {
    const content = courseContent();
    content.teachingBlueprint!.sections[0]!.pages[0]!.presentationItems = [
      { text: '旧页完整句', nodeIds: ['node-0'], role: 'key-point' },
    ];
    const original = structuredClone(content);
    const replanned = after.map((outline): SceneOutline => !outline.teachingBrief?.teachingPlan ? outline : {
      ...outline, teachingBrief: { ...outline.teachingBrief, teachingPlan: {
        ...outline.teachingBrief.teachingPlan, presentationItems: [
          { text: outline.keyPoints[0]!, nodeIds: [...outline.teachingBrief.teachingPlan.introduces!], role: 'comparison' },
        ],
      } },
    });
    const updated = applyVersionedOutlinePlanToCourseContent(content, replanned);
    updated.teachingBlueprint!.sections[0]!.pages.forEach((page, index) => {
      expect(page.presentationItems).toEqual(replanned[index]!.teachingBrief!.teachingPlan!.presentationItems);
      expect(page.presentationItems![0]!.text).toBe(page.keyPoints[0]);
      expect(page.presentationItems).not.toBe(replanned[index]!.teachingBrief!.teachingPlan!.presentationItems);
    });
    expect(content).toEqual(original);
    expect(applyVersionedOutlinePlanToCourseContent(updated, replanned)).toEqual(updated);
    expect(applyVersionedOutlinePlanToCourseContent(content, after).teachingBlueprint!.sections[0]!.pages[0]!.presentationItems)
      .toBeUndefined();
  });

  it('leaves all teacher-confirmed content untouched when no version is supplied', () => {
    const content = courseContent();
    expect(applyVersionedOutlinePlanToCourseContent(content, before.map((outline) => ({ ...outline, title: '不同标题' }))))
      .toBe(content);
  });

  it('synchronizes page identities and responsibilities while preserving other sections and section budgets', () => {
    const content = courseContent();
    const original = structuredClone(content);
    const updated = applyVersionedOutlinePlanToCourseContent(content, after);
    expect(updated._openmaicSceneOutlines?.map((outline) => outline.id)).toEqual(['replanned-0', 'replanned-1', 'quiz', 'other']);
    expect(updated.lessonOutline.map((outline) => outline.id)).toEqual(['replanned-0', 'replanned-1', 'quiz', 'other']);
    expect(updated.lessonOutline[0]).toMatchObject({ objectives: ['可见责任 0'], targetDurationSec: 90 });
    expect(updated._openmaicScenesCount).toBe(4);
    expect(updated.knowledgeLectureSections?.[0]).toMatchObject({
      id: 's1', sceneOutlineIds: ['replanned-0', 'replanned-1'], quizOutlineId: 'quiz',
    });
    expect(updated.teachingBlueprint?.sections[0]?.pages.map((page) => page.id)).toEqual(['replanned-0', 'replanned-1']);
    expect(updated.teachingBlueprint?.sections[0]?.pages[0]).toMatchObject({
      sourcePageIds: ['a', 'b'], sectionPlanVersion: 'v2', introducesNodeIds: ['node-0'],
      keyPoints: ['可见责任 0'], plannedTiming: after[0]!.plannedTiming, targetDurationSec: 90,
      teachingBrief: after[0]!.teachingBrief,
      resourceNeeds: after[0]!.teachingBrief!.resourceNeeds,
      visualRelationship: after[0]!.teachingBrief!.teachingPlan!.visualRelationship,
    });
    expect(updated.teachingBlueprint?.sections[0]?.units).toBe(content.teachingBlueprint?.sections[0]?.units);
    expect(updated.teachingBlueprint?.sections[0]).toMatchObject({ teachingDurationSec: 200, learnerActivityDurationSec: 40, assessmentDurationSec: 30 });
    expect(updated.teachingBlueprint?.sections[1]).toBe(content.teachingBlueprint?.sections[1]);
    expect(updated.lessonOutline[3]).toBe(content.lessonOutline[3]);
    expect(updated._openmaicSceneOutlines?.[3]).toBe(content._openmaicSceneOutlines?.[3]);
    expect(content).toEqual(original);
    expect(applyVersionedOutlinePlanToCourseContent(updated, after)).toEqual(updated);
    expect(applyVersionedOutlinePlanToCourseContent(content,
      [...after, { ...before[3]!, title: '旧运行试图覆盖另一节' }])._openmaicSceneOutlines?.[3])
      .toBe(content._openmaicSceneOutlines?.[3]);
  });

  it('retains timing diagnostics while rejecting foreign or unowned source identities without mutating the adopted course', () => {
    const content = courseContent();
    const original = structuredClone(content);
    const timingDifference = after.map((outline, index) => index ? outline : {
      ...outline, targetDurationSec: outline.targetDurationSec! + 1,
    });
    const retained = applyVersionedOutlinePlanToCourseContent(content, timingDifference);
    expect(retained.teachingBlueprint?.qualityDiagnostics?.join('\n')).toContain('实际重规划时长');
    expect(retained._openmaicSceneOutlines?.[0]?.targetDurationSec).toBe(after[0]!.targetDurationSec! + 1);
    expect(() => applyVersionedOutlinePlanToCourseContent(content, after.slice(0, 1))).toThrow('来源不完整');
    expect(() => applyVersionedOutlinePlanToCourseContent(content,
      [{ ...after[0]!, sourcePageIds: ['a', 'other'] }, ...after.slice(1)])).toThrow('来源不完整');
    expect(() => applyVersionedOutlinePlanToCourseContent(content,
      after.map((outline) => ({ ...outline, lectureSectionId: 'new-section' })))).toThrow('已确认的教学蓝图小节');
    const missingBlueprint = { ...content, teachingBlueprint: { ...content.teachingBlueprint!,
      sections: content.teachingBlueprint!.sections.map((section) => section.id === 's1' ? { ...section, pages: [] } : section) } };
    expect(() => applyVersionedOutlinePlanToCourseContent(missingBlueprint, after)).toThrow('蓝图来源');
    expect(content).toEqual(original);
  });

  it('preserves an explicit no-image case decision on text pages after pagination', () => {
    const content = courseContent();
    const observation = { kind: 'none' as const, imageWouldHelp: false, observableDifference: '',
      reason: '本页只解释定义与关系，没有需要观察的实物案例。' };
    content.teachingBlueprint!.sections[0]!.pages[0]!.caseObservation = observation;
    const updated = applyVersionedOutlinePlanToCourseContent(content, after);
    expect(updated.teachingBlueprint?.sections[0]?.pages[0]?.caseObservation).toEqual(observation);
  });

  it('keeps the complete observation on its image page and records the text continuation responsibility', () => {
    const content = courseContent();
    const observation = { kind: 'source-image' as const, imageWouldHelp: true,
      observableDifference: '观察流程图的全部步骤及箭头方向。', reason: '完整原图用于理解真实流程。', resourceIds: ['figure'] };
    content.teachingBlueprint!.sections[0]!.pages[0]!.caseObservation = observation;
    const paginated = after.map((outline, index): SceneOutline => index === 1 ? { ...outline,
      visualIntent: { representation: 'source-image',
        observationGoal: '观察完整流程及箭头方向',
        resourceRefs: [{ resourceId: 'figure', kind: 'source-image' as const, reason: '观察完整流程', required: true }] },
    } : outline);
    const updated = applyVersionedOutlinePlanToCourseContent(content, paginated);
    expect(updated.teachingBlueprint?.sections[0]?.pages[0]?.caseObservation).toMatchObject({
      kind: 'none', imageWouldHelp: false, reason: expect.stringContaining('重新分配 1'),
    });
    expect(updated.teachingBlueprint?.sections[0]?.pages[1]?.caseObservation).toEqual(observation);
    const missingImage = applyVersionedOutlinePlanToCourseContent(content, after);
    expect(missingImage.teachingBlueprint?.qualityDiagnostics?.join('\n')).toContain('案例观察配图未完整保留');
    expect(missingImage.teachingBlueprint?.sections[0]?.pages[0]?.caseObservation).toEqual(observation);
    expect(missingImage.teachingBlueprint?.sections[0]?.pages[0]?.caseObservation?.reason).not.toContain('完整保留于');
  });

  it('preserves the actual image observation after a preceding no-image source page across repeated synchronization', () => {
    const content = courseContent();
    content.teachingBlueprint!.sections[0]!.pages[0]!.caseObservation = {
      kind: 'none', imageWouldHelp: false, observableDifference: '', reason: '仅讲定义。',
    };
    const observation = { kind: 'source-image' as const, imageWouldHelp: true, resourceIds: ['figure'],
      observableDifference: '三个环节按真实顺序连接，最后一条箭头回到第一个环节。', reason: '观察完整循环。' };
    content.teachingBlueprint!.sections[0]!.pages[1]!.caseObservation = observation;
    const paginated = after.map((outline, index): SceneOutline => index === 1 ? { ...outline,
      visualIntent: { representation: 'mixed', observationGoal: observation.observableDifference,
        resourceRefs: [{ resourceId: 'figure', kind: 'source-image', reason: '循环关系', required: true }] },
    } : outline);
    const updated = applyVersionedOutlinePlanToCourseContent(content, paginated);
    expect(updated.teachingBlueprint!.sections[0]!.pages[1]!.caseObservation).toEqual(observation);
    expect(updated.teachingBlueprint!.sections[0]!.pages[0]!.caseObservation!.kind).toBe('none');
    expect(applyVersionedOutlinePlanToCourseContent(updated, paginated)).toEqual(updated);
    expect(updated.teachingBlueprint!.sections[0]!.units).toBe(content.teachingBlueprint!.sections[0]!.units);
  });

  it('preserves different generated-image observations using their actual original media identities', () => {
    const content = courseContent();
    const observations = ['三角形具有三条边。', '四边形具有四条边。'].map((observableDifference) => ({
      kind: 'generated-image' as const, imageWouldHelp: true, observableDifference, reason: '比较真实形状。',
    }));
    content.teachingBlueprint!.sections[0]!.pages.forEach((page, index) => { page.caseObservation = observations[index]; });
    content._openmaicSceneOutlines = content._openmaicSceneOutlines!.map((outline, index) => index < 2 ? { ...outline,
      visualIntent: { representation: 'generated-image' as const, observationGoal: observations[index]!.observableDifference,
        resourceRefs: [{ resourceId: `shape-${index}`, kind: 'generated-image' as const, required: true, reason: '观察形状' }] },
    } : outline);
    const paginated = after.map((outline, index): SceneOutline => index < 2 ? { ...outline,
      visualIntent: { representation: 'mixed', observationGoal: observations[1 - index]!.observableDifference,
        resourceRefs: [{ resourceId: `shape-${1 - index}`, kind: 'generated-image', required: true, reason: '观察形状' }] },
    } : outline);
    const updated = applyVersionedOutlinePlanToCourseContent(content, paginated);
    expect(updated.teachingBlueprint!.sections[0]!.pages.map((page) => page.caseObservation)).toEqual([...observations].reverse());
    expect(applyVersionedOutlinePlanToCourseContent(updated, paginated)).toEqual(updated);
  });
});
