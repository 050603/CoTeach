import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "./page";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), useParams: () => ({ offeringId: "course-1" }) }));
const offering = { id: "course-1", name: "设计思维", status: "open", chapters: [{ id: "chapter-1", title: "发现问题", isOpen: true, version: 2, activities: [] }] };
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  push.mockReset();
  fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method) return new Response(JSON.stringify({ success: true }));
    return new Response(JSON.stringify(url === "/api/platform/templates" ? { templates: [] } : { offerings: [offering] }));
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("课程章节管理", () => {
  it("locks a chapter in its directory with optimistic version protection", async () => {
    render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "锁定章节" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/chapters/chapter-1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ isOpen: false, version: 2 }) })));
    expect(await screen.findByText("章节已锁定")).toBeTruthy();
  });
  it("creates a questionnaire within the chosen chapter with actual questions", async () => {
    render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "添加学习内容" }));
    fireEvent.change(screen.getByLabelText("内容类型"), { target: { value: "Form" } });
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "学习前调查" } });
    fireEvent.change(screen.getByLabelText("题目（每行一题，学生填写文字回答）"), { target: { value: "你关注什么问题？\n你有哪些经验？" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/offerings/course-1/chapters/chapter-1/activities", expect.objectContaining({ method: "POST", body: expect.stringContaining('"questions":[{"id":"q1","title":"你关注什么问题？","required":true},{"id":"q2","title":"你有哪些经验？","required":true}]') })));
  });
  it("keeps the editor open and explains a failed activity save", async () => {
    render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "添加学习内容" }));
    fireEvent.change(screen.getByLabelText("内容类型"), { target: { value: "Assignment" } });
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "调研报告" } });
    fetcher.mockImplementationOnce(async () => new Response(JSON.stringify({ message: "课程已被其他教师更新" }), { status: 409 }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("课程已被其他教师更新");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});


describe("课堂主入口", () => {
  function classrooms(status?: string, published = true) {
    fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method) return new Response(JSON.stringify({ instance: { id: "new-run", status: "scheduled" } }));
      return new Response(JSON.stringify(url === "/api/platform/templates" ? { templates: [{ id: "template", title: "课堂教案", versions: [{ id: "version", version: 1, status: published ? "published" : "draft" }] }] } : { offerings: [{ ...offering, chapters: [{ ...offering.chapters[0], activities: [{ id: "activity", title: "项目课堂", type: "Classroom", isOpen: true, templateId: "template", instances: status ? [{ id: "run", status }] : [] }] }] }] }));
    });
  }
  it.each([["scheduled", "进入课堂", "/teacher/teach/run/setup"], ["teaching", "继续授课", "/teacher/teach/run/setup?enter=1"], ["finished", "查看课堂记录", "/teacher/classrooms/run"]])("routes %s with one teaching entry", async (status, label, href) => {
    classrooms(status); render(<Page />);
    expect(await screen.findByRole("link", { name: label })).toHaveAttribute("href", href);
    expect(screen.queryByRole("button", { name: "开始课堂" })).toBeNull();
    expect(screen.queryByRole("button", { name: "结束课堂" })).toBeNull();
    expect(screen.queryByRole("button", { name: "配置" })).toBeNull();
  });
  it("creates a scheduled run then opens setup without a start request", async () => {
    classrooms(); render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "进入课堂" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/teacher/teach/new-run/setup"));
    expect(fetcher).toHaveBeenCalledWith("/api/platform/activities/activity/instance", expect.objectContaining({ method: "POST", body: JSON.stringify({ templateVersionId: "version" }) }));
    expect(fetcher.mock.calls.filter(([, options]) => options?.method)).toHaveLength(1);
  });
  it("keeps creation failures reviewable and does not navigate or start teaching", async () => {
    classrooms(); render(<Page />);
    const enter = await screen.findByRole("button", { name: "进入课堂" });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ message: "教案已更新，请重新选择" }), { status: 409 }));
    fireEvent.click(enter);
    expect(await screen.findByRole("alert")).toHaveTextContent("教案已更新，请重新选择");
    expect(push).not.toHaveBeenCalled();
    expect(enter).toBeEnabled();
  });
  it("explains an unpublished lesson instead of creating an unusable run", async () => {
    classrooms(undefined, false); render(<Page />);
    expect(await screen.findByRole("link", { name: "前往课程库" })).toHaveAttribute("href", "/teacher/templates");
    expect(screen.queryByRole("button", { name: "进入课堂" })).toBeNull();
  });
});
