"use client";

import { BookOpen, Check, Minimize2, Network, Plus, Trash2 } from "lucide-react";
import { motion } from "motion/react";
import { useMemo, useState } from "react";
import { KnowledgeGraphFlow } from "@/components/knowledge-graph-flow";
import type {
  KnowledgeGraph,
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
  KnowledgePoint,
  KnowledgeScopePlan,
} from "@/lib/session/types";
import type { CourseEvidenceSnapshot } from "@/lib/textbook/course-evidence-types";

const LEVELS = [
  ["foundation", "基础"],
  ["core", "核心"],
  ["application", "应用"],
  ["extension", "拓展"],
] as const;

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function prepareGraph(points: KnowledgePoint[], graph: KnowledgeGraph): KnowledgeGraph {
  const ids = new Set(graph.nodes.map((node) => node.id));
  return {
    nodes: [
      ...graph.nodes,
      ...points.filter((point) => !ids.has(point.id)).map((point): KnowledgeGraphNode => ({
        id: point.id,
        label: point.name,
        description: point.description,
        keyInfo: point.keyInfo,
        level: point.level ?? "core",
        instructionalRole: "lesson",
        objectiveIndexes: point.objectiveIndexes,
        masteryBoundary: point.masteryBoundary,
      })),
    ],
    edges: graph.edges,
  };
}

