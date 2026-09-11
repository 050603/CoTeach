import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { SurveyQuestionAnalytics, SurveyTextAnalytics } from "./survey";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), extract: vi.fn(), redis: vi.fn() }));
vi.mock("./survey-keyword-model", () => ({ resolveSurveyKeywordModel: mocks.resolve }));
vi.mock("@/lib/redis/client", () => ({ getRedisClient: mocks.redis }));

function question(contents = ["人工智能 人工智能", "人工智能与机器学习"]): SurveyTextAnalytics {
  return { id: "q", title: "你的收获", type: "short-text", chartType: "donut", required: true, options: [], responseCount: contents.length,
    responses: contents.map((content, index) => ({ studentId: `s${index}`, displayName: `姓名${index}`, content })), terms: [] };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.redis.mockResolvedValue(null);
  mocks.resolve.mockResolvedValue({ cacheKey: "model-v1", modelName: "test", extract: mocks.extract });
  mocks.extract.mockResolvedValue([["人工智能", "人工智能"], ["人工智能", "机器学习"]]);
});
afterEach(() => vi.useRealTimers());

async function setup() {
  const { populateSurveyTerms } = await import("./survey-terms");
  const work: Array<() => Promise<void>> = [];
  const defer = (job: () => Promise<void>) => { work.push(job); };
  return { populateSurveyTerms: (scope: string, questions: SurveyQuestionAnalytics[], schedule: typeof defer) => populateSurveyTerms(scope, questions, schedule, 0), work, defer };
}

