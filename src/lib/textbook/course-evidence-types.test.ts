import { describe, expect, it } from "vitest";
import { formatCourseEvidenceContext, type CourseEvidenceSnapshot } from "./course-evidence-types";

describe("knowledge structure evidence context", () => {
  it("lists shared textbook evidence once while preserving each source mapping", () => {
    const snapshot = {
      retrievalMode: "hybrid",
      items: [{
        id: "evidence-1", kind: "concept", title: "教材概念", content: "唯一教材原文",
        source: { textbookId: "book", textbookTitle: "教材", revisionId: "revision", revisionVersion: 1, sectionPath: ["第一章"] },
      }],
      mappings: ["source-1", "source-2"].map((sourceKnowledgePointId) => ({
        sourceKnowledgePointId,
        sourceKnowledgePointName: sourceKnowledgePointId,
        status: "direct" as const,
        evidenceItemIds: ["evidence-1"],
        rationale: "教材明确支持",
      })),
    } as CourseEvidenceSnapshot;

    const compact = formatCourseEvidenceContext(snapshot, { deduplicateItems: true });
    expect(compact.split("唯一教材原文")).toHaveLength(2);
    expect(compact).toContain('"sourceKnowledgePointId":"source-1"');
    expect(compact).toContain('"sourceKnowledgePointId":"source-2"');
    expect(compact).toContain('"id":"evidence-1"');
    expect(compact.length).toBeLessThan(formatCourseEvidenceContext(snapshot).length);
  });
});
