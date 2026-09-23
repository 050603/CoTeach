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
import { bindRequiredTextbookFiguresToOutlines } from "./course-visual-binding";
import type { SceneOutline } from "@/lib/openmaic/types/generation";

describe("course textbook evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.revisions.mockResolvedValue([{
      id: "revision-1", revision: 3, status: "WAITING_EMBEDDING", textbookId: "book-1",
      textbook: { id: "book-1", title: "人工智能教学", status: "ACTIVE" },
      sections: [{ id: "section-1", title: "具身认知", path: "第三章/具身认知", kind: "SECTION", position: 7 }],
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
      section: { id: "section-1", title: "具身认知", path: "第三章/具身认知", position: 7, figures: [{ id: "figure-1" }] },
      sourceBlock: { id: "block-1", content: "教材原文：认知形成于身体与环境的互动。", position: 48, figures: [] },
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
    expect(snapshot.items[0]).toMatchObject({
      figureRefs: [{ figureId: "figure-1", relation: "section-candidate", direct: false }],
      figureIds: ["figure-1"], source: {
      textbookTitle: "人工智能教学", revisionVersion: 3, sourceBlockId: "block-1", sectionPosition: 7, sourceBlockPosition: 48,
      },
    });
    expect(snapshot.warnings.join(" ")).toContain("语义检索暂不可用");
  });

  it("retrieves a child concept together with its substantive parent context", async () => {
    await resolveCourseEvidenceSnapshot({
      courseId: "course-1",
      selections: [{ revisionId: "revision-1", primary: true, sectionIds: ["section-1"] }],
      upstreamKnowledgePoints: [
        { id: "theory", name: "建构主义学习理论", description: "学习者主动建构意义并调整认知结构。", teachingRole: "core-concept" },
        { id: "assimilation", name: "同化", description: "把新经验纳入已有图式。", groupName: "建构主义学习理论", parentKnowledgePointId: "theory", teachingRole: "detail-concept" },
      ],
    });

    expect(mocks.search).toHaveBeenCalledTimes(2);
    expect(mocks.search.mock.calls[1]?.[0].query).toContain("同化\n把新经验纳入已有图式。\n建构主义学习理论\n建构主义学习理论\n学习者主动建构意义并调整认知结构。");
  });

  it("turns only adopted evidence figures into protected course image references", async () => {
    mocks.figures.mockResolvedValue([{
      id: "figure-1", fileAssetId: "asset-1", position: 2, caption: "具身认知关系图", width: 800, height: 600, status: "AVAILABLE",
      fileAsset: { id: "asset-1", mimeType: "image/png", deletedAt: null }, revision: { textbook: { title: "人工智能教学" } }, section: { title: "具身认知" },
    }]);
    const figures = await resolveCourseTextbookFigures({
      schemaVersion: 2, version: 1, fingerprint: "f", createdAt: new Date(0).toISOString(), retrievalMode: "hybrid",
      selections: [], mappings: [{ sourceKnowledgePointId: "kp-1", sourceKnowledgePointName: "具身认知", status: "direct", evidenceItemIds: ["e"], rationale: "direct" }], warnings: [], items: [{
        id: "e", kind: "concept", title: "具身认知", content: "解释",
        figureRefs: [{ figureId: "figure-1", relation: "concept-direct", direct: true }], figureIds: ["figure-1"],
        source: { textbookId: "book-1", textbookTitle: "人工智能教学", revisionId: "revision-1", revisionVersion: 3, sectionPath: ["第三章"] },
      }],
    });
    expect(figures).toEqual([expect.objectContaining({
      id: expect.stringMatching(/^textbook_fig_/), figureId: "figure-1", assetId: "asset-1",
      src: "/api/uploads/asset-1", relation: "direct", required: true, status: "available",
      knowledgePointIds: ["kp-1"],
    })]);
  });

  it("binds a source-linked required figure to the first page of its mapped lesson node", async () => {
    mocks.figures.mockResolvedValue([{
      id: "figure-1", fileAssetId: "asset-1", position: 0, caption: "具身认知关系图", status: "AVAILABLE",
      fileAsset: { id: "asset-1", mimeType: "image/png", deletedAt: null },
      revision: { textbook: { title: "人工智能教学" } }, section: { title: "具身认知" },
    }]);
    const figures = await resolveCourseTextbookFigures({
      schemaVersion: 2, version: 1, fingerprint: "f", createdAt: new Date(0).toISOString(), retrievalMode: "hybrid",
      selections: [], warnings: [],
      mappings: [{ sourceKnowledgePointId: "source-embodied", sourceKnowledgePointName: "具身认知", status: "direct", evidenceItemIds: ["e"], rationale: "direct" }],
      items: [{ id: "e", kind: "concept", title: "具身认知", content: "教材说明",
        figureRefs: [{ figureId: "figure-1", relation: "concept-direct", direct: true }],
        source: { textbookId: "book-1", textbookTitle: "人工智能教学", revisionId: "revision-1", revisionVersion: 1, sectionPath: ["第三章"] },
      }],
    }, [{ id: "kp-4", sourceKnowledgePointIds: ["source-embodied"], evidenceItemIds: ["e"] }]);

    expect(figures[0]?.knowledgePointIds).toEqual(["kp-4"]);
    const pages: SceneOutline[] = [{
      id: "first-kp-4", type: "slide", title: "首次讲解", description: "讲解具身认知", keyPoints: ["概念"],
      order: 0, generationPurpose: "knowledge-teaching", knowledgePointIds: ["kp-4"],
    }];
    const outlines = bindRequiredTextbookFiguresToOutlines(pages, figures);
    expect(outlines[0]?.suggestedImageIds).toContain(figures[0]?.id);
    expect(outlines[0]?.visualIntent?.resourceRefs?.[0]).toMatchObject({ required: true, resourceId: figures[0]?.id });
  });

  it("keeps later figures available instead of truncating the course pool at 24", async () => {
    const refs = Array.from({ length: 26 }, (_, index) => ({
      figureId: `figure-${index + 1}`, relation: "section-candidate" as const, direct: false,
    }));
    mocks.figures.mockResolvedValue(refs.map((reference, index) => ({
      id: reference.figureId, fileAssetId: `asset-${index + 1}`, position: index,
      caption: `图 ${index + 1}`, width: 800, height: 600, status: "AVAILABLE",
      fileAsset: { id: `asset-${index + 1}`, mimeType: "image/png", deletedAt: null },
      revision: { textbook: { title: "人工智能教学" } }, section: { title: "章节" },
    })));
    const figures = await resolveCourseTextbookFigures({
      schemaVersion: 2, version: 1, fingerprint: "f", createdAt: new Date(0).toISOString(), retrievalMode: "hybrid",
      selections: [], mappings: [], warnings: [], items: [{
        id: "e", kind: "concept", title: "主题", content: "解释", figureRefs: refs,
        figureIds: refs.map((reference) => reference.figureId),
        source: { textbookId: "book-1", textbookTitle: "人工智能教学", revisionId: "revision-1", revisionVersion: 3, sectionPath: ["章节"] },
      }],
    });
    expect(figures).toHaveLength(26);
    expect(figures.at(-1)).toMatchObject({ figureId: "figure-26", status: "available" });
  });

  it("preserves an unavailable required textbook figure as an explicit failure", async () => {
    mocks.figures.mockResolvedValue([{
      id: "figure-1", fileAssetId: "asset-1", position: 0, caption: "核心原图", width: 800, height: 600, status: "UNSUPPORTED",
      fileAsset: { id: "asset-1", mimeType: "image/png", deletedAt: null }, revision: { textbook: { title: "人工智能教学" } }, section: { title: "具身认知" },
    }]);
    const figures = await resolveCourseTextbookFigures({
      schemaVersion: 2, version: 1, fingerprint: "f", createdAt: new Date(0).toISOString(), retrievalMode: "hybrid",
      selections: [], mappings: [{ sourceKnowledgePointId: "kp-1", sourceKnowledgePointName: "具身认知", status: "direct", evidenceItemIds: ["e"], rationale: "direct" }], warnings: [], items: [{
        id: "e", kind: "concept", title: "具身认知", content: "解释",
        figureRefs: [{ figureId: "figure-1", relation: "concept-direct", direct: true }], figureIds: ["figure-1"],
        source: { textbookId: "book-1", textbookTitle: "人工智能教学", revisionId: "revision-1", revisionVersion: 3, sectionPath: ["第三章"] },
      }],
    });
    expect(figures).toEqual([expect.objectContaining({
      figureId: "figure-1", required: true, status: "unavailable",
      failureReason: "教材图片状态为 UNSUPPORTED",
    })]);
  });
});
