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
    expect(mocks.callLLM.mock.calls[0][0].system).toContain("最小且可独立理解的核心词");
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

  it("limits each response to three evidence phrases and rejects overly long phrases without truncating them", async () => {
    const terms = Array.from({ length: 20 }, (_, index) => `concept${index}`);
    const tooLong = "长".repeat(49);
    mocks.callLLM.mockResolvedValue({ text: JSON.stringify({ responses: [{ id: 0, terms: [tooLong, ...terms] }] }) });
    const model = await resolveSurveyLlmKeywordModel();
    expect(await model.extract("题目", [[tooLong, ...terms].join(" ")])).toEqual([terms.slice(0, 3)]);
  });

  it("asks for atomic source words instead of composing related course concepts", async () => {
    mocks.callLLM.mockResolvedValue({ text: JSON.stringify({ responses: [
      { id: 0, terms: ["机器人", "编程", "编程教育"] },
      { id: 1, terms: ["人工智能", "编程"] },
    ] }) });
    const model = await resolveSurveyLlmKeywordModel();
    expect(await model.extract("人工智能教育", ["机器人和编程教育", "人工智能编程"])).toEqual([
      ["机器人", "编程"], ["人工智能", "编程"],
    ]);
    expect(mocks.callLLM.mock.calls[0][0].system).toContain("机器人和编程教育提取机器人、编程");
  });

  it("removes generic context suffixes from coordinated concepts across subject areas", async () => {
    mocks.callLLM.mockResolvedValue({ text: JSON.stringify({ responses: [
      { id: 0, terms: ["数据分析", "可视化技术"] },
      { id: 1, terms: ["历史教育"] },
    ] }) });
    const model = await resolveSurveyLlmKeywordModel();
    expect(await model.extract("关注方向", ["数据分析与可视化技术", "历史教育"])).toEqual([
      ["数据分析", "可视化"], ["历史教育"],
    ]);
  });

  it("consolidates synonymous evidence while preserving opposite sentiment and leaves counting to the caller", async () => {
    mocks.callLLM.mockResolvedValue({ text: JSON.stringify({ themes: [
      { canonicalEvidenceId: 0, evidenceIds: [0, 1] },
      { canonicalEvidenceId: 2, evidenceIds: [2] },
      { canonicalEvidenceId: 3, evidenceIds: [3] },
    ] }) });
    const model = await resolveSurveyLlmKeywordModel();
    const evidence = [
      { id: 0, responseId: 0, text: "小组协作" },
      { id: 1, responseId: 1, text: "组员配合" },
      { id: 2, responseId: 2, text: "反馈及时" },
      { id: 3, responseId: 3, text: "反馈太慢" },
    ];
    expect(await model.consolidate!("课堂体验", evidence)).toEqual([
      { canonicalEvidenceId: 0, evidenceIds: [0, 1] },
      { canonicalEvidenceId: 2, evidenceIds: [2] },
      { canonicalEvidenceId: 3, evidenceIds: [3] },
    ]);
    const request = mocks.callLLM.mock.calls[0][0];
    expect(request.system).toContain("反馈及时与反馈太慢等方向相反的评价也必须分开");
    expect(request.system).toContain("机器人与编程或编程教育不得合并");
    expect(request.system).toContain("返回全部有实质内容的主题组");
    expect(request.system).toContain("禁止创造、拼接或改写主题名称");
    expect(JSON.parse(request.prompt)).toMatchObject({ question: "课堂体验", evidence });
  });

  it("sanitizes recoverable theme rows without trusting invented labels or duplicate mappings", async () => {
    mocks.callLLM.mockResolvedValue({ text: `<think>draft</think>
      [{"label":"机器人编程","canonicalEvidenceId":9,"evidenceIds":[0,0,99]},
       {"canonicalEvidenceId":0,"evidenceIds":[1]},
       {"canonicalEvidenceId":2,"evidenceIds":[2]},
       {"evidenceIds":["invalid"]}]` });
    const model = await resolveSurveyLlmKeywordModel();
    await expect(model.consolidate!("题目", [
      { id: 0, responseId: 0, text: "小组协作" },
      { id: 1, responseId: 1, text: "团队合作" },
      { id: 2, responseId: 2, text: "小组协作" },
    ])).resolves.toEqual([
      { canonicalEvidenceId: 0, evidenceIds: [0, 2] },
      { canonicalEvidenceId: 1, evidenceIds: [1] },
    ]);
  });

  it("returns more than twelve valid themes without a presentation-layer cap", async () => {
    const evidence = Array.from({ length: 20 }, (_, id) => ({ id, responseId: id, text: `概念${id}` }));
    mocks.callLLM.mockResolvedValue({ text: JSON.stringify({ themes: evidence.map(({ id }) => ({
      canonicalEvidenceId: id, evidenceIds: [id],
    })) }) });
    const model = await resolveSurveyLlmKeywordModel();
    await expect(model.consolidate!("题目", evidence)).resolves.toHaveLength(20);
  });

  it.each([
    "invalid JSON", "{}", '{"themes":[]}',
    '{"themes":[{"canonicalEvidenceId":9,"evidenceIds":[99]}]}',
    '{"themes":[{"evidenceIds":"not-an-array"}]}',
  ])("rejects a theme result with no usable source evidence: %s", async (text) => {
    mocks.callLLM.mockResolvedValue({ text });
    const model = await resolveSurveyLlmKeywordModel();
    await expect(model.consolidate!("题目", [
      { id: 0, responseId: 0, text: "小组协作" },
    ])).rejects.toThrow("主题结果不完整或格式无效");
  });

  it.each([
    { baseUrl: "https://another.example/v1" }, { modelId: "another-model" },
    { providerId: "another-provider" }, { apiKey: "another-private-credential" },
  ])("isolates caches when the configured model connection changes: %j", async (change) => {
    const first = await resolveSurveyLlmKeywordModel();
    expect((await resolveSurveyLlmKeywordModel()).cacheKey).toBe(first.cacheKey);
    expect((await resolveSurveyLlmKeywordModel()).themeCacheKey).toBe(first.themeCacheKey);
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
