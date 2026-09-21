"use client";

import * as echarts from "echarts/core";
import { GraphChart, type GraphSeriesOption } from "echarts/charts";
import { TooltipComponent, type TooltipComponentOption } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { Focus, Maximize2, Minimize2, RotateCcw, Search, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ComposeOption, ECharts } from "echarts/core";
import type { TextbookConcept, TextbookRelation, TextbookSection } from "@/app/teacher/textbooks/textbook-view-types";
import styles from "./textbook-graph-explorer.module.css";

echarts.use([GraphChart, TooltipComponent, CanvasRenderer]);

type GraphOption = ComposeOption<GraphSeriesOption | TooltipComponentOption>;

const LEVEL_COLORS = [
  "#315f8d", "#4f7f9f", "#4f8b7d", "#8b744f", "#7a6f9f",
  "#9a6670", "#687f58", "#5e7f8a",
];
const UNASSIGNED_COLOR = "#8794a2";
const GRAPH_NODE_SIZE = 18;

function conceptName(concept: TextbookConcept) {
  return concept.name || concept.title || "未命名知识点";
}

function relationEnds(relation: TextbookRelation) {
  return {
    source: relation.sourceConceptId || relation.sourceId || "",
    target: relation.targetConceptId || relation.targetId || "",
  };
}

export function graphRelationEnds(relation: TextbookRelation) {
  const ends = relationEnds(relation);
  const kind = (relation.relationType || relation.type || "related").toLocaleLowerCase();
  if (kind === "part_of" || kind === "child_of" || kind === "requires") {
    return { source: ends.target, target: ends.source };
  }
  return ends;
}

function relationLabel(relation: TextbookRelation) {
  const value = (relation.relationType || relation.type || "related").toLocaleLowerCase();
  const labels: Record<string, string> = {
    prerequisite: "先修", requires: "先修", supports: "支持", application: "应用",
    applies: "应用", comparison: "对比", contrasts: "对比", contains: "包含",
    parent_of: "包含", part_of: "包含", child_of: "包含", precedes: "先于", related: "相关",
  };
  return labels[value] || relation.relationType || relation.type || "相关";
}

function relationIsInferred(relation: TextbookRelation) {
  return relation.inferred ?? (Boolean(relation.origin) && relation.origin !== "TEXTBOOK");
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character] || character);
}

function compactTitle(value: string, max = 18) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

type TextbookGraphExplorerProps = {
  concepts: TextbookConcept[];
  relations: TextbookRelation[];
  sections: TextbookSection[];
  focusedSectionId: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onSelectSection: (sectionId: string) => void;
};

type GraphData = {
  option: GraphOption;
  categories: Array<{ id: string; name: string; color: string; count: number; focused: boolean }>;
  indexById: Map<string, number>;
  nodeCount: number;
  relationCount: number;
};

type GraphEntity = {
  id: string;
  name: string;
  sectionId: string;
  level: number | null;
  nodeKind: "concept" | "section";
};

export function graphFocusedSectionIds(sections: TextbookSection[], focusedSectionId: string) {
  if (focusedSectionId === "all") return null;
  if (focusedSectionId === "unassigned") return new Set(["unassigned"]);
  const result = new Set([focusedSectionId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const section of sections) {
      if (section.parentId && result.has(section.parentId) && !result.has(section.id)) {
        result.add(section.id);
        changed = true;
      }
    }
  }
  return result;
}

export function graphLevelColor(sectionLevel: number | null) {
  if (sectionLevel == null) return UNASSIGNED_COLOR;
  const level = Math.max(0, Math.floor(sectionLevel));
  return LEVEL_COLORS[level % LEVEL_COLORS.length];
}

function normalizedKnowledgeLabel(value: string) {
  return value.trim().replace(/\s+/g, "").toLocaleLowerCase();
}

