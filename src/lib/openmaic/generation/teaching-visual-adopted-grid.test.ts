import { afterAll, describe, expect, it } from 'vitest';
import type { PPTLineElement, PPTShapeElement, TeachingVisualComponent, TeachingVisualScene } from '@openmaic/dsl';
import type { DiagramPlan } from '@openmaic/generation/browser';
import type { GeneratedSlideContent, SceneOutline } from '../types/generation';
import { compileAdoptedGrid, type AdoptedGridResult } from './teaching-visual-adopted-grid';
import { closeSpatialMeasurementBrowser, measureAuthoredSlideText } from './slide-spatial-measurement';
import { auditSlideDensity } from './slide-layout-audit';
import { teachingVisualSceneProjection } from './teaching-visual-scene';

afterAll(closeSpatialMeasurementBrowser);
const bounds = { left: 44, top: 112, width: 912, height: 420.5 };
const facts = ['Keep the smallest relevant input', 'Compare actual and expected values',
  'Rerun the same check within the same repair scope', 'Check related regressions before finishing'];
function fixture(topology: DiagramPlan['topology'] = 'cycle') {
  const graph: DiagramPlan = { topology, nodes: [
    { id: 'reproduce', label: 'Reproduce the relevant failure' }, { id: 'inspect', label: 'Inspect the first incorrect state' },
    { id: 'fix', label: 'Fix the cause and rerun the check' }, { id: 'finish', label: 'Check related regressions and finish' },
  ], edges: [{ from: 'reproduce', to: 'inspect' }, { from: 'inspect', to: 'fix' },
    ...(topology === 'cycle' ? [{ from: 'fix', to: 'inspect', label: 'Still fails' }] : []),
    { from: 'fix', to: 'finish', label: 'Failing check passes' }] };
  const component: TeachingVisualComponent = { id: 'feedback', kind: 'process', role: 'primary', useAdoptedDiagram: true,
    nodes: facts.map((text, index) => ({ id: `condition-${index + 1}`, text, anchorId: graph.nodes[index]!.id,
      sourceContentIds: [`adopted-content-${index + 1}`] })) };
  return { graph, component };
}
function rendered(result: AdoptedGridResult, graph: DiagramPlan, component: TeachingVisualComponent) {
  const scene: TeachingVisualScene = { schemaVersion: 1, designVersion: 'teaching-visual-v2', pages: [{ id: 'grid',
    title: 'Repair and verify', focus: 'Observe the real return and exit', components: [component] }] };
  const outline: SceneOutline = { id: 'grid', type: 'slide', title: scene.pages[0]!.title, order: 0,
    description: facts.join('. '), keyPoints: facts, audience: 'student', generationPurpose: 'knowledge-teaching',
    visualIntent: { representation: 'native-diagram', observationGoal: 'Observe the actual relationships', diagram: graph } };
  const projection = teachingVisualSceneProjection(scene);
  const content: GeneratedSlideContent = { elements: result.elements, background: { type: 'solid', color: '#FFFFFF' },
    presentationProjection: { ...projection, elementIdsBySource: result.mapping, verified: true },
    teachingVisual: { scene, pageId: 'grid', candidateId: 'measured-grid', compilerVersion: 'test', themeVersion: 'test',
      components: [{ id: component.id, kind: component.kind, elementIds: result.elements.map((element) => element.id),
        sourceContentIds: component.nodes.flatMap((node) => node.sourceContentIds) }] } };
  return { outline, content };
}
function shape(result: AdoptedGridResult, id: string): PPTShapeElement {
  const element = result.elements.find((item) => item.id === `feedback-node-${id}`);
  if (!element || element.type !== 'shape') throw new Error(`Missing original node ${id}`);
  return element;
}
function point(line: PPTLineElement, end: 'start' | 'end') {
  return [line.left + line[end][0], line.top + line[end][1]];
}
function onBoundary(position: number[], rectangle: PPTShapeElement) {
  const [x, y] = position as [number, number];
  const withinX = x >= rectangle.left - 3 && x <= rectangle.left + rectangle.width + 3;
  const withinY = y >= rectangle.top - 3 && y <= rectangle.top + rectangle.height + 3;
  return withinX && withinY && Math.min(Math.abs(x - rectangle.left), Math.abs(x - rectangle.left - rectangle.width),
    Math.abs(y - rectangle.top), Math.abs(y - rectangle.top - rectangle.height)) <= 3;
}
function checkRelationships(result: AdoptedGridResult, graph: DiagramPlan) {
  const edges = result.elements.filter((element): element is PPTLineElement => element.type === 'line');
  expect(edges).toHaveLength(graph.edges!.length);
  for (const [index, relation] of graph.edges!.entries()) {
    const line = edges.find((element) => element.id === `feedback-edge-${index}`)!;
    expect(line.points).toEqual(['', 'arrow']);
    expect(onBoundary(point(line, 'start'), shape(result, relation.from))).toBe(true);
    expect(onBoundary(point(line, 'end'), shape(result, relation.to))).toBe(true);
    const global = (p: [number, number]) => [p[0] + line.left, p[1] + line.top];
    const start = global(line.start), end = global(line.end);
    for (let step = 1; step < 100; step++) {
      const t = step / 100, u = 1 - t;
      const location = line.cubic ? [0, 1].map((axis) => u ** 3 * start[axis]! + 3 * u ** 2 * t * global(line.cubic![0])[axis]!
        + 3 * u * t ** 2 * global(line.cubic![1])[axis]! + t ** 3 * end[axis]!)
        : [start[0]! + t * (end[0]! - start[0]!), start[1]! + t * (end[1]! - start[1]!)];
      expect(location[0]).toBeGreaterThanOrEqual(bounds.left); expect(location[0]).toBeLessThanOrEqual(bounds.left + bounds.width);
      expect(location[1]).toBeGreaterThanOrEqual(bounds.top); expect(location[1]).toBeLessThanOrEqual(bounds.top + bounds.height);
      for (const node of graph.nodes) {
        const box = shape(result, node.id);
        const inNode = location[0]! > box.left + 0.5 && location[0]! < box.left + box.width - 0.5
          && location[1]! > box.top + 0.5 && location[1]! < box.top + box.height - 0.5;
        expect(inNode, `${relation.from} → ${relation.to} crossed ${node.id}`).toBe(false);
      }
    }
    if (relation.label) {
      const label = result.elements.find((element) => element.id === `feedback-edge-label-${index}`);
      expect(label?.type).toBe('text');
      if (label?.type === 'text') {
        expect(label.content).toContain(relation.label);
        expect(label.content).toContain('font-size:18px');
        expect(label.fill).toBe('#FFFFFF');
      }
    }
  }
}

