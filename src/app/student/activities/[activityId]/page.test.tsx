import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "./page";

vi.mock("next/navigation", () => ({ useParams: () => ({ activityId: "activity" }), usePathname: () => "/student/activities/activity" }));
vi.mock("@/components/platform/student-shell", () => ({ StudentShell: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/components/classroom/simple-stage-resources", () => ({
  StudentPdfResourceViewer: ({ url, title, onReady }: { url: string; title: string; onReady: () => void }) =>
    <div aria-label={`PDF 阅读器 ${title}`}><span>{url}</span><button onClick={onReady} type="button">模拟 PDF 解析完成</button></div>,
}));
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
        { id: "pace", title: "课堂节奏如何？", type: "single-choice", required: true, options: [{ id: "fast", label: "偏快" }, { id: "good", label: "合适" }, { id: "other", label: "其他", allowTextInput: true }] },
        { id: "skills", title: "练习了哪些能力？", type: "multiple-choice", chartType: "bar", maxSelections: 2, required: true, options: [{ id: "research", label: "调研" }, { id: "teamwork", label: "协作" }, { id: "present", label: "表达" }] },
        { id: "idea", title: "最有启发的内容？", type: "short-text", required: true, options: [] },
      ] }, progress: { status: "not_started", progressData: {} }, instance: null,
    } })));
    render(<Page />);
    expect(screen.queryByText("我的学习空间")).toBeNull();
    expect(await screen.findByText("单选题")).toBeInTheDocument();
    expect(screen.getByText("多选题")).toBeInTheDocument();
    expect(screen.getByText("约 3 分钟")).toBeInTheDocument();
    expect(screen.queryByText(/本题只能选择一个选项/)).not.toBeInTheDocument();
    expect(screen.queryByText(/本题可以选择一个或多个选项/)).not.toBeInTheDocument();
    expect(screen.getByText("最多选 2 项")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("radio", { name: /其他/ }));
    const otherDetail = screen.getByRole("textbox", { name: "请补充其他的具体内容" });
    expect(otherDetail).toBeRequired();
    expect(otherDetail).toHaveAttribute("maxlength", "200");
    fireEvent.change(otherDetail, { target: { value: "前半段合适，讨论环节偏快" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /调研/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /协作/ }));
    expect(screen.getByRole("checkbox", { name: /表达/ })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "最有启发的内容？" }), { target: { value: "小组共创让我理解了设计思维" } });
    fireEvent.click(screen.getByRole("button", { name: "提交问卷" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/activities/activity/submit", expect.objectContaining({ method: "POST", body: JSON.stringify({ answer: "", answers: { pace: { selected: "other", optionText: { other: "前半段合适，讨论环节偏快" } }, skills: ["research", "teamwork"], idea: "小组共创让我理解了设计思维" } }) })));
    expect(await screen.findByRole("link", { name: "返回课程" })).toHaveAttribute("href", "/student/courses/offering");
    expect(screen.getByRole("button", { name: "更新回答" })).toBeInTheDocument();
  });
});

