"use client";

import { Focus, Maximize2, Minimize2, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { Graph } from "@antv/g6";
import type { TextbookConcept, TextbookRelation, TextbookSection } from "@/app/teacher/textbooks/textbook-view-types";
import { cachedGraphView, conceptName, createGraphModel, graphFocusedSectionIds, relationLabel, resolveGraphFocus, type ViewOptions, type GraphView } from "@/lib/textbook/graph-model";
import styles from "./textbook-graph-explorer.module.css";

export type TextbookGraphExplorerProps = {
  className?: string; concepts: TextbookConcept[]; relations: TextbookRelation[]; sections: TextbookSection[];
  focusedSectionId: string; selectedId: string | null; onSelect: (id: string | null) => void; onSelectSection: (id: string) => void; detail?: ReactNode;
};

function chapterFill(color: string) {
  return ({ "#2563eb": "#eef4ff", "#0d9488": "#eaf9f5", "#d97706": "#fff6e8", "#8b5cf6": "#f3eeff", "#db2777": "#fff0f6", "#0284c7": "#eaf7ff" } as Record<string, string>)[color] || "#f1f5f9";
}
const narrowQuery = "(max-width: 900px)";
function subscribeNarrow(onChange: () => void) { const query = window.matchMedia(narrowQuery); query.addEventListener("change", onChange); return () => query.removeEventListener("change", onChange); }
const getNarrow = () => window.matchMedia(narrowQuery).matches;
const getServerNarrow = () => false;

export function TextbookGraphExplorer({ concepts, relations, sections, focusedSectionId, selectedId, onSelect, onSelectSection, className, detail }: TextbookGraphExplorerProps) {
  const host = useRef<HTMLDivElement>(null); const canvas = useRef<HTMLDivElement>(null); const graph = useRef<Graph | null>(null);
  const [portalHost, setPortalHost] = useState<HTMLDivElement | null>(null);
  const mountHost = useCallback((node: HTMLDivElement | null) => { host.current = node; setPortalHost(node); }, []);
  const narrow = useSyncExternalStore(subscribeNarrow, getNarrow, getServerNarrow);
  const [completedView, setCompletedView] = useState<GraphView | null>(null);
  const [fullscreen, setFullscreen] = useState(false); const [error, setError] = useState("");
  const [focusId, setFocusId] = useState<string | null>(null); const [focusSection, setFocusSection] = useState<string | null>(null); const [direction, setDirection] = useState<ViewOptions["direction"]>("neighbors"); const [hops, setHops] = useState(1);
  const [page, setPage] = useState(0); const [textbook, setTextbook] = useState(true); const [inferred, setInferred] = useState(true); const [kind, setKind] = useState("all");
  const model = useMemo(() => createGraphModel(concepts, relations, sections), [concepts, relations, sections]);
  // External search selection opens its chapter. Selecting an already visible node only changes its state.
  const requestedFocus = focusSection === focusedSectionId ? focusId : null;
  const activeFocus = useMemo(() => resolveGraphFocus(model, {
    sectionId: focusedSectionId, focusId: requestedFocus, direction, hops, page, textbook, inferred, kind,
  }, selectedId), [model, focusedSectionId, requestedFocus, direction, hops, page, textbook, inferred, kind, selectedId]);
  // Commit the automatic exit so a later click on an old neighbor cannot resurrect stale focus.
  if (requestedFocus && !activeFocus) setFocusId(null);
  const sectionId = focusedSectionId === "all" && selectedId && !activeFocus ? model.conceptById.get(selectedId)?.sectionId || "unassigned" : focusedSectionId;
  const scopeIds = useMemo(() => graphFocusedSectionIds(model.sections, sectionId), [model, sectionId]);
  const selectedIndex = !activeFocus && selectedId ? model.concepts.filter(c => sectionId === "unassigned" ? model.rootOf(c.id) === "unassigned" : !scopeIds || scopeIds.has(c.sectionId || "")).findIndex(c => c.id === selectedId) : -1;
  const visiblePage = selectedIndex >= 0 ? Math.floor(selectedIndex / 200) : page;
  const view = useMemo(() => cachedGraphView(model, { sectionId, focusId: activeFocus, direction, hops, page: visiblePage, textbook, inferred, kind }), [model, sectionId, activeFocus, direction, hops, visiblePage, textbook, inferred, kind]);
  const callbacks = useRef({ onSelect, onSelectSection, selectedId });
  useEffect(() => { callbacks.current = { onSelect, onSelectSection, selectedId }; }, [onSelect, onSelectSection, selectedId]);
  const selection = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false; let instance: Graph | null = null; let observer: ResizeObserver | null = null;
    const container = canvas.current; if (!container) return;
    void import("@antv/g6").then(async ({ Graph: GraphClass }) => {
      if (cancelled) return;
      setError("");
      instance = new GraphClass({
        container, width: container.clientWidth, height: container.clientHeight || 600, animation: false, padding: [48, 56, 48, 56],
        data: {
          nodes: view.nodes.map(node => ({ id: node.id, data: { ...node }, style: { x: node.x, y: node.y, fill: chapterFill(model.colorOf(node.root)), stroke: model.colorOf(node.root), labelText: node.label } })),
          edges: view.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, style: { labelText: edge.count ? `${edge.count} 条关系汇总` : relationLabel(edge.kind), lineDash: edge.inferred ? [5, 4] : undefined } })),
        },
        node: { type: "rect", style: { size: view.overview ? [280, 86] : [224, 72], radius: 14, zIndex: 2, lineWidth: 1.3, labelPlacement: "center", labelFill: "#18334d", labelFontSize: 15, labelFontWeight: 550, labelWordWrap: true, labelMaxWidth: view.overview ? 256 : 204, labelMaxLines: 3, labelTextOverflow: "ellipsis" }, state: { selected: { lineWidth: 3, shadowColor: "#2563eb44", shadowBlur: 14 }, active: { lineWidth: 2.5 } } },
        edge: { type: "quadratic", style: { stroke: "#c7d5e6", lineWidth: 1.1, endArrow: true, zIndex: 1, labelOpacity: 0, labelFill: "#526680", labelFontSize: 13, labelBackground: true, labelBackgroundFill: "#ffffff", labelPadding: [3, 5] }, state: { active: { stroke: "#2563eb", lineWidth: 2, labelOpacity: 1 } } },
        behaviors: ["drag-canvas", "zoom-canvas", "drag-element", { type: "hover-activate", degree: 1 }],
      });
      graph.current = instance;
      instance.on("node:click", event => {
        const id = "target" in event && event.target && "id" in event.target ? String(event.target.id) : ""; const node = view.nodes.find(n => n.id === id);
        if (node?.kind === "section") { setFocusId(null); setPage(0); callbacks.current.onSelect(null); callbacks.current.onSelectSection(node.sectionId!); }
        else callbacks.current.onSelect(id);
      });
      await instance.render();
      if (cancelled) return;
      await instance.fitView({ when: "always" }, false);
      if (cancelled) return;
      const minimumZoom = view.overview ? .85 : .9;
      const fittedZoom = instance.getZoom();
      const initialZoom = Math.min(1, Math.max(minimumZoom, fittedZoom));
      if (initialZoom !== fittedZoom) { await instance.zoomTo(initialZoom, false); if (cancelled) return; }
      if (fittedZoom < minimumZoom) {
        if (view.nodes.length) {
          const topLeft = instance.getViewportByCanvas([
            Math.min(...view.nodes.map(node => node.x)) - (view.overview ? 140 : 112),
            Math.min(...view.nodes.map(node => node.y)) - (view.overview ? 43 : 36),
          ]);
          await instance.translateBy([48 - topLeft[0], 48 - topLeft[1]], false);
        }
      }
      if (cancelled) return;
      const selected = callbacks.current.selectedId;
      if (selected && view.nodes.some(n => n.id === selected)) { selection.current = selected; await instance.setElementState(selected, "selected", false); await instance.focusElement(selected, false); }
      if (cancelled) return;
      setCompletedView(view);
      observer = new ResizeObserver(() => { if (!cancelled && instance) instance.setSize(container.clientWidth, container.clientHeight); });
      observer.observe(container);
    }).catch(() => { if (!cancelled) setError("图谱加载失败，请切换章节或刷新后重试。"); });
    return () => { cancelled = true; observer?.disconnect(); if (graph.current === instance) graph.current = null; instance?.destroy(); selection.current = null; };
  }, [model, view]);

  useEffect(() => {
    const instance = graph.current; if (!instance) return;
    const states: Record<string, string[]> = {};
    if (selection.current && view.nodes.some(n => n.id === selection.current)) states[selection.current] = [];
    if (selectedId && view.nodes.some(n => n.id === selectedId)) states[selectedId] = ["selected"];
    selection.current = selectedId;
    void instance.setElementState(states, false).then(() => { if (graph.current === instance && selectedId && view.nodes.some(n => n.id === selectedId)) return instance.focusElement(selectedId, false); }).catch(() => {});
  }, [selectedId, view]);
  useEffect(() => { const changed = () => setFullscreen(document.fullscreenElement === host.current); document.addEventListener("fullscreenchange", changed); return () => document.removeEventListener("fullscreenchange", changed); }, []);

  const reset = () => { setFocusId(null); setPage(0); onSelect(null); onSelectSection("all"); };
  const selected = selectedId ? model.conceptById.get(selectedId) : null;
  const title = activeFocus && model.conceptById.has(activeFocus) ? `聚焦 · ${conceptName(model.conceptById.get(activeFocus)!)}` : view.overview ? "整书知识地图" : model.sectionById.get(sectionId)?.title || "未归类知识";
  return <div ref={mountHost} data-ready={completedView === view ? "true" : "false"} data-graph-ready={completedView === view ? "true" : "false"} data-visible-node-count={view.nodes.length} data-total-node-count={view.total} data-edge-count={view.edges.length} aria-busy={completedView !== view} className={[styles.explorer, className].filter(Boolean).join(" ")} data-fullscreen={fullscreen || undefined}>
    <div className={styles.main}>
      <header className={styles.header}><div><span className={styles.eyebrow}>KNOWLEDGE ATLAS</span><h2>{title}</h2><p>{view.overview ? "从章节出发，逐层探索知识之间的联系" : `${view.total} 个知识点 · 当前 ${view.nodes.length} 个 · ${view.edges.length} 条可见关系`}</p></div><button type="button" onClick={reset}>返回整书</button></header>
      <div className={styles.filters}>
        <label><input type="checkbox" checked={textbook} onChange={e => setTextbook(e.target.checked)} />教材关系</label>
        <label><input type="checkbox" checked={inferred} onChange={e => setInferred(e.target.checked)} />推断关系</label>
        <select aria-label="筛选关系类型" value={kind} onChange={e => setKind(e.target.value)}><option value="all">所有关系</option>{[...new Set(model.edges.map(e => e.kind))].map(k => <option key={k} value={k}>{relationLabel(k)}</option>)}</select>
        <button type="button" disabled={!selected} onClick={() => { setFocusId(selectedId); setFocusSection(focusedSectionId); setPage(0); }}>聚焦所选知识点</button>
        {activeFocus && <><select aria-label="探索方向" value={direction} onChange={e => { setDirection(e.target.value as ViewOptions["direction"]); setPage(0); }}><option value="neighbors">相邻知识</option><option value="upstream">上游先修</option><option value="downstream">下游应用与支持</option></select>{direction === "neighbors" && <select aria-label="关系跳数" value={hops} onChange={e => { setHops(Number(e.target.value)); setPage(0); }}><option value={1}>一跳关系</option><option value={2}>两跳关系</option></select>}<button type="button" onClick={() => { setFocusId(null); setPage(0); }}>返回章节</button></>}
      </div>
      <div className={styles.stage}>
        <div ref={canvas} className={styles.canvas} role="img" aria-label={`${title}，${view.nodes.length} 个可见节点，${view.edges.length} 条关系`} />
        {completedView !== view && !error && <div className={styles.loading} role="status">正在整理知识地图…</div>}
        {!view.nodes.length && <div className={styles.empty}>此范围还没有知识点，请选择其他章节。</div>}
        {error && <div role="alert" className={styles.error}>{error}</div>}
        <div className={styles.actions}>
          <button type="button" aria-label="放大图谱" onClick={() => { void graph.current?.zoomBy(1.2, false); }}><ZoomIn size={18} /></button>
          <button type="button" aria-label="缩小图谱" onClick={() => { void graph.current?.zoomBy(.8, false); }}><ZoomOut size={18} /></button>
          <button type="button" aria-label="适配当前范围" onClick={() => { void graph.current?.fitView({ when: "always" }, false); }}><Focus size={18} /></button>
          <button type="button" aria-label={fullscreen ? "退出全屏图谱" : "全屏查看图谱"} onClick={() => { void (fullscreen ? document.exitFullscreen() : host.current?.requestFullscreen())?.catch(() => setError("浏览器未允许全屏，可继续在当前页面浏览。")); }}>{fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>
        </div>
      </div>
      <footer className={styles.footer}>
        <div className={styles.legend}>{[...new Set(view.nodes.map(n => n.root))].map(root => <span key={root} title={model.sectionById.get(root)?.title || "未归类"}><i style={{ background: model.colorOf(root) }} />{model.sectionById.get(root)?.title || "未归类"}</span>)}</div>
        {view.pages > 1 && <div className={styles.pagination}><button type="button" disabled={view.page === 0} onClick={() => { onSelect(null); setPage(view.page - 1); }}>上一组</button><span>{view.page + 1} / {view.pages} · 共 {view.total} 个知识点</span><button type="button" disabled={view.page + 1 === view.pages} onClick={() => { onSelect(null); setPage(view.page + 1); }}>更多知识点</button></div>}
        {activeFocus && direction === "downstream" && <p>沿实际先修、应用和支持关系向后追踪，不根据章节顺序推断。</p>}
        {view.overview && <p>连线汇总章节之间的真实关系数量，不代表章节的先修或包含关系。悬停章节查看相邻汇总。</p>}
        {!view.overview && <p>关系按层级排列；长链折行后继续沿箭头阅读。</p>}
        <p>拖动平移 · 滚轮缩放 · 点击节点查看详情 · 实线为教材关系，虚线为推断 · 箭头表示关系方向</p>
        <details className={styles.accessible}><summary>以列表浏览当前节点</summary><div>{view.nodes.map(node => <button key={node.id} type="button" onClick={() => { if (node.kind === "section") { setFocusId(null); setPage(0); onSelect(null); onSelectSection(node.sectionId!); } else onSelect(node.id); }}>{node.label}</button>)}</div></details>
      </footer>
    </div>
    {detail && !narrow && <aside className={styles.detail}>{detail}</aside>}
    {narrow && <DialogPrimitive.Root open={Boolean(detail)} onOpenChange={open => { if (!open) onSelect(null); }}>
      <DialogPrimitive.Portal container={portalHost}>
        <DialogPrimitive.Overlay className={styles.drawerOverlay} />
        <DialogPrimitive.Content className={styles.drawer} aria-describedby={undefined} onCloseAutoFocus={event => { event.preventDefault(); host.current?.querySelector<HTMLButtonElement>("button")?.focus(); }}>
          <DialogPrimitive.Title className={styles.drawerTitle}>知识点详情</DialogPrimitive.Title>
          <DialogPrimitive.Close className={styles.drawerClose} aria-label="关闭知识点详情">关闭</DialogPrimitive.Close>
          {detail}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>}
  </div>;
}