export function graphStructuralSectionIds(sections: TextbookSection[], concepts: TextbookConcept[]) {
  const conceptNamesBySection = new Map<string, Set<string>>();
  for (const concept of concepts) {
    if (!concept.sectionId) continue;
    const names = conceptNamesBySection.get(concept.sectionId) || new Set<string>();
    names.add(normalizedKnowledgeLabel(conceptName(concept)));
    conceptNamesBySection.set(concept.sectionId, names);
  }
  return new Set(sections
    .filter(section => !conceptNamesBySection.get(section.id)?.has(normalizedKnowledgeLabel(section.title)))
    .map(section => section.id));
}

function buildGraphData(
  concepts: TextbookConcept[],
  relations: TextbookRelation[],
  sections: TextbookSection[],
  focusedSectionId: string,
  selectedId: string | null,
): GraphData {
  const sectionById = new Map(sections.map(section => [section.id, section]));
  const focusedIds = graphFocusedSectionIds(sections, focusedSectionId);
  const sectionLevelCache = new Map<string, number>();
  const sectionLevel = (sectionId: string, visited = new Set<string>()): number => {
    const cached = sectionLevelCache.get(sectionId);
    if (cached != null) return cached;
    const section = sectionById.get(sectionId);
    if (!section || visited.has(sectionId)) return 0;
    const explicitLevel = Number(section.level);
    if (Number.isFinite(explicitLevel) && explicitLevel >= 0) {
      const level = Math.floor(explicitLevel);
      sectionLevelCache.set(sectionId, level);
      return level;
    }
    const level = section.parentId
      ? sectionLevel(section.parentId, new Set(visited).add(sectionId)) + 1
      : 0;
    sectionLevelCache.set(sectionId, level);
    return level;
  };
  const conceptsBySection = new Map<string, TextbookConcept[]>();
  for (const concept of concepts) {
    if (!concept.sectionId || !sectionById.has(concept.sectionId)) continue;
    conceptsBySection.set(concept.sectionId, [...(conceptsBySection.get(concept.sectionId) || []), concept]);
  }
  const representativeBySection = new Map<string, string>();
  const structuralSectionIds = graphStructuralSectionIds(sections, concepts);
  for (const section of sections) {
    const matchingConcept = (conceptsBySection.get(section.id) || [])
      .find(concept => normalizedKnowledgeLabel(conceptName(concept)) === normalizedKnowledgeLabel(section.title));
    representativeBySection.set(section.id, matchingConcept?.id || `section:${section.id}`);
  }
  const entities: GraphEntity[] = [
    ...concepts.map(concept => ({
      id: concept.id,
      name: conceptName(concept),
      sectionId: concept.sectionId && sectionById.has(concept.sectionId) ? concept.sectionId : "unassigned",
      level: concept.sectionId && sectionById.has(concept.sectionId) ? sectionLevel(concept.sectionId) : null,
      nodeKind: "concept" as const,
    })),
    ...sections.filter(section => structuralSectionIds.has(section.id)).map(section => ({
      id: `section:${section.id}`,
      name: section.title,
      sectionId: section.id,
      level: sectionLevel(section.id),
      nodeKind: "section" as const,
    })),
  ];
  const entityById = new Map(entities.map(entity => [entity.id, entity]));
  const conceptIds = new Set(concepts.map(concept => concept.id));
  const visibleRelations = relations.filter(relation => {
    const { source, target } = graphRelationEnds(relation);
    return source !== target && conceptIds.has(source) && conceptIds.has(target);
  });
  const linkPairs = new Set(visibleRelations.map(relation => {
    const ends = graphRelationEnds(relation);
    return `${ends.source}->${ends.target}`;
  }));
  const hierarchyRelations: Array<{ id: string; source: string; target: string }> = [];
  const addHierarchyRelation = (source: string | undefined, target: string | undefined, id: string) => {
    if (!source || !target || source === target || !entityById.has(source) || !entityById.has(target)) return;
    const pair = `${source}->${target}`;
    if (linkPairs.has(pair)) return;
    linkPairs.add(pair);
    hierarchyRelations.push({ id, source, target });
  };
  for (const section of sections) {
    const sectionRepresentative = representativeBySection.get(section.id);
    if (section.parentId) {
      addHierarchyRelation(representativeBySection.get(section.parentId), sectionRepresentative, `section-edge:${section.parentId}:${section.id}`);
    }
    for (const concept of conceptsBySection.get(section.id) || []) {
      if (concept.id !== sectionRepresentative) {
        addHierarchyRelation(sectionRepresentative, concept.id, `section-concept:${section.id}:${concept.id}`);
      }
    }
  }
  const degree = new Map(entities.map(entity => [entity.id, 0]));
  visibleRelations.forEach(relation => {
    const { source, target } = graphRelationEnds(relation);
    degree.set(source, (degree.get(source) || 0) + 1);
    degree.set(target, (degree.get(target) || 0) + 1);
  });
  hierarchyRelations.forEach(relation => {
    degree.set(relation.source, (degree.get(relation.source) || 0) + 1);
    degree.set(relation.target, (degree.get(relation.target) || 0) + 1);
  });

  const categoryKeys: string[] = [];
  entities.forEach(entity => {
    const key = entity.level == null ? "unassigned" : `level:${entity.level}`;
    if (!categoryKeys.includes(key)) categoryKeys.push(key);
  });
  categoryKeys.sort((left, right) => {
    if (left === "unassigned") return 1;
    if (right === "unassigned") return -1;
    return Number(left.slice("level:".length)) - Number(right.slice("level:".length));
  });
  const categoryIndex = new Map(categoryKeys.map((key, index) => [key, index]));
  const categories = categoryKeys.map(key => {
    const level = key === "unassigned" ? null : Number(key.slice("level:".length));
    return {
      id: key,
      name: level == null ? "未归类" : `第 ${level + 1} 层知识`,
      color: graphLevelColor(level),
      count: entities.filter(entity => (entity.level == null ? "unassigned" : `level:${entity.level}`) === key).length,
      focused: !focusedIds || entities.some(entity => (entity.level == null ? "unassigned" : `level:${entity.level}`) === key && focusedIds.has(entity.sectionId)),
    };
  });
  const labelLimit = entities.length <= 48 ? entities.length : Math.min(48, Math.max(26, Math.ceil(Math.sqrt(entities.length) * 3)));
  const labelledIds = new Set([
    ...entities.filter(entity => entity.nodeKind === "section").map(entity => entity.id),
    ...[...entities]
      .sort((left, right) => (degree.get(right.id) || 0) - (degree.get(left.id) || 0))
      .map(entity => entity.id),
  ].slice(0, labelLimit));
  const bucketOffsets = new Map<string, number>();
  const categoryCount = Math.max(1, categories.length);
  const orbit = Math.min(520, Math.max(230, 130 + categoryCount * 64));
  const indexById = new Map<string, number>();
  const data = entities.map((entity, index) => {
    indexById.set(entity.id, index);
    const key = entity.level == null ? "unassigned" : `level:${entity.level}`;
    const category = categoryIndex.get(key) || 0;
    const localIndex = bucketOffsets.get(key) || 0;
    bucketOffsets.set(key, localIndex + 1);
    const centerAngle = categoryCount === 1 ? 0 : Math.PI * 2 * category / categoryCount - Math.PI / 2;
    const localAngle = localIndex * 2.399963229728653;
    const localRadius = 48 + Math.sqrt(localIndex) * 52;
    const count = degree.get(entity.id) || 0;
    const focused = !focusedIds || focusedIds.has(entity.sectionId);
    return {
      id: entity.id,
      name: entity.name,
      nodeKind: entity.nodeKind,
      sectionId: entity.sectionId,
      value: count,
      category,
      x: Math.cos(centerAngle) * orbit + Math.cos(localAngle) * localRadius,
      y: Math.sin(centerAngle) * orbit * .68 + Math.sin(localAngle) * localRadius,
      symbol: "circle",
      symbolSize: [GRAPH_NODE_SIZE, GRAPH_NODE_SIZE],
      symbolKeepAspect: true,
      selected: entity.nodeKind === "concept" && entity.id === selectedId,
      draggable: true,
      label: { show: focused && labelledIds.has(entity.id) },
      itemStyle: {
        color: categories[category]?.color || LEVEL_COLORS[0],
        opacity: focused ? 1 : .16,
        borderColor: "rgba(255,255,255,.96)",
        borderWidth: 2,
        shadowBlur: focused ? 13 : 0,
        shadowColor: "rgba(35,54,74,.2)",
      },
    };
  });

  const nodeNameById = new Map(entities.map(entity => [entity.id, entity.name]));
  const focusedNodeIds = new Set(entities.filter(entity => !focusedIds || focusedIds.has(entity.sectionId)).map(entity => entity.id));

  const links = visibleRelations.map((relation, index) => {
    const { source, target } = graphRelationEnds(relation);
    const inFocus = focusedNodeIds.has(source) || focusedNodeIds.has(target);
    const inferred = relationIsInferred(relation);
    return {
      id: relation.id || `${source}-${target}-${index}`,
      source,
      target,
      sourceName: nodeNameById.get(source) || "未知知识点",
      targetName: nodeNameById.get(target) || "未知知识点",
      relationName: relationLabel(relation),
      inferred,
      lineStyle: {
        color: inferred ? "#a5805c" : "#718aa2",
        width: entities.length > 100 ? .75 : 1.15,
        opacity: inFocus ? (entities.length > 100 ? .28 : .48) : .055,
        type: inferred ? "dashed" as const : "solid" as const,
        curveness: .07,
      },
    };
  });
  const structuralLinks = hierarchyRelations.map(relation => {
    const inFocus = focusedNodeIds.has(relation.source) || focusedNodeIds.has(relation.target);
    return {
      ...relation,
      sourceName: nodeNameById.get(relation.source) || "知识层级",
      targetName: nodeNameById.get(relation.target) || "知识点",
      relationName: "包含",
      inferred: false,
      structural: true,
      lineStyle: {
        color: "#8ca0b3",
        width: 1,
        opacity: inFocus ? .42 : .055,
        type: "solid" as const,
        curveness: .04,
      },
    };
  });
  const graphLinks = [...links, ...structuralLinks];

  const option: GraphOption = {
    animationDurationUpdate: 420,
    animationEasingUpdate: "cubicOut",
    tooltip: {
      trigger: "item",
      enterable: false,
      confine: true,
      padding: 0,
      borderWidth: 0,
      backgroundColor: "transparent",
      extraCssText: "box-shadow:none",
      formatter: rawParams => {
        const params = Array.isArray(rawParams) ? rawParams[0] : rawParams;
        if (!params) return "";
        const raw = params.data as { name?: string; value?: number; nodeKind?: "concept" | "section"; relationName?: string; inferred?: boolean; structural?: boolean; sourceName?: string; targetName?: string } | undefined;
        if (!raw) return "";
        if (params.dataType === "edge") {
          return `<div class=\"${styles.chartTooltip}\"><small>${raw.structural ? "知识层级关系" : raw.inferred ? "AI 推断关系" : "教材关系"}</small><strong>${escapeHtml(raw.sourceName || "知识点")} <b>—${escapeHtml(raw.relationName || "相关")}→</b> ${escapeHtml(raw.targetName || "知识点")}</strong></div>`;
        }
        return `<div class=\"${styles.chartTooltip}\"><small>${raw.nodeKind === "section" ? "知识层级" : "知识点"} · ${raw.value || 0} 条关联</small><strong>${escapeHtml(raw.name || "未命名知识点")}</strong><span>${raw.nodeKind === "section" ? "点击聚焦这一知识分支" : "点击查看教材依据"}</span></div>`;
      },
    },
    series: [{
      type: "graph",
      layout: "force",
      left: 86,
      right: 86,
      top: 96,
      bottom: 96,
      data,
      links: graphLinks,
      categories: categories.map(category => ({ name: category.name, itemStyle: { color: category.color } })),
      roam: true,
      draggable: true,
      edgeSymbol: ["none", "arrow"],
      edgeSymbolSize: [0, 10],
      cursor: "pointer",
      selectedMode: "single",
      scaleLimit: { min: .24, max: 4.5 },
      force: {
        repulsion: entities.length > 120 ? 520 : entities.length > 50 ? 450 : 380,
        edgeLength: entities.length > 100 ? 148 : entities.length > 45 ? 138 : 128,
        gravity: entities.length > 100 ? .08 : .065,
        friction: .64,
        layoutAnimation: entities.length < 650,
      },
      lineStyle: { color: "source", opacity: .24, width: .8, curveness: .07 },
      label: {
        show: true,
        position: "right",
        distance: 8,
        formatter: params => compactTitle(String(params.name || ""), 18),
        color: "#3f5266",
        fontSize: 10,
        fontWeight: 650,
        textBorderColor: "rgba(255,255,255,.96)",
        textBorderWidth: 4,
      },
      labelLayout: { hideOverlap: true },
      edgeLabel: { show: false },
      emphasis: {
        focus: "adjacency",
        scale: 1.16,
        label: { show: true, color: "#1f3f5e", fontSize: 11, fontWeight: 750 },
        lineStyle: { width: 2, opacity: .86 },
        itemStyle: { borderColor: "#ffffff", borderWidth: 3, shadowBlur: 18, shadowColor: "rgba(35,76,112,.3)" },
      },
      blur: {
        itemStyle: { opacity: .32 },
        lineStyle: { opacity: .05 },
        label: { opacity: .38 },
      },
      select: {
        itemStyle: { borderColor: "#173f65", borderWidth: 3, shadowBlur: 18, shadowColor: "rgba(35,76,112,.36)" },
      },
    }],
  };

  return { option, categories, indexById, nodeCount: entities.length, relationCount: graphLinks.length };
}

