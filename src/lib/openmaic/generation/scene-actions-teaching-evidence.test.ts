import { describe, expect, it, vi } from "vitest";
import type { PPTElement } from "@openmaic/dsl";
import type { SceneOutline } from "@openmaic/lib/types/generation";
import { generateSceneActions } from "./scene-generator";

describe("narration shares complete teaching evidence", () => {
  it("passes late text, shape labels, chart data and source conditions without truncating them", async () => {
    const outline: SceneOutline = { id: "page", type: "slide", title: "证据边界", description: "结合实际数据解释", keyPoints: ["区分数据和结论"], order: 0,
      teachingBrief: { schemaVersion: 1, explanation: "必须根据独立测试判断", examples: [], conditions: ["不能复用训练集"], evidence: [], assessmentFocus: "说明判断依据" } };
    const elements = [
      { id: "text", type: "text", left: 60, top: 150, width: 500, height: 300, content: `<p>${"前置解释".repeat(30)}最后的必要条件不可省略</p>` },
      { id: "shape", type: "shape", left: 100, top: 150, width: 300, height: 100, text: { content: "形状中的实际结论" } },
      { id: "chart", type: "chart", left: 450, top: 180, width: 450, height: 250, chartType: "bar", data: { labels: ["测试组"], legends: ["正确率"], series: [[0.75]] } },
    ] as PPTElement[];
    const ai = vi.fn().mockResolvedValue(JSON.stringify([{ type: "text", content: "依据测试组的实际表现，解释边界条件。" }]));
    const actions = await generateSceneActions(outline, { elements }, ai, { teachingSourceContext: "原始教案：样本必须独立；记录正确率为0.75" });
    const prompt = ai.mock.calls[0][1];
    expect(prompt).toContain("最后的必要条件不可省略");
    expect(prompt).toContain("形状中的实际结论");
    expect(prompt).toContain("0.75");
    expect(prompt).toContain("原始教案：样本必须独立");
    expect(prompt).toContain("不能复用训练集");
    expect(actions.some((action) => action.type === "speech")).toBe(true);
  });
});
