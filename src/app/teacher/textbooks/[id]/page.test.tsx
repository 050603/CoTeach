import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const routeParams = vi.hoisted(() => ({ id: "book-1" }));
vi.mock("next/navigation", () => ({ useParams: () => routeParams }));
vi.mock("@/components/platform/teacher-shell", () => ({ TeacherPlatformHeader: () => <div />, TeacherPlatformPage: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock("next/dynamic", () => ({ default: () => ({ concepts, onSelect, detail }: { concepts: Array<{ id: string; name: string }>; onSelect: (id: string) => void; detail: ReactNode }) => <div aria-label="教材知识图谱">{concepts.map(c => <button key={c.id} onClick={() => onSelect(c.id)}>{c.name}图谱节点</button>)}{detail}</div> }));
import TeacherTextbookDetailPage from "./page";
const fixture = {
  textbook: { id: "book-1", title: "人工智能学科教师素养提升", author: "编写组" }, revision: { id: "revision-1", version: 1, status: "READY" },
  sections: [{ id: "section-1", title: "第三章 人工智能教学方法", position: 1 }, { id: "section-2", parentId: "section-1", title: "教学支架", position: 2 }],
  sourceBlocks: [{ id: "block-1", sectionId: "section-2", blockType: "PARAGRAPH", content: "教学支架是教师为学习者提供的暂时性支持，并随着能力提升逐步撤除。" }],
  concepts: [{ id: "concept-1", sectionId: "section-2", name: "教学支架", explanation: "通过阶段性支持帮助学生逐步独立完成任务。", aliases: ["学习支架"], evidence: [{ sourceBlockId: "block-1", quote: "教学支架是教师为学习者提供的暂时性支持" }] }, { id: "concept-2", sectionId: "section-2", name: "项目式学习", explanation: "以真实项目组织学习。" }],
  relations: [{ id: "r1", sourceConceptId: "concept-1", targetConceptId: "concept-2", relationType: "supports" }],
  examples: [{ id: "e1", conceptId: "concept-1", title: "分类游戏", content: "学生观察分类规则。" }],
  figures: [{ id: "f1", conceptId: "concept-1", sectionId: "section-2", sourceBlockId: "block-1", caption: "支架示意图", url: "/api/uploads/a1" }],
};
function mockFetch(data: unknown = fixture) {
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (input === "/api/auth/me") return Response.json({ user: { id: "teacher-1" } });
    if (input.includes("/search?")) return Response.json({ hits: [] });
    if (init?.method === "POST") return Response.json({});
    return Response.json(data);
  }));
}
describe("textbook reading and graph workspace", () => {
  beforeEach(() => {
    routeParams.id = "book-1";
    window.history.replaceState(null, "", "/teacher/textbooks/book-1"); localStorage.clear();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    mockFetch();
  });
  afterEach(() => vi.unstubAllGlobals());
  it("starts with the complete chapter overview and loads the graph only on request", async () => {
    render(<TeacherTextbookDetailPage />);
    expect(await screen.findByRole("heading", { name: fixture.textbook.title })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "章节阅读" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "从一个章节开始探索" })).toBeInTheDocument();
    expect(screen.queryByLabelText("教材知识图谱")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "知识图谱" }));
    expect(screen.getByLabelText("教材知识图谱")).toBeInTheDocument();
  });
  it("opens knowledge evidence and jumps back to the exact source paragraph", async () => {
    window.history.replaceState(null, "", "/teacher/textbooks/book-1?view=read&section=section-2");
    render(<TeacherTextbookDetailPage />);
    await screen.findByRole("region", { name: "本节知识点" });
    fireEvent.click(within(screen.getByRole("region", { name: "本节知识点" })).getByRole("button", { name: "教学支架" }));
    const detail = screen.getByLabelText("知识点详情");
    expect(within(detail).getByText("分类游戏")).toBeInTheDocument();
    expect(within(detail).getByRole("img", { name: "支架示意图" })).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole("button", { name: "查看原文" }));
    expect(screen.queryByLabelText("知识点详情")).not.toBeInTheDocument();
    expect(document.getElementById("source-block-1")).toHaveAttribute("data-highlighted", "true");
    expect(window.location.search).toContain("block=block-1");
  });
  it("keeps a same-name chapter distinct and follows related concepts", async () => {
    window.history.replaceState(null, "", "/teacher/textbooks/book-1?view=read&section=section-2&concept=concept-1");
    render(<TeacherTextbookDetailPage />);
    const detail = await screen.findByLabelText("知识点详情");
    expect(screen.getByRole("navigation", { name: "教材章节目录" })).toHaveTextContent("教学支架");
    fireEvent.click(within(detail).getByRole("button", { name: /支持.*项目式学习/ }));
    expect(within(screen.getByLabelText("知识点详情")).getByRole("heading", { name: "项目式学习" })).toBeInTheDocument();
  });
  it("ignores an older book response after switching textbook routes", async () => {
    let finishOld: (response: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (input === "/api/auth/me") return Response.json({ user: { sub: "teacher-1" } });
      if (input.endsWith("book-1")) return new Promise<Response>(resolve => { finishOld = resolve; });
      return Response.json({ ...fixture, textbook: { ...fixture.textbook, id: "book-2", title: "第二本教材" } });
    }));
    const view = render(<TeacherTextbookDetailPage />);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/textbooks/book-1", expect.objectContaining({ signal: expect.any(AbortSignal) })));
    routeParams.id = "book-2";
    view.rerender(<TeacherTextbookDetailPage />);
    await screen.findByRole("heading", { name: "第二本教材" });
    await act(async () => { finishOld(Response.json(fixture)); });
    expect(screen.queryByRole("heading", { name: fixture.textbook.title })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "第二本教材" })).toBeInTheDocument();
  });
  it("shows failed parsing with a retry action", async () => {
    mockFetch({ ...fixture, revision: { ...fixture.revision, status: "FAILED" }, job: { error: "解析中断" } });
    render(<TeacherTextbookDetailPage />);
    expect(await screen.findByText("解析中断")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新解析" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/textbooks/book-1/retry", { method: "POST" }));
  });
});
