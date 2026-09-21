import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "book-1" }) }));
vi.mock("@/components/platform/teacher-shell", () => ({
  TeacherPlatformHeader: () => <div data-testid="teacher-header" />,
  TeacherPlatformPage: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/components/teacher/textbook-graph-explorer", () => ({
  TextbookGraphExplorer: ({ concepts, onSelect }: {
    concepts: Array<{ id: string; name?: string; title?: string }>;
    onSelect: (id: string | null) => void;
  }) => <div aria-label="教材知识图谱">{concepts.map(concept => <button key={concept.id} type="button" onClick={() => onSelect(concept.id)}>查看知识点：{concept.name || concept.title}</button>)}</div>,
}));

import TeacherTextbookDetailPage from "./page";

describe("TeacherTextbookDetailPage", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      textbook: { id: "book-1", title: "人工智能学科教师素养提升", author: "编写组", status: "ACTIVE" },
      revision: { id: "revision-1", version: 1, status: "READY", progress: 1 },
      sections: [
        { id: "section-1", title: "第三章 人工智能教学方法", level: 0, position: 1 },
      ],
      sourceBlocks: [
        { id: "block-1", sectionId: "section-1", blockKey: "3.2-p4", blockType: "paragraph", position: 4, content: "教学支架是教师为学习者提供的暂时性支持，并随着能力提升逐步撤除。" },
      ],
      concepts: [
        { id: "concept-1", sectionId: "section-1", name: "教学支架", explanation: "通过阶段性支持帮助学生逐步独立完成任务。", aliases: ["学习支架"], evidence: [{ sourceBlockId: "block-1", quote: "教学支架是教师为学习者提供的暂时性支持" }] },
        { id: "concept-2", sectionId: "section-1", name: "项目式学习", explanation: "以真实项目组织学习。" },
      ],
      relations: [{ id: "relation-1", sourceConceptId: "concept-1", targetConceptId: "concept-2", relationType: "supports", inferred: false }],
      examples: [{ id: "example-1", conceptId: "concept-1", title: "分类游戏体验机器学习", content: "学生通过分类游戏观察模型如何从样例中形成规则。" }],
      figures: [{ id: "figure-1", conceptId: "concept-1", caption: "教学支架示意图", fileAssetId: "asset-1", url: "/api/uploads/asset-1" }],
      job: { status: "COMPLETED", progress: 1 },
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the graph spacious and opens textbook evidence only after selecting a node", async () => {
    render(<TeacherTextbookDetailPage />);

    expect(await screen.findByRole("heading", { name: "人工智能学科教师素养提升" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "教材章节" })).toBeInTheDocument();
    expect(screen.getByLabelText("教材知识图谱")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "教学支架" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看知识点：教学支架" }));
    expect(screen.getByRole("heading", { name: "教学支架" })).toBeInTheDocument();
    expect(screen.getByText("教学支架是教师为学习者提供的暂时性支持")).toBeInTheDocument();
    expect(screen.getByText("分类游戏体验机器学习")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "教学支架示意图" })).toHaveAttribute("src", expect.stringContaining("asset-1"));

    fireEvent.click(screen.getByRole("button", { name: "支持项目式学习" }));
    expect(screen.getByRole("heading", { name: "项目式学习" })).toBeInTheDocument();
    expect(screen.getByText("以真实项目组织学习。")).toBeInTheDocument();
  });
});