describe("local neural survey keyword cache", () => {
  it("defers LLM work immediately, isolates mode caches and reuses them after switching back", async () => {
    const { populateSurveyTerms } = await import("./survey-terms");
    mocks.resolve.mockImplementation(async (mode: string) => ({ cacheKey: mode, extract: mocks.extract }));
    mocks.extract.mockImplementation(async (_title: string, responses: string[]) => responses.map(() => ["人工智能"]));
    const work: Array<() => Promise<void>> = [];
    const defer = (job: () => Promise<void>) => { work.push(job); };
    const q = question(["人工智能"]);
    await populateSurveyTerms("activity", [q], defer, 500, "llm");
    expect(q).toMatchObject({ keywordMode: "llm", keywordStatus: "processing" });
    expect(mocks.extract).not.toHaveBeenCalled();
    await work.shift()!();
    await populateSurveyTerms("activity", [q], defer, 500, "local");
    expect(q).toMatchObject({ keywordMode: "local", keywordStatus: "ready" });
    await populateSurveyTerms("activity", [q], defer, 500, "llm");
    expect(q).toMatchObject({ keywordMode: "llm", keywordStatus: "ready" });
    expect(mocks.extract).toHaveBeenCalledTimes(2);
  });

  it("bounds LLM batches and keeps a slow remote call from delaying the local tokenizer", async () => {
    const { populateSurveyTerms } = await import("./survey-terms");
    let complete: (value: string[][]) => void = () => {};
    const remoteExtract = vi.fn(() => new Promise<string[][]>((resolve) => { complete = resolve; }));
    mocks.resolve.mockImplementation(async (mode: string) => ({ cacheKey: mode, extract: mode === "llm" ? remoteExtract : mocks.extract }));
    const work: Array<() => Promise<void>> = [];
    const defer = (job: () => Promise<void>) => { work.push(job); };
    await populateSurveyTerms("activity", [question(Array.from({ length: 9 }, (_, i) => `人工智能${i}`))], defer, 500, "llm");
    const remote = work.shift()!();
    await vi.waitFor(() => expect(remoteExtract).toHaveBeenCalledOnce());
    expect((remoteExtract.mock.calls[0] as unknown as [string, string[]])[1]).toHaveLength(8);
    const local = question();
    await populateSurveyTerms("activity", [local], defer, 500, "local");
    expect(local.keywordStatus).toBe("ready");
    complete(Array.from({ length: 8 }, () => ["人工智能"]));
    await remote;
  });

  it("includes fast local inference in the initial response", async () => {
    const { populateSurveyTerms } = await import("./survey-terms");
    const defer = vi.fn();
    const q = question();
    await populateSurveyTerms("activity", [q], defer);
    expect(q.keywordStatus).toBe("ready");
    expect(q.terms[0]).toMatchObject({ label: "人工智能", value: 2 });
    expect(mocks.extract).toHaveBeenCalledOnce();
  });

  it("stops waiting when inference exceeds the response budget and finishes in the background", async () => {
    const { populateSurveyTerms } = await import("./survey-terms");
    let complete: (value: string[][]) => void = () => {};
    mocks.extract.mockReturnValue(new Promise<string[][]>((resolve) => { complete = resolve; }));
    const work: Array<() => Promise<void>> = [];
    const defer = (job: () => Promise<void>) => { work.push(job); };
    const q = question();
    await populateSurveyTerms("activity", [q], defer, 1);
    expect(q.keywordStatus).toBe("processing");
    complete([["人工智能"], ["人工智能", "机器学习"]]);
    await work[0]();
    await populateSurveyTerms("activity", [q], defer);
    expect(q.keywordStatus).toBe("ready");
    expect(mocks.extract).toHaveBeenCalledOnce();
  });
  it("returns immediately, coalesces polling, and counts each respondent once from verified phrases", async () => {
    const { populateSurveyTerms, work, defer } = await setup();
    const q = question();
    await populateSurveyTerms("activity", [q], defer);
    expect(q).toMatchObject({ keywordStatus: "processing", terms: [] });
    expect(mocks.extract).not.toHaveBeenCalled();
    await populateSurveyTerms("activity", [question()], defer);
    expect(work).toHaveLength(1);
    await work.shift()!();
    await populateSurveyTerms("activity", [q], defer);
    expect(q).toMatchObject({ keywordStatus: "ready", terms: [
      { label: "人工智能", value: 2, studentIds: ["s0", "s1"] },
      { label: "机器学习", value: 1, studentIds: ["s1"] },
    ] });
    expect(mocks.extract).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.extract.mock.calls)).not.toContain("姓名");
  });

  it("reuses repeated answers and only sends newly submitted content", async () => {
    const { populateSurveyTerms, work, defer } = await setup();
    mocks.extract.mockResolvedValueOnce([["人工智能"]]).mockResolvedValueOnce([["生物多样性"]]);
    await populateSurveyTerms("activity", [question(["人工智能", "人工智能"])], defer);
    await work.shift()!();
    const updated = question(["人工智能", "人工智能", "生物多样性"]);
    await populateSurveyTerms("activity", [updated], defer);
    expect(updated).toMatchObject({ keywordStatus: "processing", keywordAnalyzedCount: 2, keywordRepresentedCount: 2,
      keywordUnrepresentedResponses: [{ studentId: "s2", reason: "pending" }], terms: [{ label: "人工智能", value: 2 }] });
    await work.shift()!();
    expect(mocks.extract.mock.calls.map((call) => call[1])).toEqual([["人工智能"], ["生物多样性"]]);
    await populateSurveyTerms("activity", [updated], defer);
    expect(updated.terms[0]).toMatchObject({ label: "人工智能", value: 2 });
    expect(updated.terms[1]).toMatchObject({ label: "生物多样性", value: 1 });
    expect(updated.keywordRepresentedCount).toBe(3);
    expect(updated.keywordUnrepresentedResponses).toEqual([]);
  });

  it("prioritizes a unique student opinion on the first page and retains every term for later pages", async () => {
    const { populateSurveyTerms, work, defer } = await setup();
    const common = Array.from({ length: 50 }, (_, index) => `共同观点${String(index).padStart(3, "0")}`);
    const q = question([common.join(" "), common.join(" "), "独特的改进建议"]);
    mocks.extract.mockImplementation(async (_title: string, responses: string[]) => responses.map((response) => response.split(" ")));
    await populateSurveyTerms("activity", [q], defer);
    await work.shift()!();
    await populateSurveyTerms("activity", [q], defer);
    expect(q.terms).toHaveLength(51);
    expect(q.terms.slice(0, 48)).toContainEqual({ label: "独特的改进建议", value: 1, studentIds: ["s2"] });
    expect(new Set(q.terms.slice(0, 48).flatMap((term) => term.studentIds!)).size).toBe(3);
    expect(q).toMatchObject({ keywordAnalyzedCount: 3, keywordRepresentedCount: 3, keywordUnrepresentedResponses: [] });
    expect(new Set(q.terms.map((term) => term.label))).toEqual(new Set([...common, "独特的改进建议"]));
  });

  it("keeps all distinct class responses reachable beyond the 48-term first page", async () => {
    const { populateSurveyTerms, work, defer } = await setup();
    const contents = Array.from({ length: 61 }, (_, index) => `独立反馈${String(index).padStart(3, "0")}`);
    const q = question(contents);
    mocks.extract.mockImplementation(async (_title: string, responses: string[]) => responses.map((response) => [response]));
    await populateSurveyTerms("activity", [q], defer);
    while (work.length) {
      await work.shift()!();
      await populateSurveyTerms("activity", [q], defer);
    }
    expect(q.terms).toHaveLength(61);
    expect(q.terms.slice(48)).toHaveLength(13);
    expect(new Set(q.terms.flatMap((term) => term.studentIds!)).size).toBe(61);
    expect(q).toMatchObject({ keywordAnalyzedCount: 61, keywordRepresentedCount: 61, keywordUnrepresentedResponses: [] });
    expect(mocks.extract.mock.calls.map((call) => call[1].length)).toEqual([24, 24, 13]);
  });

  it("distinguishes completed answers without verified keywords from pending and failed analysis", async () => {
    const { populateSurveyTerms, work, defer } = await setup();
    mocks.extract.mockResolvedValueOnce([["有效反馈"], [], ["原文没有的词"]]);
    const first = question(["有效反馈", "谢谢", "有内容但模型漏词"]);
    await populateSurveyTerms("activity", [first], defer);
    await work.shift()!();
    await populateSurveyTerms("activity", [first], defer);
    expect(first).toMatchObject({ keywordAnalyzedCount: 3, keywordRepresentedCount: 1,
      keywordUnrepresentedResponses: [{ studentId: "s1", reason: "no-keywords" }, { studentId: "s2", reason: "no-keywords" }] });
    const updated = question([...first.responses.map((response) => response.content), "新反馈"]);
    mocks.extract.mockRejectedValueOnce(new Error("timeout"));
    await populateSurveyTerms("activity", [updated], defer);
    expect(updated.keywordUnrepresentedResponses?.at(-1)).toEqual({ studentId: "s3", reason: "pending" });
    await work.shift()!();
    await populateSurveyTerms("activity", [updated], defer);
    expect(updated).toMatchObject({ keywordAnalyzedCount: 3, keywordRepresentedCount: 1 });
    expect(updated.keywordUnrepresentedResponses).toEqual([
      { studentId: "s1", reason: "no-keywords" }, { studentId: "s2", reason: "no-keywords" },
      { studentId: "s3", reason: "analysis-unavailable" },
    ]);
  });

  it("invalidates cache when question context, activity or model changes", async () => {
    const { populateSurveyTerms, work, defer } = await setup();
    mocks.extract.mockResolvedValue([["人工智能"]]);
    const q = question(["人工智能"]);
    for (const [scope, title, model] of [["a", "原题", "m1"], ["a", "新题", "m1"], ["b", "新题", "m1"], ["b", "新题", "m2"]]) {
      mocks.resolve.mockResolvedValue({ cacheKey: model, extract: mocks.extract });
      await populateSurveyTerms(scope, [{ ...q, title }], defer);
      await work.shift()!();
    }
    expect(mocks.extract).toHaveBeenCalledTimes(4);
  });

  it("retains empty model results so non-substantive answers do not trigger repeated calls", async () => {
    const { populateSurveyTerms, work, defer } = await setup();
    mocks.extract.mockResolvedValue([[]]);
    const q = question(["谢谢"]);
    await populateSurveyTerms("activity", [q], defer);
    await work.shift()!();
    await populateSurveyTerms("activity", [q], defer);
    expect(q).toMatchObject({ keywordStatus: "ready", terms: [] });
    expect(work).toHaveLength(0);
  });

  it("keeps choice statistics available and backs off before retrying a failed model", async () => {
    vi.useFakeTimers();
    const { populateSurveyTerms, work, defer } = await setup();
    const choice = { ...question(), type: "multiple-choice", options: [{ id: "a", label: "A", count: 2, percentage: 100, respondents: [] }] } as SurveyQuestionAnalytics;
    const q = question();
    mocks.extract.mockRejectedValueOnce(new Error("timeout"));
    await populateSurveyTerms("activity", [choice, q], defer);
    await work.shift()!();
    await populateSurveyTerms("activity", [choice, q], defer);
    expect(q.keywordStatus).toBe("unavailable");
    expect(choice.options[0]).toMatchObject({ count: 2, percentage: 100 });
    expect(work).toHaveLength(0);
    vi.setSystemTime(Date.now() + 61_000);
    await populateSurveyTerms("activity", [q], defer);
    expect(q.keywordStatus).toBe("processing");
    expect(work).toHaveLength(1);
    await work.shift()!();
    await populateSurveyTerms("activity", [q], defer);
    expect(q.keywordStatus).toBe("ready");
  });

  it("batches large classes without truncating or reprocessing the remaining answers", async () => {
    const { populateSurveyTerms, work, defer } = await setup();
    const q = question(Array.from({ length: 25 }, (_, index) => `第${index}人讨论人工智能`));
    mocks.extract.mockImplementation(async (_title: string, responses: string[]) => responses.map(() => ["人工智能"]));
    await populateSurveyTerms("activity", [q], defer);
    await work.shift()!();
    await populateSurveyTerms("activity", [q], defer);
    await work.shift()!();
    await populateSurveyTerms("activity", [q], defer);
    expect(mocks.extract.mock.calls.map((call) => call[1].length)).toEqual([24, 1]);
    expect(q.terms[0]).toMatchObject({ label: "人工智能", value: 25 });
  });

  it("reuses Redis results across process-local cache resets", async () => {
    const values = new Map<string, string>();
    const redis = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      set: vi.fn(async (key: string, value: string, options: { NX?: boolean }) => {
        if (options.NX && values.has(key)) return null;
        values.set(key, value); return "OK";
      }),
      eval: vi.fn(async (_script: string, options: { keys: string[] }) => { values.delete(options.keys[0]); return 1; }),
    };
    mocks.redis.mockResolvedValue(redis);
    const first = await setup();
    await first.populateSurveyTerms("activity", [question()], first.defer);
    await first.work.shift()!();
    vi.resetModules();
    const second = await setup();
    const q = question();
    await second.populateSurveyTerms("activity", [q], second.defer);
    expect(q.keywordStatus).toBe("ready");
    expect(q.terms[0].value).toBe(2);
    expect(second.work).toHaveLength(0);
    expect(mocks.extract).toHaveBeenCalledOnce();
  });

  it("chunks text expanded by Unicode normalization and merges a student's mentions only once", async () => {
    const { populateSurveyTerms, work, defer } = await setup();
    // 4,000 legal input characters expand beyond a model batch after NFKC normalization.
    const q = question(["㍿".repeat(4_000), "人工智能"]);
    mocks.extract.mockImplementation(async (_title: string, responses: string[]) => {
      expect(responses.reduce((length, content) => length + content.length, 0)).toBeLessThanOrEqual(12_000);
      return responses.map((content) => content.includes("株式会社") ? ["株式会社"] : ["人工智能"]);
    });
    await populateSurveyTerms("activity", [q], defer);
    while (work.length) {
      await work.shift()!();
      await populateSurveyTerms("activity", [q], defer);
    }
    expect(q.keywordStatus).toBe("ready");
    expect(q.keywordAnalyzedCount).toBe(2);
    expect(q.terms).toEqual(expect.arrayContaining([
      { label: "株式会社", value: 1, studentIds: ["s0"] },
      { label: "人工智能", value: 1, studentIds: ["s1"] },
    ]));
  });

  it("reports unavailable without scheduling calls when no model is configured", async () => {
    const { populateSurveyTerms, work, defer } = await setup();
    mocks.resolve.mockRejectedValue(new Error("not configured"));
    const q = question();
    await populateSurveyTerms("activity", [q], defer);
    expect(q.keywordStatus).toBe("unavailable");
    expect(q).toMatchObject({ keywordAnalyzedCount: 0, keywordRepresentedCount: 0,
      keywordUnrepresentedResponses: [{ studentId: "s0", reason: "analysis-unavailable" }, { studentId: "s1", reason: "analysis-unavailable" }] });
    expect(work).toHaveLength(0);
  });
});
