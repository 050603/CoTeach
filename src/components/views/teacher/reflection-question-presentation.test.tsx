import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Course, ReflectionClassSummaryV1 } from "@/lib/session/types";
import { REFLECTION_SURVEY_QUESTIONS } from "@/lib/reflection-survey";

vi.mock("@/components/classroom/teacher-presentation-actions", () => ({ TeacherPresentationActions: ({ children }: { children: ReactNode }) => <div aria-label="底部阶段操作">{children}</div> }));
vi.mock("@/components/platform/survey-word-cloud", () => ({ SurveyWordCloud: ({ terms, onSelect }: { terms: Array<{ label: string; value: number }>; onSelect: (term: { label: string; value: number }) => void }) => <div aria-label="大词云">{terms.map((term) => <button key={term.label} onClick={() => onSelect(term)} type="button">{term.label}</button>)}</div> }));

import { ReflectionQuestionPresentation } from "./reflection-question-presentation";

const timestamp = "2026-09-12T00:00:00.000Z";
const course = {
  id: "course", content: {}, students: [{ id: "s1", name: "学生甲" }, { id: "s2", name: "学生乙" }],
  reflections: [{ id: "r1", courseId: "course", studentId: "s1", createdAt: timestamp, updatedAt: timestamp, survey: { schemaVersion: 1, learningReflection: "学会使用证据表达", systemReflection: "希望改进系统导航", aiHelpfulness: 5, systemUsability: 3, reuseIntention: 4 } }, { id: "r2", courseId: "course", studentId: "s2", createdAt: timestamp, updatedAt: timestamp, survey: { schemaVersion: 1, learningReflection: "学会团队讨论", systemReflection: "AI追问很有帮助", aiHelpfulness: 3, systemUsability: 4, reuseIntention: 5 } }],
} as unknown as Course;
const summary = {
  sourceRefs: course.reflections!.map((reflection) => ({ studentId: reflection.studentId, reflectionId: reflection.id, updatedAt: reflection.updatedAt })),
  categories: [{ key: "learning-gains", title: "收获", summary: "", terms: [{ label: "证据表达", sources: [{ studentId: "s1", fields: ["learningReflection"] }] }, { label: "导航改进", sources: [{ studentId: "s1", fields: ["systemReflection"] }] }] }],
} as ReflectionClassSummaryV1;

function props() { return { course, summary, presentation: "teaching" as const, onRefreshSummary: vi.fn(), summaryPending: false }; }

describe("ReflectionQuestionPresentation", () => {
  it("shows the complete question and only its own themes until evidence is requested", () => {
    render(<ReflectionQuestionPresentation {...props()} />);
    expect(screen.getByRole("heading", { name: REFLECTION_SURVEY_QUESTIONS.learningReflection })).toBeTruthy();
    expect(screen.queryByText("学生甲")).toBeNull();
    expect(screen.queryByText("学会使用证据表达")).toBeNull();
    expect(screen.getByRole("button", { name: "证据表达" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "导航改进" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "证据表达" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("学生甲")).toBeTruthy();
    expect(within(dialog).getByText("学会使用证据表达")).toBeTruthy();
    expect(within(dialog).queryByText("学生乙")).toBeNull();
    expect(within(dialog).queryByText("希望改进系统导航")).toBeNull();
  });

  it("keeps all five option rows, including zero counts, and filters evidence by the selected score", () => {
    render(<ReflectionQuestionPresentation {...props()} />);
    fireEvent.change(screen.getByRole("combobox", { name: "选择反思题目" }), { target: { value: "2" } });
    expect(screen.getByText("4.0")).toBeTruthy();
    expect(screen.getByRole("button", { name: "非常不同意，0 人，0%" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "不同意，0 人，0%" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "同意，0 人，0%" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "不确定，1 人，50%" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "非常同意，1 人，50%" }));
    expect(within(screen.getByRole("dialog")).getByText("学生甲")).toBeTruthy();
    expect(within(screen.getByRole("dialog")).queryByText("学生乙")).toBeNull();
  });

  it("clears evidence when changing modes without resetting the active question", () => {
    const input = props();
    const view = render(<ReflectionQuestionPresentation {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "下一道反思题" }));
    fireEvent.click(screen.getByRole("button", { name: "查看本题回答" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    view.rerender(<ReflectionQuestionPresentation {...input} presentation="analytics" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { name: REFLECTION_SURVEY_QUESTIONS.systemReflection })).toBeTruthy();
    expect(screen.getByRole("region", { name: "班级学情大屏" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "导航改进" })).toBeTruthy();
  });

  it("shows truthful empty results and requires an explicit eligible request to update themes", () => {
    const input = props();
    const view = render(<ReflectionQuestionPresentation {...input} summary={undefined} />);
    expect(input.onRefreshSummary).not.toHaveBeenCalled();
    expect(screen.getByText("本题暂无可展示的关键词")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "更新词云" }));
    expect(input.onRefreshSummary).toHaveBeenCalledTimes(1);
    view.rerender(<ReflectionQuestionPresentation {...input} course={{ ...course, reflections: [] }} summary={undefined} />);
    expect(screen.getByRole("button", { name: "更新词云" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: "选择反思题目" }), { target: { value: "4" } });
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByRole("button", { name: "非常同意，0 人，0%" })).toBeTruthy();
  });
});
