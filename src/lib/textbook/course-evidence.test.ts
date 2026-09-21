// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revisions: vi.fn(), retrievalItems: vi.fn(), figures: vi.fn(), search: vi.fn(), transaction: vi.fn(),
}));

vi.mock("@/lib/textbook/service", () => ({ searchTextbookEvidence: mocks.search }));
vi.mock("@/lib/db/client", () => ({ prisma: {
  textbookRevision: { findMany: mocks.revisions },
  textbookRetrievalItem: { findMany: mocks.retrievalItems },
  textbookFigure: { findMany: mocks.figures },
  $transaction: mocks.transaction,
} }));

import { resolveCourseEvidenceSnapshot, resolveCourseTextbookFigures } from "./course-evidence";

describe("course textbook evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.revisions.mockResolvedValue([{
      id: "revision-1", revision: 3, status: "WAITING_EMBEDDING", textbookId: "book-1",
      textbook: { id: "book-1", title: "人工智能教学", status: "ACTIVE" },
      sections: [{ id: "section-1", title: "具身认知", path: "第三章/具身认知", kind: "SECTION" }],
    }]);
    mocks.search.mockResolvedValue({
      query: "具身认知", degraded: true, degradationReason: "尚未配置向量模型",
      hits: [{ retrievalItemId: "retrieval-1", revisionId: "revision-1", sectionId: "section-1",
        sourceBlockId: "block-1", conceptId: "concept-1", exampleId: null, kind: "CONCEPT",
        title: "具身认知", content: "认知形成于身体与环境的互动。", score: 0.03, lexicalRank: 1, semanticRank: null }],
    });
    mocks.retrievalItems.mockResolvedValue([{
      id: "retrieval-1", revisionId: "revision-1", sectionId: "section-1", kind: "CONCEPT",
      title: "具身认知", content: "认知形成于身体与环境的互动。",
      revision: { revision: 3, textbookId: "book-1", textbook: { title: "人工智能教学" } },
      section: { id: "section-1", title: "具身认知", path: "第三章/具身认知", figures: [{ id: "figure-1" }] },
      sourceBlock: { id: "block-1", content: "教材原文：认知形成于身体与环境的互动。", figures: [] },
      concept: { aliases: ["具身学习"], evidence: [], figures: [] }, example: null,
    }]);
    const tx = {
      $executeRaw: vi.fn(), classroomTemplate: { findUnique: vi.fn().mockResolvedValue({ id: "course-1" }) },
      courseTextbookBinding: { updateMany: vi.fn(), upsert: vi.fn().mockResolvedValue({ id: "binding-1" }), findMany: vi.fn().mockResolvedValue([{ id: "binding-1" }]) },
      courseTextbookSection: { deleteMany: vi.fn(), createMany: vi.fn() },
      courseEvidenceSnapshot: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(null), updateMany: vi.fn(), create: vi.fn().mockResolvedValue({ id: "snapshot-1" }) },
      courseEvidenceSnapshotBinding: { createMany: vi.fn() },
    };
    mocks.transaction.mockImplementation(async (work: (value: typeof tx) => unknown) => work(tx));
  });

  it("freezes traceable lexical evidence without claiming semantic retrieval succeeded", async () => {
    const snapshot = await resolveCourseEvidenceSnapshot({
      courseId: "course-1",
      selections: [{ revisionId: "revision-1", primary: true, sectionIds: ["section-1"] }],
      upstreamKnowledgePoints: [{ id: "kp-1", name: "具身认知", description: "解释身体与环境的作用" }],
    });
    expect(snapshot.retrievalMode).toBe("lexical-degraded");
    expect(snapshot.mappings[0]).toMatchObject({ status: "direct", evidenceItemIds: ["retrieval-1"] });
    expect(snapshot.items[0]).toMatchObject({ figureIds: ["figure-1"], source: {
      textbookTitle: "人工智能教学", revisionVersion: 3, sourceBlockId: "block-1",
    } });
    expect(snapshot.warnings.join(" ")).toContain("语义检索暂不可用");
  });

  it("turns only adopted evidence figures into protected course image references", async () => {
    mocks.figures.mockResolvedValue([{
      id: "figure-1", fileAssetId: "asset-1", position: 2, caption: "具身认知关系图", width: 800, height: 600,
      fileAsset: { id: "asset-1", mimeType: "image/png" }, revision: { textbook: { title: "人工智能教学" } }, section: { title: "具身认知" },
    }]);
    const figures = await resolveCourseTextbookFigures({
      schemaVersion: 1, version: 1, fingerprint: "f", createdAt: new Date(0).toISOString(), retrievalMode: "hybrid",
      selections: [], mappings: [], warnings: [], items: [{
        id: "e", kind: "concept", title: "具身认知", content: "解释", figureIds: ["figure-1"],
        source: { textbookId: "book-1", textbookTitle: "人工智能教学", revisionId: "revision-1", revisionVersion: 3, sectionPath: ["第三章"] },
      }],
    });
    expect(figures).toEqual([expect.objectContaining({ id: "img_1", figureId: "figure-1", assetId: "asset-1", src: "/api/uploads/asset-1" })]);
  });
});
