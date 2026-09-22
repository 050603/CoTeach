import { describe, expect, it } from "vitest";
import { normalizeProjectSupportOutput } from "./project-support-types";

describe("normalizeProjectSupportOutput", () => {
  it("keeps server-provided sources and bounds model metadata", () => {
    const normalized = normalizeProjectSupportOutput({
      knowledgePointIds: ["kp-1", "kp-1", "kp-2"],
      nextStep: "比较两组输入的输出差异。",
      memoryUpdates: [
        { kind: "attempt-result", content: "第一次测试在边界输入下失败。", rationale: "后续需要继续排查" },
        { kind: "invalid", content: "不能保存" },
      ],
    }, [{
      id: "textbook:item-1",
      type: "textbook",
      title: "课程教材",
      locator: "第三章 / 边界测试",
      excerpt: "边界值应单独设计测试。",
    }], {
      retrievalStatus: "textbook-supported",
      retrievalNote: "教材已支持。",
    }, { "kp-1": "知识点一", "kp-2": "知识点二" });

    expect(normalized.details.sources).toHaveLength(1);
    expect(normalized.details.knowledgePointIds).toEqual(["kp-1", "kp-2"]);
    expect(normalized.memoryCandidates).toEqual([expect.objectContaining({ kind: "attempt-result" })]);
  });
});
