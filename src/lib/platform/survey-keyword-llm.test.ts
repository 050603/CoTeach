import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ callLLM: vi.fn(), resolveModel: vi.fn() }));
vi.mock("@openmaic/lib/ai/llm", () => ({ callLLM: mocks.callLLM }));
vi.mock("@openmaic/lib/server/resolve-model", () => ({ resolveModel: mocks.resolveModel }));

import { resolveSurveyLlmKeywordModel } from "./survey-keyword-llm";

const configuredModel = {
  model: "managed-model", modelString: "managed:context-model", providerId: "managed",
  modelId: "context-model", baseUrl: "https://provider.example/v1", apiKey: "private-test-credential",
};

beforeEach(() => { vi.resetAllMocks(); mocks.resolveModel.mockResolvedValue(configuredModel); });
afterEach(() => vi.restoreAllMocks());

describe("managed LLM survey concept extraction", () => {
  it("normalizes supported phrases, removes their fragments and preserves each source mapping", async () => {
    mocks.callLLM.mockResolvedValue({ text: JSON.stringify({ responses: [
      { id: 1, terms: ["单细胞测序", "人工智能", "不存在的概念"] },
      { id: 0, terms: [" 人工智能 ", "智能", "人工智能", "ＡＩ Agent", "ai", "单细胞测序"] },
    ] }) });
    const model = await resolveSurveyLlmKeywordModel();
    expect(await model.extract("学习了什么？", ["人工智能和 AI Agent", "了解单细胞测序"]))
      .toEqual([["人工智能", "ai agent"], ["单细胞测序"]]);
    expect(mocks.resolveModel).toHaveBeenCalledWith({});
    expect(mocks.callLLM).toHaveBeenCalledWith(expect.objectContaining({
      model: "managed-model", temperature: 0, maxRetries: 0, abortSignal: expect.any(AbortSignal),
    }), "survey-keywords-llm", { retries: 0 }, { enabled: false });
    expect(JSON.parse(mocks.callLLM.mock.calls[0][0].prompt)).toEqual({
      question: "学习了什么？", responses: [{ id: 0, text: "人工智能和 AI Agent" }, { id: 1, text: "了解单细胞测序" }],
    });
  });

  it("does not mistake an incidental Latin substring for a concept fragment", async () => {
    mocks.callLLM.mockResolvedValue({ text: '{"responses":[{"id":0,"terms":["AI","training","机器学习","学习"]}]}' });
    const model = await resolveSurveyLlmKeywordModel();
    expect(await model.extract("收获", ["AI training 机器学习"]))
      .toEqual([["ai", "training", "机器学习"]]);
  });

  it("retains concrete feedback and meaningful single-character opinions without inventing terms", async () => {
    mocks.callLLM.mockResolvedValue({ text: JSON.stringify({ responses: [
      { id: 0, terms: ["难", "的", "我", "课程困难"] },
      { id: 1, terms: ["反馈太慢", "慢", "响应延迟"] },
      { id: 2, terms: ["更多动手实践"] },
    ] }) });
    const model = await resolveSurveyLlmKeywordModel();
    expect(await model.extract("对课程的意见", ["难", "反馈太慢", "希望有更多动手实践"]))
      .toEqual([["难"], ["反馈太慢"], ["更多动手实践"]]);
    expect(mocks.callLLM.mock.calls[0][0].system).toContain("每条有实质内容的回答至少保留一个代表词");
  });

  it.each([
    "invalid JSON", "null", "{}", '{"responses":[]}',
    '{"responses":[{"id":0,"terms":[]},{"id":0,"terms":[]}]}',
    '{"responses":[{"id":0,"terms":[]},{"id":2,"terms":[]}]}',
    '{"responses":[{"id":0,"terms":[]},{"id":"1","terms":[]}]}',
    '{"responses":[{"id":0,"terms":[]},{"id":1,"terms":[null]}]}',
  ])("rejects incomplete or malformed responses: %s", async (text) => {
    mocks.callLLM.mockResolvedValue({ text });
    const model = await resolveSurveyLlmKeywordModel();
    await expect(model.extract("题目", ["甲", "乙"])).rejects.toThrow("结果不完整或格式无效");
  });

  it("accepts empty keywords and fenced JSON while excluding noninformative fragments", async () => {
    mocks.callLLM.mockResolvedValue({ text: '```JSON\n{"responses":[{"id":0,"terms":["我们","谢谢","１２３","！"]},{"id":1,"terms":[]}]}\n```' });
    const model = await resolveSurveyLlmKeywordModel();
    expect(await model.extract("题目", ["我们谢谢１２３！", "没有补充"]))
      .toEqual([[], []]);
  });

  it("checks batch bounds before spending a model call", async () => {
    const model = await resolveSurveyLlmKeywordModel();
    expect(await model.extract("题目", [])).toEqual([]);
    await expect(model.extract("题目", Array(25).fill("回答"))).rejects.toThrow("批次过大");
    await expect(model.extract("题目", ["字".repeat(12_001)])).rejects.toThrow("批次过大");
    await expect(model.extract("字".repeat(501), ["回答"])).rejects.toThrow("批次过大");
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it("limits meaningful terms and rejects overly long phrases without truncating them", async () => {
    const terms = Array.from({ length: 20 }, (_, index) => `concept${index}`);
    const tooLong = "长".repeat(49);
    mocks.callLLM.mockResolvedValue({ text: JSON.stringify({ responses: [{ id: 0, terms: [tooLong, ...terms] }] }) });
    const model = await resolveSurveyLlmKeywordModel();
    expect(await model.extract("题目", [[tooLong, ...terms].join(" ")])).toEqual([terms.slice(0, 16)]);
  });

  it.each([
    { baseUrl: "https://another.example/v1" }, { modelId: "another-model" },
    { providerId: "another-provider" }, { apiKey: "another-private-credential" },
  ])("isolates caches when the configured model connection changes: %j", async (change) => {
    const first = await resolveSurveyLlmKeywordModel();
    expect((await resolveSurveyLlmKeywordModel()).cacheKey).toBe(first.cacheKey);
    expect(first.cacheKey).not.toContain(configuredModel.apiKey);
    expect(first.cacheKey).not.toContain(configuredModel.baseUrl);
    expect(first.modelName).toBe(configuredModel.modelString);
    mocks.resolveModel.mockResolvedValue({ ...configuredModel, ...change });
    expect((await resolveSurveyLlmKeywordModel()).cacheKey).not.toBe(first.cacheKey);
  });

  it("uses a 30 second deadline and does not retry or fall back on provider failure", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    mocks.callLLM.mockRejectedValue(new Error("sensitive upstream request body"));
    const model = await resolveSurveyLlmKeywordModel();
    await expect(model.extract("题目", ["人工智能"])).rejects.toThrow("分析暂时不可用");
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(mocks.callLLM).toHaveBeenCalledOnce();
  });

  it("reports unconfigured models without trying another analysis mode", async () => {
    mocks.resolveModel.mockRejectedValue(new Error("configuration unavailable"));
    await expect(resolveSurveyLlmKeywordModel()).rejects.toThrow("未配置或暂时不可用");
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });
});
