import { describe, expect, it } from "vitest";
import { buildGraphView, cachedGraphView, createGraphModel, graphFocusedSectionIds, graphRelationEnds, layeredPositions, resolveGraphFocus } from "./graph-model";

const sections = [{ id: "a", title: "第一章", position: 0 }, { id: "aa", parentId: "a", title: "同名", position: 1 }, { id: "b", title: "第二章", position: 2 }];
const concepts = [{ id: "1", name: "同名", sectionId: "aa" }, { id: "2", name: "后续", sectionId: "b" }, { id: "3", name: "孤立", sectionId: "a" }];
describe("textbook atlas model", () => {
  it("caches repeated view layouts per immutable model", () => {
    const model = createGraphModel(concepts, [], sections);
    const first = cachedGraphView(model, { sectionId: "a" });
    cachedGraphView(model, { sectionId: "b" });
    expect(cachedGraphView(model, { sectionId: "a" })).toBe(first);
  });
  it("preserves full section hierarchy and root chapter colors despite matching concept names", () => {
    const model = createGraphModel(concepts, [], sections);
    expect(model.sections).toHaveLength(3);
    expect(graphFocusedSectionIds(sections, "a")).toEqual(new Set(["a", "aa"]));
    expect(model.rootOf("1")).toBe("a");
    expect(model.colorOf(model.rootOf("1"))).toBe(model.colorOf(model.rootOf("3")));
    expect(buildGraphView(model, { sectionId: "a" }).nodes.map(n => n.id)).toEqual(["1", "3"]);
  });
  it("normalizes inverse relations and ignores invalid endpoints without inventing semantic edges", () => {
    expect(graphRelationEnds({ sourceId: "1", targetId: "2", type: "REQUIRES" })).toEqual({ source: "2", target: "1" });
    expect(graphRelationEnds({ sourceId: "1", targetId: "2", type: "PART_OF" })).toEqual({ source: "2", target: "1" });
    const model = createGraphModel(concepts, [{ sourceId: "missing", targetId: "2" }], sections);
    expect(model.edges).toEqual([]);
    expect(buildGraphView(model, { sectionId: "all" }).nodes).toHaveLength(2);
  });
  it("aggregates actual cross-chapter relations and respects source filters", () => {
    const model = createGraphModel(concepts, [{ sourceId: "1", targetId: "2" }, { sourceId: "1", targetId: "2", inferred: true }, { sourceId: "1", targetId: "3" }], sections);
    expect(buildGraphView(model, { sectionId: "all" }).edges[0].count).toBe(2);
    expect(buildGraphView(model, { sectionId: "all", inferred: false }).edges[0].count).toBe(1);
    expect(buildGraphView(model, { sectionId: "all", textbook: false, inferred: false }).edges).toEqual([]);
  });
  it("terminates cycles and traverses only prerequisite relations upstream", () => {
    const model = createGraphModel(concepts, [{ sourceId: "1", targetId: "2", type: "requires" }, { sourceId: "2", targetId: "1", type: "requires" }, { sourceId: "3", targetId: "1", type: "related" }], sections);
    const view = buildGraphView(model, { sectionId: "a", focusId: "1", direction: "upstream" });
    expect(view.nodes.map(n => n.id)).toEqual(["1", "2"]);
    expect(buildGraphView(model, { sectionId: "a", focusId: "1", hops: 1 }).nodes).toHaveLength(3);
    const cyclic = createGraphModel([], [], [{ id: "x", title: "X", parentId: "y" }, { id: "y", title: "Y", parentId: "x" }]);
    expect(cyclic.roots).toHaveLength(1);
  });
  it("follows downstream application, support and prerequisite edges but excludes unrelated and inverse links", () => {
    const model = createGraphModel([...concepts, { id: "4", name: "应用", sectionId: "b" }, { id: "5", name: "无关", sectionId: "a" }], [
      { sourceId: "1", targetId: "2", type: "prerequisite" },
      { sourceId: "2", targetId: "3", type: "supports" },
      { sourceId: "3", targetId: "4", type: "application" },
      { sourceId: "4", targetId: "1", type: "supports" },
      { sourceId: "1", targetId: "5", type: "related" },
    ], sections);
    const view = buildGraphView(model, { sectionId: "a", focusId: "1", direction: "downstream" });
    expect(view.nodes.map(n => n.id)).toEqual(["1", "2", "3", "4"]);
    expect(view.nodes.find(n => n.id === "2")?.label).toContain("第二章");
    expect(buildGraphView(model, { sectionId: "a", focusId: "4", direction: "upstream" }).nodes.map(n => n.id)).toEqual(["4"]);
  });
  it("ranks real dependencies, condenses cycles and packs isolated nodes without overlaps", () => {
    const edges = [{ id: "a", source: "1", target: "2", kind: "prerequisite", inferred: false }, { id: "b", source: "2", target: "3", kind: "prerequisite", inferred: false }, { id: "c", source: "3", target: "2", kind: "prerequisite", inferred: false }];
    const positions = layeredPositions(["1", "2", "3", "isolated"], edges);
    expect(positions.get("2")!.x).toBeGreaterThan(positions.get("1")!.x);
    expect(positions.get("3")!.x).toBeGreaterThan(positions.get("1")!.x);
    const isolated = layeredPositions(Array.from({ length: 200 }, (_, i) => String(i)), []);
    const coordinates = [...isolated.values()];
    expect(new Set(coordinates.map(p => `${p.x},${p.y}`)).size).toBe(200);
    expect(Math.max(...coordinates.map(p => p.y))).toBeLessThan(2500);
    expect(layeredPositions(["1", "2", "3", "isolated"], edges)).toEqual(positions);
  });
  it("folds a long dependency chain into compact alternating rows", () => {
    const ids = Array.from({ length: 84 }, (_, i) => String(i));
    const edges = ids.slice(1).map((id, i) => ({ id: `edge${i}`, source: String(i), target: id, kind: "prerequisite", inferred: false }));
    const positions = layeredPositions(ids, edges);
    expect(Math.max(...[...positions.values()].map(p => p.x))).toBeLessThan(1400);
    expect(positions.get("4")!.y).toBeGreaterThan(positions.get("3")!.y);
    expect(positions.get("5")!.x).toBeLessThan(positions.get("4")!.x);
    expect(new Set([...positions.values()].map(p => `${p.x},${p.y}`)).size).toBe(84);
  });
  it("reveals a same-chapter concept reached outside the active one-hop focus without relayout for visible selections", () => {
    const nodes = [{ id: "a", sectionId: "chapter", name: "A" }, { id: "b", sectionId: "chapter", name: "B" }, { id: "c", sectionId: "chapter", name: "C" }];
    const model = createGraphModel(nodes, [{ sourceId: "a", targetId: "b" }, { sourceId: "b", targetId: "c" }], [{ id: "chapter", title: "同一章节" }]);
    const options = { sectionId: "chapter", focusId: "a", hops: 1 };
    const originalView = cachedGraphView(model, options);
    expect(originalView.nodes.map(node => node.id)).toEqual(["a", "b"]);
    const visibleFocus = resolveGraphFocus(model, options, "b");
    expect(visibleFocus).toBe("a");
    expect(cachedGraphView(model, { ...options, focusId: visibleFocus! })).toBe(originalView);
    const hiddenFocus = resolveGraphFocus(model, options, "c");
    expect(hiddenFocus).toBeNull();
    expect(cachedGraphView(model, { ...options, focusId: hiddenFocus }).nodes.map(node => node.id)).toContain("c");
    expect(resolveGraphFocus(model, { ...options, focusId: "missing" }, "c")).toBeNull();
  });
  it.each([300, 1000, 3000])("keeps all %i concepts reachable in bounded pages including isolated ones", count => {
    const nodes = Array.from({ length: count }, (_, i) => ({ id: String(i), sectionId: "a", name: `概念 ${i}` }));
    const edges = Array.from({ length: count * 4 }, (_, i) => ({ sourceId: String(i % count), targetId: String((i + 1) % count) }));
    const model = createGraphModel(nodes, edges, sections);
    const overview = buildGraphView(model, { sectionId: "all" }); expect(overview.nodes.length).toBe(2);
    const all = new Set<string>();
    for (let page = 0; page < Math.ceil(count / 200); page++) { const view = buildGraphView(model, { sectionId: "a", page }); expect(view.nodes.length).toBeLessThanOrEqual(200); view.nodes.forEach(n => all.add(n.id)); }
    expect(all.size).toBe(count);
  });
});
