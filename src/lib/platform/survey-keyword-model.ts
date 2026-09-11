import { createHash } from "node:crypto";
import type { SurveyKeywordMode } from "./survey-keyword-settings";

export const LOCAL_SURVEY_MODEL = "COARSE_ELECTRA_SMALL_ZH:20220616";
// Function words are filtered for display; word boundaries come exclusively from the neural model.
const STOP_WORDS = new Set([
  "一个", "一些", "这个", "那个", "这些", "那些", "我们", "你们", "他们", "自己",
  "以及", "因为", "所以", "但是", "然后", "可以", "能够", "觉得", "认为", "希望",
  "需要", "比较", "非常", "还是", "就是", "进行", "通过", "对于", "关于", "没有",
  "不是", "有点", "什么", "怎么", "这样", "那么", "已经", "还有", "更加", "真的",
  "the", "and", "that", "this", "with", "from", "have", "would", "could", "very",
  "about", "into", "your", "our", "are", "was", "were", "for", "but", "not", "you",
]);

export interface SurveyKeywordModel {
  cacheKey: string;
  modelName: string;
  extract(questionTitle: string, responses: string[]): Promise<string[][]>;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").trim();
}

/** The dedicated local CPU service holds the trained model in memory; no provider or API key is used. */
export async function resolveSurveyKeywordModel(mode: SurveyKeywordMode = "local"): Promise<SurveyKeywordModel> {
  if (mode === "llm") {
    const { resolveSurveyLlmKeywordModel } = await import("./survey-keyword-llm");
    return resolveSurveyLlmKeywordModel();
  }
  const endpoint = process.env.OPENPBL_NLP_URL?.trim() || "http://127.0.0.1:3003";
  const url = new URL(endpoint);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.protocol !== "http:") {
    throw new Error("问卷分词服务必须使用本机回环地址。");
  }
  const modelName = LOCAL_SURVEY_MODEL;
  const fingerprint = createHash("sha256").update(`${modelName}:${url.origin}:filter-v1`).digest("hex");
  return {
    cacheKey: `local-neural-v1:${fingerprint}`,
    modelName,
    async extract(_questionTitle, responses) {
      if (!responses.length) return [];
      if (responses.length > 24 || responses.reduce((size, text) => size + text.length, 0) > 12_000) {
        throw new Error("问卷分词批次过大，请分批处理。");
      }
      const response = await fetch(new URL("/tokenize", url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ responses }),
        signal: AbortSignal.timeout(30_000),
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) throw new Error("本地分词服务暂时不可用。");
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || !("model" in result) || result.model !== modelName
        || !("tokens" in result) || !Array.isArray(result.tokens) || result.tokens.length !== responses.length) {
        throw new Error("本地分词结果格式不完整。");
      }
      return result.tokens.map((tokens: unknown, index: number) => {
        if (!Array.isArray(tokens) || !tokens.every((term) => typeof term === "string")) {
          throw new Error("本地分词结果格式不完整。");
        }
        const source = normalize(responses[index]);
        return [...new Set(tokens.map((token: string) => normalize(token))
          .filter((term) => term.length >= 2 && [...term].length <= 48 && /\p{Letter}/u.test(term)
            && !STOP_WORDS.has(term) && source.includes(term)))];
      });
    },
  };
}
