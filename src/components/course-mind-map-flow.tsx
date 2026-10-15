'use client';

import '@xyflow/react/dist/style.css';
import {
  Background, Handle, MiniMap, Position, getNodesBounds, getViewportForBounds,
  ReactFlow, ReactFlowProvider, useReactFlow,
  type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import { ArrowRight, BookOpen, ChevronRight, Expand, Focus, GitBranch, Minus, Plus, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { CourseMindMap } from '@/lib/course-mind-map/types';
import {
  COURSE_MIND_MAP_NODE_HEIGHT, COURSE_MIND_MAP_NODE_WIDTH,
  courseMindMapAncestors, layoutCourseMindMap,
} from '@/lib/course-mind-map/layout';
import { cn } from '@/lib/utils';
import styles from './course-mind-map-flow.module.css';

type ConceptNodeData = {
  label: string;
  active: boolean;
  ancestor: boolean;
  root: boolean;
  color: string;
  side: 'left' | 'right';
  childCount: number;
  collapsed: boolean;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
};

function ConceptNode({ id, data }: NodeProps<Node<ConceptNodeData>>) {
  return <div
    className={cn(styles.concept, data.root && styles.rootConcept, data.active && styles.active, data.ancestor && styles.ancestor)}
    data-active-concept={data.active || undefined}
    data-concept-id={id}
    style={{ '--concept-color': data.color } as React.CSSProperties}
    title={data.label}
  >
    <Handle id="target" type="target" position={data.side === 'left' ? Position.Right : Position.Left} className={styles.handle} />
    <span className={styles.conceptDot} aria-hidden="true" />
    <button
      className={cn('nodrag nopan', styles.conceptLabel)} type="button" onClick={() => data.onSelect(id)}
    >{data.label}</button>
    {data.childCount > 0 ? <button
      aria-label={`${data.collapsed ? '展开' : '折叠'}${data.label}分支`}
      aria-expanded={!data.collapsed}
      className={cn('nodrag nopan', styles.collapse, data.side === 'left' && styles.collapseLeft)}
      onClick={event => { event.stopPropagation(); data.onToggle(id); }}
      type="button"
    ><span>{data.collapsed ? <><Plus size={12} /><small>{data.childCount}</small></> : <Minus size={14} />}</span></button> : null}
    <Handle id="right" type="source" position={Position.Right} className={styles.handle} />
    <Handle id="left" type="source" position={Position.Left} className={styles.handle} />
  </div>;
}

const nodeTypes = { concept: ConceptNode };
const BRANCH_COLORS = ['#168575', '#4476bb', '#b38738', '#678952', '#ab6475', '#508e9f'];
/** Fit only when the visible hierarchy or available pane changes, never on a plain selection. */
function ExplorerCamera({ nodes, containerRef, revision, focusId }: {
  nodes: Node[];
  containerRef: RefObject<HTMLDivElement | null>;
  revision: number;
  focusId: string | null;
}) {
  const { setViewport, viewportInitialized } = useReactFlow();
  const [size, setSize] = useState({ width: 0, height: 0 });
  // Node data changes during playback/selection; camera geometry does not.
  const geometry = JSON.stringify(nodes.map(node => ({ id: node.id, position: node.position,
    width: COURSE_MIND_MAP_NODE_WIDTH, height: COURSE_MIND_MAP_NODE_HEIGHT })));
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const { width, height } = container.getBoundingClientRect();
      setSize(current => current.width === width && current.height === height ? current : { width, height });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    measure();
    return () => observer.disconnect();
  }, [containerRef]);
  useEffect(() => {
    if (!viewportInitialized || !size.width || !size.height) return;
    const positioned: Node[] = JSON.parse(geometry);
    if (!positioned.length) return;
    const viewport = getViewportForBounds(getNodesBounds(positioned), size.width, size.height, 0.1, 1, 0.22);
    const focused = focusId ? positioned.find(node => node.id === focusId) : undefined;
    if (focused) {
      viewport.zoom = Math.max(viewport.zoom, 0.9);
      viewport.x = size.width / 2 - (focused.position.x + COURSE_MIND_MAP_NODE_WIDTH / 2) * viewport.zoom;
      viewport.y = size.height / 2 - (focused.position.y + COURSE_MIND_MAP_NODE_HEIGHT / 2) * viewport.zoom;
    }
    const frame = requestAnimationFrame(() => { void setViewport(viewport, { duration: 0 }); });
    return () => cancelAnimationFrame(frame);
  }, [focusId, geometry, revision, setViewport, size, viewportInitialized]);
  return null;
}

