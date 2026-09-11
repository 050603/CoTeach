import { createHash, randomUUID } from "node:crypto";
import { getRedisClient } from "@/lib/redis/client";
import type { SurveyQuestionAnalytics, SurveyTextAnalytics } from "./survey";
import { resolveSurveyKeywordModel } from "./survey-keyword-model";
import type { SurveyKeywordMode } from "./survey-keyword-settings";

const VERSION = "local-neural-v1";
const CACHE_SECONDS = 7 * 24 * 60 * 60;
const RETRY_SECONDS = 5;
const MAX_MEMORY_ENTRIES = 2_000;
const memory = new Map<string, { expires: number; value: string[] }>();
const failures = new Map<string, number>();
const scheduled = new Set<string>();
const lanes = {
  local: { active: 0, limit: 1, queue: [] as Array<() => void> },
  llm: { active: 0, limit: 2, queue: [] as Array<() => void> },
};

type Model = Awaited<ReturnType<typeof resolveSurveyKeywordModel>>;
type Defer = (work: () => Promise<void>) => void;
type Document = { key: string; content: string };

function textChunks(content: string): string[] {
  if (content.length <= 12_000) return [content];
  const characters = [...content];
  const chunks: string[] = [];
  // Overlap the model's maximum phrase length so a concept at a boundary remains intact.
  for (let index = 0; index < characters.length; index += 6_000 - 48) {
    chunks.push(characters.slice(index, index + 6_000).join(""));
  }
  return chunks;
}

