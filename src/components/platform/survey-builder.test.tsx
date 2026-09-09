import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SurveyQuestion } from "@/lib/platform/survey";
import { SurveyBuilder } from "./survey-builder";

const question: SurveyQuestion = {
  id: "q1",
  title: "课堂节奏如何？",
  type: "single-choice",
  chartType: "donut",
  required: true,
  options: [{ id: "a", label: "合适" }, { id: "b", label: "偏快" }],
};

describe("survey builder", () => {
  it("configures multi-choice questions and a semantically valid chart per question", () => {
    const onChange = vi.fn();
    const view = render(<SurveyBuilder questions={[question]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "多选题" }));
    const multiQuestion = onChange.mock.calls[0][0][0] as SurveyQuestion;
    expect(multiQuestion).toMatchObject({ type: "multiple-choice", chartType: "bar" });

    view.rerender(<SurveyBuilder questions={[multiQuestion]} onChange={onChange} />);
    expect(screen.queryByRole("button", { name: /环状图/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /柱状图/ }));
    expect(onChange.mock.calls.at(-1)?.[0][0]).toMatchObject({ type: "multiple-choice", chartType: "column" });
  });
});
