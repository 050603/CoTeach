import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentType, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CourseMindMap } from '@/lib/course-mind-map/types';
import { CourseMindMapFlow } from './course-mind-map-flow';

const flow = vi.hoisted(() => ({
  viewportInitialized: true,
  positions: new Map<string, { x: number; y: number }>(),
  setViewport: vi.fn<(viewport: { x: number; y: number; zoom: number }, options?: { duration: number }) => Promise<boolean>>(() => Promise.resolve(true)),
  getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  getInternalNode: vi.fn((id: string): { internals: { positionAbsolute: { x: number; y: number } } } | undefined => {
    const position = flow.positions.get(id);
    return position ? { internals: { positionAbsolute: position } } : undefined;
  }),
}));

vi.mock('@xyflow/react', async importOriginal => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Background: () => null,
  Controls: () => <button type="button">缩放控制</button>,
  Handle: () => null,
  MiniMap: () => null,
  MarkerType: { ArrowClosed: 'arrowclosed' },
  Position: { Left: 'left', Right: 'right' },
  ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
  ReactFlow: ({ nodes, edges, nodeTypes, onNodeClick, fitView, children }: {
    nodes: Array<{ id: string; type: string; position: { x: number; y: number }; data: Record<string, unknown> }>;
    edges: Array<{ id: string; source: string; target: string; label?: string; style?: Record<string, unknown> }>;
    nodeTypes: Record<string, ComponentType<{ id: string; data: Record<string, unknown> }>>;
    onNodeClick: (event: unknown, node: { id: string }) => void;
    fitView: boolean;
    children: ReactNode;
  }) => <div role="application" data-fit-view={String(fitView)}>
    {nodes.map(node => {
      flow.positions.set(node.id, node.position);
      const Concept = nodeTypes[node.type];
      return <div aria-label={String(node.data.label)} data-testid={`node-${node.id}`}
        data-position={JSON.stringify(node.position)} key={node.id}
        onClick={event => onNodeClick(event, node)}>
        <Concept id={node.id} data={node.data} />
      </div>;
    })}
    {edges.map(edge => <span key={edge.id} data-testid={`edge-${edge.id}`}
      data-source={edge.source} data-target={edge.target} data-dashed={Boolean(edge.style?.strokeDasharray)}>{edge.label}</span>)}
    {children}
  </div>,
  useReactFlow: () => flow,
}));

const map: CourseMindMap = {
  schemaVersion: 1, sourceFingerprint: 'source', bindingFingerprint: 'binding', rootId: 'course',
  nodes: [
    { id: 'course', label: '教学理论与方法', knowledgePointIds: [] },
    { id: 'anchor', label: '抛锚式教学法', description: '围绕真实问题开展探究。', parentId: 'course', knowledgePointIds: ['anchor'] },
    { id: 'traits', label: '主要特征', parentId: 'anchor', knowledgePointIds: ['anchor'] },
    { id: 'collaboration', label: '协作交流', parentId: 'traits', knowledgePointIds: ['anchor'] },
    { id: 'steps', label: '实施流程', parentId: 'anchor', knowledgePointIds: ['anchor'] },
    { id: 'context', label: '创设情境', parentId: 'steps', knowledgePointIds: ['anchor'] },
    { id: 'problem', label: '确定问题', parentId: 'steps', knowledgePointIds: ['anchor'] },
    { id: 'theory', label: '建构主义', parentId: 'course', knowledgePointIds: ['theory'] },
  ],
  relations: [{ id: 'supports', source: 'theory', target: 'anchor', label: '理论支撑', rationale: '抛锚式教学法以建构主义为基础。' }],
  bindings: [], diagnostics: [],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  flow.setViewport.mockClear();
  flow.viewportInitialized = true;
  flow.getInternalNode.mockClear();
});

