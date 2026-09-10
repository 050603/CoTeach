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
    fireEvent.change(screen.getByLabelText("第 1 题最多可选"), { target: { value: "1" } });
    expect(onChange.mock.calls.at(-1)?.[0][0]).toMatchObject({ type: "multiple-choice", maxSelections: 1 });
    fireEvent.click(screen.getByRole("button", { name: /柱状图/ }));
    expect(onChange.mock.calls.at(-1)?.[0][0]).toMatchObject({ type: "multiple-choice", chartType: "column" });
  });

  it("lets teachers enable a follow-up input for an other option", () => {
    const onChange = vi.fn();
    const view = render(<SurveyBuilder questions={[question]} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("第 1 题选项 2"), { target: { value: "其他" } });
    const renamed = onChange.mock.calls.at(-1)?.[0][0] as SurveyQuestion;
    expect(renamed.options[1].label).toBe("其他");

    view.rerender(<SurveyBuilder questions={[renamed]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "第 1 题选项 2 要求补充填写" }));
    expect(onChange.mock.calls.at(-1)?.[0][0].options[1]).toMatchObject({ label: "其他", allowTextInput: true });
  });
});
