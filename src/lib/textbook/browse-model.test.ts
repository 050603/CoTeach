import { describe, expect, it } from "vitest";
import type { TextbookDetailPayload, TextbookSection } from "@/app/teacher/textbooks/textbook-view-types";
import { browseSearch, browseStorageKey, buildChapterTree, chapterPath, conceptLabel, normalizeBrowseState, parseBrowseState, type ChapterTreeNode } from "./browse-model";

const sections: TextbookSection[] = [
  { id: "child", parentId: "root", title: "完整的第一节标题", position: 2 },
  { id: "root", title: "完整的第一章标题", position: 1 },
  { id: "last", title: "第二章", order: 3 },
];
const payload: TextbookDetailPayload = { textbook: { id: "book", title: "教材" }, sections, concepts: [{ id: "concept", sectionId: "child", name: "完整的第一节标题" }], sourceBlocks: [{ id: "block", sectionId: "child", content: "原文" }, { id: "front", content: "前言" }] };
function flatten(nodes: ChapterTreeNode[]): string[] { return nodes.flatMap((node) => [node.section.id, ...flatten(node.children)]); }

describe("textbook browsing", () => {
  it("preserves full section names, hierarchy, and stable textbook order", () => {
    const tree = buildChapterTree(sections);
    expect(flatten(tree)).toEqual(["root", "child", "last"]);
    expect(tree[0].children[0].section.title).toBe("完整的第一节标题");
    expect(sections[0].id).toBe("child");
    expect(chapterPath(sections, "child").map((s) => s.id)).toEqual(["root", "child"]);
  });
  it("retains orphans, self parents and cycles once without recursion loops", () => {
    const malformed = [{ id: "a", parentId: "b", title: "A" }, { id: "b", parentId: "a", title: "B" }, { id: "c", parentId: "c", title: "C" }, { id: "d", parentId: "missing", title: "D" }];
    expect(flatten(buildChapterTree(malformed)).sort()).toEqual(["a", "b", "c", "d"]);
    expect(chapterPath(malformed, "a")).toHaveLength(2);
    expect(chapterPath(malformed, "missing")).toEqual([]);
  });
  it("does not merge same-name concepts with sections", () => {
    expect(buildChapterTree(sections)[0].children).toHaveLength(1);
    expect(conceptLabel(payload.concepts![0])).toBe("完整的第一节标题");
    expect(conceptLabel({ id: "x", name: " ", title: "备用标题" })).toBe("备用标题");
  });
  it("round trips shareable graph selection including encoded ids", () => {
    const state = { view: "graph" as const, sectionId: "第一章 & 2", conceptId: "概念?", blockId: null };
    expect(parseBrowseState(browseSearch(state))).toEqual(state);
    expect(normalizeBrowseState(parseBrowseState("?view=graph&section=child&concept=concept"), payload)).toEqual({ view: "graph", sectionId: "child", conceptId: "concept", blockId: null });
  });
  it("locates evidence in the correct chapter or unassigned section", () => {
    expect(normalizeBrowseState({ view: "graph", blockId: "block" }, payload)).toEqual({ view: "read", sectionId: "child", conceptId: null, blockId: "block" });
    expect(normalizeBrowseState({ blockId: "front" }, payload).sectionId).toBe("unassigned");
    expect(normalizeBrowseState({ sectionId: "unassigned" }, payload).sectionId).toBe("unassigned");
  });
  it.each([{ sectionId: "deleted" }, { conceptId: "deleted" }, { blockId: "deleted" }])("resets stale references safely: %j", (input) => {
    expect(normalizeBrowseState({ view: "graph", ...input }, payload)).toEqual({ view: "read", sectionId: "all", conceptId: null, blockId: null });
  });
  it("isolates saved position by user, textbook, and revision", () => {
    expect(new Set([browseStorageKey("u", "b", "r"), browseStorageKey("v", "b", "r"), browseStorageKey("u", "c", "r"), browseStorageKey("u", "b", "s")]).size).toBe(4);
    expect(browseStorageKey("u:b", "c", "r")).not.toBe(browseStorageKey("u", "b:c", "r"));
  });
});
