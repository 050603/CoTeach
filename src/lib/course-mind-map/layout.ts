import type { CourseMindMap, CourseMindMapNode } from './types';

export const COURSE_MIND_MAP_NODE_WIDTH = 172;
export const COURSE_MIND_MAP_NODE_HEIGHT = 64;
const COLUMN_GAP = 84;
const ROW_GAP = 36;

export function courseMindMapAncestors(map: CourseMindMap, nodeId: string): string[] {
  const nodes = new Map(map.nodes.map(node => [node.id, node]));
  const path: string[] = [];
  let current: CourseMindMapNode | undefined = nodes.get(nodeId);
  while (current && !path.includes(current.id)) {
    path.unshift(current.id);
    current = current.parentId ? nodes.get(current.parentId) : undefined;
  }
  return path;
}

type CourseMindMapLayoutNode = {
  id: string;
  position: { x: number; y: number };
  depth: number;
  side: 'left' | 'right';
};

/** Uses the supplied visible tree; labels, playback focus and relations do not affect geometry. */
export function layoutCourseMindMap(
  map: Pick<CourseMindMap, 'rootId' | 'nodes'>,
  options: { balanced?: boolean } = {},
): CourseMindMapLayoutNode[] {
  const children = new Map<string, CourseMindMapNode[]>();
  for (const node of map.nodes) {
    if (!node.parentId) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }
  const positions = new Map<string, CourseMindMapLayoutNode>();
  const visited = new Set<string>();
  const rowHeight = COURSE_MIND_MAP_NODE_HEIGHT + ROW_GAP;
  const visit = (id: string, depth: number, side: 'left' | 'right', cursor: { nextRow: number }): number => {
    if (visited.has(id)) return positions.get(id)?.position.y ?? cursor.nextRow;
    visited.add(id);
    const childRows = (children.get(id) ?? []).filter(node => !visited.has(node.id))
      .map(node => visit(node.id, depth + 1, side, cursor));
    const y = childRows.length ? (childRows[0] + childRows[childRows.length - 1]) / 2 : cursor.nextRow;
    if (!childRows.length) cursor.nextRow += rowHeight;
    const x = depth * (COURSE_MIND_MAP_NODE_WIDTH + COLUMN_GAP) * (side === 'left' ? -1 : 1);
    positions.set(id, { id, position: { x, y }, depth, side });
    return y;
  };
  const cursor = { nextRow: 0 };
  const hasRoot = map.nodes.some(node => node.id === map.rootId);
  if (options.balanced && hasRoot) {
    visited.add(map.rootId);
    positions.set(map.rootId, { id: map.rootId, position: { x: 0, y: 0 }, depth: 0, side: 'right' });
    const branches = (children.get(map.rootId) ?? []).filter(node => !visited.has(node.id));
    const countLeaves = (id: string, seen: Set<string>): number => {
      if (seen.has(id)) return 0;
      seen.add(id);
      return Math.max(1, (children.get(id) ?? []).reduce((sum, child) => sum + countLeaves(child.id, seen), 0));
    };
    const loads = { left: 0, right: 0 };
    const branchSides = new Map<string, 'left' | 'right'>();
    // Assign the largest complete branches first, then lay out each side in
    // the original teaching order. A long branch cannot dominate both sides.
    const weightedBranches = branches.map((node, index) => ({
      id: node.id, index, leaves: countLeaves(node.id, new Set([map.rootId])),
    })).sort((a, b) => b.leaves - a.leaves || a.index - b.index);
    for (const branch of weightedBranches) {
      const side = loads.right <= loads.left ? 'right' : 'left';
      branchSides.set(branch.id, side);
      loads[side] += branch.leaves;
    }
    for (const side of ['right', 'left'] as const) {
      const sideCursor = { nextRow: 0 };
      for (const branch of branches) {
        if (branchSides.get(branch.id) === side) visit(branch.id, 1, side, sideCursor);
      }
      const center = Math.max(0, sideCursor.nextRow - rowHeight) / 2;
      for (const node of positions.values()) {
        if (node.side === side && node.depth > 0) node.position.y -= center;
      }
    }
    cursor.nextRow = Math.max(...Array.from(positions.values(), node => node.position.y)) + rowHeight;
  } else if (hasRoot) {
    visit(map.rootId, 0, 'right', cursor);
  }
  // A damaged older draft remains inspectable instead of crashing the player.
  for (const node of map.nodes) if (!visited.has(node.id)) visit(node.id, 0, 'right', cursor);
  return map.nodes.flatMap(node => positions.get(node.id) ?? []);
}

export function courseMindMapNeighborhood(map: CourseMindMap, activeNodeId?: string | null): Set<string> {
  if (!activeNodeId || !map.nodes.some(node => node.id === activeNodeId)) return new Set(map.nodes.map(node => node.id));
  const ancestors = courseMindMapAncestors(map, activeNodeId);
  const ids = new Set(ancestors);
  const activeParentId = map.nodes.find(node => node.id === activeNodeId)?.parentId;
  for (const node of map.nodes) {
    if (node.parentId === activeNodeId || (activeParentId && node.parentId === activeParentId)) ids.add(node.id);
  }
  for (const relation of map.relations) {
    if (relation.source === activeNodeId) ids.add(relation.target);
    if (relation.target === activeNodeId) ids.add(relation.source);
  }
  return ids;
}
