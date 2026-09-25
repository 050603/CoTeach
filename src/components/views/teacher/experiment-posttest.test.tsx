import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import { NewExperimentPosttestTeacherView } from "./experiment-posttest";

const course = {
  id: "run-1",
  updatedAt: "2026-09-25T09:00:00.000Z",
  platformContext: { offeringId: "offering-1", activityId: "activity-1", templateId: "template", templateVersionId: "version" },
} as Course;

const results = {
  enabled: true,
  enrollmentCount: 3,
  pretestCount: 1,
  posttestCount: 1,
  posttestDraftCount: 1,
  posttestOpenedAt: "2026-09-25T09:00:00.000Z",
  variantCounts: { aPreBPost: 1, bPreAPost: 0 },
  studentRows: [
    { student: { id: "student-a", displayName: "小林" }, status: "submitted", submittedAt: "2026-09-25T09:10:00.000Z" },
    { student: { id: "student-b", displayName: "小周" }, status: "in-progress" },
    { student: { id: "student-c", displayName: "小陈" }, status: "not-started" },
  ],
  submissions: [
    { id: "pretest-a", phase: "pretest", variant: "A_PRE_B_POST", student: { id: "student-a", displayName: "小林", username: "lin" }, submittedAt: "2026-09-25T08:00:00.000Z", questionnaire: { pretest: [{ id: "pre-q", type: "short-answer", prompt: "原有想法" }], posttest: [] }, answers: { "pre-q": "先观察" }, objectiveScore: 0, objectiveTotal: 0 },
    { id: "posttest-a", phase: "posttest", variant: "A_PRE_B_POST", student: { id: "student-a", displayName: "小林", username: "lin" }, submittedAt: "2026-09-25T09:10:00.000Z", questionnaire: { pretest: [], posttest: [{ id: "post-q", type: "short-answer", prompt: "新的判断" }] }, answers: { "post-q": "再验证" }, objectiveScore: 0, objectiveTotal: 0 },
  ],
};

function mockResults(value: object) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => value }));
}

afterEach(() => vi.unstubAllGlobals());

describe("教师后测阶段", () => {
  it("shows formal submission counts and per-student draft state without treating old reflection as submission", async () => {
    mockResults(results);
    render(<NewExperimentPosttestTeacherView course={course} />);
    expect(await screen.findByText("草稿不计入提交人数。", { exact: false })).toBeTruthy();
    const summary = screen.getByLabelText("后测人数统计");
    expect(within(summary).getByText("未开始").parentElement?.textContent).toContain("1");
    expect(within(summary).getByText("作答中").parentElement?.textContent).toContain("1");
    expect(within(summary).getByText("已提交").parentElement?.textContent).toContain("1");
    expect(screen.getByText("小周").parentElement?.textContent).toContain("作答中");
    expect(screen.getByRole("link", { name: "实验配置" }).getAttribute("href")).toBe("/teacher/classes/offering-1/activities/activity-1/experiment");
    fireEvent.click(screen.getByText("小林"));
    expect(screen.getByText("学生作答：先观察")).toBeTruthy();
    expect(screen.getByText("学生作答：再验证")).toBeTruthy();
  });

  it("shows only aggregate progress on the projected view", async () => {
    mockResults(results);
    render(<NewExperimentPosttestTeacherView course={course} presentation="teaching" />);
    expect(await screen.findByText("1/3 人已提交正式后测。草稿不计入提交人数。")).toBeTruthy();
    expect(screen.queryByText("小林")).toBeNull();
    expect(screen.queryByText("学生作答：再验证")).toBeNull();
    expect(screen.queryByRole("button", { name: "导出实验数据" })).toBeNull();
  });

  it("points the teacher to setup when the experiment is disabled", async () => {
    mockResults({ ...results, enabled: false, submissions: [], studentRows: [] });
    render(<NewExperimentPosttestTeacherView course={course} />);
    expect(await screen.findByText("本课堂未开启后测")).toBeTruthy();
    expect(screen.getByRole("link", { name: "进入实验配置" }).getAttribute("href")).toBe("/teacher/classes/offering-1/activities/activity-1/experiment");
  });
});