describe('measured native four-object adopted graph', () => {
  it('fits the real long-label feedback graph and exit without adding a closing edge', async () => {
    const { graph, component } = fixture(), original = structuredClone({ graph, component });
    const result = await compileAdoptedGrid(component, graph, bounds, measureAuthoredSlideText);
    expect(result).not.toBeNull();
    if (!result) throw new Error('The complete four-object feedback graph should fit');
    checkRelationships(result, graph);
    expect(shape(result, 'reproduce').left).toBeLessThan(shape(result, 'inspect').left);
    expect(shape(result, 'inspect').top).toBeLessThan(shape(result, 'fix').top);
    expect(shape(result, 'fix').left).toBeGreaterThan(shape(result, 'finish').left);
    for (const [index, node] of graph.nodes.entries()) {
      const plate = shape(result, node.id);
      expect(plate.text?.content).toContain(node.label);
      expect(plate.text?.content).toContain(facts[index]);
      expect(plate.text?.content).toContain('font-size:24px');
      expect(plate.text?.content).toContain('font-size:20px');
      expect(result.mapping[`adopted-content-${index + 1}`]).toEqual([plate.id]);
      expect(result.mapping[`diagram-node:${node.id}`]).toEqual([plate.id]);
      expect(plate.top + plate.height).toBeLessThanOrEqual(bounds.top + bounds.height);
    }
    const { outline, content } = rendered(result, graph, component);
    expect(auditSlideDensity(outline, content).underrepresentedKeyPoints).toEqual([]);
    expect(auditSlideDensity(outline, content).semanticStructureSatisfied).toBe(true);
    const missing = structuredClone(content);
    missing.elements = missing.elements.filter((element) => element.id !== 'feedback-edge-2');
    expect(auditSlideDensity(outline, missing).semanticStructureSatisfied).toBe(false);
    const invisible = structuredClone(content);
    const plate = invisible.elements.find((element) => element.id === 'feedback-node-fix')! as PPTShapeElement;
    plate.text!.content = '<p style="font-size:24px">Fix</p>';
    expect(auditSlideDensity(outline, invisible).underrepresentedKeyPoints.length).toBeGreaterThan(0);
    expect({ graph, component }).toEqual(original);
  }, 20_000);

  it('preserves the exact adjacent sequence and every full note, including multiple notes on one object', async () => {
    const { graph, component } = fixture('sequence');
    component.nodes.push({ id: 'guard', label: 'Only the selected scope', text: 'Do not repair unrelated failures',
      anchorId: 'inspect', sourceContentIds: ['boundary'] });
    const result = await compileAdoptedGrid(component, graph, bounds, measureAuthoredSlideText);
    expect(result).not.toBeNull();
    if (!result) throw new Error('The measured sequence should fit');
    checkRelationships(result, graph);
    const native = shape(result, 'inspect');
    expect(native.text?.content).toContain('Only the selected scope');
    expect(native.text?.content).toContain('Do not repair unrelated failures');
    expect(result.mapping.boundary).toEqual([native.id]);
  }, 20_000);

  it('keeps a root, a guard and two outcomes with only the three actual condition edges', async () => {
    const { graph, component } = fixture('branch');
    graph.nodes = [{ id: 'reproduce', label: 'Observe the proposed intervention' }, { id: 'inspect', label: 'Does the required condition hold?' },
      { id: 'fix', label: 'Proceed within the stated conditions' }, { id: 'finish', label: 'Stop and retain the original result' }];
    graph.edges = [{ from: 'reproduce', to: 'inspect' }, { from: 'inspect', to: 'fix', label: 'Condition holds' },
      { from: 'inspect', to: 'finish', label: 'Condition does not hold' }];
    const result = await compileAdoptedGrid(component, graph, bounds, measureAuthoredSlideText);
    expect(result).not.toBeNull();
    if (!result) throw new Error('The readable two-outcome branch should fit');
    checkRelationships(result, graph);
    const { outline, content } = rendered(result, graph, component);
    expect(auditSlideDensity(outline, content).semanticStructureSatisfied).toBe(true);
    expect(auditSlideDensity(outline, content).underrepresentedKeyPoints).toEqual([]);
    expect(shape(result, 'fix').top).toEqual(shape(result, 'finish').top);
    expect(shape(result, 'inspect').top).toBeLessThan(shape(result, 'fix').top);
  }, 20_000);

  it('keeps HTML-significant original labels and literal source text intact', async () => {
    const { graph, component } = fixture('sequence');
    graph.nodes[0]!.label = 'Check x < 0 && y > 1';
    component.nodes[0]!.text = 'Keep the literal entity &gt; in the output';
    const result = await compileAdoptedGrid(component, graph, bounds, measureAuthoredSlideText);
    expect(result).not.toBeNull();
    if (!result) throw new Error('Literal source text should remain renderable');
    expect(shape(result, 'reproduce').text!.content).toContain('x &lt; 0 &amp;&amp; y &gt; 1');
    expect(shape(result, 'reproduce').text!.content).toContain('entity &amp;gt;');
  }, 20_000);

  it('returns null on real text overload without changing a word or reducing typography', async () => {
    const { graph, component } = fixture();
    component.nodes[0]!.text = 'The complete adopted condition must remain visible before moving on. '.repeat(30);
    const original = structuredClone({ graph, component });
    expect(await compileAdoptedGrid(component, graph, bounds, measureAuthoredSlideText)).toBeNull();
    expect({ graph, component }).toEqual(original);
    expect(await compileAdoptedGrid(fixture().component, fixture().graph, { ...bounds, height: 100 }, measureAuthoredSlideText)).toBeNull();
  }, 20_000);

  it('rejects unsupported or ambiguous facts and relations instead of drawing a convenient subgraph', async () => {
    const variants = Array.from({ length: 6 }, () => fixture());
    variants[0]!.graph.edges = undefined; // An implicit ring is not an explicit feedback plan.
    variants[1]!.graph.edges!.push({ from: 'finish', to: 'reproduce' });
    variants[2]!.graph.nodes.push({ id: 'other', label: 'A fifth required object' });
    variants[3]!.component.nodes[0]!.anchorId = 'unknown';
    variants[4]!.component.edges = [{ from: 'condition-4', to: 'condition-1', label: 'Invented return' }];
    variants[5]!.graph.edges![1] = { from: 'reproduce', to: 'fix' }; // Missing the adopted adjacent chain.
    for (const { graph, component } of variants) expect(await compileAdoptedGrid(component, graph, bounds, measureAuthoredSlideText)).toBeNull();
  });

  it('retains a real measurement infrastructure failure as an error', async () => {
    const { graph, component } = fixture();
    await expect(compileAdoptedGrid(component, graph, bounds, () => ({ height: Number.NaN, naturalWidth: 100, lines: [] })))
      .rejects.toThrow('measurement returned invalid geometry');
  });
});
