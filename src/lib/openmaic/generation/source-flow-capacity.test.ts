import { afterAll, describe, expect, it } from 'vitest';
import type { SceneOutline } from '../types/generation';
import type { TeachingExplanationNode } from '@/lib/session/types';
import fixture from './__fixtures__/source-flow-capacity.json';
import { evaluateSemanticPageCapacity } from './semantic-page-capacity';
import { replanMeasuredTeachingSection } from './section-capacity-replanner';
import { prepareTeachingPageCapacity } from './teaching-page-preflight';
import { closeSpatialMeasurementBrowser } from './slide-spatial-measurement';

const outlines = fixture.outlines as unknown as SceneOutline[];
const explanationNodes = fixture.explanationNodes as TeachingExplanationNode[];
const resourceDimensions = Object.fromEntries(fixture.resources.map((resource) => [resource.id, resource]));
const options = { explanationNodes, resourceDimensions };
const figureId = 'textbook_fig_abded1f47532';
const flowId = 'teaching-section-4-unit-1-node-3';
const original = outlines.find((page) => page.id === 'teaching-section-4-page-1')!;
const flowNode = explanationNodes.find((node) => node.id === flowId)!;
const wholeFlow = original.keyPoints[2]!;
afterAll(() => closeSpatialMeasurementBrowser());

