import { describe, expect, it } from "vitest";
import { graphFocusedSectionIds, graphLevelColor, graphRelationEnds, graphStructuralSectionIds } from "./textbook-graph-explorer";

describe("textbook graph relation direction", () => {
  it("keeps forward teaching relations and reverses inverse semantic relations", () => {
    expect(graphRelationEnds({ sourceConceptId: "parent", targetConceptId: "child", relationType: "PARENT_OF" }))
      .toEqual({ source: "parent", target: "child" });
    expect(graphRelationEnds({ sourceConceptId: "first", targetConceptId: "next", relationType: "PRECEDES" }))
      .toEqual({ source: "first", target: "next" });
    expect(graphRelationEnds({ sourceConceptId: "part", targetConceptId: "whole", relationType: "PART_OF" }))
      .toEqual({ source: "whole", target: "part" });
    expect(graphRelationEnds({ sourceConceptId: "lesson", targetConceptId: "prerequisite", relationType: "REQUIRES" }))
      .toEqual({ source: "prerequisite", target: "lesson" });
  });
});

describe("textbook graph section focus", () => {
  it("includes every descendant when focusing a deep navigation branch", () => {
    const sections = [
      { id: "chapter", title: "第一章" },
      { id: "section", parentId: "chapter", title: "第一节" },
      { id: "subsection", parentId: "section", title: "知识点" },
    ];

    expect(graphFocusedSectionIds(sections, "section"))
      .toEqual(new Set(["section", "subsection"]));
    expect(graphFocusedSectionIds(sections, "subsection"))
      .toEqual(new Set(["subsection"]));
    expect(graphFocusedSectionIds(sections, "all")).toBeNull();
  });
});

describe("textbook graph hierarchy colors", () => {
  it("uses stable colors for levels rather than chapter groups", () => {
    expect(graphLevelColor(2)).toBe(graphLevelColor(2));
    expect(graphLevelColor(2)).not.toBe(graphLevelColor(3));
    expect(graphLevelColor(null)).not.toBe(graphLevelColor(0));
  });
});

describe("textbook graph structural nodes", () => {
  it("adds chapter and topic nodes while reusing same-name concept nodes", () => {
    const sections = [
      { id: "01", title: "前置内容", level: 0 },
      { id: "02", title: "人工智能教育", level: 0 },
      { id: "02.1", parentId: "02", title: "教学理论基础", level: 1 },
      { id: "02.1.1", parentId: "02.1", title: "建构主义学习理论", level: 2 },
    ];
    const concepts = [{ id: "constructivism", sectionId: "02.1.1", name: "建构主义学习理论" }];

    expect(graphStructuralSectionIds(sections, concepts))
      .toEqual(new Set(["01", "02", "02.1"]));
  });
});
