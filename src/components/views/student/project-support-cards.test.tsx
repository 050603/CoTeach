import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectMemoryPanel, ProjectSupportCard } from "./project-support-cards";

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

    expect(screen.getByText("1 条教材依据 · 1 条网页来源")).toBeInTheDocument();
    expect(screen.getByText("控制变量")).toBeInTheDocument();
    expect(screen.getByText(/只改变一个变量/)).toBeInTheDocument();
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
