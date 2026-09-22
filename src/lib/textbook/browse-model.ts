import type { TextbookConcept, TextbookDetailPayload, TextbookSection } from "@/app/teacher/textbooks/textbook-view-types";

export type ChapterTreeNode = { section: TextbookSection; children: ChapterTreeNode[] };
export type BrowseState = { view: "read" | "graph"; sectionId: string; conceptId: string | null; blockId: string | null };
const overview = (): BrowseState => ({ view: "read", sectionId: "all", conceptId: null, blockId: null });

/** Every section survives, including orphaned sections and malformed parent cycles. */
export function buildChapterTree(sections: TextbookSection[]): ChapterTreeNode[] {
  const ordered = [...sections].sort((a, b) => (a.position ?? a.order ?? 0) - (b.position ?? b.order ?? 0));
  const nodes = new Map(ordered.map((section) => [section.id, { section, children: [] } as ChapterTreeNode]));
  const roots: ChapterTreeNode[] = [];
  const attachedParent = new Map<string, string>();
  for (const section of ordered) {
    const node = nodes.get(section.id)!;
    const parent = section.parentId ? nodes.get(section.parentId) : undefined;
    let ancestor = parent?.section.id;
    const seen = new Set<string>([section.id]);
    let cycle = false;
    while (ancestor) {
      if (seen.has(ancestor)) { cycle = true; break; }
      seen.add(ancestor);
      ancestor = attachedParent.get(ancestor);
    }
    if (parent && !cycle) {
      parent.children.push(node);
      attachedParent.set(section.id, parent.section.id);
    } else roots.push(node);
  }
  return roots;
}

export function chapterPath(sections: TextbookSection[], id: string): TextbookSection[] {
  const index = new Map(sections.map((section) => [section.id, section]));
  const result: TextbookSection[] = [];
  const seen = new Set<string>();
  let section = index.get(id);
  while (section && !seen.has(section.id)) {
    seen.add(section.id);
    result.unshift(section);
    section = section.parentId ? index.get(section.parentId) : undefined;
  }
  return result;
}

export function conceptLabel(concept: TextbookConcept): string {
  return concept.name?.trim() || concept.title?.trim() || "未命名知识点";
}

export function normalizeBrowseState(input: Partial<BrowseState> | null | undefined, payload: TextbookDetailPayload): BrowseState {
  const state: BrowseState = { view: input?.view === "graph" ? "graph" : "read", sectionId: input?.sectionId || "all", conceptId: input?.conceptId || null, blockId: input?.blockId || null };
  const sections = new Set((payload.sections ?? []).map((section) => section.id));
  if (state.sectionId !== "all" && state.sectionId !== "unassigned" && !sections.has(state.sectionId)) return overview();
  if (state.conceptId && !payload.concepts?.some((concept) => concept.id === state.conceptId)) return overview();
  if (state.blockId) {
    const block = payload.sourceBlocks?.find((candidate) => candidate.id === state.blockId);
    if (!block) return overview();
    state.view = "read";
    state.sectionId = block.sectionId && sections.has(block.sectionId) ? block.sectionId : "unassigned";
  }
  return state;
}

export function parseBrowseState(search: string): BrowseState {
  const params = new URLSearchParams(search);
  return { view: params.get("view") === "graph" ? "graph" : "read", sectionId: params.get("section") || "all", conceptId: params.get("concept") || null, blockId: params.get("block") || null };
}

/** Returns a query string (including ?), ready to append to the textbook URL. */
export function browseSearch(state: BrowseState): string {
  const params = new URLSearchParams({ view: state.view, section: state.sectionId });
  if (state.conceptId) params.set("concept", state.conceptId);
  if (state.blockId) params.set("block", state.blockId);
  return `?${params.toString()}`;
}

export function browseStorageKey(userId: string, bookId: string, revisionId: string): string {
  return `textbook-browse:v1:${[userId, bookId, revisionId].map(encodeURIComponent).join(":")}`;
}
