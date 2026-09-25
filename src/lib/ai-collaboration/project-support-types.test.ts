import { describe, expect, it } from "vitest";
import { normalizeProjectSupportOutput, projectSupportJsonInstruction } from "./project-support-types";

describe("normalizeProjectSupportOutput", () => {
  it("limits concise reply guidance to document collaboration", () => {
    expect(projectSupportJsonInstruction()).toContain("复杂问题用 2 至 4 块");
    expect(projectSupportJsonInstruction("concise-document")).toContain("默认只用一个简洁的 answer 分块");
  });

  it("keeps server-provided sources and bounds model metadata", () => {
    const normalized = normalizeProjectSupportOutput({
      knowledgePointIds: ["kp-1", "kp-1", "kp-2"],
      nextStep: "比较两组输入的输出差异。",
      sourceIds: ["textbook:item-1"],
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

  it("shows only cited server sources and normalizes reply blocks", () => {
    const sources = [
      { id: "textbook:one", type: "textbook" as const, title: "教材一", excerpt: "有效依据" },
      { id: "textbook:two", type: "textbook" as const, title: "教材二", excerpt: "未使用片段" },
    ];
    const result = normalizeProjectSupportOutput({
      sourceIds: ["textbook:one", "invented", "textbook:one"],
      nextStep: "重复的步骤",
      replyBlocks: [
        { type: "answer", content: "观察：先记录边界输入。", sourceIds: ["textbook:one", "invented"] },
        { type: "next-step", content: "下一步验证：对比结果。", sourceIds: [] },
      ],
    }, sources, { retrievalStatus: "textbook-supported" });
    expect(result.details.sources.map((source) => source.id)).toEqual(["textbook:one"]);
    expect(result.details.replyBlocks).toEqual([
      { type: "answer", content: "先记录边界输入。", sourceIds: ["textbook:one"] },
      { type: "next-step", content: "对比结果。", sourceIds: [] },
    ]);
    expect(result.details.nextStep).toBeUndefined();
  });

  it("does not display retrieved sources unless the model cites them", () => {
    const result = normalizeProjectSupportOutput({}, [{
      id: "textbook:one", type: "textbook", title: "教材一", excerpt: "片段",
    }], { retrievalStatus: "textbook-supported" });
    expect(result.details.sources).toEqual([]);
  });
});
