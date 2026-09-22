import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TextbookKnowledgeNavigator } from "./textbook-knowledge-navigator";

describe("textbook chapter navigation", () => {
  it("preserves every chapter including same-name concepts and independently expands branches", () => {
    const select = vi.fn();
    render(<TextbookKnowledgeNavigator sections={[
      { id: "chapter", title: "第三章", position: 1 },
      { id: "section", parentId: "chapter", title: "教学方法", position: 2 },
      { id: "leaf", parentId: "section", title: "项目式学习", position: 3 },
    ]} concepts={[{ id: "method", sectionId: "section", name: "教学方法" }, { id: "project", sectionId: "leaf", name: "项目式学习" }, { id: "orphan", name: "孤立知识" }]} selectedSectionId="all" onSelectSection={select} />);
    expect(screen.queryByText("项目式学习")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    fireEvent.click(screen.getByText("项目式学习"));
    expect(select).toHaveBeenCalledWith("leaf");
    fireEvent.click(screen.getByText("教学方法"));
    expect(select).toHaveBeenCalledWith("section");
    expect(screen.queryByText("孤立知识")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /未归类知识/ }));
    expect(select).toHaveBeenCalledWith("unassigned");
    fireEvent.click(screen.getByRole("button", { name: "收起目录：第三章" }));
    expect(screen.queryByText("教学方法")).not.toBeInTheDocument();
  });
  it("automatically reveals ancestors of a deep linked section", () => {
    render(<TextbookKnowledgeNavigator sections={[{ id: "parent", title: "第一章" }, { id: "child", parentId: "parent", title: "目标章节" }]} concepts={[]} selectedSectionId="child" onSelectSection={vi.fn()} />);
    expect(screen.getByText("目标章节").closest("button")).toHaveAttribute("aria-current", "page");
  });
});
