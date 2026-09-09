import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "./page";

vi.mock("next/navigation", () => ({ useParams: () => ({ activityId: "activity" }), usePathname: () => "/student/activities/activity" }));
vi.mock("@/components/platform/student-shell", () => ({ StudentShell: ({ children }: { children: React.ReactNode }) => children }));
let fetcher: ReturnType<typeof vi.fn>;
const instance = { id: "finished-run", status: "finished", startedAt: null, endedAt: null, canWrite: false, coverImageUrl: "/generated/classroom-cover.png" };
beforeEach(() => {
  fetcher = vi.fn(async (_url: string, options?: RequestInit) => new Response(JSON.stringify(options?.method ? { message: "活动尚未开放学习" } : { activity: { id: "activity", type: "Classroom", title: "课堂", isOpen: true, offering: { id: "offering", name: "课程", status: "open" }, chapter: { title: "章节" }, progress: { status: "completed" }, instance, instances: [instance] } }), options?.method ? { status: 403 } : undefined));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("student classroom history", () => {
  it("uses the existing entry permission check for a finished run and shows its rejection", async () => {
    render(<Page />);
    expect(await screen.findByRole("img", { name: "课堂课堂封面" })).toHaveAttribute("src", expect.stringContaining("classroom-cover.png"));
    fireEvent.click(await screen.findByRole("button", { name: /查看课堂记录/ }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/classroom-instances/finished-run/enter", { method: "POST" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("活动尚未开放学习");
    expect(screen.queryByRole("button", { name: "进入课堂" })).toBeNull();
  });
  it("does not offer writable entry for a closed offering even if an older API reports canWrite", async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ activity: { id: "activity", type: "Classroom", title: "课堂", isOpen: true, offering: { id: "offering", name: "课程", status: "finished" }, chapter: { title: "章节" }, progress: { status: "completed" }, instance: { ...instance, status: "teaching", canWrite: true } } })));
    render(<Page />);
    await screen.findByRole("heading", { name: "课堂" });
    expect(screen.queryByRole("button", { name: "进入课堂" })).toBeNull();
  });
});

describe("student questionnaire", () => {
  it("renders mixed question types and submits option ids with text answers", async () => {
    fetcher.mockImplementation(async (_url: string, options?: RequestInit) => new Response(JSON.stringify(options?.method ? { progress: { progressData: JSON.parse(String(options.body)) } } : { activity: {
      id: "activity", type: "Form", title: "课堂反馈", description: null, isOpen: true,
      offering: { id: "offering", name: "课程", status: "open" }, chapter: { title: "章节" },
      config: { content: "请真实表达", questions: [
        { id: "pace", title: "课堂节奏如何？", type: "single-choice", required: true, options: [{ id: "fast", label: "偏快" }, { id: "good", label: "合适" }] },
        { id: "skills", title: "练习了哪些能力？", type: "multiple-choice", chartType: "bar", required: true, options: [{ id: "research", label: "调研" }, { id: "teamwork", label: "协作" }, { id: "present", label: "表达" }] },
        { id: "idea", title: "最有启发的内容？", type: "short-text", required: true, options: [] },
      ] }, progress: { status: "not_started", progressData: {} }, instance: null,
    } })));
    render(<Page />);
    expect(screen.queryByText("我的学习空间")).toBeNull();
    expect(await screen.findByText("单选题")).toBeInTheDocument();
    expect(screen.getByText("多选题")).toBeInTheDocument();
    expect(screen.getByText(/单选：本题只能选择一个选项/)).toBeInTheDocument();
    expect(screen.getByText(/多选：本题可以选择一个或多个选项/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("radio", { name: /合适/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /调研/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /协作/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "最有启发的内容？" }), { target: { value: "小组共创让我理解了设计思维" } });
    fireEvent.click(screen.getByRole("button", { name: "提交问卷" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/activities/activity/submit", expect.objectContaining({ method: "POST", body: JSON.stringify({ answer: "", answers: { pace: "good", skills: ["research", "teamwork"], idea: "小组共创让我理解了设计思维" } }) })));
    expect(await screen.findByRole("link", { name: "返回课程" })).toHaveAttribute("href", "/student/courses/offering");
    expect(screen.getByRole("button", { name: "更新回答" })).toBeInTheDocument();
  });
});

describe("student reference material", () => {
  it("opens an uploaded PDF from the protected upload route", async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ activity: {
      id: "activity", type: "Resource", title: "阅读材料", description: null, isOpen: true,
      offering: { id: "offering", name: "课程", status: "open" }, chapter: { title: "章节" },
      config: { resourceKind: "file", fileName: "观察方法.pdf", url: "/api/uploads/8f31b270-b23d-4ec1-bd2b-8543210bcf88" },
      progress: { status: "not_started", progressData: {} }, instance: null,
    } })));
    render(<Page />);
    expect(await screen.findByRole("link", { name: "打开 观察方法.pdf ↗" })).toHaveAttribute("href", "/api/uploads/8f31b270-b23d-4ec1-bd2b-8543210bcf88");
  });
});