function key(parts: string[]): string {
  return `survey-keywords:${VERSION}:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

function remember(cacheKey: string, value: string[], seconds = CACHE_SECONDS) {
  memory.delete(cacheKey);
  memory.set(cacheKey, { value, expires: Date.now() + seconds * 1000 });
  while (memory.size > MAX_MEMORY_ENTRIES) memory.delete(memory.keys().next().value!);
}

async function cacheRead(cacheKey: string): Promise<string[] | null> {
  const cached = memory.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value;
  memory.delete(cacheKey);
  try {
    const redis = await getRedisClient();
    const raw = await redis?.get(cacheKey);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || !value.every((term) => typeof term === "string" && term.length <= 96)) return null;
    remember(cacheKey, value);
    return value;
  } catch {
    // A Redis outage must not hide existing survey answers or block local reuse.
    return null;
  }
}

async function cacheWrite(cacheKey: string, value: string[], seconds = CACHE_SECONDS) {
  remember(cacheKey, value, seconds);
  try {
    const redis = await getRedisClient();
    await redis?.set(cacheKey, JSON.stringify(value), { EX: seconds });
  } catch { /* Retain the in-process cache when Redis is unavailable. */ }
}

async function withJobSlot(mode: SurveyKeywordMode, work: () => Promise<void>) {
  const lane = lanes[mode];
  if (lane.active >= lane.limit) await new Promise<void>((resolve) => lane.queue.push(resolve));
  else lane.active++;
  try { await work(); } finally {
    const next = lane.queue.shift();
    if (next) next();
    else lane.active--;
  }
}

function aggregateTerms(question: SurveyTextAnalytics, documents: string[][]) {
  const studentsByTerm = new Map<string, Set<string>>();
  documents.forEach((terms, index) => {
    const content = question.responses[index].content.normalize("NFKC").toLocaleLowerCase("zh-CN");
    const unique = [...new Set(terms)].filter((term) => term && content.includes(term));
    for (const term of unique) {
      const students = studentsByTerm.get(term) ?? new Set<string>();
      students.add(question.responses[index].studentId);
      studentsByTerm.set(term, students);
    }
  });
  const remaining = [...studentsByTerm.entries()]
    .sort(([left, a], [right, b]) => b.size - a.size || left.localeCompare(right, "zh-CN"))
    .map(([label, students]) => ({ label, value: students.size, studentIds: [...students] }));
  const prioritized: typeof remaining = [];
  const represented = new Set<string>();
  // Prefer new student voices in the first page, then retain every remaining term
  // for pagination/search. Popular answers must not crowd out unique feedback.
  while (prioritized.length < 48 && remaining.length) {
    let bestIndex = -1;
    let bestGain = 0;
    for (let index = 0; index < remaining.length; index++) {
      const gain = remaining[index].studentIds.reduce((count, id) => count + Number(!represented.has(id)), 0);
      if (gain > bestGain) { bestIndex = index; bestGain = gain; }
    }
    if (bestIndex < 0) break;
    const [term] = remaining.splice(bestIndex, 1);
    prioritized.push(term);
    term.studentIds.forEach((id) => represented.add(id));
  }
  return [...prioritized, ...remaining];
}

function scheduleBatch(jobKey: string, documents: Document[], title: string, model: Model, defer: Defer, mode: SurveyKeywordMode) {
  if (scheduled.has(jobKey)) return;
  scheduled.add(jobKey);
  defer(async () => {
    try {
      await withJobSlot(mode, async () => {
        const lockKey = `${jobKey}:lock`;
        const token = randomUUID();
        const redis = await getRedisClient().catch(() => null);
        let locked = false;
        if (redis) {
          try {
            locked = (await redis.set(lockKey, token, { NX: true, EX: 45 })) === "OK";
            if (!locked) return;
          } catch { /* The bounded local queue still protects a standalone process. */ }
        }
        try {
          // Another request/process may have finished these documents while this job waited.
          const batch: Document[] = [];
          let characters = 0;
          for (const document of documents) {
            if (await cacheRead(document.key) !== null) continue;
            if (batch.length >= (mode === "llm" ? 8 : 24) || (batch.length && characters + document.content.length > (mode === "llm" ? 6_000 : 12_000))) break;
            batch.push(document);
            characters += document.content.length;
          }
          if (!batch.length) return;
          const extracted = await model.extract(title, batch.map((document) => document.content));
          if (extracted.length !== batch.length) throw new Error("Incomplete keyword batch");
          await Promise.all(batch.map((document, index) => cacheWrite(document.key, extracted[index])));
          failures.delete(jobKey);
        } catch {
          const retrySeconds = mode === "llm" ? 60 : RETRY_SECONDS;
          failures.set(jobKey, Date.now() + retrySeconds * 1000);
          while (failures.size > MAX_MEMORY_ENTRIES) failures.delete(failures.keys().next().value!);
          await cacheWrite(`${jobKey}:retry`, [String(Date.now() + retrySeconds * 1000)], retrySeconds);
        } finally {
          if (locked && redis) {
            await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", {
              keys: [lockKey], arguments: [token],
            }).catch(() => undefined);
          }
        }
      });
    } finally { scheduled.delete(jobKey); }
  });
}

/** Reuse cached neural tokens, allowing fast local inference before deferring larger workloads. */
export async function populateSurveyTerms(scope: string, questions: SurveyQuestionAnalytics[], defer: Defer, inlineWaitMs = 500, mode: SurveyKeywordMode = "local"): Promise<void> {
  questions.forEach((question) => {
    if (question.type !== "short-text") return;
    question.keywordMode = mode;
    question.keywordAnalyzedCount = 0;
    question.keywordRepresentedCount = 0;
    question.keywordUnrepresentedResponses = question.responses.map(({ studentId }) => ({ studentId, reason: "pending" }));
  });
  const textQuestions = questions.filter((question): question is SurveyTextAnalytics => question.type === "short-text" && question.responses.length > 0);
  if (!textQuestions.length) return;
  let model: Model;
  try { model = await resolveSurveyKeywordModel(mode); } catch {
    textQuestions.forEach((question) => {
      question.terms = [];
      question.keywordStatus = "unavailable";
      question.keywordUnrepresentedResponses = question.responses.map(({ studentId }) => ({ studentId, reason: "analysis-unavailable" }));
    });
    return;
  }
  const jobs: Array<() => Promise<void>> = [];
  const refreshers: Array<() => Promise<void>> = [];
  await Promise.all(textQuestions.map(async (question) => {
    const jobKey = key([scope, question.id, question.title, model.cacheKey]);
    const responseDocuments = question.responses.map((response) => {
      const content = response.content.normalize("NFKC").toLocaleLowerCase("zh-CN").trim();
      return textChunks(content).map((chunk) => ({ key: key([jobKey, chunk]), content: chunk }));
    });
    const documents = responseDocuments.flat();
    const refresh = async () => {
      const entries = await Promise.all(documents.map((document) => cacheRead(document.key)));
      const entryByKey = new Map(documents.map((document, index) => [document.key, entries[index]]));
      const responseEntries = responseDocuments.map((chunks) => {
        const terms = chunks.map((chunk) => entryByKey.get(chunk.key));
        return terms.every((entry) => entry != null) ? [...new Set(terms.flat() as string[])] : null;
      });
      question.terms = aggregateTerms(question, responseEntries.map((entry) => entry ?? []));
      question.keywordAnalyzedCount = responseEntries.filter((entry) => entry !== null).length;
      const missing = [...new Map(documents.filter((_, index) => entries[index] === null).map((document) => [document.key, document])).values()];
      const retry = failures.get(jobKey) ?? Number((await cacheRead(`${jobKey}:retry`))?.[0] ?? 0);
      question.keywordStatus = !missing.length ? "ready" : retry > Date.now() ? "unavailable" : "processing";
      const represented = new Set(question.terms.flatMap((term) => term.studentIds ?? []));
      question.keywordRepresentedCount = question.responses.filter(({ studentId }) => represented.has(studentId)).length;
      question.keywordUnrepresentedResponses = question.responses.flatMap(({ studentId }, index) => {
        if (represented.has(studentId)) return [];
        const reason = responseEntries[index] !== null ? "no-keywords"
          : question.keywordStatus === "unavailable" ? "analysis-unavailable" : "pending";
        return [{ studentId, reason }];
      });
      return missing;
    };
    const missing = await refresh();
    refreshers.push(async () => { await refresh(); });
    if (question.keywordStatus === "processing") scheduleBatch(jobKey, missing, question.title, model, (job) => jobs.push(job), mode);
  }));
  if (!jobs.length) return;
  if (inlineWaitMs <= 0 || mode === "llm") {
    jobs.forEach(defer);
    return;
  }
  // A warm local model normally completes before this budget. Large batches continue
  // after the response so charts and previously analyzed answers remain responsive.
  const work = Promise.all(jobs.map((job) => job())).then(() => undefined);
  defer(() => work);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<void>((resolve) => { timeout = setTimeout(resolve, inlineWaitMs); })]);
  } finally { if (timeout) clearTimeout(timeout); }
  await Promise.all(refreshers.map((refresh) => refresh()));
}
