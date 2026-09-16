import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("next/navigation", () => ({ useParams: () => ({ activityId: "survey-1" }) }));
vi.mock("@/lib/platform/client", () => ({ teacherPlatformFetch: mocks.fetch }));
vi.mock("@/components/platform/teacher-shell", () => ({
  TeacherPlatformPage: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TeacherPlatformHeader: () => null,
}));
vi.mock("@/components/platform/survey-word-cloud", () => ({
  SurveyWordCloud: ({ terms, onSelect }: { terms: Array<{ label: string; value: number }>; onSelect: (term: { label: string; value: number }) => void }) => (
    <div>{terms.map((term) => <button onClick={() => onSelect(term)} type="button" key={term.label}>{term.label}</button>)}</div>
  ),
}));

import SurveyDashboardPage from "./page";

const result = {
  activity: { id: "survey-1", title: "课堂反馈", isOpen: true, chapter: { id: "chapter-1", title: "第一章" }, offering: { id: "offering-1", name: "设计思维" } },
  analytics: {
    submittedCount: 2,
    totalStudents: 3,
    completionRate: 66.7,
    questions: [
      {
        id: "choice",
        title: "课堂节奏如何？",
        type: "single-choice",
        chartType: "column",
        required: true,
        responseCount: 2,
        options: [
          { id: "good", label: "合适", count: 2, percentage: 100, respondents: [{ studentId: "s1", displayName: "林晓", detail: "讨论环节有一点快" }, { studentId: "s2", displayName: "陈舟" }] },
          { id: "fast", label: "偏快", count: 0, percentage: 0, respondents: [] },
        ],
      },
      {
        id: "text",
        title: "你学到了什么？",
        type: "short-text",
        required: true,
        responseCount: 2,
        responses: [
          { studentId: "s1", displayName: "林晓", content: "合作帮助我理解了设计思维" },
          { studentId: "s2", displayName: "陈舟", content: "通过讨论形成了新方案" },
        ],
        terms: [{ label: "合作", value: 1 }],
      },
    ],
  },
  updatedAt: "2026-09-09T08:00:00.000Z",
};

afterEach(() => vi.clearAllMocks());

