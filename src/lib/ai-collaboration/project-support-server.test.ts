import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";

const mocks = vi.hoisted(() => ({
  memoryFindMany: vi.fn(),
  retrievalFindMany: vi.fn(),
  searchTextbookEvidence: vi.fn(),
  searchWeb: vi.fn(),
  resolveWebConfig: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    aiSupportRecord: { findMany: mocks.memoryFindMany },
    textbookRetrievalItem: { findMany: mocks.retrievalFindMany },
  },
}));
vi.mock("@/lib/textbook/service", () => ({ searchTextbookEvidence: mocks.searchTextbookEvidence }));
vi.mock("@openmaic/lib/server/web-search-config", () => ({ resolveClassroomWebSearchConfig: mocks.resolveWebConfig }));
vi.mock("@openmaic/lib/web-search", () => ({ searchWeb: mocks.searchWeb }));

import { resolveProjectSupportContext } from "./project-support-server";

function course(practiceWebSearchEnabled = true): Course {
  return {
    id: "course-1",
    pblConfig: { practiceWebSearchEnabled },
    content: {
      textbookSelections: [{ revisionId: "revision-1", primary: true, sectionIds: [] }],
      knowledgePoints: [{ id: "kp-1", name: "边界值分析" }],
    },
    aiLearningProgress: {},
  } as unknown as Course;
}

describe("resolveProjectSupportContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memoryFindMany.mockResolvedValue([]);
    mocks.resolveWebConfig.mockReturnValue({ providerId: "tavily", apiKey: "key" });
  });

  it("uses textbook evidence and does not start web search when the textbook supports the question", async () => {
    mocks.searchTextbookEvidence.mockResolvedValue({
      query: "边界值分析方法是什么？",
      degraded: false,
      degradationReason: null,
      hits: [{ retrievalItemId: "item-1", score: 0.03, lexicalRank: 1, semanticRank: 2 }],
    });
    mocks.retrievalFindMany.mockResolvedValue([{
      id: "item-1",
      content: "边界值分析需要覆盖有效边界与无效边界。",
      revision: { textbook: { title: "软件测试基础" } },
      section: { path: "第三章/边界值分析", title: "边界值分析" },
    }]);

    const result = await resolveProjectSupportContext({
      course: course(),
      studentId: "student-1",
      participationId: "participation-1",
      message: "边界值分析方法是什么？",
      history: [],
      allowRetrieval: true,
    });

    expect(result.retrievalStatus).toBe("textbook-supported");
    expect(result.sources[0]).toEqual(expect.objectContaining({ type: "textbook", title: "软件测试基础" }));
    expect(mocks.searchWeb).not.toHaveBeenCalled();
  });

  it("uses web only after the textbook has no sufficient evidence", async () => {
    mocks.searchTextbookEvidence.mockResolvedValue({ query: "最新 API 规范", degraded: false, degradationReason: null, hits: [] });
    mocks.searchWeb.mockResolvedValue({
      answer: "",
      query: "最新 API 规范",
      responseTime: 10,
      sources: [{ title: "官方规范", url: "https://example.com/spec", content: "现行版本说明", score: 1 }],
    });

    const result = await resolveProjectSupportContext({
      course: course(),
      studentId: "student-1",
      participationId: "participation-1",
      message: "请查找最新 API 规范",
      history: [],
      allowRetrieval: true,
    });

    expect(mocks.searchTextbookEvidence).toHaveBeenCalledBefore(mocks.searchWeb);
    expect(result.retrievalStatus).toBe("web-supplemented");
    expect(result.sources[0]).toEqual(expect.objectContaining({ type: "web" }));
  });

  it("treats a textbook match as background rather than proof of a current fact", async () => {
    mocks.searchTextbookEvidence.mockResolvedValue({
      query: "当前 API 版本",
      degraded: false,
      degradationReason: null,
      hits: [{ retrievalItemId: "item-1", score: 0.03, lexicalRank: 1, semanticRank: 1 }],
    });
    mocks.retrievalFindMany.mockResolvedValue([{
      id: "item-1",
      content: "教材介绍了 API 的基本定义。",
      revision: { textbook: { title: "课程教材" } },
      section: { path: "API 基础", title: "API 基础" },
    }]);
    mocks.searchWeb.mockResolvedValue({
      answer: "",
      query: "当前 API 版本",
      responseTime: 10,
      sources: [{ title: "官方版本页", url: "https://example.com/current", content: "当前版本", score: 1 }],
    });

    const result = await resolveProjectSupportContext({
      course: course(),
      studentId: "student-1",
      participationId: "participation-1",
      message: "当前 API 版本是什么？",
      history: [],
      allowRetrieval: true,
    });

    expect(result.retrievalStatus).toBe("web-supplemented");
    expect(result.sources.map((source) => source.type)).toEqual(["textbook", "web"]);
  });

  it("does not use web for ordinary project discussion or when the teacher disables it", async () => {
    const ordinary = await resolveProjectSupportContext({
      course: course(),
      studentId: "student-1",
      participationId: "participation-1",
      message: "我们下一步先做什么？",
      history: [],
      allowRetrieval: true,
    });
    expect(ordinary.retrievalStatus).toBe("not-needed");

    mocks.searchTextbookEvidence.mockResolvedValue({ query: "最新案例", degraded: false, degradationReason: null, hits: [] });
    const disabled = await resolveProjectSupportContext({
      course: course(false),
      studentId: "student-1",
      participationId: "participation-1",
      message: "请查找最新案例",
      history: [],
      allowRetrieval: true,
    });
    expect(disabled.retrievalStatus).toBe("unavailable");
    expect(mocks.searchWeb).not.toHaveBeenCalled();
  });
});
