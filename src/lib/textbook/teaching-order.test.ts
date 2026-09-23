import { describe, expect, it } from "vitest";
import { textbookTeachingBaseline } from "./teaching-order";
import type { CourseEvidenceSnapshot } from "./course-evidence-types";

const snapshot: CourseEvidenceSnapshot = {
  schemaVersion: 2, version: 1, fingerprint: "f", createdAt: "2026-01-01T00:00:00.000Z",
  retrievalMode: "hybrid", warnings: [], mappings: [],
  selections: [
    { revisionId: "primary", primary: true, sectionIds: [] },
    { revisionId: "supplement", primary: false, sectionIds: [] },
  ],
  items: [
    { id: "later", kind: "concept", title: "应用", content: "应用解释", retrievalScore: 0.99,
      source: { textbookId: "book", textbookTitle: "主教材", revisionId: "primary", revisionVersion: 1,
        sectionPath: ["第一章"], sectionPosition: 1, sourceBlockPosition: 28, quoteStart: 5 } },
    { id: "earlier", kind: "concept", title: "基础", content: "基础解释", retrievalScore: 0.01,
      source: { textbookId: "book", textbookTitle: "主教材", revisionId: "primary", revisionVersion: 1,
        sectionPath: ["第一章"], sectionPosition: 1, sourceBlockPosition: 9, quoteStart: 2 } },
    { id: "other-book", kind: "concept", title: "应用", content: "辅助教材先讲应用",
      source: { textbookId: "other", textbookTitle: "辅助教材", revisionId: "supplement", revisionVersion: 1,
        sectionPath: ["导言"], sectionPosition: 0, sourceBlockPosition: 0 } },
  ],
};

describe("textbook teaching baseline", () => {
  it("uses the primary textbook's earliest substantive position, independent of retrieval rank", () => {
    const result = textbookTeachingBaseline([
      { id: "application", evidenceItemIds: ["other-book", "later"] },
      { id: "foundation", evidenceItemIds: ["earlier"] },
      { id: "unlocated", evidenceItemIds: ["other-book"] },
    ], snapshot);
    expect(result.baselineKnowledgePointIds).toEqual(["foundation", "application", "unlocated"]);
    expect(result.anchors.find((anchor) => anchor.knowledgePointId === "application"))
      .toMatchObject({ evidenceItemId: "later", sourceBlockPosition: 28, status: "primary-textbook" });
    expect(result.anchors.find((anchor) => anchor.knowledgePointId === "unlocated")?.status).toBe("unlocated");
  });

  it("recovers an exact concept citation when old lesson data lacks evidence ids", () => {
    const result = textbookTeachingBaseline([
      { id: "foundation", name: "基础", evidenceItemIds: [] },
      { id: "application", name: "应用", evidenceItemIds: ["other-book"] },
    ], snapshot);
    expect(result.baselineKnowledgePointIds).toEqual(["foundation", "application"]);
    expect(result.anchors.map((anchor) => anchor.evidenceItemId)).toEqual(["earlier", "later"]);
  });

  it("does not treat an illustrative example as the first explanation of a concept", () => {
    const withExample: CourseEvidenceSnapshot = { ...snapshot, items: [
      { id: "early-example", kind: "example", title: "引入故事", content: "教材先给一个故事",
        source: { ...snapshot.items[0]!.source, sourceBlockPosition: 1 } },
      ...snapshot.items,
    ] };
    const result = textbookTeachingBaseline([
      { id: "application", evidenceItemIds: ["early-example", "later"] },
      { id: "foundation", evidenceItemIds: ["earlier"] },
    ], withExample);
    expect(result.baselineKnowledgePointIds).toEqual(["foundation", "application"]);
    expect(result.anchors[0]?.evidenceItemId).toBe("later");
  });
});
