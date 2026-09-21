import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TextbookKnowledgeNavigator } from "./textbook-knowledge-navigator";

describe("TextbookKnowledgeNavigator", () => {
  it("uses concepts as terminal leaves without duplicating the smallest section level", () => {
    const onSelectSection = vi.fn();
    const onSelectConcept = vi.fn();
    render(<TextbookKnowledgeNavigator
      sections={[
        { id: "chapter", title: "第三章", position: 1 },
        { id: "section", parentId: "chapter", title: "教学方法", position: 1 },
        { id: "leaf", parentId: "section", title: "项目式学习", position: 1 },
      ]}
      concepts={[
        { id: "method", sectionId: "section", name: "教学方法" },
        { id: "project", sectionId: "leaf", name: "项目式学习" },
        { id: "orphan", name: "未归类概念" },
      ]}
      relations={[]}
      selectedSectionId="all"
      selectedConceptId={null}
      onSelectSection={onSelectSection}
      onSelectConcept={onSelectConcept}
    />);

    expect(screen.getAllByRole("button", { name: "项目式学习" })).toHaveLength(1);
    expect(screen.getAllByText("教学方法")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "未归类概念" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "项目式学习" }));
    expect(onSelectConcept).toHaveBeenCalledWith("project", "leaf");

    fireEvent.click(screen.getByText("教学方法").closest("button")!);
    expect(onSelectConcept).toHaveBeenCalledWith("method", "section");

    fireEvent.click(screen.getByText("第三章").closest("button")!);
    expect(onSelectSection).toHaveBeenCalledWith("chapter");

    fireEvent.click(screen.getByRole("button", { name: "—未归类知识点1 个知识点" }));
    expect(onSelectSection).toHaveBeenCalledWith("unassigned");

    fireEvent.click(screen.getByRole("button", { name: "收起目录：第三章" }));
    expect(screen.queryByRole("button", { name: /教学方法/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开目录" }));
    expect(screen.getByText("教学方法")).toBeInTheDocument();
  });
});