function MapControls({ onFit }: { onFit: () => void }) {
  const { zoomIn, zoomOut } = useReactFlow();
  return <div className={styles.mapControls} aria-label="导图视图控制">
    <button type="button" aria-label="缩小导图" title="缩小" onClick={() => void zoomOut()}><Minus size={17} /></button>
    <button type="button" aria-label="放大导图" title="放大" onClick={() => void zoomIn()}><Plus size={17} /></button>
    <button type="button" aria-label="适应画布" title="适应画布" onClick={onFit}><Expand size={17} /></button>
  </div>;
}

type CourseMindMapFlowProps = {
  map: CourseMindMap;
  activeNodeId?: string | null;
  compact?: boolean;
  fillAvailableHeight?: boolean;
  height?: number;
  focusActiveNode?: boolean;
  showMiniMap?: boolean;
  showControls?: boolean;
};

export function CourseMindMapFlow(props: CourseMindMapFlowProps) {
  return props.compact ? <CourseMindMapPreview {...props} />
    : <CourseMindMapExplorer key={props.map.sourceFingerprint} {...props} />;
}

/** Keep the current concept and its immediate context readable in the listening rail. */
function CourseMindMapPreview({ map, activeNodeId, height = 360, fillAvailableHeight = false }: CourseMindMapFlowProps) {
  const nodeById = new Map(map.nodes.map(node => [node.id, node]));
  const current = nodeById.get(activeNodeId ?? '') ?? nodeById.get(map.rootId) ?? map.nodes[0];
  if (!current) return null;
  const path = courseMindMapAncestors(map, current.id);
  const parent = nodeById.get(current.parentId ?? '');
  const descendants = map.nodes.filter(node => node.parentId === current.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const siblings = parent ? map.nodes.filter(node => node.parentId === parent.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) : [];
  const currentIndex = siblings.findIndex(node => node.id === current.id);
  const nearby = descendants.length ? descendants.slice(0, 2)
    : [siblings[currentIndex - 1], siblings[currentIndex + 1]].filter((node): node is CourseMindMap['nodes'][number] => Boolean(node));
  const total = descendants.length || Math.max(0, siblings.length - 1);
  const branches = map.nodes.filter(node => node.parentId === map.rootId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const branchIndex = branches.findIndex(node => node.id === path[1]);
  const color = branchIndex < 0 ? '#168575' : BRANCH_COLORS[branchIndex % BRANCH_COLORS.length];
  const breadcrumb = path.slice(1).map(id => nodeById.get(id)?.label).join(' › ') || current.label;
  return <div className={styles.liveMap} aria-label="当前讲授思维导图" data-mind-map-camera={current.id}
    style={{ '--concept-color': color, ...(fillAvailableHeight ? {} : { height }) } as React.CSSProperties}>
    <div className={styles.liveHeader}><span />{activeNodeId && nodeById.has(activeNodeId) ? '当前讲授' : '课程概览'}</div>
    <div className={styles.livePath} aria-label="当前概念路径" title={breadcrumb}>{breadcrumb}</div>
    <div className={styles.liveTree}>
      {parent ? <><div className={styles.liveParent} title={parent.label}>{parent.label}</div><div className={styles.liveStem} /></> : null}
      <div className={styles.liveCurrent} data-active-concept="true" data-concept-id={current.id} title={current.label}>
        <span className={styles.conceptDot} /><strong>{current.label}</strong>
      </div>
      {nearby.length ? <div className={cn(styles.liveRelated, descendants.length > 0 && styles.liveChildren)}>
        <div className={styles.liveRelationLabel}>{descendants.length ? '下级概念' : '同级概念'}{total > nearby.length ? ` · 另有 ${total - nearby.length} 个` : ''}</div>
        <div className={styles.liveRelatedNodes}>{nearby.map(node => <div key={node.id} title={node.label} data-context-concept={node.id}>{node.label}</div>)}</div>
      </div> : null}
    </div>
  </div>;
}

function CourseMindMapExplorer({
  map, activeNodeId, fillAvailableHeight = false,
  height = 360, focusActiveNode = false, showMiniMap = true, showControls = true,
}: CourseMindMapFlowProps) {
  const initialFocus = focusActiveNode && activeNodeId && map.nodes.some(node => node.id === activeNodeId) ? activeNodeId : null;
  const initialPath = initialFocus ? courseMindMapAncestors(map, initialFocus) : [map.rootId];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scopeId, setScopeId] = useState(initialPath[1] ?? map.rootId);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set(initialPath));
  const [query, setQuery] = useState('');
  const [cameraRevision, setCameraRevision] = useState(0);
  const [cameraFocusId, setCameraFocusId] = useState<string | null>(initialFocus);
  const containerRef = useRef<HTMLDivElement>(null);
  const highlightId = selectedId ?? activeNodeId;
  const nodeById = useMemo(() => new Map(map.nodes.map(node => [node.id, node])), [map.nodes]);
  const paths = useMemo(() => new Map(map.nodes.map(node => [node.id, courseMindMapAncestors(map, node.id)])), [map]);
  const activePath = paths.get(highlightId ?? '') ?? [];
  const children = useMemo(() => {
    const groups = new Map<string, CourseMindMap['nodes']>();
    for (const node of map.nodes) if (node.parentId) groups.set(node.parentId, [...(groups.get(node.parentId) ?? []), node]);
    for (const group of groups.values()) group.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return groups;
  }, [map.nodes]);
  const rootChildren = children.get(map.rootId) ?? [];
  const scopeNodes = useMemo(() => map.nodes.filter(node => scopeId === map.rootId || paths.get(node.id)?.includes(scopeId)), [map.nodes, map.rootId, paths, scopeId]);
  const visibleNodes = useMemo(() => {
    return scopeNodes.filter(node => {
      const path = paths.get(node.id) ?? [];
      return path.slice(Math.max(0, path.indexOf(scopeId)), -1).every(id => expandedIds.has(id));
    });
  }, [expandedIds, paths, scopeId, scopeNodes]);
  // Folding recomputes the visible tree, so hidden branches leave no blank rows.
  const layout = useMemo(() => layoutCourseMindMap({ rootId: scopeId, nodes: visibleNodes },
    { balanced: scopeId === map.rootId }), [map.rootId, scopeId, visibleNodes]);
  const layoutById = useMemo(() => new Map(layout.map(node => [node.id, node])), [layout]);
  const visibleIds = useMemo(() => new Set(visibleNodes.map(node => node.id)), [visibleNodes]);
  const branchColor = (id: string) => {
    const index = rootChildren.findIndex(node => node.id === paths.get(id)?.[1]);
    return index < 0 ? '#334b53' : BRANCH_COLORS[index % BRANCH_COLORS.length];
  };
  const toggle = useCallback((id: string) => {
    setCameraFocusId(null);
    setExpandedIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const browse = (id: string) => {
    setScopeId(id);
    setSelectedId(null);
    setCameraFocusId(null);
    setExpandedIds(new Set([id]));
    setQuery('');
    setCameraRevision(value => value + 1);
  };
  const reveal = (id: string) => {
    const path = paths.get(id) ?? [];
    setScopeId(path[1] ?? map.rootId);
    setExpandedIds(new Set(path));
    setSelectedId(id);
    setCameraFocusId(id);
    setQuery('');
    setCameraRevision(value => value + 1);
  };
  const nodes: Array<Node<ConceptNodeData>> = visibleNodes.map(node => ({
    id: node.id, type: 'concept', position: layoutById.get(node.id)?.position ?? { x: 0, y: 0 },
    width: COURSE_MIND_MAP_NODE_WIDTH, height: COURSE_MIND_MAP_NODE_HEIGHT,
    ariaLabel: node.label,
    data: {
      label: node.label, active: node.id === highlightId,
      ancestor: activePath.includes(node.id) && node.id !== highlightId,
      root: node.id === scopeId, color: branchColor(node.id),
      side: layoutById.get(node.id)?.side ?? 'right',
      childCount: children.get(node.id)?.length ?? 0, collapsed: !expandedIds.has(node.id), onToggle: toggle, onSelect: setSelectedId,
    },
  }));
  // Cross-topic relationships remain fully available in the inspector. They do
  // not become canvas edges, which would obscure the parent-child hierarchy.
  const edges: Edge[] = visibleNodes.flatMap(node => {
    if (!node.parentId || !visibleIds.has(node.parentId)) return [];
    const onPath = activePath.includes(node.id) && activePath.includes(node.parentId);
    return [{
      id: `contains:${node.id}`, source: node.parentId, target: node.id,
      sourceHandle: layoutById.get(node.id)?.side ?? 'right', targetHandle: 'target', type: 'default',
      ariaLabel: `${nodeById.get(node.parentId)?.label}包含${node.label}`,
      style: { stroke: branchColor(node.id), strokeWidth: onPath ? 2 : 1.5, opacity: onPath ? 0.85 : 0.38 },
    }];
  });
  const selected = selectedId ? nodeById.get(selectedId) : undefined;
  const selectedRelations = selected ? map.relations.filter(relation => relation.source === selected.id || relation.target === selected.id) : [];
  const searchResults = query.trim() ? map.nodes.filter(node => `${node.label} ${node.description ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) : [];
  const focusedVisibleId = activeNodeId && visibleIds.has(activeNodeId) ? activeNodeId : null;
  const fit = () => { setCameraFocusId(null); setCameraRevision(value => value + 1); };

  return <div
    className={styles.workspace}
    style={fillAvailableHeight ? undefined : { height }}
  >
    <>
      <div className={styles.toolbar}>
        <div className={styles.searchBox}>
          <Search size={16} aria-hidden="true" />
          <input aria-label="搜索课程概念" placeholder="搜索概念…" value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing && searchResults[0]) reveal(searchResults[0].id);
              if (event.key === 'Escape' && query) { event.stopPropagation(); setQuery(''); }
            }} />
          {query ? <button type="button" aria-label="清空搜索" onClick={() => setQuery('')}><X size={15} /></button> : null}
          {query.trim() ? <div className={styles.searchResults} aria-label="概念搜索结果">
            <p>{searchResults.length ? `${searchResults.length} 个匹配概念` : '未找到匹配概念'}</p>
            {searchResults.map(node => <button type="button" key={node.id} onClick={() => reveal(node.id)}>
              <span>{node.label}</span><small>{nodeById.get(paths.get(node.id)?.[1] ?? '')?.label ?? '课程'}</small>
            </button>)}
          </div> : null}
        </div>
        <div className={styles.toolbarActions}>
          {activeNodeId && nodeById.has(activeNodeId) ? <button type="button" onClick={() => reveal(activeNodeId)}><Focus size={16} />当前讲授</button> : null}
          <button type="button" aria-label="展开全部" title="展开全部" onClick={() => { setExpandedIds(new Set(scopeNodes.map(node => node.id))); fit(); }}><Expand size={15} /><span>展开全部</span></button>
          <button type="button" aria-label="收起层级" title="收起层级" onClick={() => { setExpandedIds(new Set([scopeId])); fit(); }}><Minus size={15} /><span>收起层级</span></button>
        </div>
      </div>
      <nav className={styles.topics} aria-label="课程主题">
        <div className={styles.courseHeading}><BookOpen size={17} /><strong title={nodeById.get(map.rootId)?.label}>{nodeById.get(map.rootId)?.label ?? '课程思维导图'}</strong></div>
        <p className={styles.topicSummary}>{rootChildren.length} 个主题 · {Math.max(0, map.nodes.length - 1)} 个概念</p>
        <button type="button" className={cn(styles.topicButton, scopeId === map.rootId && styles.topicSelected)}
          aria-pressed={scopeId === map.rootId} onClick={() => browse(map.rootId)}><GitBranch size={16} /><span>课程总览</span></button>
        <div className={styles.topicList}>{rootChildren.map((node, index) => <button key={node.id} type="button"
          className={cn(styles.topicButton, scopeId === node.id && styles.topicSelected)}
          aria-pressed={scopeId === node.id} onClick={() => browse(node.id)} title={node.label}>
          <span className={styles.topicNumber} style={{ color: BRANCH_COLORS[index % BRANCH_COLORS.length] }}>{String(index + 1).padStart(2, '0')}</span>
          <span>{node.label}</span><small>{map.nodes.filter(item => paths.get(item.id)?.includes(node.id)).length}</small>
        </button>)}</div>
        <p className={styles.navigationHint}>选择主题逐层浏览<br />点击概念查看完整内容与关联</p>
      </nav>
      <div className={styles.mobileTopics}>
        <label htmlFor={`mind-map-topic-${map.rootId}`}>浏览主题</label>
        <select id={`mind-map-topic-${map.rootId}`} aria-label="选择导图主题" value={scopeId} onChange={event => browse(event.target.value)}>
          <option value={map.rootId}>课程总览</option>
          {rootChildren.map(node => <option value={node.id} key={node.id}>{node.label}</option>)}
        </select>
      </div>
    </>
    <div className={styles.mainPane}>
      <div className={styles.viewHeading}>
        <div><span>{scopeId === map.rootId ? '课程总览' : '主题导图'}</span><strong title={nodeById.get(scopeId)?.label}>{nodeById.get(scopeId)?.label}</strong></div>
        <small aria-live="polite">已显示 {visibleNodes.length} / {scopeNodes.length} 个节点</small>
      </div>
      <div ref={containerRef} className={styles.canvas} data-mind-map-camera={focusedVisibleId ?? undefined}>
        <ReactFlowProvider>
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            fitView={false}
            minZoom={0.1} maxZoom={1.8}
            nodesDraggable={false} nodesConnectable={false} nodesFocusable={false}
            edgesFocusable={false} elementsSelectable
            onlyRenderVisibleElements proOptions={{ hideAttribution: true }}
          >
            <ExplorerCamera nodes={nodes} containerRef={containerRef} revision={cameraRevision} focusId={cameraFocusId} />
            <Background color="#d5e0df" gap={24} size={1} />
            {showControls ? <MapControls onFit={fit} /> : null}
            {showMiniMap && visibleNodes.length > 20 ? <MiniMap position="bottom-left" pannable zoomable
              nodeColor={node => (node.data as ConceptNodeData).color} maskColor="rgba(244,248,247,0.8)" /> : null}
          </ReactFlow>
        </ReactFlowProvider>
        <div className={styles.canvasHint}><span />点击节点旁的 + 展开分支</div>
      </div>
    </div>
    {selected ? <aside className={styles.detail} aria-label="概念详情">
      <div className={styles.detailHeader}><span>概念详情</span><button aria-label="关闭概念详情" onClick={() => setSelectedId(null)} type="button"><X size={18} /></button></div>
      <div className={styles.detailBody}>
        <div className={styles.detailPath}>{(paths.get(selected.id) ?? []).slice(1, -1).map(id => nodeById.get(id)?.label).join(' / ') || '课程概念'}</div>
        <h3>{selected.label}</h3>
        {selected.description ? <p className={styles.description}>{selected.description}</p> : null}
        {children.get(selected.id)?.length ? <section className={styles.detailSection}>
          <h4>下级概念 <span>{children.get(selected.id)?.length}</span></h4>
          {children.get(selected.id)?.map(node => <button type="button" className={styles.childLink} key={node.id} onClick={() => reveal(node.id)}>{node.label}<ChevronRight size={15} /></button>)}
        </section> : null}
        <section className={styles.detailSection}>
          <h4>关联关系 <span>{selectedRelations.length}</span></h4>
          {selectedRelations.length ? selectedRelations.map(relation => {
            const otherId = relation.source === selected.id ? relation.target : relation.source;
            return <div className={styles.relation} key={relation.id}>
              <div className={styles.relationDirection}>{nodeById.get(relation.source)?.label}<ArrowRight size={13} /><span>{relation.label}</span><ArrowRight size={13} />{nodeById.get(relation.target)?.label}</div>
              <button type="button" onClick={() => reveal(otherId)}>查看：{nodeById.get(otherId)?.label}<ChevronRight size={15} /></button>
              <p>{relation.rationale}</p>
            </div>;
          }) : <p className={styles.emptyRelations}>该概念暂无额外关联</p>}
        </section>
      </div>
    </aside> : null}
  </div>;
}
