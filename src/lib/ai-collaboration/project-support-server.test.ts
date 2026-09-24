import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";

const mocks = vi.hoisted(() => ({
  memoryFindMany: vi.fn(),
  retrievalFindMany: vi.fn(),
  searchTextbookEvidence: vi.fn(),
  searchLibraryTextbookEvidence: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    aiSupportRecord: { findMany: mocks.memoryFindMany },
    textbookRetrievalItem: { findMany: mocks.retrievalFindMany },
  },
}));
vi.mock("@/lib/textbook/service", () => ({
  searchTextbookEvidence: mocks.searchTextbookEvidence,
  searchLibraryTextbookEvidence: mocks.searchLibraryTextbookEvidence,
}));

import { resolveProjectSupportContext } from "./project-support-server";

function course(bound = true): Course {
  return {
    id: "course-1",
    content: {
      textbookSelections: bound ? [{ revisionId: "revision-1", primary: true, sectionIds: [] }] : [],
      knowledgePoints: [{ id: "kp-1", name: "边界值分析" }],
    },
    aiLearningProgress: {},
  } as unknown as Course;
}

const hit = (id: string, lexicalRank: number | null = 1) => ({ retrievalItemId: id, score: 0.03, lexicalRank, semanticRank: 1 });
const record = (id: string) => ({
  id,
  content: "边界值分析需要覆盖有效边界与无效边界。",
  revision: { textbook: { title: "软件测试基础" } },
  section: { path: "第三章/边界值分析", title: "边界值分析" },
});

const input = (bound = true) => ({
  course: course(bound),
  studentId: "student-1",
  participationId: "participation-1",
  message: "边界值分析方法是什么？",
  history: [] as Array<{ role: "user" | "assistant"; content: string }>,
  allowRetrieval: true,
});

describe("resolveProjectSupportContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memoryFindMany.mockResolvedValue([]);
    mocks.searchTextbookEvidence.mockResolvedValue({ hits: [hit("item-1")] });
    mocks.searchLibraryTextbookEvidence.mockResolvedValue({ hits: [] });
    mocks.retrievalFindMany.mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
      Promise.resolve(where.id.in.map((id) => record(id))));
  });

  it("uses sufficient course evidence without querying the whole library", async () => {
    const result = await resolveProjectSupportContext(input());
    expect(result.retrievalStatus).toBe("textbook-supported");
    expect(result.sources).toEqual([expect.objectContaining({ id: "textbook:item-1", title: "软件测试基础" })]);
    expect(mocks.searchLibraryTextbookEvidence).not.toHaveBeenCalled();
  });

  it("accepts semantically matched evidence without a lexical rank", async () => {
    mocks.searchTextbookEvidence.mockResolvedValue({ hits: [hit("item-1", null)] });
    const result = await resolveProjectSupportContext(input());
    expect(result.sources).toHaveLength(1);
    expect(mocks.searchLibraryTextbookEvidence).toHaveBeenCalledOnce();
  });

  it("searches the library when course evidence is insufficient", async () => {
    mocks.searchTextbookEvidence.mockResolvedValue({ hits: [] });
    mocks.searchLibraryTextbookEvidence.mockResolvedValue({ hits: [hit("item-2")] });
    const result = await resolveProjectSupportContext(input());
    expect(mocks.searchTextbookEvidence).toHaveBeenCalledBefore(mocks.searchLibraryTextbookEvidence);
    expect(result.sources).toEqual([expect.objectContaining({ id: "textbook:item-2" })]);
  });

  it("searches the library directly when no course textbook is bound", async () => {
    mocks.searchLibraryTextbookEvidence.mockResolvedValue({ hits: [hit("item-2")] });
    const result = await resolveProjectSupportContext(input(false));
    expect(mocks.searchTextbookEvidence).not.toHaveBeenCalled();
    expect(result.sources).toHaveLength(1);
  });

  it("keeps answering context available when course evidence retrieval fails", async () => {
    mocks.searchTextbookEvidence.mockRejectedValue(new Error("search unavailable"));
    const result = await resolveProjectSupportContext(input());
    expect(mocks.searchLibraryTextbookEvidence).toHaveBeenCalled();
    expect(result.sources).toEqual([]);
    expect(result.retrievalStatus).toBe("not-needed");
    expect(result.promptContext).toContain("正常运用模型知识");
    expect(result.promptContext).not.toContain("联网搜索服务尚未配置");
  });

  it("widens the search for current facts while keeping textbook context optional", async () => {
    mocks.searchLibraryTextbookEvidence.mockResolvedValue({ hits: [hit("item-2")] });
    const result = await resolveProjectSupportContext({ ...input(), message: "当前版本的 API 规范是什么？" });
    expect(mocks.searchLibraryTextbookEvidence).toHaveBeenCalledOnce();
    expect(result.sources.map((source) => source.id)).toEqual(["textbook:item-1", "textbook:item-2"]);
  });

  it("uses recent student context for an elliptical follow-up", async () => {
    const result = await resolveProjectSupportContext({
      ...input(),
      message: "这个怎么做？",
      history: [{ role: "user", content: "我在做边界值分析。" }],
    });
    expect(mocks.searchTextbookEvidence).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.stringMatching(/边界值分析.*这个怎么做/),
    }));
    expect(result.sources).toHaveLength(1);
  });
});
