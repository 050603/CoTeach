import { afterAll, expect, it } from 'vitest';
import type { SceneOutline } from '../types/generation';
import type { TeachingExplanationNode } from '@/lib/session/types';
import fixture from './__fixtures__/scaffolding-capacity.json';
import { replanMeasuredTeachingSection } from './section-capacity-replanner';
import { evaluateSemanticPageCapacity } from './semantic-page-capacity';
import { closeSpatialMeasurementBrowser } from './slide-spatial-measurement';
const outlines = fixture.outlines as unknown as SceneOutline[];
const explanationNodes = fixture.explanationNodes as TeachingExplanationNode[];
const resourceDimensions = Object.fromEntries(fixture.resources.map((resource) => [resource.id, resource]));
afterAll(() => closeSpatialMeasurementBrowser());

it('assigns an oral-only case after its complete prerequisite instead of linking the entire lesson to a lexically similar definition', async () => {
  const result = await evaluateSemanticPageCapacity(outlines[0]!, { explanationNodes, resourceDimensions });
  const flow = result.groups.find((group) => group.sourceNodeIds.includes('teaching-section-6-unit-1-node-3'))!;
  const example = result.groups.find((group) => group.sourceNodeIds.includes('teaching-section-6-unit-1-node-4'))!;
  expect(example).toBe(flow);
  expect(example.narrationExpansion).toContain(explanationNodes[3]!.content);
  expect(result.groups[0]!.sourceNodeIds).not.toContain(explanationNodes[3]!.id);
  expect(result.groups[0]!.indivisibleWith).not.toContain(flow.id);
  const image = result.groups.find((group) => group.resourceIds.includes('textbook_fig_55e989b6f34d'))!;
  expect(image.indivisibleWith).toContain(result.groups[0]!.id);
  expect(result.groups.filter((group) => group.visibleText).map((group) => group.visibleText)).toEqual(outlines[0]!.keyPoints);
});

it('preserves complete source and diagram responsibilities across a densely authored real section', async () => {
  const result = await replanMeasuredTeachingSection(outlines, { explanationNodes, resourceDimensions });
  expect(result.status).toBe('replanned');
  if (result.status !== 'replanned') return;
  const firstTeaching = new Map(result.outlines.flatMap((page, index) =>
    (page.teachingBrief?.teachingPlan?.introduces ?? []).map((id) => [id, index] as const)));
  for (const node of explanationNodes) {
    const index = firstTeaching.get(node.id)!;
    expect(index).toBeDefined();
    const page = result.outlines[index]!;
    expect(page.teachingBrief?.explanation).toContain(node.content);
    for (const prerequisite of node.prerequisiteNodeIds) {
      expect(firstTeaching.get(prerequisite)).toBeLessThanOrEqual(index);
      if (firstTeaching.get(prerequisite)! < index
        && !page.teachingBrief?.teachingPlan?.deepens?.includes(prerequisite)) {
        expect(page.teachingBrief?.teachingPlan?.references).toContain(prerequisite);
      }
    }
  }
  const originalPoints = outlines.flatMap((page) => page.keyPoints);
  expect(result.outlines.flatMap((page) => page.keyPoints).filter((point) => originalPoints.includes(point)))
    .toEqual(originalPoints);
  expect(result.outlines.flatMap((page) => page.visualIntent?.resourceRefs ?? []))
    .toEqual(outlines.flatMap((page) => page.visualIntent?.resourceRefs ?? []));
  const imagePage = result.outlines.find((page) => page.visualIntent?.resourceRefs?.length)!;
  expect(imagePage.teachingBrief?.teachingPlan?.introduces).toContain('teaching-section-6-unit-1-node-1');
  expect(imagePage.teachingBrief?.explanation).toContain(explanationNodes[0]!.content);
  expect(imagePage.teachingBrief?.teachingPlan?.visualRelationship).toEqual(outlines[0]!.teachingBrief?.teachingPlan?.visualRelationship);
  const diagramPages = result.outlines.filter((page) => page.visualIntent?.diagram);
  expect(diagramPages).toHaveLength(1);
  expect(diagramPages[0]!.visualIntent!.diagram).toEqual(outlines[1]!.visualIntent!.diagram);
  expect(diagramPages[0]!.teachingBrief?.teachingPlan?.visualRelationship).toEqual(outlines[1]!.teachingBrief?.teachingPlan?.visualRelationship);
  for (const field of ['targetDurationSec', 'estimatedDuration'] as const) {
    expect(result.outlines.reduce((sum, page) => sum + (page[field] ?? 0), 0))
      .toBe(outlines.reduce((sum, page) => sum + (page[field] ?? 0), 0));
  }
  for (const field of ['narrationSec', 'learnerActivitySec', 'transitionSec'] as const) {
    expect(result.outlines.reduce((sum, page) => sum + (page.plannedTiming?.[field] ?? 0), 0))
      .toBe(outlines.reduce((sum, page) => sum + (page.plannedTiming?.[field] ?? 0), 0));
  }
  expect(result.assessments.every((assessment) => assessment.selectedLayout?.fits && assessment.selectedLayout.bodyFontSize >= 22)).toBe(true);
});
