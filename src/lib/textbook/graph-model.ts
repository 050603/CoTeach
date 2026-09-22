import type { TextbookConcept, TextbookRelation, TextbookSection } from "@/app/teacher/textbooks/textbook-view-types";

export const CHAPTER_COLORS = ["#2563eb", "#0d9488", "#d97706", "#8b5cf6", "#db2777", "#0284c7"];
export const conceptName = (concept: TextbookConcept) => concept.name || concept.title || "未命名知识点";
export function graphRelationEnds(relation: TextbookRelation) {
  const source = relation.sourceConceptId || relation.sourceId || "";
  const target = relation.targetConceptId || relation.targetId || "";
  return ["part_of", "child_of", "requires"].includes((relation.relationType || relation.type || "related").toLowerCase()) ? { source: target, target: source } : { source, target };
}
export function relationKind(relation: TextbookRelation) {
  const raw = (relation.relationType || relation.type || "related").toLowerCase();
  return ({ requires: "prerequisite", part_of: "contains", child_of: "contains", parent_of: "contains", applies: "application", contrasts: "comparison" } as Record<string, string>)[raw] || raw;
}
export function relationLabel(kind: string) {
  return ({ prerequisite: "先修", supports: "支持", application: "应用", comparison: "对比", contains: "包含", precedes: "先于", related: "相关" } as Record<string, string>)[kind] || kind;
}
export function graphFocusedSectionIds(sections: TextbookSection[], id: string) {
  if (id === "all") return null;
  const children = new Map<string, string[]>();
  for (const section of sections) if (section.parentId) children.set(section.parentId, [...(children.get(section.parentId) || []), section.id]);
  const result = new Set<string>();
  const queue = [id];
  for (let i = 0; i < queue.length; i++) { const current = queue[i]; if (result.has(current)) continue; result.add(current); queue.push(...(children.get(current) || [])); }
  return result;
}
export type ModelEdge = { id: string; source: string; target: string; kind: string; inferred: boolean };
export function createGraphModel(concepts: TextbookConcept[], relations: TextbookRelation[], sections: TextbookSection[]) {
  const ordered = [...sections].sort((a, b) => (a.position ?? a.order ?? 0) - (b.position ?? b.order ?? 0));
  const sectionById = new Map(ordered.map(s => [s.id, s]));
  const conceptById = new Map(concepts.map(c => [c.id, c]));
  const rootBySection = new Map<string, string>();
  for (const section of ordered) {
    let current = section; const seen = new Set<string>();
    while (current.parentId && sectionById.has(current.parentId) && !seen.has(current.id)) { seen.add(current.id); current = sectionById.get(current.parentId)!; }
    // Malformed cycles share one stable root and remain navigable.
    rootBySection.set(section.id, seen.has(current.id) ? [...seen].sort()[0] : current.id);
  }
  const roots = [...new Set(ordered.map(s => rootBySection.get(s.id)!))];
  const rootOf = (id: string) => rootBySection.get(conceptById.get(id)?.sectionId || "") || "unassigned";
  if (concepts.some(c => rootOf(c.id) === "unassigned")) roots.push("unassigned");
  const colorOf = (root: string) => root === "unassigned" ? "#64748b" : CHAPTER_COLORS[Math.max(0, roots.indexOf(root)) % CHAPTER_COLORS.length];
  const edges: ModelEdge[] = relations.flatMap((r, i) => { const ends = graphRelationEnds(r); return conceptById.has(ends.source) && conceptById.has(ends.target) ? [{ ...ends, id: `relation:${i}`, kind: relationKind(r), inferred: r.inferred ?? (!!r.origin && r.origin !== "TEXTBOOK") }] : []; });
  const adjacency = new Map(concepts.map(c => [c.id, [] as ModelEdge[]]));
  for (const edge of edges) { adjacency.get(edge.source)!.push(edge); if (edge.target !== edge.source) adjacency.get(edge.target)!.push(edge); }
  return { concepts, sections: ordered, conceptById, sectionById, roots, rootOf, colorOf, edges, adjacency };
}
export type GraphModel = ReturnType<typeof createGraphModel>;
export type ViewOptions = { sectionId: string; focusId?: string | null; direction?: "neighbors" | "upstream" | "downstream"; hops?: number; page?: number; textbook?: boolean; inferred?: boolean; kind?: string };
export type ViewNode = { id: string; label: string; root: string; kind: "section" | "concept"; sectionId?: string; x: number; y: number };
export type GraphView = { nodes: ViewNode[]; edges: (ModelEdge & { count?: number })[]; total: number; page: number; pages: number; overview: boolean };
export function buildGraphView(model: GraphModel, options: ViewOptions): GraphView {
  const filtered = model.edges.filter(e => (e.inferred ? options.inferred !== false : options.textbook !== false) && (!options.kind || options.kind === "all" || e.kind === options.kind));
  if (options.sectionId === "all" && !options.focusId) {
    const counts = new Map<string, number>(); for (const c of model.concepts) counts.set(model.rootOf(c.id), (counts.get(model.rootOf(c.id)) || 0) + 1);
    const nodes: ViewNode[] = model.roots.map((root, i) => ({ id: `section:${root}`, label: `${model.sectionById.get(root)?.title || "未归类"}\n${counts.get(root) || 0} 个知识点`, root, sectionId: root, kind: "section", x: (i % 3) * 350 + 180, y: Math.floor(i / 3) * 160 + 100 }));
    const aggregates = new Map<string, ModelEdge & { count: number }>();
    for (const edge of filtered) { const source = model.rootOf(edge.source), target = model.rootOf(edge.target); if (source === target) continue; const key = `${source}:${target}`; const old = aggregates.get(key); if (old) old.count++; else aggregates.set(key, { id: `summary:${key}`, source: `section:${source}`, target: `section:${target}`, kind: "汇总", inferred: false, count: 1 }); }
    return { nodes, edges: [...aggregates.values()], total: model.concepts.length, page: 0, pages: 1, overview: true };
  }
  let ids: string[];
  if (options.focusId && model.conceptById.has(options.focusId)) {
    const permitted = new Set(filtered.map(e => e.id)); const visited = new Set([options.focusId]); let frontier = [options.focusId];
    const depth = options.direction === "neighbors" || !options.direction ? options.hops || 1 : model.concepts.length;
    for (let step = 0; step < depth && frontier.length; step++) { const next: string[] = []; for (const id of frontier) for (const edge of model.adjacency.get(id) || []) {
      if (!permitted.has(edge.id)) continue;
      if (options.direction === "upstream" && (edge.kind !== "prerequisite" || edge.target !== id)) continue;
      if (options.direction === "downstream" && (!["prerequisite", "application", "supports"].includes(edge.kind) || edge.source !== id)) continue;
      const other = edge.source === id ? edge.target : edge.source; if (!visited.has(other)) { visited.add(other); next.push(other); }
    } frontier = next; }
    ids = [...visited];
  } else { const sectionIds = graphFocusedSectionIds(model.sections, options.sectionId); ids = model.concepts.filter(c => options.sectionId === "unassigned" ? model.rootOf(c.id) === "unassigned" : !sectionIds || sectionIds.has(c.sectionId || "")).map(c => c.id); }
  const pages = Math.max(1, Math.ceil(ids.length / 200)); const page = Math.min(Math.max(0, options.page || 0), pages - 1); const visible = ids.slice(page * 200, (page + 1) * 200); const visibleSet = new Set(visible);
  const edges = filtered.filter(e => visibleSet.has(e.source) && visibleSet.has(e.target));
  const positions = layeredPositions(visible, edges);
  const nodes: ViewNode[] = visible.map(id => {
    const concept = model.conceptById.get(id)!;
    const root = model.rootOf(id);
    const source = model.sectionById.get(concept.sectionId || "")?.title || "未归类";
    return { id, label: options.focusId ? `${conceptName(concept)}\n${source}` : conceptName(concept), root, kind: "concept", sectionId: concept.sectionId || undefined, ...positions.get(id)! };
  });
  return { nodes, edges, total: ids.length, page, pages, overview: false };
}