describe('measured original-figure and complete-flow responsibility', () => {
  it.each(['source-image', 'mixed'] as const)('uses canonical source steps when readingOrder contains instructions, keeping the complete narration with its figure in %s production', async (representation) => {
    const page = structuredClone(original);
    page.visualIntent!.representation = representation;
    const sourceSteps = page.teachingBrief!.teachingPlan!.visualRelationship!.readingOrder.map((label) => ({ label }));
    page.teachingBrief!.teachingPlan!.visualRelationship!.readingOrder = ['先从第一个环节读到最后一个环节', '再看每个环节的教师与学生任务'];
    const sourceOptions = { resourceDimensions, resourceSequences: { [figureId]: sourceSteps } };
    for (const context of [sourceOptions, { ...sourceOptions, explanationNodes }]) {
      const assessment = await evaluateSemanticPageCapacity(page, context);
      const anchor = assessment.groups.find((group) => group.visibleText === wholeFlow)!;
      const image = assessment.groups.find((group) => group.resourceIds.includes(figureId))!;
      expect(image.indivisibleWith).toEqual([anchor.id]);
      expect(anchor.narrationExpansion).toContain(flowNode.content);
      expect(assessment.groups.filter((group) => group.narrationExpansion.includes(flowNode.content))).toEqual([anchor]);
      expect(assessment.groups.filter((group) => group.visibleText).map((group) => group.visibleText)).toEqual(page.keyPoints);
    }
    const result = await replanMeasuredTeachingSection([page], { ...sourceOptions, explanationNodes });
    expect(result.status).toBe('replanned');
    if (result.status !== 'replanned') return;
    const imagePage = result.outlines.find((candidate) => candidate.visualIntent?.resourceRefs?.some((ref) => ref.resourceId === figureId))!;
    expect(imagePage.keyPoints).toContain(wholeFlow);
    expect(imagePage.teachingBrief!.teachingPlan!.introduces).toContain(flowId);
    expect(imagePage.teachingBrief!.explanation).toContain(flowNode.content);
    const production = await evaluateSemanticPageCapacity(imagePage, sourceOptions);
    expect(production.selectedLayout?.fits).toBe(true);
  });
  it('anchors the original figure and full source node to the existing ordered overview, not the similar detailed step', async () => {
    const assessment = await evaluateSemanticPageCapacity(original, options);
    const anchor = assessment.groups.find((group) => group.visibleText === wholeFlow)!;
    const media = assessment.groups.find((group) => group.resourceIds.includes(figureId))!;
    expect(anchor.sourceNodeIds).toContain(flowId);
    expect(anchor.narrationExpansion).toContain(flowNode.content);
    expect(media.indivisibleWith).toContain(anchor.id);
    expect(anchor.indivisibleWith).toContain(media.id);
    expect(assessment.groups.filter((group) => group.sourceNodeIds.includes(flowId))).toEqual([anchor]);
    expect(assessment.groups.flatMap((group) => group.narrationExpansion).filter((text) => text === flowNode.content)).toHaveLength(1);
    expect(assessment.groups.filter((group) => group.visibleText).map((group) => group.visibleText)).toEqual(original.keyPoints);
  });

  it('preserves all three original figures, locked pages, source text, node identity, sequence and every timing component', async () => {
    const locked = outlines.filter((page) => page.lectureSectionId !== 'teaching-section-4');
    const result = await prepareTeachingPageCapacity(outlines, { ...options,
      completedOutlineIds: locked.map((page) => page.id) });
    expect(result.changed).toBe(true);
    const section = result.outlines.filter((page) => page.lectureSectionId === 'teaching-section-4');
    const originals = outlines.filter((page) => page.lectureSectionId === 'teaching-section-4');
    const imagePage = section.find((page) => page.visualIntent?.resourceRefs?.some((ref) => ref.resourceId === figureId))!;
    expect(imagePage.keyPoints).toContain(wholeFlow);
    expect(imagePage.teachingBrief?.teachingPlan?.introduces).toContain(flowId);
    expect(imagePage.teachingBrief?.teachingPlan?.narrationFocus).toContain(flowNode.content);
    expect(imagePage.teachingBrief?.teachingPlan?.visualRelationship).toEqual(original.teachingBrief?.teachingPlan?.visualRelationship);
    expect(imagePage.visualIntent?.observationGoal).toBe(original.visualIntent?.observationGoal);
    expect(section.flatMap((page) => page.keyPoints)).toEqual(originals.flatMap((page) => page.keyPoints));
    for (const node of explanationNodes.filter((node) => node.id.startsWith('teaching-section-4-'))) {
      expect(section.flatMap((page) => page.teachingBrief?.teachingPlan?.introduces ?? [])).toContain(node.id);
      expect(section.map((page) => page.teachingBrief?.explanation).join('\n')).toContain(node.content);
    }
    const sourceFigures = (pages: SceneOutline[]) => pages.flatMap((page) => page.visualIntent?.resourceRefs ?? [])
      .filter((ref) => ref.kind === 'source-image').map((ref) => ref.resourceId).sort();
    expect(sourceFigures(result.outlines)).toEqual(sourceFigures(outlines));
    expect(sourceFigures(result.outlines)).toHaveLength(3);
    for (const page of locked) {
      const actual = result.outlines.find((candidate) => candidate.id === page.id)!;
      // The global list index may shift as unlocked pages are inserted.
      expect({ ...actual, order: page.order }).toEqual(page);
    }
    for (const field of ['targetDurationSec', 'estimatedDuration'] as const) {
      expect(section.reduce((sum, page) => sum + (page[field] ?? 0), 0))
        .toBe(originals.reduce((sum, page) => sum + (page[field] ?? 0), 0));
    }
    for (const field of ['narrationSec', 'learnerActivitySec', 'transitionSec'] as const) {
      expect(section.reduce((sum, page) => sum + (page.plannedTiming?.[field] ?? 0), 0))
        .toBe(originals.reduce((sum, page) => sum + (page.plannedTiming?.[field] ?? 0), 0));
    }
    for (const page of section.filter((page) => page.sourcePageIds?.includes(original.id) && page !== imagePage)) {
      expect(page.teachingBrief?.teachingPlan?.visualRelationship).toMatchObject({ kind: 'statement', preferredForm: 'text' });
    }
    expect(result.assessments.every((assessment) => assessment.selectedLayout?.fits)).toBe(true);
    expect(result.assessments.every((assessment) => assessment.selectedLayout!.bodyFontSize >= 22)).toBe(true);
  });

  it('does not import global explanation nodes into an explicit media-only empty responsibility', async () => {
    const page = structuredClone(original);
    page.keyPoints = [];
    page.teachingBrief!.explanation = '';
    Object.assign(page.teachingBrief!.teachingPlan!, { introduces: [], deepens: [], references: [],
      presentationContent: [], visibleContent: [], narrationFocus: [] });
    const assessment = await evaluateSemanticPageCapacity(page, options);
    expect(assessment.groups.flatMap((group) => group.sourceNodeIds)).toEqual([]);
    expect(assessment.groups.flatMap((group) => group.narrationExpansion)).toEqual([]);
    expect(assessment.groups.map((group) => group.visibleText).join('\n')).not.toContain(flowNode.content);
  });

  it('stops when the complete flow and figure cannot fit instead of splitting their responsibility or shrinking text', async () => {
    const before = structuredClone(original);
    const result = await replanMeasuredTeachingSection([original], { ...options,
      measure: async ({ text, fontSize }) => ({ naturalWidth: 900,
        height: text === wholeFlow ? 900 : fontSize * 1.5, lines: [text] }),
    });
    expect(result.status).toBe('infeasible');
    expect(original).toEqual(before);
    expect(result.assessments[0]!.groups.find((group) => group.visibleText === wholeFlow)?.sourceNodeIds).toContain(flowId);
  });

  it('keeps a long definition, complete flow and classroom case intact under mixed-density pagination', async () => {
    const page = structuredClone(original);
    const caseText = '课堂案例：学生围绕校园节水问题选择项目，先制定调查与分工计划，再活动探究收集证据，制作节水方案作品，通过成果交流说明依据，最后活动评价反思方案的限制。';
    page.keyPoints.push(caseText);
    const plan = page.teachingBrief!.teachingPlan!;
    plan.presentationContent = [...page.keyPoints];
    plan.visibleContent.push(caseText);
    plan.narrationFocus.push(caseText);
    // This case itself contains the ordered sequence. An ambiguous pair of
    // complete statements must not be silently assigned a unique source role.
    const ambiguous = await evaluateSemanticPageCapacity(page, options);
    const media = ambiguous.groups.find((group) => group.resourceIds.includes(figureId))!;
    expect(media.indivisibleWith).not.toContain(ambiguous.groups.find((group) => group.visibleText === caseText)!.id);
    page.keyPoints[page.keyPoints.length - 1] = '课堂案例：学生以校园节水为真实问题，制作方案并向后勤人员展示；若课程只要求反复练习一个基本操作，就不宜为了形式完整而套用项目式教学。';
    plan.presentationContent = [...page.keyPoints];
    plan.visibleContent[plan.visibleContent.length - 1] = page.keyPoints.at(-1)!;
    plan.narrationFocus[plan.narrationFocus.length - 1] = page.keyPoints.at(-1)!;
    const result = await replanMeasuredTeachingSection([page], options);
    expect(result.status).toBe('replanned');
    if (result.status !== 'replanned') return;
    expect(result.outlines.flatMap((candidate) => candidate.keyPoints)).toEqual(page.keyPoints);
    const imagePage = result.outlines.find((candidate) => candidate.visualIntent?.resourceRefs?.some((ref) => ref.resourceId === figureId))!;
    expect(imagePage.teachingBrief?.teachingPlan?.introduces).toContain(flowId);
    expect(imagePage.teachingBrief?.teachingPlan?.narrationFocus).toContain(flowNode.content);
  });
});
