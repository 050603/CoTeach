import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("@/components/platform/teacher-shell", () => ({
  TeacherPlatformHeader: () => <div data-testid="teacher-header" />,
  TeacherPlatformPage: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

import TeacherTextbooksPage from "./page";

describe("TeacherTextbooksPage", () => {
  let fetcher: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/textbooks" && init?.method === "POST") {
        return Response.json({ textbook: { id: "book-3" }, deduplicated: false });
      }
      if (url === "/api/textbooks/book-1" && init?.method === "PATCH") {
        return Response.json({ textbook: { id: "book-1", archivedAt: "2026-09-21T01:00:00.000Z" } });
      }
      if (url.startsWith("/api/textbooks?")) {
        return Response.json({
          items: [
            {
              id: "book-1",
              title: "人工智能学科教师素养提升",
              author: "张老师",
              status: "ACTIVE",
              currentRevision: { id: "revision-1", version: 1, status: "READY", progress: 1 },
              updatedAt: "2026-09-21T00:00:00.000Z",
            },
            {
              id: "book-2",
              title: "具身智能教学设计",
              author: "李老师",
              status: "ACTIVE",
              currentRevision: { id: "revision-2", version: 1, status: "PARSING" },
              updatedAt: "2026-09-21T00:00:00.000Z",
            },
          ],
          total: 2,
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows reusable教材 with its parsing status and supports search", async () => {
    render(<TeacherTextbooksPage />);

    expect(await screen.findByRole("heading", { name: "人工智能学科教师素养提升" })).toBeInTheDocument();
    expect(screen.getAllByText("可用于课程")).toHaveLength(2);
    expect(screen.getByText("章节、图谱和检索索引已就绪")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "查看教材" })[0]).toHaveAttribute("href", "/teacher/textbooks/book-1");
    const processingRow = screen.getByRole("heading", { name: "具身智能教学设计" }).closest("article");
    expect(processingRow).not.toBeNull();
    expect(within(processingRow!).getByText("正在解析")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "搜索教材" }), { target: { value: "不匹配" } });
    expect(screen.getByText("没有找到匹配的教材")).toBeInTheDocument();
  });

  it("uploads a DOCX as multipart form data and reports background parsing", async () => {
    render(<TeacherTextbooksPage />);
    await screen.findByText("人工智能学科教师素养提升");

    const file = new File(["docx"], "人工智能教学.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    fireEvent.change(screen.getByLabelText("上传 DOCX 教材"), { target: { files: [file] } });

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/textbooks", expect.objectContaining({ method: "POST", body: expect.any(FormData) })));
    const request = fetcher.mock.calls.find(([url, init]) => url === "/api/textbooks" && init?.method === "POST");
    const body = request?.[1]?.body as FormData;
    expect(body.get("file")).toBe(file);
    expect(await screen.findByRole("status")).toHaveTextContent("系统正在提取章节、知识和插图");
  });

  it("archives a textbook without deleting its existing references", async () => {
    render(<TeacherTextbooksPage />);
    await screen.findByText("人工智能学科教师素养提升");

    fireEvent.click(screen.getByRole("button", { name: "归档 人工智能学科教师素养提升" }));
    expect(await screen.findByText(/已有课程引用、教材原文和解析结果会继续保留/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认归档" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/textbooks/book-1", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ archived: true }),
    })));
  });
});
