import { resolveDiagramSequenceGroups, type DiagramPlan } from '@openmaic/generation/browser';

/** An explicit feedback graph owns its edges. The word "cycle" alone cannot
 * turn an exit into a return to the start. Historical implicit rings and
 * ordered sequences retain their established contract. */
export function adoptedDiagramEdges(graph: DiagramPlan): Array<{ from: string; to: string; label?: string }> {
  const groups = resolveDiagramSequenceGroups(graph);
  const implicit = graph.topology === 'branch' || graph.topology === 'cycle' && graph.edges?.length ? []
    : (groups ?? [{ nodeIds: graph.nodes.map((node) => node.id) }]).flatMap((group) =>
      group.nodeIds.slice(0, graph.topology === 'cycle' ? undefined : -1)
        .map((from, index) => ({ from, to: group.nodeIds[(index + 1) % group.nodeIds.length]! })));
  return [...new Map([...implicit, ...(graph.edges ?? [])].map((edge) => [`${edge.from}\0${edge.to}`, edge])).values()];
}

/** The existing native compiler supports a sequence with one real feedback
 * edge. Use that geometry for a declared non-ring cycle only when every edge
 * is preserved exactly; the adopted plan itself remains unchanged. */
export function renderableAdoptedDiagramPlan(graph: DiagramPlan): DiagramPlan {
  if (graph.topology !== 'cycle' || !graph.edges?.length) return graph;
  const ids = graph.nodes.map((node) => node.id);
  const ring = ids.map((from, index) => ({ from, to: ids[(index + 1) % ids.length]! }));
  if (graph.edges.length === ring.length && graph.edges.every((edge) => ring.some((part) =>
    part.from === edge.from && part.to === edge.to))) return graph;
  const sequence = ring.slice(0, -1), edges = adoptedDiagramEdges(graph);
  const feedback = edges.filter((edge) => !sequence.some((part) => part.from === edge.from && part.to === edge.to));
  if (sequence.every((part) => edges.some((edge) => edge.from === part.from && edge.to === part.to))
    && feedback.length <= 1 && feedback.every((edge) => ids.indexOf(edge.from) > ids.indexOf(edge.to))) {
    return { ...graph, topology: 'sequence', edges };
  }
  return graph;
}
