import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TextbookDetailPayload } from "@/app/teacher/textbooks/textbook-view-types";
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/platform/client", () => ({ teacherPlatformFetch: mocks.fetch }));
import { TextbookSearch } from "./textbook-search";

const payload: TextbookDetailPayload = {
  textbook: { id: "book-1", title: "生物学" },
  sections: [{ id: "chapter", title: "生命基础" }, { id: "section", parentId: "chapter", title: "细胞结构" }],
  concepts: [{ id: "concept", name: "细胞膜", aliases: ["质膜"], sectionId: "section" }],
};
const evidence = (content: string) => ({ hits: [{ retrievalItemId: `hit-${content}`, content, sectionId: "section", sourceBlockId: "source-block" }], degraded: false });
async function debounce() { await act(async () => { await vi.advanceTimersByTimeAsync(300); }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function search(value: string) { fireEvent.change(screen.getByRole("combobox", { name: "搜索本书" }), { target: { value } }); }

describe("textbook unified search", () => {
  beforeEach(() => { vi.useFakeTimers(); mocks.fetch.mockReset(); mocks.fetch.mockResolvedValue(Response.json({ hits: [], degraded: false })); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("combines local chapters and concepts with debounced source evidence and chapter paths", async () => {
    mocks.fetch.mockResolvedValue(Response.json(evidence("细胞是生命活动的基本单位")));
    const onSelect = vi.fn();
    render(<TextbookSearch payload={payload} onSelect={onSelect} />);
    search("细胞");
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(mocks.fetch).not.toHaveBeenCalled();
    await debounce();
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.getByText("原文 · 生命基础 / 细胞结构")).toBeInTheDocument();
    expect(mocks.fetch).toHaveBeenCalledWith(expect.stringContaining("/api/textbooks/book-1/search?q=%E7%BB%86%E8%83%9E&limit=12"), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    fireEvent.click(screen.getByText("细胞是生命活动的基本单位"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: "原文", sectionId: "section", blockId: "source-block" }));
    expect(screen.getByRole("combobox")).toHaveValue("");
  });

  it("matches concept aliases and supports arrow selection, enter, and escape", async () => {
    const onSelect = vi.fn();
    render(<TextbookSearch payload={payload} onSelect={onSelect} />);
    search("质膜");
    expect(screen.getByText("细胞膜")).toBeInTheDocument();
    search("细胞");
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("细胞膜");
    expect(document.getElementById(input.getAttribute("aria-activedescendant")!)).toHaveTextContent("细胞膜");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("章节");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ conceptId: "concept", kind: "知识点" }));
    search("细胞");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1);
    await debounce();
  });

  it("keeps the keyboard-selected option visible in a scrolling result list", () => {
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
    try {
      render(<TextbookSearch payload={payload} onSelect={vi.fn()} />);
      search("细胞");
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
      expect(scroll).toHaveBeenLastCalledWith({ block: "nearest" });
      expect(scroll.mock.contexts.at(-1)).toBe(screen.getByRole("option", { selected: true }));
    } finally { delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView; }
  });

  it("aborts the prior request and ignores its late successful response", async () => {
    const old = deferred<Response>();
    mocks.fetch.mockReturnValueOnce(old.promise).mockResolvedValueOnce(Response.json(evidence("新的搜索结果")));
    render(<TextbookSearch payload={payload} onSelect={vi.fn()} />);
    search("旧搜索");
    await debounce();
    const signal = mocks.fetch.mock.calls[0][1].signal as AbortSignal;
    search("新搜索");
    expect(signal.aborted).toBe(true);
    await debounce();
    expect(screen.getByText("新的搜索结果")).toBeInTheDocument();
    await act(async () => { old.resolve(Response.json(evidence("过期的搜索结果"))); });
    expect(screen.queryByText("过期的搜索结果")).not.toBeInTheDocument();
    expect(screen.getByText("新的搜索结果")).toBeInTheDocument();
  });

  it("keeps local results on API failure and retries the same query", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ message: "检索服务暂时不可用" }, { status: 503 })).mockResolvedValueOnce(Response.json(evidence("恢复后的原文")));
    render(<TextbookSearch payload={payload} onSelect={vi.fn()} />);
    search("细胞");
    await debounce();
    expect(screen.getByRole("status")).toHaveTextContent("检索服务暂时不可用");
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "重试原文检索" }));
    await debounce();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.fetch.mock.calls[1][0]).toBe(mocks.fetch.mock.calls[0][0]);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("恢复后的原文")).toBeInTheDocument();
  });

  it("clears results immediately and does not retrieve empty text", async () => {
    render(<TextbookSearch payload={payload} onSelect={vi.fn()} />);
    search("细胞");
    fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveFocus();
    await debounce();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
