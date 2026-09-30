import { afterAll, describe, expect, it } from 'vitest';
import type { SceneOutline } from '../types/generation';
import type { TeachingExplanationNode } from '@/lib/session/types';
import fixture from './__fixtures__/task-driven-capacity.json';
import { replanMeasuredTeachingSection } from './section-capacity-replanner';
import { evaluateSemanticPageCapacity } from './semantic-page-capacity';
import { closeSpatialMeasurementBrowser } from './slide-spatial-measurement';

const original = fixture.outline as unknown as SceneOutline;
const explanationNodes = fixture.explanationNodes as TeachingExplanationNode[];
afterAll(() => closeSpatialMeasurementBrowser());

describe('directed prerequisites during measured pagination', () => {
  it('teaches the complete real definition before the condition, preserving every point, process and example within 107 seconds', async () => {
    const result = await replanMeasuredTeachingSection([original], { explanationNodes });
    expect(result.status, result.status === 'infeasible' ? JSON.stringify(result.assessments.map((a) => ({ groups: a.groups.map((g) => ({ text: g.visibleText, nodes: g.sourceNodeIds, links: g.indivisibleWith })), reason: a.reason }))) : '').toBe('replanned');
    if (result.status !== 'replanned') return;
    expect(result.outlines.flatMap((page) => page.keyPoints)).toEqual(original.keyPoints);
    const firstTeaching = new Map(result.outlines.flatMap((page, index) =>
      (page.teachingBrief?.teachingPlan?.introduces ?? []).map((id) => [id, index] as const)));
    for (const node of explanationNodes) {
      const pageIndex = firstTeaching.get(node.id)!;
      expect(pageIndex).toBeDefined();
      const page = result.outlines[pageIndex]!;
      expect(page.teachingBrief?.explanation).toContain(node.content);
      for (const prerequisite of node.prerequisiteNodeIds) {
        expect(firstTeaching.get(prerequisite)).toBeLessThanOrEqual(pageIndex);
        if (firstTeaching.get(prerequisite)! < pageIndex) {
          expect(page.teachingBrief?.teachingPlan?.references).toContain(prerequisite);
        }
      }
    }
    expect(firstTeaching.get(explanationNodes[0]!.id)).toBeLessThan(firstTeaching.get(explanationNodes[2]!.id)!);
    expect(result.outlines.reduce((sum, page) => sum + page.targetDurationSec!, 0)).toBe(107);
    expect(result.outlines.reduce((sum, page) => sum + page.plannedTiming!.narrationSec, 0)).toBe(107);
    expect(result.assessments.every((assessment) => assessment.selectedLayout?.fits && assessment.selectedLayout.bodyFontSize >= 22)).toBe(true);
  });

  it('keeps a backward dependency on one page instead of presenting its condition before the concept', async () => {
    const page = structuredClone(original);
    const concept = '随机抽样以总体中明确的抽取机会为基础';
    const condition = '只有抽取机会明确，才能判断随机抽样是否成立';
    page.keyPoints = [condition, concept];
    page.teachingBrief!.explanation = [condition, concept].join('\n');
    Object.assign(page.teachingBrief!.teachingPlan!, { visibleContent: page.keyPoints, presentationContent: page.keyPoints,
      narrationFocus: page.keyPoints, introduces: ['condition', 'concept'], deepens: [], references: [] });
    const capacity = await evaluateSemanticPageCapacity(page, { explanationNodes: [
      { id: 'concept', kind: 'concept', content: concept, prerequisiteNodeIds: [], provenance: 'course-source' },
      { id: 'condition', kind: 'condition', content: condition, prerequisiteNodeIds: ['concept'], provenance: 'course-source' },
    ] });
    expect(capacity.groups[0]!.indivisibleWith).toContain(capacity.groups[1]!.id);
    expect(capacity.groups[1]!.indivisibleWith).toContain(capacity.groups[0]!.id);
  });

  it('preserves a locked accepted page while redistributing only the remaining condition lesson', async () => {
    const locked = { ...structuredClone(original), id: 'accepted-page', keyPoints: ['已经讲授的课堂背景'],
      teachingBrief: undefined, targetDurationSec: 20, plannedTiming: {
        narrationSec: 20, learnerActivitySec: 0, transitionSec: 0, role: 'teaching' as const,
      } };
    const result = await replanMeasuredTeachingSection([locked, original], {
      explanationNodes, lockedOutlineIds: [locked.id],
    });
    expect(result.status).toBe('replanned');
    if (result.status !== 'replanned') return;
    expect(result.outlines[0]).toBe(locked);
    expect(result.outlines.reduce((sum, page) => sum + page.targetDurationSec!, 0)).toBe(127);
  });

  it('does not invent a taught reference for a missing prerequisite', async () => {
    const nodes = structuredClone(explanationNodes);
    nodes[2]!.prerequisiteNodeIds.push('missing-concept');
    const result = await replanMeasuredTeachingSection([original], { explanationNodes: nodes });
    expect(result.status).toBe('replanned');
    if (result.status !== 'replanned') return;
    expect(result.outlines.flatMap((page) => page.teachingBrief?.teachingPlan?.references ?? []))
      .not.toContain('missing-concept');
    // The original node contract is unchanged: the blueprint prerequisite
    // gate still sees and rejects this absent concept after capacity work.
    expect(nodes[2]!.prerequisiteNodeIds).toContain('missing-concept');
  });
});
