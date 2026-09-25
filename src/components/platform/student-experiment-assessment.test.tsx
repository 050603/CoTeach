import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudentExperimentAssessment, paginateExperimentQuestions, type ExperimentQuestion } from "./student-experiment-assessment";

const group = { id: "g", title: "研究情境", instruction: "阅读情境后作答" };
const questions: ExperimentQuestion[] = [
  { id: "q1", type: "single-choice", prompt: "第一题", options: ["甲", "乙"], group },
  { id: "q2", type: "multiple-choice", prompt: "第二题", options: ["甲", "乙"], group },
  { id: "q3", type: "true-false", prompt: "第三题" },
  { id: "q4", type: "scale", prompt: "第四题", scale: { min: 1, max: 5 } },
  { id: "q5", type: "short-answer", prompt: "第五题" },
];

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function assessment(draft: unknown = null, submission: unknown = null) {
  return { enabled: true, available: true, questions, draft, submission, studentKey: "student-1" };
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("student experiment assessment", () => {
  it("lets students skip experience ratings with a reason and leave feedback blank", async () => {
    const optionalQuestions: ExperimentQuestion[] = [
      { id: "knowledge", type: "single-choice", prompt: "知识题", options: ["甲", "乙"] },
      { id: "experience", type: "scale", prompt: "体验题", scale: { min: 1, max: 7 }, optional: true, skipReasonRequired: true },
      { id: "feedback", type: "short-answer", prompt: "一条课堂反馈", optional: true },
    ];
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_url, options) => options?.method === "POST"
      ? response({ submission: { id: "s1", submittedAt: "2026-01-01T00:01:00Z" } })
      : options?.method === "PUT"
        ? response({ draft: { answers: { knowledge: "甲" }, currentPage: 0, version: 1, updatedAt: "2026-01-01T00:00:00Z" } })
        : response({ ...assessment({ answers: { knowledge: "甲" }, currentPage: 0, version: 1, updatedAt: "2026-01-01T00:00:00Z" }), questions: optionalQuestions, variant: "A_PRE_B_POST", minutes: 15, skipReasonPrompt: "跳题原因" }));
    render(<StudentExperimentAssessment instanceId="run-1" phase="posttest" />);
    await screen.findByText("体验题");
    expect(screen.getByRole("heading", { name: "后测｜情境B" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "检查并提交" }));
    expect(screen.getByRole("button", { name: "确认提交后测" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "跳题原因" }), { target: { value: "技术故障" } });
    fireEvent.click(screen.getByRole("button", { name: "确认提交后测" }));
    await screen.findByText(/提交时间：/);
    const post = fetchMock.mock.calls.find(([, options]) => options?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body)).answers).toEqual({ knowledge: "甲", __skipReason: "技术故障" });
  });
  it("keeps authored groups together and paginates consecutive ungrouped questions in fives", () => {
    const input = [...questions.slice(0, 2), ...Array.from({ length: 32 }, (_, index) => ({ id: `u${index}`, type: "short-answer" as const, prompt: `问题 ${index}` }))];
    const pages = paginateExperimentQuestions(input);
    expect(pages.map((page) => page.questions.length)).toEqual([2, 5, 5, 5, 5, 5, 5, 2]);
    expect(pages[0].group?.title).toBe("研究情境");
    expect(pages.at(-1)?.startIndex).toBe(32);
    expect(pages.flatMap((page) => page.questions.map((question) => question.id))).toEqual(input.map((question) => question.id));
  });

  it("restores the assigned draft and submits all question types through the check page", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_url, options) => options?.method === "POST"
      ? response({ submission: { id: "submission-1", phase: "posttest", submittedAt: "2026-01-01T00:01:00Z" } })
      : options?.method === "PUT"
        ? response({ draft: { answers: {}, currentPage: 1, version: 3, updatedAt: "2026-01-01T00:00:01Z" } })
        : response(assessment({ answers: { q1: "甲", q2: ["甲"], q3: "true", q4: "3" }, currentPage: 1, version: 2, updatedAt: "2026-01-01T00:00:00Z" })));
    render(<StudentExperimentAssessment instanceId="run-1" phase="posttest" />);
    await screen.findByText("第三题");
    expect(screen.getByText(/已完成 4 \/ 5 题/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "第五题" }), { target: { value: "我的想法" } });
    fireEvent.click(screen.getByRole("button", { name: "检查并提交" }));
    expect(screen.getByText("所有题目已完成")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认提交后测" }));
    await screen.findByText(/提交时间：/);
    const post = fetchMock.mock.calls.find(([, options]) => options?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body)).answers).toEqual({ q1: "甲", q2: ["甲"], q3: "true", q4: "3", q5: "我的想法" });
    expect(screen.getByRole("textbox", { name: "第五题" })).toHaveAttribute("readonly");
  });

  it("shows an explicit choice when the server draft changed in another tab", async () => {
    localStorage.setItem("experiment-draft:v1:student-1:run-1:posttest", JSON.stringify({ answers: { q1: "甲" }, currentPage: 0, version: 1, updatedAt: "2026-01-01T00:00:00Z", pending: true }));
    vi.mocked(fetch).mockResolvedValueOnce(response(assessment({ answers: { q1: "乙" }, currentPage: 0, version: 2, updatedAt: "2026-01-01T00:01:00Z" })));
    render(<StudentExperimentAssessment instanceId="run-1" phase="posttest" />);
    expect(await screen.findByText("另一页面更新了这份草稿")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "使用服务器版本" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "乙" })).toBeChecked());
    expect(vi.mocked(fetch).mock.calls.filter(([, options]) => options?.method === "PUT")).toHaveLength(0);
  });

  it("saves answers and current page with a version, then advances the saved version", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_url, options) => options?.method === "PUT"
      ? response({ draft: { answers: { q1: "甲" }, currentPage: 1, version: 1, updatedAt: "2026-01-01T00:00:01Z" } })
      : response(assessment()));
    render(<StudentExperimentAssessment instanceId="run-1" phase="posttest" />);
    await screen.findByText("第一题");
    fireEvent.click(screen.getByRole("radio", { name: "甲" }));
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(true));
    await waitFor(() => expect(screen.getByText("已保存")).toBeInTheDocument());
    const put = fetchMock.mock.calls.find(([, options]) => options?.method === "PUT");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ phase: "posttest", answers: { q1: "甲" }, currentPage: 1, version: 0 });
    expect(JSON.parse(localStorage.getItem("experiment-draft:v1:student-1:run-1:posttest") ?? "null")).toMatchObject({ version: 1, pending: false });
  });

  it("recovers a successful submission when the response is lost", async () => {
    const complete = { q1: "甲", q2: ["甲"], q3: "true", q4: "3", q5: "说明" };
    const fetchMock = vi.mocked(fetch);
    let readCount = 0;
    fetchMock.mockImplementation(async (_url, options) => {
      if (options?.method === "POST") throw new Error("连接中断");
      if (options?.method === "PUT") return response({ draft: { answers: complete, currentPage: 1, version: 2, updatedAt: "2026-01-01T00:00:00Z" } });
      readCount++;
      return response(assessment({ answers: complete, currentPage: 1, version: 1, updatedAt: "2026-01-01T00:00:00Z" }, readCount > 1 ? { id: "s1", answers: complete, submittedAt: "2026-01-01T00:01:00Z" } : null));
    });
    render(<StudentExperimentAssessment instanceId="run-1" phase="posttest" />);
    await screen.findByText("第三题");
    fireEvent.click(screen.getByRole("button", { name: "检查并提交" }));
    fireEvent.click(screen.getByRole("button", { name: "确认提交后测" }));
    expect(await screen.findByText(/提交时间：/)).toBeInTheDocument();
    expect(screen.queryByText("连接中断")).not.toBeInTheDocument();
  });

  it("shows saved answers after completion even when new submissions are closed", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ ...assessment(null, { id: "s1", answers: { q1: "乙" }, submittedAt: "2026-01-01T00:00:00Z" }), available: false }));
    render(<StudentExperimentAssessment instanceId="run-1" phase="posttest" />);
    expect(await screen.findByText(/提交时间：/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "乙" })).toBeDisabled();
  });
});
