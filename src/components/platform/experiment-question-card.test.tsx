import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExperimentQuestionCard, ExperimentQuestionList } from "./experiment-question-card";

afterEach(cleanup);

describe("experiment question presentation", () => {
  it("keeps paragraph breaks and line breaks in long prompts and options", () => {
    const onAnswerChange = vi.fn();
    const question = { id: "choice", type: "single-choice" as const, prompt: "阅读下面的情境：\r\n你和同伴需要完成调查。\n\n你会先做什么？", options: ["先观察\n再记录", "直接提出结论"] };
    const { rerender } = render(<ExperimentQuestionCard answer={undefined} index={0} inputName="choice" onAnswerChange={onAnswerChange} question={question} />);
    const group = screen.getByRole("group", { name: /阅读下面的情境/ });
    const title = document.getElementById(group.getAttribute("aria-labelledby") ?? "")!;
    expect(title.querySelectorAll("p")).toHaveLength(2);
    expect(title.querySelectorAll("p")[0].textContent).toBe("阅读下面的情境：\n你和同伴需要完成调查。");
    expect(title.querySelectorAll("p")[0]).toHaveClass("whitespace-pre-wrap");
    const option = within(group).getByRole("radio", { name: /先观察\s+再记录/ });
    expect(option.closest("label")?.querySelector(".whitespace-pre-wrap")).toHaveClass("whitespace-pre-wrap");
    fireEvent.click(option);
    expect(onAnswerChange).toHaveBeenCalledWith("先观察\n再记录");
    rerender(<ExperimentQuestionCard answer={"先观察\n再记录"} index={0} inputName="choice" onAnswerChange={onAnswerChange} question={question} />);
    expect(option).toBeChecked();
    expect(option.closest("label")).toHaveClass("border-[var(--pbl-student)]");
  });

  it("shows readable scale endpoints and an explicit selected score", () => {
    const onAnswerChange = vi.fn();
    const question = { id: "scale", type: "scale" as const, prompt: "我能够完成任务", scale: { min: 0, max: 10, minLabel: "完全没有信心", maxLabel: "非常有信心" } };
    const { rerender } = render(<ExperimentQuestionCard answer={undefined} index={2} inputName="scale" onAnswerChange={onAnswerChange} question={question} />);
    expect(screen.getAllByRole("radio")).toHaveLength(11);
    expect(screen.getByText("0 分 · 完全没有信心")).toBeInTheDocument();
    expect(screen.getByText("10 分 · 非常有信心")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "7 分" }));
    expect(onAnswerChange).toHaveBeenCalledWith("7");
    rerender(<ExperimentQuestionCard answer="7" index={2} inputName="scale" onAnswerChange={onAnswerChange} question={question} />);
    expect(screen.getByRole("radio", { name: "7 分" })).toBeChecked();
    expect(screen.getByText("已选择 7 分")).toBeInTheDocument();
  });

  it("places related questions under one accessible title and shared instruction", () => {
    const group = { id: "confidence", title: "任务信心", instruction: "请根据现在的感受：\n选择最符合自己的一项。" };
    const questions = [
      { id: "first", type: "scale" as const, prompt: "我能完成任务", scale: { min: 1, max: 5 }, group },
      { id: "other", type: "short-answer" as const, prompt: "其他感受" },
      { id: "second", type: "scale" as const, prompt: "我能解决问题", scale: { min: 1, max: 5 }, group },
    ];
    const onAnswerChange = vi.fn();
    render(<ExperimentQuestionList answers={{}} inputNamePrefix="pretest" onAnswerChange={onAnswerChange} questions={questions} />);
    const section = screen.getByRole("region", { name: "任务信心" });
    expect(within(section).getAllByRole("group")).toHaveLength(2);
    expect(section).toHaveTextContent(/请根据现在的感受：\s*选择最符合自己的一项。/);
    expect(within(section).getAllByRole("group")[0]).toHaveAttribute("aria-describedby", expect.any(String));
    expect(screen.getAllByRole("group")).toHaveLength(3);
    fireEvent.click(within(section).getAllByRole("radio", { name: "4 分" })[0]);
    expect(onAnswerChange).toHaveBeenCalledWith("first", "4");
  });
});
