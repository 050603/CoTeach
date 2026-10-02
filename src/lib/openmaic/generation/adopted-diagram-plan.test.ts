import { describe, expect, it } from 'vitest';
import type { DiagramPlan } from '@openmaic/generation/browser';
import { adoptedDiagramEdges, renderableAdoptedDiagramPlan } from './adopted-diagram-plan';

describe('actual adopted feedback relationships', () => {
  const nodes = ['reproduce', 'inspect', 'fix', 'finish'].map((id) => ({ id, label: id }));
  const edges = [{ from: 'reproduce', to: 'inspect' }, { from: 'inspect', to: 'fix' },
    { from: 'fix', to: 'inspect', label: 'Still fails' }, { from: 'fix', to: 'finish', label: 'Failing check passes' }];
  it('uses a real return edge and exit without adding a ring-closing transition', () => {
    const graph: DiagramPlan = { topology: 'cycle', nodes, edges }, before = structuredClone(graph);
    expect(adoptedDiagramEdges(graph)).toEqual(edges);
    const renderable = renderableAdoptedDiagramPlan(graph);
    expect(renderable.topology).toBe('sequence');
    expect(renderable.edges).toEqual(edges);
    expect(renderable.edges?.some((edge) => edge.from === 'finish' && edge.to === 'reproduce')).toBe(false);
    expect(graph).toEqual(before);
  });
  it('retains an implicit historical ring and a fully declared ring', () => {
    const implicit: DiagramPlan = { topology: 'cycle', nodes };
    const ring = nodes.map((node, index) => ({ from: node.id, to: nodes[(index + 1) % nodes.length]!.id }));
    expect(adoptedDiagramEdges(implicit)).toEqual(ring);
    expect(renderableAdoptedDiagramPlan(implicit)).toBe(implicit);
    const explicit: DiagramPlan = { ...implicit, edges: ring };
    expect(renderableAdoptedDiagramPlan(explicit)).toBe(explicit);
  });
  it('does not rewrite unsupported feedback graphs or branch alternatives', () => {
    const complex: DiagramPlan = { topology: 'cycle', nodes,
      edges: [...edges, { from: 'finish', to: 'inspect', label: 'Regression fails' }] };
    expect(renderableAdoptedDiagramPlan(complex)).toBe(complex);
    const branch: DiagramPlan = { topology: 'branch', nodes, edges: [
      { from: 'reproduce', to: 'inspect' }, { from: 'inspect', to: 'fix' }, { from: 'inspect', to: 'finish' },
    ] };
    expect(adoptedDiagramEdges(branch)).toEqual(branch.edges);
    expect(renderableAdoptedDiagramPlan(branch)).toBe(branch);
  });
});
