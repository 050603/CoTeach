import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCAL_SURVEY_MODEL, resolveSurveyKeywordModel } from "./survey-keyword-model";
const llm = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("./survey-keyword-llm", () => ({ resolveSurveyLlmKeywordModel: llm.resolve }));

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("local neural survey tokenizer", () => {
  it("uses the LLM adapter only when explicitly selected", async () => {
    const remote = { cacheKey: "llm", modelName: "configured", extract: vi.fn() };
    llm.resolve.mockResolvedValue(remote);
    llm.resolve.mockClear();
    await resolveSurveyKeywordModel("local");
    expect(llm.resolve).not.toHaveBeenCalled();
    expect(await resolveSurveyKeywordModel("llm")).toBe(remote);
    expect(llm.resolve).toHaveBeenCalledOnce();
  });
  it("only calls the loopback service and filters function words without a domain dictionary", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ model: LOCAL_SURVEY_MODEL, tokens: [["我们", "讨论", "人工智能", "和", "机器学习", "。"]] }));
    vi.stubGlobal("fetch", fetch);
    const model = await resolveSurveyKeywordModel();
    expect(await model.extract("收获", ["我们讨论人工智能和机器学习。"]))
      .toEqual([["讨论", "人工智能", "机器学习"]]);
    const [url, options] = fetch.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:3003/tokenize");
    expect(options.headers).not.toHaveProperty("Authorization");
    expect(options.redirect).toBe("error");
  });

  it("normalizes mixed scripts, removes duplicate tokens, and rejects unsupported terms", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ model: LOCAL_SURVEY_MODEL, tokens: [["ＡＩ", "ai", "3D打印", "H₂O", "123", "！", "幻觉词"]] })));
    const model = await resolveSurveyKeywordModel();
    expect(await model.extract("", ["ＡＩ ai 3D打印 H₂O 123！"])).toEqual([["ai", "3d打印", "h2o"]]);
  });

  it("removes common survey filler before local frequency aggregation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ model: LOCAL_SURVEY_MODEL, tokens: [["我们", "觉得", "可以", "课程", "这个", "团队协作"]] })));
    const model = await resolveSurveyKeywordModel();
    expect(await model.extract("课程体验", ["我们觉得这个课程可以加强团队协作"])).toEqual([["团队协作"]]);
  });

  it.each([
    { model: LOCAL_SURVEY_MODEL, tokens: [] },
    { model: "different-model", tokens: [["人工智能"]] },
    { model: LOCAL_SURVEY_MODEL, tokens: [[1]] },
    { model: LOCAL_SURVEY_MODEL, tokens: "人工智能" },
  ])("rejects incomplete or incompatible model output", async (result) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(result)));
    const model = await resolveSurveyKeywordModel();
    await expect(model.extract("", ["人工智能"])).rejects.toThrow("格式不完整");
  });

  it("propagates local service unavailability instead of falling back to a remote model", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const model = await resolveSurveyKeywordModel();
    await expect(model.extract("", ["人工智能"])).rejects.toThrow("暂时不可用");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("enforces batch limits before sending a request", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const model = await resolveSurveyKeywordModel();
    await expect(model.extract("", Array(25).fill("人工智能"))).rejects.toThrow("批次过大");
    await expect(model.extract("", ["文".repeat(12_001)])).rejects.toThrow("批次过大");
    expect(await model.extract("", [])).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a nonlocal endpoint to keep student answers on this machine", async () => {
    vi.stubEnv("OPENPBL_NLP_URL", "https://example.com");
    await expect(resolveSurveyKeywordModel()).rejects.toThrow("回环地址");
  });
});
