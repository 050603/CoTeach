import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectMemoryPanel, ProjectReplyContent, ProjectSupportCard } from "./project-support-cards";

describe("project support cards", () => {
  it("shows textbook evidence, web evidence, knowledge links, and the next verification step", () => {
    render(<ProjectSupportCard support={{
      sources: [
        { id: "book", type: "textbook", title: "课程教材", locator: "第二章", excerpt: "教材片段" },
        { id: "web", type: "web", title: "官方资料", url: "https://example.com", excerpt: "网页片段" },
      ],
      knowledgePointIds: ["kp-1"],
      knowledgePoints: [{ id: "kp-1", label: "控制变量" }],
      nextStep: "只改变一个变量并记录结果。",
      retrievalStatus: "web-supplemented",
      retrievalNote: "教材不足后补充联网资料。",
    }} />);

    expect(screen.getByText("1 条教材参考 · 1 条网页来源")).toBeInTheDocument();
    expect(screen.getByText("控制变量")).toBeInTheDocument();
    expect(screen.getByText(/只改变一个变量/)).toBeInTheDocument();
  });

  it("renders structured and legacy sections without duplicate next steps", () => {
    const support = {
      sources: [], knowledgePointIds: [], knowledgePoints: [], retrievalStatus: "not-needed" as const,
      nextStep: "对比结果。",
      replyBlocks: [
        { type: "answer" as const, content: "先确定变量。", sourceIds: [] },
        { type: "next-step" as const, content: "对比结果。", sourceIds: [] },
      ],
    };
    const { rerender } = render(<><ProjectReplyContent content="兼容文本" support={support} /><ProjectSupportCard replyContent="兼容文本" support={support} /></>);
    expect(screen.getByText("下一步")).toBeInTheDocument();
    expect(screen.getAllByText("对比结果。")).toHaveLength(1);
    rerender(<ProjectReplyContent content={"观察：先记录现象。\n可执行支架：试两组输入。"} />);
    expect(screen.getByText("现状分析")).toBeInTheDocument();
    expect(screen.getByText("建议做法")).toBeInTheDocument();
    expect(screen.queryByText(/观察：/)).not.toBeInTheDocument();
  });

  it("lets the student correct a remembered item", () => {
    const onUpdate = vi.fn();
    render(<ProjectMemoryPanel
      memories={[{
        id: "memory-1",
        kind: "student-decision",
        content: "先采用方案 A。",
        stageKey: "make",
        sourceMessageIds: ["message-1"],
        createdAt: "2026-09-22T00:00:00.000Z",
        updatedAt: "2026-09-22T00:00:00.000Z",
      }]}
      onClear={vi.fn()}
      onDelete={vi.fn()}
      onUpdate={onUpdate}
    />);

    fireEvent.click(screen.getByRole("button", { name: "修改这条项目记忆" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "先采用方案 B，并保留 A 作为对照。" } });
    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    expect(onUpdate).toHaveBeenCalledWith("memory-1", "先采用方案 B，并保留 A 作为对照。");
  });
});
