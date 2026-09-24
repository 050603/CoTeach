import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExperimentConfig } from "@/lib/platform/experiment";
import { ExperimentPreview } from "./experiment-preview";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const pairedConfig: ExperimentConfig = {
  enabled: true,
  sharedQuestions: [{ id: "shared", type: "single-choice", prompt: "共同题", options: ["甲", "乙"], correctAnswer: "乙" }],
  pretest: [{ id: "before", type: "true-false", prompt: "课前判断", correctAnswer: "true" }],
  posttest: [{ id: "after", type: "scale", prompt: "课后信心", scale: { min: 1, max: 5, minLabel: "低", maxLabel: "高" }, category: "confidence" }],
  scenarioPair: {
    a: { id: "scenario-a", type: "short-answer", prompt: "情境 A 问题", correctAnswer: "仅供教师查看的参考答案" },
    b: { id: "scenario-b", type: "short-answer", prompt: "情境 B 问题" },
  },
  randomizeQuestionOrder: false,
  randomizeOptionOrder: false,
};

describe("teacher experiment preview", () => {
  it("switches phase and A/B assignment while showing only student-visible question data", () => {
    render(<ExperimentPreview config={pairedConfig} />);
    expect(screen.getByRole("tab", { name: "前测" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /A→B/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("group", { name: /共同题/ })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /课前判断/ })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /情境 A 问题/ })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /情境 B 问题/ })).toBeNull();
    expect(screen.queryByText("仅供教师查看的参考答案")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /B→A/ }));
    expect(screen.getByRole("group", { name: /情境 B 问题/ })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /情境 A 问题/ })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "后测" }));
    expect(screen.getByRole("group", { name: /情境 A 问题/ })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /课后信心/ })).toBeInTheDocument();
    expect(screen.getByText("量表题 · 学习信心")).toBeInTheDocument();
    expect(screen.getByText(/1 分 · 低/)).toBeInTheDocument();
    expect(screen.getByText(/5 分 · 高/)).toBeInTheDocument();
    expect(screen.queryByText("仅供教师查看的参考答案")).toBeNull();
  });

  it("allows local answers for all question types without submitting them", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const config: ExperimentConfig = {
      enabled: true,
      sharedQuestions: [],
      pretest: [
        { id: "single", type: "single-choice", prompt: "单选问题", options: ["甲", "乙"], correctAnswer: "乙" },
        { id: "multi", type: "multiple-choice", prompt: "多选问题", options: ["一", "二", "三"], correctAnswer: ["一", "二"] },
        { id: "judge", type: "true-false", prompt: "判断问题", correctAnswer: "false" },
        { id: "short", type: "short-answer", prompt: "简答问题" },
        { id: "scale", type: "scale", prompt: "量表问题", scale: { min: 1, max: 3 } },
      ],
      posttest: [],
      randomizeQuestionOrder: false,
      randomizeOptionOrder: false,
    };
    render(<ExperimentPreview config={config} />);
    fireEvent.click(within(screen.getByRole("group", { name: /单选问题/ })).getByRole("radio", { name: "甲" }));
    fireEvent.click(within(screen.getByRole("group", { name: /多选问题/ })).getByRole("checkbox", { name: "一" }));
    fireEvent.click(within(screen.getByRole("group", { name: /多选问题/ })).getByRole("checkbox", { name: "二" }));
    fireEvent.click(within(screen.getByRole("group", { name: /判断问题/ })).getByRole("radio", { name: "错误" }));
    fireEvent.change(screen.getByRole("textbox", { name: "简答问题" }), { target: { value: "我的想法" } });
    fireEvent.click(within(screen.getByRole("group", { name: /量表问题/ })).getByRole("radio", { name: "2 分" }));
    expect(within(screen.getByRole("group", { name: /单选问题/ })).getByRole("radio", { name: "甲" })).toBeChecked();
    expect(within(screen.getByRole("group", { name: /多选问题/ })).getAllByRole("checkbox", { checked: true })).toHaveLength(2);
    expect(within(screen.getByRole("group", { name: /判断问题/ })).getByRole("radio", { name: "错误" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "简答问题" })).toHaveValue("我的想法");
    expect(within(screen.getByRole("group", { name: /量表问题/ })).getByRole("radio", { name: "2 分" })).toBeChecked();
    expect(screen.queryByRole("button", { name: /提交/ })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps a reproducible example of randomized question and option order", () => {
    const config: ExperimentConfig = {
      ...pairedConfig,
      scenarioPair: undefined,
      randomizeQuestionOrder: true,
      randomizeOptionOrder: true,
      pretest: [
        { id: "one", type: "single-choice", prompt: "第一题", options: ["苹果", "香蕉", "梨"], correctAnswer: "苹果" },
        { id: "two", type: "single-choice", prompt: "第二题", options: ["红", "绿", "蓝"], correctAnswer: "绿" },
      ],
    };
    render(<ExperimentPreview config={config} />);
    expect(screen.getByText(/固定的随机顺序示例/)).toBeInTheDocument();
    const order = () => screen.getAllByRole("group").map((group) => group.querySelector("legend")?.textContent);
    const initialOrder = order();
    const firstOptions = within(screen.getByRole("group", { name: /第一题/ })).getAllByRole("radio").map((radio) => radio.closest("label")?.textContent);
    fireEvent.click(screen.getByRole("tab", { name: "后测" }));
    fireEvent.click(screen.getByRole("tab", { name: "前测" }));
    expect(order()).toEqual(initialOrder);
    expect(within(screen.getByRole("group", { name: /第一题/ })).getAllByRole("radio").map((radio) => radio.closest("label")?.textContent)).toEqual(firstOptions);
    expect(screen.queryByRole("tab", { name: /A→B/ })).toBeNull();
  });

  it("shows a useful placeholder while a scale question is still being configured", () => {
    render(<ExperimentPreview config={{
      ...pairedConfig,
      scenarioPair: undefined,
      sharedQuestions: [],
      pretest: [{ id: "draft-scale", type: "scale", prompt: "" }],
    }} />);
    expect(screen.getByRole("group", { name: /未填写题干/ })).toBeInTheDocument();
    expect(screen.getByText("请先在题目设置中填写有效量表范围。")).toBeInTheDocument();
  });
});