// Cache belongs to each immutable data model and is released with it. No G6 instances are cached.
const viewCaches = new WeakMap<GraphModel, Map<string, GraphView>>();
export function cachedGraphView(model: GraphModel, options: ViewOptions) {
  let cache = viewCaches.get(model);
  if (!cache) { cache = new Map(); viewCaches.set(model, cache); }
  const key = JSON.stringify(options); const cached = cache.get(key); if (cached) return cached;
  const result = buildGraphView(model, options);
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(key, result); return result;
}

/** Keep a focus layout stable for visible selections, but let external navigation reveal hidden concepts. */
export function resolveGraphFocus(model: GraphModel, options: ViewOptions, selectedId: string | null) {
  if (!options.focusId || !model.conceptById.has(options.focusId)) return null;
  const candidate = cachedGraphView(model, options);
  return !selectedId || candidate.nodes.some(node => node.id === selectedId) ? options.focusId : null;
}

/** Condense cycles before topological ranking; pack wide ranks so isolated nodes never form a 200-row column. */
export function layeredPositions(ids: string[], edges: ModelEdge[]) {
  const outgoing = new Map(ids.map(id => [id, [] as string[]]));
  for (const edge of edges) outgoing.get(edge.source)?.push(edge.target);
  let nextIndex = 0;
  const index = new Map<string, number>(); const low = new Map<string, number>();
  const stack: string[] = []; const onStack = new Set<string>(); const components: string[][] = [];
  function visit(id: string) {
    index.set(id, nextIndex); low.set(id, nextIndex++); stack.push(id); onStack.add(id);
    for (const target of outgoing.get(id) || []) {
      if (!index.has(target)) { visit(target); low.set(id, Math.min(low.get(id)!, low.get(target)!)); }
      else if (onStack.has(target)) low.set(id, Math.min(low.get(id)!, index.get(target)!));
    }
    if (low.get(id) !== index.get(id)) return;
    const component: string[] = []; let current: string;
    do { current = stack.pop()!; onStack.delete(current); component.push(current); } while (current !== id);
    components.push(component);
  }
  ids.forEach(id => { if (!index.has(id)) visit(id); });
  const componentOf = new Map<string, number>(); components.forEach((members, i) => members.forEach(id => componentOf.set(id, i)));
  const next = components.map(() => new Set<number>()); const incoming = components.map(() => 0); const ranks = components.map(() => 0);
  for (const edge of edges) { const source = componentOf.get(edge.source)!, target = componentOf.get(edge.target)!; if (source !== target && !next[source].has(target)) { next[source].add(target); incoming[target]++; } }
  const queue = components.flatMap((_, i) => incoming[i] === 0 ? [i] : []);
  for (let i = 0; i < queue.length; i++) for (const target of next[queue[i]]) { ranks[target] = Math.max(ranks[target], ranks[queue[i]] + 1); if (--incoming[target] === 0) queue.push(target); }
  const layers = new Map<number, string[]>();
  for (const id of ids) { const rank = ranks[componentOf.get(id)!]; const members = layers.get(rank) || []; members.push(id); layers.set(rank, members); }
  const positions = new Map<string, { x: number; y: number }>();
  const orderedLayers = [...layers.keys()].sort((a, b) => a - b).map(rank => {
    const members = layers.get(rank)!;
    return { members, columns: Math.max(1, Math.ceil(Math.sqrt(members.length / 2))) };
  });
  // Fold long dependency chains into four-rank bands. Alternating direction preserves
  // a continuous reading path while real relation arrows remain the source of truth.
  let top = 90;
  for (let start = 0, band = 0; start < orderedLayers.length; band++) {
    const group: typeof orderedLayers = []; let usedColumns = 0;
    while (start < orderedLayers.length && (!group.length || usedColumns + orderedLayers[start].columns <= 4)) {
      const layer = orderedLayers[start++]; group.push(layer); usedColumns += layer.columns;
    }
    const display = band % 2 ? [...group].reverse() : group;
    let left = 150;
    for (const layer of display) {
      layer.members.forEach((id, i) => positions.set(id, { x: left + (i % layer.columns) * 270, y: top + Math.floor(i / layer.columns) * 100 }));
      left += layer.columns * 270 + 60;
    }
    top += Math.max(...group.map(layer => Math.ceil(layer.members.length / layer.columns))) * 100 + 70;
  }
  return positions;
}
