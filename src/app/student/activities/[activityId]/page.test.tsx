import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  const questions = [
    { id: "single", type: "single-choice", prompt: "学习前你会先观察什么？", options: ["现象", "结论"] },
    { id: "multiple", type: "multiple-choice", prompt: "选择可用的研究方法", options: ["访谈", "观察", "猜测"] },
    { id: "boolean", type: "true-false", prompt: "记录证据有助于研究" },
    { id: "short", type: "short-answer", prompt: "请说明你的想法" },
    { id: "confidence", type: "scale", prompt: "你对开展研究有多大信心？", category: "confidence", scale: { min: 1, max: 5, minLabel: "完全没有信心", maxLabel: "非常有信心" } },
  ];
  const baseActivity = {
    id: "activity", type: "Classroom", title: "研究课堂", description: null, isOpen: true,
    offering: { id: "offering", name: "课程", status: "open" }, chapter: { title: "章节" },
    progress: { status: "in_progress" },
    experiment: { enabled: true, pretest: questions, posttest: [{ id: "after", type: "short-answer", prompt: "课后收获" }] },
  };

  it("requires every pretest answer before entering and refreshes the classroom after submission", async () => {
    let submitted = false;
    fetcher.mockImplementation(async (url: string) => {
      if (url === "/api/platform/classroom-instances/run-1/experiment") {
        submitted = true;
        return new Response(JSON.stringify({ submission: { phase: "pretest", submittedAt: "2026-09-24T00:00:00Z" } }));
      }
      return new Response(JSON.stringify({ activity: {
        ...baseActivity,
        instance: { id: "run-1", status: submitted ? "teaching" : "scheduled", canWrite: submitted, pretestSubmitted: submitted, posttestSubmitted: false },
        instances: [],
      } }));
    });
    render(<Page />);
    expect(await screen.findByRole("button", { name: "开始前测" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "进入课堂" })).toBeNull();
    expect(screen.queryByRole("button", { name: "开始后测" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "开始前测" }));
    expect(screen.getByRole("progressbar", { name: "前测作答进度" })).toHaveAttribute("aria-valuenow", "0");
    const displayedQuestions = screen.getAllByRole("group");
    expect(displayedQuestions.map((group) => document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.querySelector("p")?.textContent)).toEqual([
      "学习前你会先观察什么？", "选择可用的研究方法", "记录证据有助于研究", "请说明你的想法", "你对开展研究有多大信心？",
    ]);
    expect(within(displayedQuestions[1]).getAllByRole("checkbox").map((checkbox) => checkbox.getAttribute("aria-label"))).toEqual(["访谈", "观察", "猜测"]);
    fireEvent.click(screen.getByRole("button", { name: "提交前测" }));
    expect(screen.getByRole("alert")).toHaveTextContent("请完成第 1 题");
    expect(displayedQuestions[0]).toHaveFocus();
    expect(fetcher).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("radio", { name: "现象" }));
    expect(screen.getByRole("progressbar", { name: "前测作答进度" })).toHaveAttribute("aria-valuenow", "1");
    fireEvent.click(screen.getByRole("checkbox", { name: "访谈" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "观察" }));
    fireEvent.click(screen.getByRole("radio", { name: "正确" }));
    fireEvent.change(screen.getByRole("textbox", { name: "请说明你的想法" }), { target: { value: "先收集证据" } });
    expect(screen.getByText("量表题 · 学习信心")).toBeInTheDocument();
    expect(screen.getByText(/1 分 · 完全没有信心/)).toBeInTheDocument();
    expect(screen.getByText(/5 分 · 非常有信心/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "提交前测" }));
    expect(screen.getByRole("alert")).toHaveTextContent("请完成第 5 题");
    expect(fetcher).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("radio", { name: "4 分" }));
    expect(screen.getByRole("progressbar", { name: "前测作答进度" })).toHaveAttribute("aria-valuenow", "5");
    fireEvent.click(screen.getByRole("button", { name: "提交前测" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/classroom-instances/run-1/experiment", expect.objectContaining({
      method: "POST", body: JSON.stringify({ phase: "pretest", answers: { single: "现象", multiple: ["访谈", "观察"], boolean: "true", short: "先收集证据", confidence: "4" } }),
    })));
    expect(await screen.findByRole("button", { name: "进入课堂" })).toBeInTheDocument();
    expect(screen.getByText(/前测已提交/)).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith("/api/platform/activities/activity", { cache: "no-store" });
  });

  it("offers the posttest after the classroom ends and records its completion", async () => {
    let submitted = false;
    fetcher.mockImplementation(async (url: string) => {
      if (url === "/api/platform/classroom-instances/finished-run/experiment") {
        submitted = true;
        return new Response(JSON.stringify({ submission: { phase: "posttest", submittedAt: "2026-09-24T00:00:00Z" } }));
      }
      const finished = { ...instance, pretestSubmitted: true, posttestSubmitted: submitted };
      return new Response(JSON.stringify({ activity: { ...baseActivity, instance: finished, instances: [finished] } }));
    });
    render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "开始后测" }));
    fireEvent.change(screen.getByRole("textbox", { name: "课后收获" }), { target: { value: "学会记录证据" } });
    fireEvent.click(screen.getByRole("button", { name: "提交后测" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/classroom-instances/finished-run/experiment", expect.objectContaining({
      method: "POST", body: JSON.stringify({ phase: "posttest", answers: { after: "学会记录证据" } }),
    })));
    expect(await screen.findByText(/后测已提交/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开始后测" })).toBeNull();
  });

  it("lets a late student finish the pretest before entering a teaching classroom", async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ activity: {
      ...baseActivity,
      instance: { id: "run-1", status: "teaching", canWrite: true, pretestSubmitted: false, posttestSubmitted: false },
      instances: [],
    } })));
    render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "开始前测" }));
    expect(screen.getByRole("heading", { name: /前测/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "进入课堂" })).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses each historical run's question snapshot for its posttest", async () => {
    const current = { id: "run-2", status: "scheduled", canWrite: false, pretestSubmitted: true, posttestSubmitted: false };
    const historical = { id: "run-1", status: "finished", canWrite: false, pretestSubmitted: true, posttestSubmitted: false, experiment: {
      enabled: true, pretest: [], posttest: [{ id: "old", type: "short-answer", prompt: "第一次课堂的收获" }],
    } };
    const legacy = { id: "run-0", status: "finished", canWrite: false, experiment: null };
    fetcher.mockResolvedValue(new Response(JSON.stringify({ activity: { ...baseActivity, instance: current, instances: [current, historical, legacy] } })));
    render(<Page />);
    expect(await screen.findAllByRole("button", { name: "开始后测" })).toHaveLength(1);
    fireEvent.click(await screen.findByRole("button", { name: "开始后测" }));
    expect(screen.getByRole("textbox", { name: "第一次课堂的收获" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "课后收获" })).toBeNull();
  });

  it("shows a shared instruction above grouped ratings and submits each score by question ID", async () => {
    const group = { id: "confidence-group", title: "任务信心", instruction: "请根据现在的感受，选择最符合自己的一项。" };
    const groupedQuestions = [
      { id: "confidence-a", type: "scale", prompt: "我能完成任务", scale: { min: 1, max: 5 }, group },
      { id: "confidence-b", type: "scale", prompt: "我能解决问题", scale: { min: 1, max: 5 }, group },
    ];
    let submitted = false;
    fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === "/api/platform/classroom-instances/run-1/experiment" && options?.method === "POST") {
        submitted = true;
        return new Response(JSON.stringify({ submission: { phase: "pretest" } }));
      }
      return new Response(JSON.stringify({ activity: {
        ...baseActivity,
        experiment: { enabled: true, pretest: groupedQuestions, posttest: baseActivity.experiment.posttest },
        instance: { id: "run-1", status: "scheduled", canWrite: false, pretestSubmitted: submitted, posttestSubmitted: false },
        instances: [],
      } }));
    });
    render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "开始前测" }));
    const section = screen.getByRole("region", { name: "任务信心" });
    expect(section).toHaveTextContent("请根据现在的感受，选择最符合自己的一项。");
    expect(within(section).getAllByRole("group")).toHaveLength(2);
    fireEvent.click(within(screen.getByRole("group", { name: /我能完成任务/ })).getByRole("radio", { name: "4 分" }));
    fireEvent.click(within(screen.getByRole("group", { name: /我能解决问题/ })).getByRole("radio", { name: "3 分" }));
    fireEvent.click(screen.getByRole("button", { name: "提交前测" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/classroom-instances/run-1/experiment", expect.objectContaining({
      method: "POST", body: JSON.stringify({ phase: "pretest", answers: { "confidence-a": "4", "confidence-b": "3" } }),
    })));
  });
});