function GraphSearch({ concepts, onLocate }: { concepts: TextbookConcept[]; onLocate: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    return concepts.filter(concept => conceptName(concept).toLocaleLowerCase().includes(normalized)).slice(0, 8);
  }, [concepts, query]);

  return <div className={styles.searchBox}>
    <Search aria-hidden="true" size={14} />
    <input aria-label="搜索知识点" value={query} onChange={event => setQuery(event.target.value)} placeholder={`搜索 ${concepts.length} 个知识点`} />
    {query ? <div className={styles.searchResults}>
      {results.length ? results.map(concept => <button key={concept.id} type="button" onClick={() => {
        onLocate(concept.id);
        setQuery("");
      }}>{conceptName(concept)}</button>) : <p>没有匹配的知识点</p>}
    </div> : null}
  </div>;
}

function GraphCanvas({ concepts, relations, sections, focusedSectionId, selectedId, onSelect, onSelectSection, fullscreen, onToggleFullscreen }: TextbookGraphExplorerProps & { fullscreen: boolean; onToggleFullscreen: () => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ECharts | null>(null);
  const graphData = useMemo(() => buildGraphData(concepts, relations, sections, focusedSectionId, selectedId), [concepts, focusedSectionId, relations, sections, selectedId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = echarts.init(host, undefined, { renderer: "canvas", devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2) });
    chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(host);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(graphData.option, { notMerge: true, lazyUpdate: false });
  }, [graphData.option]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.dispatchAction({ type: "downplay", seriesIndex: 0 });
    chart.dispatchAction({ type: "unselect", seriesIndex: 0 });
    const dataIndex = selectedId ? graphData.indexById.get(selectedId) : undefined;
    if (dataIndex == null) return;
    chart.dispatchAction({ type: "select", seriesIndex: 0, dataIndex });
    chart.dispatchAction({ type: "highlight", seriesIndex: 0, dataIndex });
  }, [graphData.indexById, selectedId]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const handler = (params: unknown) => {
      const event = params as { dataType?: string; data?: { id?: string; nodeKind?: "concept" | "section"; sectionId?: string } | null };
      if (event.dataType !== "node" || !event.data?.id) return;
      if (event.data.nodeKind === "section" && event.data.sectionId) {
        onSelectSection(event.data.sectionId);
        return;
      }
      onSelect(event.data.id);
    };
    chart.on("click", handler);
    return () => {
      chart.off("click", handler);
    };
  }, [onSelect, onSelectSection]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => chartRef.current?.resize());
    return () => window.cancelAnimationFrame(frame);
  }, [fullscreen]);

  const roam = useCallback((zoom: number) => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.dispatchAction({ type: "graphRoam", seriesIndex: 0, zoom, originX: chart.getWidth() / 2, originY: chart.getHeight() / 2 });
  }, []);

  const reset = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.clear();
    chart.setOption(graphData.option, { notMerge: true, lazyUpdate: false });
  }, [graphData.option]);

  const locate = useCallback((id: string) => {
    onSelect(id);
    const chart = chartRef.current;
    const dataIndex = graphData.indexById.get(id);
    if (!chart || dataIndex == null) return;
    chart.dispatchAction({ type: "downplay", seriesIndex: 0 });
    chart.dispatchAction({ type: "highlight", seriesIndex: 0, dataIndex });
  }, [graphData.indexById, onSelect]);

  return <>
    <div ref={hostRef} className={styles.canvas} role="img" aria-label={`教材知识图谱，共 ${graphData.nodeCount} 个节点、${graphData.relationCount} 条关系`} />
    <GraphSearch concepts={concepts} onLocate={locate} />
    <div className={styles.networkMeta} aria-hidden="true"><i /><span>知识关系网络</span><small>{graphData.nodeCount} 点 · {graphData.relationCount} 关系</small></div>
    <div className={styles.actions} aria-label="图谱视图控制">
      <button aria-label="放大图谱" title="放大" type="button" onClick={() => roam(1.22)}><ZoomIn size={16} /></button>
      <button aria-label="缩小图谱" title="缩小" type="button" onClick={() => roam(.82)}><ZoomOut size={16} /></button>
      <button aria-label="适配全部节点" title="适配全部节点" type="button" onClick={reset}><Focus size={16} /></button>
      <button aria-label="重新整理图谱" title="重新运行布局" type="button" onClick={reset}><RotateCcw size={15} /></button>
      <span aria-hidden="true" />
      <button aria-label={fullscreen ? "退出全屏图谱" : "全屏查看图谱"} title={fullscreen ? "退出全屏" : "全屏查看"} type="button" onClick={onToggleFullscreen}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
    </div>
    <div className={styles.legendPanel} aria-label="图谱图例">
      <div className={styles.categoryLegend} aria-label="知识层级颜色">
        {graphData.categories.slice(0, 5).map(category => <span data-focused={category.focused || undefined} key={category.id} title={category.name}><i style={{ backgroundColor: category.color }} /><em>{compactTitle(category.name, 9)}</em><small>{category.count}</small></span>)}
        {graphData.categories.length > 5 ? <b>+{graphData.categories.length - 5} 层</b> : null}
      </div>
      <div className={styles.relationLegend} aria-label="关系类型">
        <span><i />教材关系</span><span><i data-structure="true" />层级关系</span><span><i data-inferred="true" />推断关系</span><small>箭头表示知识方向</small>
      </div>
    </div>
    <div className={styles.gestureHint}>拖动画布浏览 · 滚轮缩放 · 节点可拖动 · 悬停查看邻接关系</div>
  </>;
}

export function TextbookGraphExplorer(props: TextbookGraphExplorerProps) {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!fullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", close);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", close);
    };
  }, [fullscreen]);

  if (!props.concepts.length) return <div className={styles.empty}>左侧目录当前已全部折叠，展开章节即可恢复对应知识节点。</div>;

  const explorer = <div className={styles.explorer} data-fullscreen={fullscreen || undefined}>
    <GraphCanvas {...props} fullscreen={fullscreen} onToggleFullscreen={() => setFullscreen(value => !value)} />
  </div>;
  return fullscreen && typeof document !== "undefined" ? createPortal(explorer, document.body) : explorer;
}