describe("student reference material", () => {
  const pdfActivity = { activity: {
      id: "activity", type: "Resource", title: "阅读材料", description: null, isOpen: true,
      offering: { id: "offering", name: "课程", status: "open" }, chapter: { title: "章节" },
      config: { resourceKind: "file", fileName: "观察方法.pdf", url: "/api/uploads/8f31b270-b23d-4ec1-bd2b-8543210bcf88" },
      progress: { status: "not_started", progressData: {} }, instance: null,
  } };

  it("opens an uploaded PDF in the reader and records learning when it is parsed", async () => {
    fetcher.mockImplementation(async (_url: string, options?: RequestInit) => new Response(JSON.stringify(options?.method
      ? { progress: { status: "completed", progressData: { submittedAt: "2026-09-24" } } }
      : pdfActivity)));
    render(<Page />);
    expect(await screen.findByLabelText("PDF 阅读器 观察方法.pdf")).toHaveTextContent("/api/uploads/8f31b270-b23d-4ec1-bd2b-8543210bcf88");
    expect(screen.queryByRole("link", { name: /打开 观察方法.pdf/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "标记为已学习" })).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "模拟 PDF 解析完成" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/activities/activity/submit", expect.objectContaining({ method: "POST", body: "{}" })));
    expect(await screen.findByText("已学习")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "模拟 PDF 解析完成" }));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps an already completed PDF available without submitting again", async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ activity: { ...pdfActivity.activity, config: { url: pdfActivity.activity.config.url }, progress: { status: "completed" } } })));
    render(<Page />);
    expect(await screen.findByLabelText("PDF 阅读器 阅读材料")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "模拟 PDF 解析完成" }));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("records a text-only reference after its page opens", async () => {
    fetcher.mockImplementation(async (_url: string, options?: RequestInit) => new Response(JSON.stringify(options?.method
      ? { progress: { status: "completed", progressData: {} } }
      : { activity: { ...pdfActivity.activity, config: { content: "阅读以下项目任务" } } })));
    render(<Page />);
    expect(await screen.findByText("阅读以下项目任务")).toBeInTheDocument();
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/activities/activity/submit", expect.objectContaining({ method: "POST" })));
    expect(await screen.findByText("已学习")).toBeInTheDocument();
  });

  it("records an external resource when its link is opened", async () => {
    fetcher.mockImplementation(async (_url: string, options?: RequestInit) => new Response(JSON.stringify(options?.method
      ? { progress: { status: "completed", progressData: {} } }
      : { activity: { ...pdfActivity.activity, config: { resourceKind: "link", url: "https://example.com/reference" } } })));
    render(<Page />);
    const link = await screen.findByRole("link", { name: "打开参考资料 ↗" });
    expect(link).toHaveAttribute("href", "https://example.com/reference");
    expect(fetcher).toHaveBeenCalledTimes(1);
    fireEvent.click(link);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/activities/activity/submit", expect.objectContaining({ method: "POST" })));
  });
});

describe("student classroom experiment", () => {
  const questions = [{ id: "design", type: "short-answer", prompt: "请说明你的想法" }];
  const baseActivity = {
    id: "activity", type: "Classroom", title: "研究课堂", description: null, isOpen: true,
    offering: { id: "offering", name: "课程", status: "open" }, chapter: { title: "章节" },
    progress: { status: "in_progress" },
    experiment: { enabled: true, pretest: questions, posttest: [{ id: "after", type: "short-answer", prompt: "课后收获" }] },
  };

  it("opens the pretest in a dedicated page and keeps classroom entry gated", async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ activity: {
      ...baseActivity, instance: { id: "run-1", status: "scheduled", canWrite: true, pretestSubmitted: false }, instances: [],
    } })));
    render(<Page />);
    expect(await screen.findByRole("link", { name: "开始前测" })).toHaveAttribute("href", "/student/activities/activity/assessments/run-1/pretest");
    expect(screen.queryByRole("button", { name: "进入课堂" })).toBeNull();
    expect(screen.queryByRole("progressbar", { name: "前测作答进度" })).toBeNull();
    expect(screen.queryByRole("link", { name: "开始后测" })).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("links to saved pretest answers and an available posttest", async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ activity: {
      ...baseActivity, instance: { id: "run-1", status: "teaching", canWrite: true, pretestSubmitted: true, posttestAvailable: true }, instances: [],
    } })));
    render(<Page />);
    expect(await screen.findByRole("link", { name: "查看前测答案" })).toHaveAttribute("href", "/student/activities/activity/assessments/run-1/pretest");
    expect(screen.getByRole("link", { name: "开始后测" })).toHaveAttribute("href", "/student/activities/activity/assessments/run-1/posttest");
    expect(screen.getByRole("button", { name: "进入课堂" })).toBeInTheDocument();
  });

  it("uses each historical run's own snapshot and route", async () => {
    const current = { id: "run-2", status: "scheduled", canWrite: false, pretestSubmitted: true, posttestSubmitted: false };
    const historical = { id: "run-1", status: "finished", canWrite: false, pretestSubmitted: true, posttestSubmitted: false, experiment: {
      enabled: true, pretest: [], posttest: [{ id: "old", type: "short-answer", prompt: "第一次课堂的收获" }],
    } };
    const legacy = { id: "run-0", status: "finished", canWrite: false, experiment: null };
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ activity: { ...baseActivity, instance: current, instances: [current, historical, legacy] } })));
    render(<Page />);
    const link = await screen.findByRole("link", { name: "开始后测" });
    expect(link).toHaveAttribute("href", "/student/activities/activity/assessments/run-1/posttest");
    expect(screen.getAllByRole("link", { name: "开始后测" })).toHaveLength(1);
  });
});
