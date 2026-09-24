import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn(), embed: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { $queryRaw: mocks.queryRaw } }));
vi.mock("./embedding", () => ({
  embedTextbookTexts: mocks.embed,
  TextbookEmbeddingUnavailableError: class extends Error {},
  vectorSqlLiteral: vi.fn(),
}));

import { searchLibraryTextbookEvidence } from "./service";

describe("searchLibraryTextbookEvidence", () => {
  it("queries all current active revisions and keeps lexical results if embeddings are unavailable", async () => {
    mocks.queryRaw.mockResolvedValue(Array.from({ length: 25 }, (_, index) => ({
      id: `item-${index}`, revisionId: `revision-${index}`, sectionId: null,
      sourceBlockId: null, conceptId: null, exampleId: null,
      kind: "TEXT", title: "边界值分析", content: "有效与无效边界", rank: index + 1,
    })));
    mocks.embed.mockRejectedValue(new Error("embedding unavailable"));

    const result = await searchLibraryTextbookEvidence({ query: "边界值分析", limit: 30 });

    expect(result.hits).toHaveLength(25);
    expect(result.degraded).toBe(true);
    const sql = mocks.queryRaw.mock.calls[0][0].sql as string;
    expect(sql).toContain('JOIN "Textbook" textbook');
    expect(sql).toContain('textbook."currentRevisionId" = revision."id"');
    expect(sql).toContain("textbook.\"status\" <> 'ARCHIVED'");
    expect(sql).toContain("'WAITING_EMBEDDING'");
    expect(sql).not.toContain('ri."revisionId" IN ($');
  });
});