describe("teacher survey dashboard", () => {
  it("places the all-responses button before the heading count and hides coverage statistics", async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
      ...result,
      analytics: { ...result.analytics, questions: [{
        ...result.analytics.questions[1], keywordAnalyzedCount: 2, keywordRepresentedCount: 1,
        keywordUnrepresentedResponses: [{ studentId: "s2", reason: "no-keywords" }],
      }] },
    }), { status: 200 }));
    render(<SurveyDashboardPage />);
    expect(await screen.findByText("通过讨论形成了新方案")).toBeInTheDocument();
    expect(screen.getByText("合作帮助我理解了设计思维")).toBeInTheDocument();
    expect(screen.queryByText(/已分析|已有词条覆盖/)).not.toBeInTheDocument();
    const all = screen.getByRole("button", { name: "全部回答" });
    expect(all.closest(".survey-insight-heading")).not.toBeNull();
    expect(all.nextElementSibling).toHaveTextContent("2 份回答");
    fireEvent.click(screen.getByRole("button", { name: "合作" }));
    expect(screen.queryByText("通过讨论形成了新方案")).not.toBeInTheDocument();
    fireEvent.click(all);
    expect(screen.getByText("通过讨论形成了新方案")).toBeInTheDocument();
    expect(screen.getByText("合作帮助我理解了设计思维")).toBeInTheDocument();
  });
  it("uses verified student mappings for a normalized AI theme that is not a source substring", async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
      ...result,
      analytics: { ...result.analytics, questions: [{
        ...result.analytics.questions[1],
        responses: [
          { studentId: "s1", displayName: "林晓", content: "组员之间配合默契" },
          { studentId: "s2", displayName: "陈舟", content: "更喜欢个人阅读" },
        ],
        keywordMode: "llm",
        terms: [{ label: "团队协作", value: 1, studentIds: ["s1"] }],
      }] },
    }), { status: 200 }));
    render(<SurveyDashboardPage />);
    fireEvent.click(await screen.findByRole("button", { name: "团队协作" }));
    expect(screen.getByText("组员之间配合默契")).toBeInTheDocument();
    expect(screen.queryByText("更喜欢个人阅读")).not.toBeInTheDocument();
  });
  it.each(["ai", "ＡＩ"])("matches normalized word-cloud term %s against full-width source responses", async (label) => {
    const textResult = {
      ...result,
      analytics: {
        ...result.analytics,
        questions: [{
          id: "text",
          title: "你学到了什么？",
          type: "short-text",
          required: true,
          responseCount: 1,
          responses: [{ studentId: "s1", displayName: "林晓", content: "我想了解ＡＩ技术" }],
          terms: [{ label, value: 1 }],
        }],
      },
    };
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify(textResult), { status: 200 }));
    render(<SurveyDashboardPage />);

    fireEvent.click(await screen.findByRole("button", { name: label }));
    expect(screen.getByText("我想了解ＡＩ技术")).toBeInTheDocument();
    expect(screen.getByText("林晓")).toBeInTheDocument();
  });

  it.each(["bar", "column"])("renders multiple-choice %s proportions and opens the selected students", async (chartType) => {
    const multipleChoice = {
      ...result,
      analytics: {
        ...result.analytics,
        questions: [{
          id: "multiple",
          title: "你关注哪些技术？",
          type: "multiple-choice",
          chartType,
          required: true,
          responseCount: 20,
          options: [
            { id: "ai", label: "人工智能", count: 20, percentage: 66.7, respondents: [{ studentId: "s1", displayName: "林晓" }] },
            { id: "data", label: "数据分析", count: 9, percentage: 30, respondents: [] },
            { id: "robot", label: "利用人工智能支持学生开展跨学科项目学习", count: 1, percentage: 3.3, respondents: [{ studentId: "s2", displayName: "陈舟", detail: "想了解机械臂" }] },
            { id: "other", label: "其他", count: 0, percentage: 0, respondents: [] },
          ],
        }],
      },
    };
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify(multipleChoice), { status: 200 }));
    render(<SurveyDashboardPage />);

    const chart = await screen.findByRole("group", { name: chartType === "column" ? "选项比例柱状图" : "选项比例条形图" });
    const robot = within(chart).getByRole("button", { name: "利用人工智能支持学生开展跨学科项目学习，3.3%，1 人" });
    const empty = within(chart).getByRole("button", { name: "其他，0%，0 人" });
    expect(screen.getByText(/按本题总选择人次计算占比/)).toBeInTheDocument();
    if (chartType === "column") {
      expect(chart).toHaveStyle({ "--survey-option-count": "4" });
      expect(robot).toHaveStyle({ "--survey-option-color": "#7c3aed" });
      expect(robot.querySelector("small")).toHaveAttribute("title", "利用人工智能支持学生开展跨学科项目学习");
      expect(robot.querySelector("span > i")).toHaveStyle({ "--survey-option-ratio": "0.04" });
      expect(empty.querySelector("span > i")).toHaveStyle({ "--survey-option-ratio": "0" });
    } else {
      expect(robot.querySelector("i > b")).toHaveStyle({ "--survey-option-ratio": "0.04" });
      expect(empty.querySelector("i > b")).toHaveStyle({ "--survey-option-ratio": "0" });
    }
    fireEvent.click(robot);
    expect(robot).toHaveAttribute("aria-pressed", "true");
    const matchingChoice = document.querySelector<HTMLElement>('.survey-choice-row[data-option-id="robot"]');
    expect(matchingChoice).toHaveAttribute("aria-pressed", "true");
    expect(matchingChoice).toHaveStyle({ "--survey-option-color": "#7c3aed" });
    expect(screen.getByText("选择“利用人工智能支持学生开展跨学科项目学习”的学生")).toBeInTheDocument();
    expect(screen.getByText("陈舟")).toBeInTheDocument();
    expect(screen.getByText("想了解机械臂")).toBeInTheDocument();
    const dataChoice = document.querySelector<HTMLButtonElement>('.survey-choice-row[data-option-id="data"]');
    const dataChartItem = chart.querySelector<HTMLElement>('[data-option-id="data"]');
    fireEvent.click(dataChoice!);
    expect(robot).toHaveAttribute("aria-pressed", "false");
    expect(dataChoice).toHaveAttribute("aria-pressed", "true");
    expect(dataChartItem).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("陈舟")).not.toBeInTheDocument();
  });

  it("links donut slices and right-side choices in both directions", async () => {
    const donutResult = {
      ...result,
      analytics: {
        ...result.analytics,
        questions: [{
          id: "donut",
          title: "你对课堂节奏的看法？",
          type: "single-choice",
          chartType: "donut",
          required: true,
          responseCount: 5,
          options: [
            { id: "good", label: "合适", count: 3, percentage: 60, respondents: [{ studentId: "s1", displayName: "林晓" }] },
            { id: "fast", label: "偏快", count: 2, percentage: 40, respondents: [{ studentId: "s2", displayName: "陈舟" }] },
            { id: "empty", label: "偏慢", count: 0, percentage: 0, respondents: [] },
          ],
        }],
      },
    };
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify(donutResult), { status: 200 }));
    const { container } = render(<SurveyDashboardPage />);

    const chart = await screen.findByRole("group", { name: "选项比例饼图" });
    const goodSlice = within(chart).getByRole("button", { name: "合适，60%，3 人" });
    const fastSlice = within(chart).getByRole("button", { name: "偏快，40%，2 人" });
    expect(within(chart).queryByRole("button", { name: "偏慢，0%，0 人" })).not.toBeInTheDocument();
    fireEvent.click(goodSlice);
    const goodChoice = container.querySelector<HTMLButtonElement>('.survey-choice-row[data-option-id="good"]');
    expect(goodSlice).toHaveAttribute("aria-pressed", "true");
    expect(goodChoice).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector(".survey-donut-center")).toHaveTextContent("60%合适");
    expect(screen.getByText("选择“合适”的学生")).toBeInTheDocument();

    const fastChoice = container.querySelector<HTMLButtonElement>('.survey-choice-row[data-option-id="fast"]');
    fireEvent.click(fastChoice!);
    expect(goodSlice).toHaveAttribute("aria-pressed", "false");
    expect(fastSlice).toHaveAttribute("aria-pressed", "true");
    expect(fastChoice).toHaveAttribute("aria-pressed", "true");
    expect(goodSlice).not.toHaveClass("is-selected");
    expect(fastSlice).toHaveClass("is-selected");
    expect(container.querySelector(".survey-donut-center")).toHaveTextContent("40%偏快");
    expect(screen.getByText("选择“偏快”的学生")).toBeInTheDocument();
  });

  it("starts presentation question rotation paused", async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } }));
    render(<SurveyDashboardPage />);

    await screen.findByRole("heading", { name: "课堂反馈" });
    fireEvent.click(screen.getByRole("button", { name: "大屏显示" }));

    expect(screen.getByRole("button", { name: "开始轮播" })).toBeInTheDocument();
    expect(screen.getByText("手动浏览题目")).toBeInTheDocument();
  });

  it("reveals named students for a choice and named source responses for a word", async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } }));
    const { container } = render(<SurveyDashboardPage />);

    await screen.findByRole("heading", { name: "课堂反馈" });
    expect(container.querySelector(".survey-column-chart")).toBeInTheDocument();
    const choiceRow = container.querySelector<HTMLButtonElement>(".survey-choice-row");
    expect(choiceRow).not.toBeNull();
    fireEvent.click(choiceRow!);
    expect(screen.getByText("选择“合适”的学生")).toBeInTheDocument();
    expect(screen.getByText("林晓")).toBeInTheDocument();
    expect(screen.getByText("陈舟")).toBeInTheDocument();
    expect(screen.getByText("讨论环节有一点快")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /你学到了什么/ }));
    fireEvent.click(screen.getByRole("button", { name: "合作" }));
    await waitFor(() => expect(screen.getByText("合作帮助我理解了设计思维")).toBeInTheDocument());
    expect(screen.getByText("林晓")).toBeInTheDocument();
    expect(screen.queryByText("陈舟")).not.toBeInTheDocument();
  });
});
