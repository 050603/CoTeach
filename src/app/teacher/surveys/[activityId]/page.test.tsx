import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
          { id: "good", label: "合适", count: 2, percentage: 100, respondents: [{ studentId: "s1", displayName: "林晓" }, { studentId: "s2", displayName: "陈舟" }] },
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

    fireEvent.click(screen.getByRole("button", { name: /你学到了什么/ }));
    fireEvent.click(screen.getByRole("button", { name: "合作" }));
    await waitFor(() => expect(screen.getByText("合作帮助我理解了设计思维")).toBeInTheDocument());
    expect(screen.getByText("林晓")).toBeInTheDocument();
    expect(screen.queryByText("陈舟")).not.toBeInTheDocument();
  });
});