describe('CourseMindMapFlow', () => {
  it('starts with a short topic overview and keeps factual relationships out of the canvas', () => {
    render(<CourseMindMapFlow map={map} activeNodeId="context" showMiniMap={false} />);
    expect(screen.getAllByTestId(/^node-/)).toHaveLength(3);
    expect(screen.queryByTestId('node-context')).toBeNull();
    expect(screen.queryByTestId('edge-relation:supports')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开全部' }));
    expect(screen.getAllByTestId(/^node-/)).toHaveLength(map.nodes.length);
    expect(screen.getAllByTestId(/^edge-contains:/)).toHaveLength(map.nodes.length - 1);
    expect(screen.getByTestId('edge-contains:context')).toHaveAttribute('data-source', 'steps');
    expect(screen.queryByTestId('edge-contains:problem:context')).toBeNull();
    expect(screen.queryByTestId('edge-relation:supports')).toBeNull();
  });

  it('browses one topic, preserves focus geometry, and compacts collapsed branches', () => {
    const { rerender } = render(<CourseMindMapFlow map={map} activeNodeId="context" />);
    fireEvent.click(within(screen.getByRole('navigation', { name: '课程主题' })).getByRole('button', { name: /抛锚式教学法/ }));
    expect(screen.queryByTestId('node-theory')).toBeNull();
    expect(screen.getAllByTestId(/^node-/)).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: '展开全部' }));
    const problemPosition = screen.getByTestId('node-problem').getAttribute('data-position');
    rerender(<CourseMindMapFlow map={map} activeNodeId="problem" />);
    expect(screen.getByTestId('node-problem')).toHaveAttribute('data-position', problemPosition);
    fireEvent.click(screen.getByRole('button', { name: '折叠实施流程分支' }));
    expect(screen.queryByTestId('node-problem')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开实施流程分支' }));
    expect(screen.getByTestId('node-problem')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '收起层级' }));
    expect(screen.getAllByTestId(/^node-/)).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: '课程总览' }));
    expect(screen.getByTestId('node-theory')).toBeInTheDocument();
  });

  it('shows complete descriptions and directed relations, and navigates to related concepts', () => {
    render(<CourseMindMapFlow map={map} />);
    fireEvent.click(screen.getByRole('button', { name: '抛锚式教学法' }));
    const detail = screen.getByRole('complementary', { name: '概念详情' });
    expect(detail).toHaveTextContent('围绕真实问题开展探究。');
    expect(detail).toHaveTextContent('抛锚式教学法以建构主义为基础。');
    expect(detail).toHaveTextContent('建构主义理论支撑抛锚式教学法');
    fireEvent.click(within(detail).getByRole('button', { name: '查看：建构主义' }));
    expect(screen.getByRole('heading', { name: '建构主义' })).toBeInTheDocument();
    expect(screen.getByTestId('node-theory')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭概念详情' }));
    expect(screen.queryByRole('complementary', { name: '概念详情' })).toBeNull();
  });

  it('finds hidden concepts and reveals their real parent path without losing content', () => {
    render(<CourseMindMapFlow map={map} activeNodeId="problem" />);
    fireEvent.change(screen.getByRole('textbox', { name: '搜索课程概念' }), { target: { value: '协作' } });
    fireEvent.click(within(screen.getByLabelText('概念搜索结果')).getByRole('button', { name: /协作交流/ }));
    expect(screen.getByTestId('node-collaboration')).toBeInTheDocument();
    expect(screen.getByTestId('edge-contains:collaboration')).toHaveAttribute('data-source', 'traits');
    expect(screen.queryByTestId('node-theory')).toBeNull();
    expect(screen.getByRole('textbox', { name: '搜索课程概念' })).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: '当前讲授' }));
    expect(screen.getByTestId('node-problem')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '确定问题' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: '搜索课程概念' }), { target: { value: '不存在' } });
    expect(screen.getByText('未找到匹配概念')).toBeInTheDocument();
  });

  it('opens the full view at the same concept as the listening preview', () => {
    render(<CourseMindMapFlow map={map} activeNodeId="problem" focusActiveNode />);
    expect(screen.getByTestId('node-problem').querySelector('[data-active-concept]')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '选择导图主题' })).toHaveValue('anchor');
    expect(screen.queryByTestId('node-theory')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '课程总览' }));
    expect(screen.getByTestId('node-theory')).toBeInTheDocument();
  });

  it('offers the same topic navigation through the narrow-screen selector', () => {
    render(<CourseMindMapFlow map={map} />);
    fireEvent.change(screen.getByRole('combobox', { name: '选择导图主题' }), { target: { value: 'anchor' } });
    expect(screen.getByTestId('node-anchor')).toBeInTheDocument();
    expect(screen.queryByTestId('node-theory')).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: '选择导图主题' }), { target: { value: 'course' } });
    expect(screen.getByTestId('node-theory')).toBeInTheDocument();
  });

  it('fits both sides of the overview inside a narrow canvas', async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 356, height: 500, x: 0, y: 0, top: 0, left: 0, right: 356, bottom: 500, toJSON: () => ({}),
    });
    render(<CourseMindMapFlow map={map} />);
    await act(() => vi.advanceTimersByTimeAsync(32));
    const viewport = flow.setViewport.mock.calls.at(-1)![0];
    for (const id of ['course', 'anchor', 'theory']) {
      const position = flow.positions.get(id)!;
      expect(position.x * viewport.zoom + viewport.x).toBeGreaterThanOrEqual(0);
      expect((position.x + 172) * viewport.zoom + viewport.x).toBeLessThanOrEqual(356);
    }
  });

  it('keeps the full title and explanation available when the node label is visually clamped', () => {
    const label = '通过真实情境中的合作探究理解并应用教学理论，兼顾具体教学条件与完整实施过程';
    render(<CourseMindMapFlow map={{ ...map, nodes: map.nodes.map(node => node.id === 'anchor' ? { ...node, label } : node) }} />);
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(screen.getByRole('heading', { name: label })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: '概念详情' })).toHaveTextContent('围绕真实问题开展探究。');
  });

  it('shows a readable local hierarchy while listening instead of the full graph', () => {
    render(<CourseMindMapFlow map={map} activeNodeId="steps" compact fillAvailableHeight />);
    const preview = screen.getByLabelText('当前讲授思维导图');
    expect(screen.getByLabelText('当前概念路径')).toHaveTextContent('抛锚式教学法 › 实施流程');
    expect(preview).toHaveTextContent('下级概念');
    expect(preview).toHaveTextContent('创设情境');
    expect(preview).toHaveTextContent('确定问题');
    expect(screen.queryByRole('application')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(preview.querySelector('[data-active-concept]')).toHaveTextContent('实施流程');
    expect(preview.querySelector('[data-concept-id="theory"]')).toBeNull();
    expect(preview.style.height).toBe('');
  });

  it('keeps siblings distinct from children and follows playback immediately', () => {
    const { rerender } = render(<CourseMindMapFlow map={map} activeNodeId="context" compact />);
    const preview = screen.getByLabelText('当前讲授思维导图');
    expect(preview).toHaveTextContent('同级概念');
    expect(preview.querySelector('[data-active-concept]')).toHaveTextContent('创设情境');
    expect(preview.querySelector('[data-context-concept="problem"]')).toBeInTheDocument();
    rerender(<CourseMindMapFlow map={map} activeNodeId="problem" compact />);
    expect(preview.querySelector('[data-active-concept]')).toHaveTextContent('确定问题');
    expect(preview.querySelector('[data-context-concept="context"]')).toBeInTheDocument();
    expect(screen.getByLabelText('当前概念路径')).toHaveTextContent('抛锚式教学法 › 实施流程 › 确定问题');
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it('uses the course overview when a playback concept is unavailable and reports hidden children', () => {
    const additional = Array.from({ length: 6 }, (_, index) => ({ id: `extra-${index}`, label: `概念${index}`, parentId: 'course', knowledgePointIds: [] }));
    render(<CourseMindMapFlow map={{ ...map, nodes: [...map.nodes, ...additional] }} activeNodeId="missing" compact />);
    const preview = screen.getByLabelText('当前讲授思维导图');
    expect(preview.querySelector('[data-active-concept]')).toHaveTextContent('教学理论与方法');
    expect(preview.querySelectorAll('[data-context-concept]')).toHaveLength(2);
    expect(preview).toHaveTextContent('另有 6 个');
  });
});