export function QuickKnowledgeReviewDialog({
  initialKnowledgePoints,
  initialKnowledgeGraph,
  courseEvidence,
  knowledgeScopePlan,
  onClose,
  onConfirm,
}: {
  initialKnowledgePoints: KnowledgePoint[];
  initialKnowledgeGraph: KnowledgeGraph;
  courseEvidence?: CourseEvidenceSnapshot;
  knowledgeScopePlan?: KnowledgeScopePlan;
  onClose: () => void;
  onConfirm: (knowledgePoints: KnowledgePoint[], knowledgeGraph: KnowledgeGraph) => Promise<void>;
}) {
  const [points, setPoints] = useState(() => initialKnowledgePoints.map((point) => ({ ...point })));
  const [graph, setGraph] = useState(() => prepareGraph(
    initialKnowledgePoints,
    {
      nodes: initialKnowledgeGraph.nodes.map((node) => ({ ...node })),
      edges: initialKnowledgeGraph.edges.map((edge) => ({ ...edge })),
    },
  ));
  const [selectedId, setSelectedId] = useState<string | null>(
    initialKnowledgePoints[0]?.id ?? initialKnowledgeGraph.nodes[0]?.id ?? null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const selectedNode = graph.nodes.find((node) => node.id === selectedId) ?? null;
  const selectedPoint = points.find((point) => point.id === selectedId) ?? null;
  const selectedEvidence = useMemo(() => {
    const evidenceIds = new Set([
      ...(selectedPoint?.evidenceItemIds ?? []),
      ...(selectedNode?.evidenceItemIds ?? []),
    ]);
    return (courseEvidence?.items ?? []).filter((item) => evidenceIds.has(item.id));
  }, [courseEvidence?.items, selectedNode?.evidenceItemIds, selectedPoint?.evidenceItemIds]);
  const selectedEdges = useMemo(
    () => graph.edges.filter((edge) => edge.source === selectedId || edge.target === selectedId),
    [graph.edges, selectedId],
  );

  function updateNode(patch: Partial<KnowledgeGraphNode>) {
    if (!selectedId) return;
    setGraph((current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.id === selectedId ? { ...node, ...patch } : node),
    }));
    if (selectedPoint) {
      setPoints((current) => current.map((point) => point.id === selectedId
        ? {
            ...point,
            ...(patch.label !== undefined ? { name: patch.label } : {}),
            ...(patch.description !== undefined ? { description: patch.description } : {}),
            ...(patch.keyInfo !== undefined ? { keyInfo: patch.keyInfo } : {}),
            ...(patch.level !== undefined ? { level: patch.level } : {}),
            ...(patch.masteryBoundary !== undefined ? { masteryBoundary: patch.masteryBoundary } : {}),
          }
        : point));
    }
  }

  function addKnowledgePoint() {
    const id = createId("knowledge");
    const point: KnowledgePoint = {
      id,
      name: "新知识点",
      description: "请填写该知识点的学习内容",
      level: "core",
    };
    setPoints((current) => [...current, point]);
    setGraph((current) => ({
      ...current,
      nodes: [...current.nodes, {
        id,
        label: point.name,
        description: point.description,
        level: point.level,
        instructionalRole: "lesson",
      }],
    }));
    setSelectedId(id);
  }

  function removeSelectedNode() {
    if (!selectedId) return;
    setPoints((current) => current.filter((point) => point.id !== selectedId));
    setGraph((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => node.id !== selectedId),
      edges: current.edges.filter((edge) => edge.source !== selectedId && edge.target !== selectedId),
    }));
    setSelectedId(graph.nodes.find((node) => node.id !== selectedId)?.id ?? null);
  }

  function updateEdge(edgeId: string, patch: Partial<KnowledgeGraphEdge>) {
    setGraph((current) => ({
      ...current,
      edges: current.edges.map((edge) => edge.id === edgeId ? { ...edge, ...patch } : edge),
    }));
  }

  function addRelation() {
    if (graph.nodes.length < 2) return;
    const source = selectedId && graph.nodes.some((node) => node.id === selectedId)
      ? selectedId
      : graph.nodes[0].id;
    const target = graph.nodes.find((node) => node.id !== source)?.id;
    if (!target) return;
    setGraph((current) => ({
      ...current,
      edges: [...current.edges, {
        id: createId("relation"),
        source,
        target,
        label: "支持理解",
        type: "supports",
        strength: "helpful",
      }],
    }));
  }

  async function confirm() {
    if (!points.length) {
      setError("至少保留一个本课知识点。");
      return;
    }
    if (points.some((point) => !point.name.trim())) {
      setError("知识点名称不能为空。");
      return;
    }
    const nodeIds = new Set(graph.nodes.map((node) => node.id));
    setSaving(true);
    setError(undefined);
    try {
      await onConfirm(
        points.map((point) => ({ ...point, name: point.name.trim(), description: point.description.trim() })),
        {
          nodes: graph.nodes.map((node) => ({
            ...node,
            label: node.label.trim() || "未命名知识点",
            description: node.description.trim(),
          })),
          edges: graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
        },
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <motion.div
      animate={{ opacity: 1 }}
      aria-label="审阅知识图谱"
      aria-modal="true"
      className="fixed inset-0 z-[90] bg-stone-950/45 p-3 backdrop-blur-sm sm:p-6"
      exit={{ opacity: 0 }}
      initial={{ opacity: 0 }}
      role="dialog"
    >
      <motion.div className="mx-auto flex h-full max-w-[1260px] flex-col overflow-hidden rounded-[18px] border border-white/70 bg-[#f8f7f3] shadow-[0_32px_90px_rgba(28,25,23,.28)]">
        <header className="flex items-center justify-between gap-4 border-b border-stone-200 bg-white px-5 py-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[.14em] text-blue-700">快速生成已暂停</p>
            <h2 className="mt-1 font-editorial text-xl font-semibold text-stone-950">知识图谱</h2>
            <p className="mt-1 text-xs text-stone-500">确认后的知识点与关系将直接用于生成分节知识讲授课程大纲。</p>
          </div>
          <button aria-label="缩小并返回快速生成卡片" className="grid size-9 shrink-0 place-items-center rounded-full border border-stone-200 bg-white text-stone-500 transition hover:border-stone-400 hover:text-stone-900" onClick={onClose} type="button">
            <Minimize2 size={16} />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1.45fr)_420px]">
          <section className="min-h-[360px] border-b border-stone-200 bg-white lg:border-b-0 lg:border-r">
            <KnowledgeGraphFlow
              graph={graph}
              height={560}
              onNodePositionChange={(nodeId, position) => setGraph((current) => ({
                ...current,
                nodes: current.nodes.map((node) => node.id === nodeId ? { ...node, position } : node),
              }))}
              onNodeSelect={setSelectedId}
              points={points}
            />
          </section>

          <aside className="min-h-0 overflow-y-auto p-4 sm:p-5">
            {knowledgeScopePlan?.teachingOrder ? (
              <section className="mb-4 border-b border-stone-200 pb-4" aria-label="本课教学顺序">
                <p className="text-sm font-bold text-stone-900">本课教学顺序</p>
                <p className="mt-1 text-xs text-stone-500">按主教材相关概念的正文位置展开；局部调整列出依据。</p>
                <ol className="mt-2 space-y-2">
                  {points.map((point, index) => {
                    const anchor = knowledgeScopePlan.teachingOrder?.anchors.find((item) => item.knowledgePointId === point.id);
                    const adjustments = knowledgeScopePlan.teachingOrder?.adjustments.filter((item) => item.knowledgePointId === point.id) ?? [];
                    return <li className="border-l-2 border-blue-200 pl-2.5 text-xs" key={point.id}>
                      <p className="font-semibold text-stone-900">{index + 1}. {point.name}</p>
                      <p className="mt-0.5 text-stone-500">{anchor?.status === "primary-textbook"
                        ? `主教材：${anchor.sectionPath.join(" › ") || "已定位正文"}`
                        : "主教材未定位；按知识依赖衔接"}</p>
                      {adjustments.map((adjustment) => <p className="mt-1 text-amber-800" key={`${adjustment.knowledgePointId}-${adjustment.beforeKnowledgePointId}`}>
                        调整至“{points.find((candidate) => candidate.id === adjustment.beforeKnowledgePointId)?.name ?? adjustment.beforeKnowledgePointId}”之前：{adjustment.obstacle}；{adjustment.basis}
                      </p>)}
                    </li>;
                  })}
                </ol>
              </section>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-bold text-stone-900"><Network className="size-4 text-blue-700" />节点与关系</div>
              <button className="inline-flex h-8 items-center gap-1.5 rounded-[7px] border border-blue-200 bg-blue-50 px-2.5 text-xs font-semibold text-blue-800 hover:bg-blue-100" onClick={addKnowledgePoint} type="button"><Plus className="size-3.5" />添加知识点</button>
            </div>

            <div className="mt-3 flex flex-wrap gap-1.5">
              {graph.nodes.map((node) => (
                <button className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${node.id === selectedId ? "border-blue-700 bg-blue-700 text-white" : "border-stone-200 bg-white text-stone-600 hover:border-blue-300"}`} key={node.id} onClick={() => setSelectedId(node.id)} type="button">
                  {node.instructionalRole === "prerequisite" ? "先修 · " : ""}{node.label}
                </button>
              ))}
            </div>

            {selectedNode ? (
              <div className="mt-4 space-y-3 rounded-[12px] border border-stone-200 bg-white p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-bold text-stone-700">{selectedPoint ? "本课知识点" : "先修知识点"}</p>
                  <button aria-label="删除当前节点" className="text-stone-400 hover:text-red-700" onClick={removeSelectedNode} type="button"><Trash2 className="size-4" /></button>
                </div>
                <label className="block text-xs font-semibold text-stone-600">名称
                  <input className="mt-1 h-9 w-full rounded-[7px] border border-stone-300 px-3 text-sm outline-none focus:border-blue-600" onChange={(event) => updateNode({ label: event.target.value })} value={selectedNode.label} />
                </label>
                <label className="block text-xs font-semibold text-stone-600">说明
                  <textarea className="mt-1 min-h-20 w-full resize-y rounded-[7px] border border-stone-300 px-3 py-2 text-sm leading-5 outline-none focus:border-blue-600" onChange={(event) => updateNode({ description: event.target.value })} value={selectedNode.description} />
                </label>
                <label className="block text-xs font-semibold text-stone-600">层级
                  <select className="mt-1 h-9 w-full rounded-[7px] border border-stone-300 bg-white px-3 text-sm outline-none focus:border-blue-600" onChange={(event) => updateNode({ level: event.target.value as KnowledgeGraphNode["level"] })} value={selectedNode.level ?? "core"}>
                    {LEVELS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
                {selectedPoint ? <label className="block text-xs font-semibold text-stone-600">掌握标准
                  <textarea className="mt-1 min-h-16 w-full resize-y rounded-[7px] border border-stone-300 px-3 py-2 text-sm leading-5 outline-none focus:border-blue-600" onChange={(event) => updateNode({ masteryBoundary: event.target.value })} value={selectedNode.masteryBoundary ?? ""} />
                </label> : null}
                {selectedNode.teachingDepth ? (
                  <div className="rounded-[8px] bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950">
                    <span className="font-bold">讲授深度：</span>{selectedNode.teachingDepth}
                  </div>
                ) : null}
                {selectedEvidence.length ? (
                  <div className="space-y-2 border-t border-stone-100 pt-3">
                    <p className="flex items-center gap-1.5 text-xs font-bold text-stone-700"><BookOpen className="size-3.5 text-blue-700" />教材依据</p>
                    {selectedEvidence.map((item) => (
                      <article className="rounded-[8px] border border-blue-100 bg-blue-50/50 p-2.5" key={item.id}>
                        <p className="text-xs font-bold text-stone-900">{item.title}</p>
                        <p className="mt-1 text-xs leading-5 text-stone-700">{item.content}</p>
                        {item.source.quote ? <blockquote className="mt-2 border-l-2 border-blue-300 pl-2 text-[11px] leading-5 text-stone-600">{item.source.quote}</blockquote> : null}
                        <p className="mt-1.5 text-[10px] text-stone-500">{item.source.textbookTitle} · {item.source.sectionPath.join(" / ") || "正文"}</p>
                      </article>
                    ))}
                  </div>
                ) : courseEvidence && selectedPoint ? (
                  <p className="rounded-[8px] bg-stone-50 px-3 py-2 text-xs leading-5 text-stone-500">该节点尚未绑定教材证据，应在确认前检查是否属于明确标识的 AI 补充。</p>
                ) : null}
              </div>
            ) : null}

            <div className="mt-4 rounded-[12px] border border-stone-200 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-bold text-stone-700">当前节点关系</p>
                <button className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:text-blue-900" onClick={addRelation} type="button"><Plus className="size-3.5" />添加关系</button>
              </div>
              <div className="mt-3 space-y-3">
                {selectedEdges.map((edge) => (
                  <div className="rounded-[8px] border border-stone-100 bg-stone-50 p-2.5" key={edge.id}>
                    <div className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-1.5">
                      <select aria-label="关系起点" className="h-8 min-w-0 rounded border border-stone-200 bg-white px-1.5 text-[11px]" onChange={(event) => updateEdge(edge.id, { source: event.target.value })} value={edge.source}>{graph.nodes.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}</select>
                      <span className="text-stone-400">→</span>
                      <select aria-label="关系终点" className="h-8 min-w-0 rounded border border-stone-200 bg-white px-1.5 text-[11px]" onChange={(event) => updateEdge(edge.id, { target: event.target.value })} value={edge.target}>{graph.nodes.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}</select>
                      <button aria-label="删除关系" className="text-stone-400 hover:text-red-700" onClick={() => setGraph((current) => ({ ...current, edges: current.edges.filter((item) => item.id !== edge.id) }))} type="button"><Trash2 className="size-3.5" /></button>
                    </div>
                    <input aria-label="关系说明" className="mt-2 h-8 w-full rounded border border-stone-200 bg-white px-2 text-xs" onChange={(event) => updateEdge(edge.id, { label: event.target.value })} value={edge.label} />
                  </div>
                ))}
                {!selectedEdges.length ? <p className="text-xs leading-5 text-stone-400">当前节点暂无关系，可添加后选择起点和终点。</p> : null}
              </div>
            </div>
          </aside>
        </div>

        <footer className="flex items-center justify-between gap-4 border-t border-stone-200 bg-white px-5 py-3">
          <p className="text-xs text-stone-500">{points.length} 个本课知识点 · {graph.edges.length} 条关系</p>
          <div className="flex items-center gap-3">
            {error ? <p className="text-xs font-semibold text-red-700">{error}</p> : null}
            <button className="inline-flex h-10 items-center gap-2 rounded-[8px] bg-blue-700 px-4 text-xs font-bold text-white shadow-sm hover:bg-blue-800 disabled:cursor-wait disabled:opacity-60" disabled={saving} onClick={() => void confirm()} type="button"><Check className="size-4" />{saving ? "正在保存" : "确认并继续"}</button>
          </div>
        </footer>
      </motion.div>
    </motion.div>
  );
}
