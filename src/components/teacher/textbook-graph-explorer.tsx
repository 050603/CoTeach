"use client";

import "@xyflow/react/dist/style.css";

import {
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Focus, Maximize2, Minimize2, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { TextbookConcept, TextbookRelation } from "@/app/teacher/textbooks/textbook-view-types";
import styles from "./textbook-graph-explorer.module.css";

const NODE_WIDTH = 208;
const NODE_HEIGHT = 78;
const COLUMN_GAP = 112;
const ROW_GAP = 30;
const MAX_ROWS = 6;

type TextbookNodeData = {
  label: string;
  order: number;
  relationCount: number;
  isActive: boolean;
  isDimmed: boolean;
  onSelect: (id: string) => void;
};

type TextbookEdgeData = {
  label: string;
  inferred: boolean;
  isActive: boolean;
  isDimmed: boolean;
};

function conceptName(concept: TextbookConcept) {
  return concept.name || concept.title || "未命名知识点";
}

function relationEnds(relation: TextbookRelation) {
  return {
    source: relation.sourceConceptId || relation.sourceId || "",
    target: relation.targetConceptId || relation.targetId || "",
  };
}

function relationLabel(relation: TextbookRelation) {
  const value = (relation.relationType || relation.type || "related").toLocaleLowerCase();
  const labels: Record<string, string> = {
    prerequisite: "先修",
    requires: "依赖",
    supports: "支持",
    application: "应用",
    applies: "应用",
    comparison: "对比",
    contrasts: "对比",
    contains: "包含",
    part_of: "属于",
    related: "相关",
  };
  return labels[value] || relation.relationType || relation.type || "相关";
}

function relationIsInferred(relation: TextbookRelation) {
  return relation.inferred ?? (Boolean(relation.origin) && relation.origin !== "TEXTBOOK");
}

function graphLayout(concepts: TextbookConcept[], relations: TextbookRelation[]) {
  const ids = new Set(concepts.map(concept => concept.id));
  const sourceOrder = new Map(concepts.map((concept, index) => [concept.id, index]));
  const outgoing = new Map(concepts.map(concept => [concept.id, [] as string[]]));
  const incoming = new Map(concepts.map(concept => [concept.id, [] as string[]]));

  for (const relation of relations) {
    const { source, target } = relationEnds(relation);
    if (!ids.has(source) || !ids.has(target) || source === target) continue;
    if (!outgoing.get(source)!.includes(target)) outgoing.get(source)!.push(target);
    if (!incoming.get(target)!.includes(source)) incoming.get(target)!.push(source);
  }

  const indegree = new Map(concepts.map(concept => [concept.id, incoming.get(concept.id)?.length || 0]));
  const ranks = new Map(concepts.map(concept => [concept.id, 0]));
  const queue = concepts.filter(concept => indegree.get(concept.id) === 0).map(concept => concept.id);
  const processed = new Set<string>();
  while (queue.length) {
    queue.sort((left, right) => (sourceOrder.get(left) || 0) - (sourceOrder.get(right) || 0));
    const current = queue.shift()!;
    processed.add(current);
    for (const target of outgoing.get(current) || []) {
      ranks.set(target, Math.max(ranks.get(target) || 0, (ranks.get(current) || 0) + 1));
      const nextIndegree = (indegree.get(target) || 1) - 1;
      indegree.set(target, nextIndegree);
      if (nextIndegree === 0) queue.push(target);
    }
  }

  const lastRank = processed.size ? Math.max(...[...processed].map(id => ranks.get(id) || 0)) : -1;
  for (const concept of concepts) if (!processed.has(concept.id)) ranks.set(concept.id, lastRank + 1);

  const rankedColumns = new Map<number, TextbookConcept[]>();
  for (const concept of concepts) {
    const rank = ranks.get(concept.id) || 0;
    rankedColumns.set(rank, [...(rankedColumns.get(rank) || []), concept]);
  }

  const columns: TextbookConcept[][] = [];
  for (const [, column] of [...rankedColumns.entries()].sort(([left], [right]) => left - right)) {
    for (let index = 0; index < column.length; index += MAX_ROWS) columns.push(column.slice(index, index + MAX_ROWS));
  }

  const positions = new Map<string, { x: number; y: number }>();
  columns.forEach((column, columnIndex) => {
    const columnHeight = (column.length - 1) * (NODE_HEIGHT + ROW_GAP);
    column.forEach((concept, rowIndex) => {
      positions.set(concept.id, {
        x: columnIndex * (NODE_WIDTH + COLUMN_GAP),
        y: rowIndex * (NODE_HEIGHT + ROW_GAP) - columnHeight / 2,
      });
    });
  });
  return positions;
}

function TextbookNode({ id, data }: NodeProps) {
  const node = data as TextbookNodeData;
  return <button
    aria-label={`查看知识点：${node.label}`}
    className={styles.node}
    data-active={node.isActive || undefined}
    data-muted={node.isDimmed || undefined}
    onClick={event => {
      event.stopPropagation();
      node.onSelect(id);
    }}
    style={{ width: NODE_WIDTH, minHeight: NODE_HEIGHT }}
    title={node.label}
    type="button"
  >
    <Handle className={styles.handle} position={Position.Left} type="target" />
    <span className={styles.nodeIndex}>{String(node.order).padStart(2, "0")}</span>
    <span className={styles.nodeCopy}>
      <strong>{node.label}</strong>
      <small>{node.relationCount ? `${node.relationCount} 条关联` : "独立知识点"}</small>
    </span>
    <Handle className={styles.handle} position={Position.Right} type="source" />
  </button>;
}

function TextbookEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps) {
  const edge = (data || {}) as unknown as TextbookEdgeData;
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: .32 });
  return <>
    <BaseEdge
      path={path}
      style={{
        stroke: "rgba(255,255,255,.96)",
        strokeWidth: edge.isActive ? 6 : 4.5,
        opacity: edge.isDimmed ? .12 : 1,
      }}
    />
    <BaseEdge
      path={path}
      markerEnd={markerEnd}
      style={{
        stroke: edge.isActive ? "#315f8d" : edge.inferred ? "#a78d70" : "#9aa8b7",
        strokeDasharray: edge.inferred ? "5 5" : undefined,
        strokeWidth: edge.isActive ? 2.2 : 1.35,
        opacity: edge.isDimmed ? .18 : 1,
        transition: "stroke .18s, opacity .18s, stroke-width .18s",
      }}
    />
    {edge.isActive ? <EdgeLabelRenderer>
      <span className={styles.edgeLabel} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>{edge.label}</span>
    </EdgeLabelRenderer> : null}
  </>;
}

