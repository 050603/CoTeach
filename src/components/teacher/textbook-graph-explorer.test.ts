import { describe, expect, it } from "vitest";
import { buildGraphView, createGraphModel } from "@/lib/textbook/graph-model";

describe("textbook graph view stability", () => {
  it("returns deterministic positions, retains labels and discloses pagination", () => {
    const concepts = Array.from({ length: 205 }, (_, i) => ({ id: String(i), name: `长中文知识点名称 ${i}`, sectionId: "chapter" }));
    const model = createGraphModel(concepts, [], [{ id: "chapter", title: "完整章节标题" }]);
    const first = buildGraphView(model, { sectionId: "chapter" });
    expect(buildGraphView(model, { sectionId: "chapter" })).toEqual(first);
    expect(first.nodes[0].label).toBe(concepts[0].name);
    expect(first.total).toBe(205);
    expect(first.pages).toBe(2);
    expect(buildGraphView(model, { sectionId: "chapter", page: 1 }).nodes).toHaveLength(5);
  });
});
