import { afterAll, expect, it } from 'vitest';
import type { TeachingVisualScene } from '@openmaic/dsl';
import type { SceneOutline } from '../types/generation';
import { compileTeachingVisualScene } from './teaching-visual-compiler';
import { closeSpatialMeasurementBrowser, measureAuthoredSlideText } from './slide-spatial-measurement';
import { auditSlideDensity } from './slide-layout-audit';
import { slideVisualSourceContent } from './slide-visual-projection';

afterAll(closeSpatialMeasurementBrowser);

it('keeps the true feedback and exit visible beside concise conditions without an invented closing arrow', async () => {
  const facts = ['Keep the smallest relevant input', 'Compare actual and expected values',
    "Rerun the same check; don't expand the repair scope", 'Check related regressions before finishing'];
  const page: SceneOutline = { id: 'feedback-style', type: 'slide', title: 'Repair and verify', order: 0,
    description: facts.join('. '), keyPoints: facts, audience: 'student', generationPurpose: 'knowledge-teaching',
    visualIntent: { representation: 'native-diagram', observationGoal: 'Read the real return edge and exit', diagram: {
      topology: 'cycle', nodes: [
        { id: 'reproduce', label: 'Reproduce the relevant failure' }, { id: 'inspect', label: 'Inspect the first incorrect state' },
        { id: 'fix', label: 'Fix the cause and rerun the check' }, { id: 'finish', label: 'Check related regressions and finish' },
      ], edges: [{ from: 'reproduce', to: 'inspect' }, { from: 'inspect', to: 'fix' },
        { from: 'fix', to: 'inspect', label: 'Still fails' }, { from: 'fix', to: 'finish', label: 'Failing check passes' }],
    } } };
  const scene: TeachingVisualScene = { schemaVersion: 1, designVersion: 'teaching-visual-v2', pages: [{ id: page.id,
    title: page.title, focus: 'Separate the repeated check from the successful exit', components: [{ id: 'feedback',
      title: 'Redundant large primary heading', kind: 'process', role: 'primary', useAdoptedDiagram: true,
      nodes: facts.map((text, index) => ({ id: `condition-${index + 1}`, text,
        anchorId: page.visualIntent!.diagram!.nodes[index]!.id, sourceContentIds: [`adopted-content-${index + 1}`] })),
    }] }] };
  const original = structuredClone({ page, scene });
  const result = await compileTeachingVisualScene(page, scene, { measure: measureAuthoredSlideText,
    sourceCatalog: slideVisualSourceContent(page), allowSplit: false });
  expect(result).not.toBeNull();
  if (!result) throw new Error('The short conditions and complete feedback graph should fit one page');
  expect(result.continuationPages ?? []).toHaveLength(0);
  expect(result.elements.some((element) => element.id === 'feedback:title')).toBe(false);
  const edges = result.elements.filter((element) => element.type === 'line' && element.id.startsWith('feedback-edge-'));
  expect(edges).toHaveLength(4);
  expect(auditSlideDensity(page, result).underrepresentedKeyPoints).toEqual([]);
  for (const element of result.elements) if (element.type !== 'line') {
    expect(element.top + element.height, element.id).toBeLessThanOrEqual(532.5);
    expect(element.left + element.width, element.id).toBeLessThanOrEqual(1000);
    for (const [, size] of JSON.stringify(element).matchAll(/font-size:\s*([\d.]+)px/gu)) expect(Number(size)).toBeGreaterThanOrEqual(18);
  }
  expect({ page, scene }).toEqual(original);
}, 20_000);