const nodeTypes = { textbook: TextbookNode };
const edgeTypes = { textbook: TextbookEdge };

function GraphActions({ onReset, fullscreen, onToggleFullscreen }: { onReset: () => void; fullscreen: boolean; onToggleFullscreen: () => void }) {
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  return <div className={styles.actions} aria-label="图谱视图控制">
    <button aria-label="放大图谱" title="放大" type="button" onClick={() => void zoomIn({ duration: 180 })}><ZoomIn size={16} /></button>
    <button aria-label="缩小图谱" title="缩小" type="button" onClick={() => void zoomOut({ duration: 180 })}><ZoomOut size={16} /></button>
    <button aria-label="适配全部节点" title="适配画布" type="button" onClick={() => void fitView({ duration: 280, padding: .18 })}><Focus size={16} /></button>
    <button aria-label="恢复默认布局" title="恢复布局" type="button" onClick={onReset}><RotateCcw size={15} /></button>
    <span aria-hidden="true" />
    <button aria-label={fullscreen ? "退出全屏图谱" : "全屏查看图谱"} title={fullscreen ? "退出全屏" : "全屏查看"} type="button" onClick={onToggleFullscreen}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
  </div>;
}

function GraphViewport({ concepts, relations, selectedId, onSelect, fullscreen, onToggleFullscreen }: TextbookGraphExplorerProps & { fullscreen: boolean; onToggleFullscreen: () => void }) {
  const topologyKey = useMemo(() => `${concepts.map(item => item.id).join("|")}::${relations.map(item => {
    const ends = relationEnds(item);
    return `${ends.source}>${ends.target}`;
  }).join("|")}`, [concepts, relations]);
  const positions = useMemo(() => graphLayout(concepts, relations), [concepts, relations]);
  const neighbors = useMemo(() => {
    const values = new Set(selectedId ? [selectedId] : []);
    if (!selectedId) return values;
    for (const relation of relations) {
      const { source, target } = relationEnds(relation);
      if (source === selectedId) values.add(target);
      if (target === selectedId) values.add(source);
    }
    return values;
  }, [relations, selectedId]);
  const relationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const relation of relations) {
      const { source, target } = relationEnds(relation);
      counts.set(source, (counts.get(source) || 0) + 1);
      counts.set(target, (counts.get(target) || 0) + 1);
    }
    return counts;
  }, [relations]);

  const baseNodes = useMemo<Node[]>(() => concepts.map((concept, index) => ({
    id: concept.id,
    type: "textbook",
    position: positions.get(concept.id) || { x: 0, y: 0 },
    data: {
      label: conceptName(concept),
      order: index + 1,
      relationCount: relationCounts.get(concept.id) || 0,
      isActive: concept.id === selectedId,
      isDimmed: Boolean(selectedId && !neighbors.has(concept.id)),
      onSelect,
    } satisfies TextbookNodeData,
  })), [concepts, neighbors, onSelect, positions, relationCounts, selectedId]);

  const baseEdges = useMemo<Edge[]>(() => relations.flatMap((relation, index) => {
    const { source, target } = relationEnds(relation);
    if (!positions.has(source) || !positions.has(target)) return [];
    const active = Boolean(selectedId && (source === selectedId || target === selectedId));
    const inferred = relationIsInferred(relation);
    return [{
      id: relation.id || `${source}-${target}-${index}`,
      source,
      target,
      type: "textbook",
      markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color: active ? "#315f8d" : inferred ? "#a78d70" : "#9aa8b7" },
      data: { label: relationLabel(relation), inferred, isActive: active, isDimmed: Boolean(selectedId && !active) } satisfies TextbookEdgeData,
    }];
  }), [positions, relations, selectedId]);

  const [nodes, setNodes, onNodesChange] = useNodesState(baseNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(baseEdges);
  const { fitView } = useReactFlow();

  useEffect(() => {
    setNodes(current => {
      const currentPositions = new Map(current.map(node => [node.id, node.position]));
      return baseNodes.map(node => ({ ...node, position: currentPositions.get(node.id) || node.position }));
    });
    setEdges(baseEdges);
  }, [baseEdges, baseNodes, setEdges, setNodes]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void fitView({ duration: 260, padding: .18, minZoom: .66, maxZoom: 1 }));
    return () => window.cancelAnimationFrame(frame);
  }, [fitView, fullscreen, topologyKey]);

  const resetLayout = useCallback(() => {
    setNodes(baseNodes);
    window.requestAnimationFrame(() => void fitView({ duration: 300, padding: .18, minZoom: .66, maxZoom: 1 }));
  }, [baseNodes, fitView, setNodes]);

  return <>
    <ReactFlow
      aria-label="教材知识图谱"
      className={styles.flow}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onPaneClick={() => onSelect(null)}
      fitView
      fitViewOptions={{ padding: .18, minZoom: .66, maxZoom: 1 }}
      minZoom={.24}
      maxZoom={2.1}
      nodesConnectable={false}
      panOnDrag
      panOnScroll={false}
      zoomOnScroll
      zoomOnPinch
      zoomOnDoubleClick
      proOptions={{ hideAttribution: true }}
    >
      <Background color="#d7dee7" gap={24} size={1} variant={BackgroundVariant.Dots} />
      {concepts.length > 6 ? <MiniMap className={styles.miniMap} pannable zoomable maskColor="rgba(239,243,247,.72)" nodeColor={node => node.id === selectedId ? "#315f8d" : "#a7b3bf"} /> : null}
    </ReactFlow>
    <div className={styles.legend} aria-label="关系图例"><span><i />教材关系</span><span><i data-inferred="true" />AI 推断</span></div>
    <GraphActions fullscreen={fullscreen} onReset={resetLayout} onToggleFullscreen={onToggleFullscreen} />
    <div className={styles.gestureHint}>按住空白处拖动画布 · 滚轮缩放 · 节点可单独拖动整理</div>
  </>;
}

type TextbookGraphExplorerProps = {
  concepts: TextbookConcept[];
  relations: TextbookRelation[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
};

export function TextbookGraphExplorer(props: TextbookGraphExplorerProps) {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!fullscreen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [fullscreen]);

  if (!props.concepts.length) return <div className={styles.empty}>这个章节还没有可展示的知识节点。</div>;

  const explorer = <div className={styles.explorer} data-fullscreen={fullscreen || undefined}>
    <ReactFlowProvider>
      <GraphViewport {...props} fullscreen={fullscreen} onToggleFullscreen={() => setFullscreen(value => !value)} />
    </ReactFlowProvider>
  </div>;

  return fullscreen && typeof document !== "undefined" ? createPortal(explorer, document.body) : explorer;
}
