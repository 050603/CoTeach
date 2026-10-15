import { describe, expect, it } from 'vitest';
import type { CourseMindMap } from './types';
import {
  COURSE_MIND_MAP_NODE_HEIGHT,
  COURSE_MIND_MAP_NODE_WIDTH,
  courseMindMapAncestors,
  courseMindMapNeighborhood,
  layoutCourseMindMap,
} from './layout';

const map: CourseMindMap = {
  schemaVersion: 1, sourceFingerprint: 'source', bindingFingerprint: 'binding', rootId: 'root',
  nodes: [
    { id: 'root', label: '课程', knowledgePointIds: [] },
    { id: 'methods', label: '教学方法', knowledgePointIds: [], parentId: 'root' },
    { id: 'anchor', label: '抛锚式教学法', knowledgePointIds: ['anchor'], parentId: 'methods' },
    { id: 'step-two', label: '确定问题', knowledgePointIds: ['anchor'], parentId: 'anchor', order: 2 },
    { id: 'step-one', label: '创设情境', knowledgePointIds: ['anchor'], parentId: 'anchor', order: 1 },
    { id: 'theory', label: '建构主义', knowledgePointIds: ['theory'], parentId: 'root' },
    { id: 'other', label: '行为主义', knowledgePointIds: ['other'], parentId: 'root' },
  ],
  relations: [{ id: 'support', source: 'theory', target: 'anchor', label: '支持', rationale: '教学方法以该理论为基础' }],
  bindings: [], diagnostics: [],
};

