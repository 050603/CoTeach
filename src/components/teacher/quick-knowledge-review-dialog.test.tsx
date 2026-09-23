import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuickKnowledgeReviewDialog } from "./quick-knowledge-review-dialog";

vi.mock("@/components/knowledge-graph-flow", () => ({
  KnowledgeGraphFlow: () => <div data-testid="knowledge-graph-preview" />,
}));

describe("QuickKnowledgeReviewDialog", () => {
  it("shows the confirmed teaching order, textbook chapter, and adjustment reason", () => {
    render(<QuickKnowledgeReviewDialog
      initialKnowledgeGraph={{ nodes: [], edges: [] }}
      initialKnowledgePoints={[{ id: "base", name: "基础", description: "对象" },
        { id: "apply", name: "应用", description: "判断" }]}
      knowledgeScopePlan={{
        schemaVersion: 1, planningDurationMin: 30, durationRangeMin: 30, durationRangeMax: 30,
        durationSource: "course-range", assessmentReserveMin: 3, explanationAndActivityMin: 27,
        sourcePointCount: 0, targetPointCount: 2, rationale: "教材递进", decisions: [],
        teachingOrder: {
          primaryRevisionId: "main", baselineKnowledgePointIds: ["apply", "base"],
          knowledgePointIds: ["base", "apply"],
          anchors: [{ knowledgePointId: "base", status: "primary-textbook", sectionPath: ["第一章", "基础"] },
            { knowledgePointId: "apply", status: "primary-textbook", sectionPath: ["第二章", "应用"] }],
          adjustments: [{ knowledgePointId: "base", beforeKnowledgePointId: "apply", kind: "necessary-dependency",
            obstacle: "先建立对象才能判断", basis: "基础是应用的必要前提" }],
        },
      }}
      onClose={vi.fn()} onConfirm={vi.fn()}
    />);
    const order = within(screen.getByRole("region", { name: "本课教学顺序" }));
    expect(order.getAllByRole("listitem").map((item) => item.querySelector("p")?.textContent))
      .toEqual(["1. 基础", "2. 应用"]);
    expect(order.getByText(/第一章 › 基础/)).toBeTruthy();
    expect(order.getByText(/先建立对象才能判断/)).toBeTruthy();
  });
  it("lets the teacher edit a knowledge point and continue with the edited graph", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <QuickKnowledgeReviewDialog
        initialKnowledgeGraph={{
          nodes: [{
            id: "kp-1",
            label: "旧名称",
            description: "旧说明",
            level: "core",
            instructionalRole: "lesson",
          }],
          edges: [],
        }}
        initialKnowledgePoints={[{
          id: "kp-1",
          name: "旧名称",
          description: "旧说明",
          level: "core",
        }]}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByTestId("knowledge-graph-preview")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "新名称" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    const [points, graph] = onConfirm.mock.calls[0];
    expect(points[0].name).toBe("新名称");
    expect(graph.nodes[0].label).toBe("新名称");
  });
});