describe('course mind map tree layout', () => {
  it('preserves the existing one-sided coordinates by default', () => {
    expect(layoutCourseMindMap(map)).toEqual([
      { id: 'root', position: { x: 0, y: 175 }, depth: 0, side: 'right' },
      { id: 'methods', position: { x: 256, y: 50 }, depth: 1, side: 'right' },
      { id: 'anchor', position: { x: 512, y: 50 }, depth: 2, side: 'right' },
      { id: 'step-two', position: { x: 768, y: 100 }, depth: 3, side: 'right' },
      { id: 'step-one', position: { x: 768, y: 0 }, depth: 3, side: 'right' },
      { id: 'theory', position: { x: 256, y: 200 }, depth: 1, side: 'right' },
      { id: 'other', position: { x: 256, y: 300 }, depth: 1, side: 'right' },
    ]);
    expect(layoutCourseMindMap(map, { balanced: false })).toEqual(layoutCourseMindMap(map));
  });

  it('places real parent-child levels in columns and keeps procedural order', () => {
    const nodes = new Map(layoutCourseMindMap(map).map(node => [node.id, node]));
    expect(nodes.get('methods')!.position.x).toBeGreaterThan(nodes.get('root')!.position.x);
    expect(nodes.get('anchor')!.position.x).toBeGreaterThan(nodes.get('methods')!.position.x);
    expect(nodes.get('step-one')!.position.x).toBe(nodes.get('step-two')!.position.x);
    expect(nodes.get('step-one')!.position.y).toBeLessThan(nodes.get('step-two')!.position.y);
    expect(new Set([...nodes.values()].map(node => `${node.position.x}:${node.position.y}`)).size).toBe(map.nodes.length);
  });

  it('does not move concepts when labels or cross-branch relations change', () => {
    const original = layoutCourseMindMap(map);
    expect(layoutCourseMindMap({ ...map, nodes: map.nodes.map(node => ({ ...node, label: `${node.label}的说明` })) })).toEqual(original);
    expect(layoutCourseMindMap({ ...map, relations: [] } as CourseMindMap)).toEqual(original);
  });

  it('highlights ancestors, siblings, children and factual cross relationships', () => {
    expect(courseMindMapAncestors(map, 'step-two')).toEqual(['root', 'methods', 'anchor', 'step-two']);
    expect(courseMindMapNeighborhood(map, 'step-two')).toEqual(new Set(['root', 'methods', 'anchor', 'step-two', 'step-one']));
    expect(courseMindMapNeighborhood(map, 'anchor').has('theory')).toBe(true);
    expect(courseMindMapNeighborhood(map, 'anchor').has('other')).toBe(false);
  });

  it('allows inspection of a damaged draft without recursing forever', () => {
    const malformed: CourseMindMap = {
      ...map, nodes: [{ id: 'a', label: 'a', parentId: 'b', knowledgePointIds: [] },
        { id: 'b', label: 'b', parentId: 'a', knowledgePointIds: [] }], rootId: 'a',
    };
    expect(layoutCourseMindMap(malformed)).toHaveLength(2);
    expect(layoutCourseMindMap(malformed, { balanced: true })).toHaveLength(2);
    expect(courseMindMapAncestors(malformed, 'a')).toHaveLength(2);
  });

  it('balances visible leaf load while keeping complete branches and teaching order on each side', () => {
    const branchedMap: CourseMindMap = {
      ...map,
      nodes: [map.nodes[0], ...[
        { id: 'first', leaves: 1 }, { id: 'second', leaves: 1 },
        { id: 'large', leaves: 4 }, { id: 'last', leaves: 2 },
      ].flatMap((branch, order) => [
        { id: branch.id, label: branch.id, parentId: 'root', order, knowledgePointIds: [] },
        ...Array.from({ length: branch.leaves }, (_, index) => ({
          id: `${branch.id}-${index}`, label: `${branch.id}-${index}`, parentId: branch.id,
          order: branch.leaves - index, knowledgePointIds: [],
        })),
      ])],
    };
    const layout = layoutCourseMindMap(branchedMap, { balanced: true });
    const nodes = new Map(layout.map(node => [node.id, node]));
    expect(nodes.get('root')?.position).toEqual({ x: 0, y: 0 });
    const leaves = branchedMap.nodes.filter(node => node.parentId && node.parentId !== 'root');
    expect(leaves.filter(node => nodes.get(node.id)?.side === 'left')).toHaveLength(4);
    expect(leaves.filter(node => nodes.get(node.id)?.side === 'right')).toHaveLength(4);
    expect(nodes.get('first')!.position.y).toBeLessThan(nodes.get('second')!.position.y);
    expect(nodes.get('second')!.position.y).toBeLessThan(nodes.get('last')!.position.y);
    for (const leaf of leaves) {
      const node = nodes.get(leaf.id)!;
      const parent = nodes.get(leaf.parentId!)!;
      expect(node.side).toBe(parent.side);
      expect(Math.abs(node.position.x)).toBeGreaterThan(Math.abs(parent.position.x));
    }
    for (const branch of ['first', 'second', 'large', 'last']) {
      const ordered = leaves.filter(node => node.parentId === branch).sort((a, b) => a.order! - b.order!);
      for (let index = 1; index < ordered.length; index++) {
        expect(nodes.get(ordered[index - 1].id)!.position.y).toBeLessThan(nodes.get(ordered[index].id)!.position.y);
      }
    }
    for (const [index, node] of layout.entries()) {
      for (const other of layout.slice(index + 1)) {
        const overlapX = Math.abs(node.position.x - other.position.x) < COURSE_MIND_MAP_NODE_WIDTH;
        const overlapY = Math.abs(node.position.y - other.position.y) < COURSE_MIND_MAP_NODE_HEIGHT;
        expect(overlapX && overlapY, `${node.id} overlaps ${other.id}`).toBe(false);
      }
    }
    for (const side of ['left', 'right'] as const) {
      const rows = layout.filter(node => node.depth > 0 && node.side === side).map(node => node.position.y);
      expect(Math.min(...rows) + Math.max(...rows)).toBe(0);
    }
  });

  it('compacts a smaller visible tree without reserving space for hidden descendants', () => {
    const complete = layoutCourseMindMap(map, { balanced: true });
    const visibleIds = new Set(['root', 'methods', 'anchor', 'step-one']);
    const visible = layoutCourseMindMap({ ...map, nodes: map.nodes.filter(node => visibleIds.has(node.id)) }, { balanced: true });
    expect(visible.map(node => node.id)).toEqual(['root', 'methods', 'anchor', 'step-one']);
    expect(visible.every(node => node.position.y === 0)).toBe(true);
    const height = (nodes: typeof complete) => Math.max(...nodes.map(node => node.position.y)) - Math.min(...nodes.map(node => node.position.y));
    expect(height(visible)).toBeLessThan(height(complete));
    expect(map.nodes).toHaveLength(7);
  });

  it('keeps disconnected and missing-root drafts inspectable in balanced mode', () => {
    const disconnected = {
      ...map,
      nodes: [...map.nodes, { id: 'orphan', label: '未归类', parentId: 'missing', knowledgePointIds: [] }],
    };
    const layout = layoutCourseMindMap(disconnected, { balanced: true });
    expect(layout).toHaveLength(disconnected.nodes.length);
    const orphan = layout.find(node => node.id === 'orphan')!;
    expect(orphan.depth).toBe(0);
    expect(orphan.position.y).toBeGreaterThan(Math.max(...layout.filter(node => node.id !== 'orphan').map(node => node.position.y)));
    const missingRoot = layoutCourseMindMap({ ...disconnected, rootId: 'missing-root' }, { balanced: true });
    expect(missingRoot).toHaveLength(disconnected.nodes.length);
    expect(missingRoot.every(node => Number.isFinite(node.position.x) && Number.isFinite(node.position.y))).toBe(true);
    expect(layoutCourseMindMap({ rootId: 'absent', nodes: [] }, { balanced: true })).toEqual([]);
  });
});
