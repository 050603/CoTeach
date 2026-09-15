import { createHash, randomUUID } from "node:crypto";
import { getRedisClient } from "@/lib/redis/client";
import type { SurveyQuestionAnalytics, SurveyTextAnalytics } from "./survey";
import { resolveSurveyKeywordModel, type SurveyThemeEvidence, type SurveyThemeGroup } from "./survey-keyword-model";
import type { SurveyKeywordMode } from "./survey-keyword-settings";

const VERSION = "class-themes-v1";
const CACHE_SECONDS = 7 * 24 * 60 * 60;
const RETRY_SECONDS = 5;
const MAX_MEMORY_ENTRIES = 2_000;
// Protect the API and DOM from adversarially large surveys without imposing a normal display limit.
const MAX_SAFE_TERMS = 500;
const THEME_FALLBACK_SECONDS = 5 * 60;
const memory = new Map<string, { expires: number; value: unknown }>();
const failures = new Map<string, number>();
const scheduled = new Set<string>();
const lanes = {
  local: { active: 0, limit: 1, queue: [] as Array<() => void> },
  llm: { active: 0, limit: 2, queue: [] as Array<() => void> },
};

type Model = Awaited<ReturnType<typeof resolveSurveyKeywordModel>>;
type Defer = (work: () => Promise<void>) => void;
type Document = { key: string; content: string };
type ResponseAnalysis = { fingerprint: string; studentId: string; documents: Document[] };
type ThemeSnapshot = {
  responseFingerprints: string[];
  themes: Array<{ label: string; responseFingerprints: string[] }>;
  aggregation?: "semantic" | "exact-fallback";
};

function textChunks(content: string): string[] {
  if (content.length <= 12_000) return [content];
  const characters = [...content];
  const chunks: string[] = [];
  // Overlap the model's maximum evidence length so a concept at a boundary remains intact.
  for (let index = 0; index < characters.length; index += 6_000 - 48) {
    chunks.push(characters.slice(index, index + 6_000).join(""));
  }
  return chunks;
}

function key(parts: string[]): string {
  return `survey-keywords:${VERSION}:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

function fingerprint(parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function remember(cacheKey: string, value: unknown, seconds = CACHE_SECONDS) {
  memory.delete(cacheKey);
  memory.set(cacheKey, { value, expires: Date.now() + seconds * 1000 });
  while (memory.size > MAX_MEMORY_ENTRIES) memory.delete(memory.keys().next().value!);
}

async function cacheValueRead(cacheKey: string): Promise<unknown | null> {
  const cached = memory.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value;
  memory.delete(cacheKey);
  try {
    const redis = await getRedisClient();
    const raw = await redis?.get(cacheKey);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    remember(cacheKey, value);
    return value;
  } catch {
    // A Redis outage must not hide existing survey answers or block local reuse.
    return null;
  }
}

async function cacheRead(cacheKey: string): Promise<string[] | null> {
  const value = await cacheValueRead(cacheKey);
  return Array.isArray(value) && value.every((term) => typeof term === "string" && term.length <= 96) ? value : null;
}

function isThemeSnapshot(value: unknown): value is ThemeSnapshot {
  if (!value || typeof value !== "object" || !("responseFingerprints" in value) || !("themes" in value)) return false;
  const snapshot = value as Partial<ThemeSnapshot>;
  return Array.isArray(snapshot.responseFingerprints)
    && snapshot.responseFingerprints.length <= 5_000
    && snapshot.responseFingerprints.every((item) => typeof item === "string" && item.length === 64)
    && (snapshot.aggregation === undefined || snapshot.aggregation === "semantic" || snapshot.aggregation === "exact-fallback")
    && Array.isArray(snapshot.themes)
    && snapshot.themes.length <= MAX_SAFE_TERMS
    && snapshot.themes.every((theme) => theme && typeof theme.label === "string" && [...theme.label].length <= 24
      && Array.isArray(theme.responseFingerprints) && theme.responseFingerprints.length <= 5_000
      && theme.responseFingerprints.every((item) => typeof item === "string" && item.length === 64));
}

async function cacheReadTheme(cacheKey: string): Promise<ThemeSnapshot | null> {
  const value = await cacheValueRead(cacheKey);
  return isThemeSnapshot(value) ? value : null;
}

async function cacheWriteValue(cacheKey: string, value: unknown, seconds = CACHE_SECONDS) {
  remember(cacheKey, value, seconds);
  try {
    const redis = await getRedisClient();
    await redis?.set(cacheKey, JSON.stringify(value), { EX: seconds });
  } catch { /* Retain the in-process cache when Redis is unavailable. */ }
}

async function cacheWrite(cacheKey: string, value: string[], seconds = CACHE_SECONDS) {
  await cacheWriteValue(cacheKey, value, seconds);
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

function termSpecificity(label: string, questionTitle: string): number {
  const characters = [...label];
  const lengthScore = Math.min(1.25, 0.75 + characters.length * 0.1);
  return lengthScore * (questionTitle.includes(label) ? 0.55 : 1);
}

function aggregateLocalTerms(question: SurveyTextAnalytics, documents: string[][]) {
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
  const title = question.title.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const ranked = [...studentsByTerm.entries()].map(([label, students]) => ({
    label,
    value: students.size,
    studentIds: [...students],
    specificity: termSpecificity(label, title),
  }));
  const byRelevance = (left: typeof ranked[number], right: typeof ranked[number]) => right.value * right.specificity - left.value * left.specificity
    || right.value - left.value || right.specificity - left.specificity || left.label.localeCompare(right.label, "zh-CN");
  const repeated = ranked.filter((term) => term.value > 1).sort(byRelevance);
  const singletons = ranked.filter((term) => term.value === 1).sort(byRelevance);
  return [...repeated, ...singletons].slice(0, MAX_SAFE_TERMS)
    .map(({ label, value, studentIds }) => ({ label, value, studentIds }));
}

function responseAnalyses(scope: string, question: SurveyTextAnalytics, model: Model): ResponseAnalysis[] {
  return question.responses.map((response) => {
    const content = response.content.normalize("NFKC").toLocaleLowerCase("zh-CN").trim();
    const responseFingerprint = fingerprint([scope, question.id, response.studentId, content]);
    const documents = textChunks(content).map((chunk) => ({
      key: key([scope, question.id, question.title, model.cacheKey, chunk]),
      content: chunk,
    }));
    return { fingerprint: responseFingerprint, studentId: response.studentId, documents };
  });
}

function applyThemeSnapshot(question: SurveyTextAnalytics, analyses: ResponseAnalysis[], snapshot: ThemeSnapshot): boolean {
  const current = new Map(analyses.map((analysis) => [analysis.fingerprint, analysis.studentId]));
  if (!snapshot.responseFingerprints.every((item) => current.has(item))) return false;
  question.terms = snapshot.themes.flatMap((theme) => {
    const studentIds = [...new Set(theme.responseFingerprints.map((item) => current.get(item)).filter((id): id is string => Boolean(id)))];
    return studentIds.length ? [{ label: theme.label, value: studentIds.length, studentIds }] : [];
  }).sort((left, right) => right.value - left.value || left.label.localeCompare(right.label, "zh-CN"))
    .slice(0, MAX_SAFE_TERMS);
  question.keywordAggregation = snapshot.aggregation ?? "semantic";
  return true;
}

function exactEvidenceGroups(evidence: SurveyThemeEvidence[], title: string): SurveyThemeGroup[] {
  const byLabel = new Map<string, { evidenceIds: number[]; responses: Set<number> }>();
  evidence.forEach((item) => {
    const group = byLabel.get(item.text) ?? { evidenceIds: [], responses: new Set<number>() };
    group.evidenceIds.push(item.id);
    group.responses.add(item.responseId);
    byLabel.set(item.text, group);
  });
  return [...byLabel.entries()].sort(([leftLabel, left], [rightLabel, right]) =>
    right.responses.size - left.responses.size
    || termSpecificity(rightLabel, title) - termSpecificity(leftLabel, title)
    || leftLabel.localeCompare(rightLabel, "zh-CN"))
    .slice(0, MAX_SAFE_TERMS)
    .map(([, group]) => ({ canonicalEvidenceId: group.evidenceIds[0], evidenceIds: group.evidenceIds }));
}

/** A model may not turn separately extracted points from one answer into one apparent consensus. */
function conservativeThemeGroups(groups: SurveyThemeGroup[], evidence: SurveyThemeEvidence[], title: string): SurveyThemeGroup[] {
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const safe: SurveyThemeGroup[] = [];
  groups.forEach((group) => {
    const responseIds = group.evidenceIds.map((id) => evidenceById.get(id)?.responseId);
    if (new Set(responseIds).size === responseIds.length) {
      safe.push(group);
      return;
    }
    const conflictedEvidence = group.evidenceIds.flatMap((id) => {
      const item = evidenceById.get(id);
      return item ? [item] : [];
    });
    safe.push(...exactEvidenceGroups(conflictedEvidence, title));
  });
  return safe.sort((left, right) => {
    const leftResponses = new Set(left.evidenceIds.map((id) => evidenceById.get(id)?.responseId)).size;
    const rightResponses = new Set(right.evidenceIds.map((id) => evidenceById.get(id)?.responseId)).size;
    const leftLabel = evidenceById.get(left.canonicalEvidenceId)?.text ?? "";
    const rightLabel = evidenceById.get(right.canonicalEvidenceId)?.text ?? "";
    return rightResponses - leftResponses || termSpecificity(rightLabel, title) - termSpecificity(leftLabel, title)
      || leftLabel.localeCompare(rightLabel, "zh-CN");
  }).slice(0, MAX_SAFE_TERMS);
}

function createThemeSnapshot(groups: SurveyThemeGroup[], evidence: SurveyThemeEvidence[], analyses: ResponseAnalysis[], aggregation: ThemeSnapshot["aggregation"]): ThemeSnapshot {
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  return {
    aggregation,
    responseFingerprints: analyses.map((analysis) => analysis.fingerprint),
    themes: groups.map((theme) => {
      const canonicalTerm = evidenceById.get(theme.canonicalEvidenceId)?.text;
      if (!canonicalTerm || !theme.evidenceIds.includes(theme.canonicalEvidenceId)) {
        throw new Error("Invalid canonical survey theme evidence");
      }
      const responseFingerprints = [...new Set(theme.evidenceIds.map((id) => evidenceById.get(id)?.responseId)
        .filter((responseId): responseId is number => responseId !== undefined)
        .map((responseId) => analyses[responseId]?.fingerprint)
        .filter((item): item is string => Boolean(item)))];
      return { label: canonicalTerm, responseFingerprints };
    }).filter((theme) => theme.responseFingerprints.length > 0),
  };
}

async function retryUntil(jobKey: string): Promise<number> {
  return failures.get(jobKey) ?? Number((await cacheRead(`${jobKey}:retry`))?.[0] ?? 0);
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

function scheduleThemeAggregation(jobKey: string, latestKey: string, title: string, evidence: SurveyThemeEvidence[], analyses: ResponseAnalysis[], model: Model, defer: Defer) {
  if (scheduled.has(jobKey) || !model.consolidate) return;
  scheduled.add(jobKey);
  defer(async () => {
    try {
      await withJobSlot("llm", async () => {
        const lockKey = `${jobKey}:lock`;
        const token = randomUUID();
        const redis = await getRedisClient().catch(() => null);
        let locked = false;
        if (redis) {
          try {
            locked = (await redis.set(lockKey, token, { NX: true, EX: 45 })) === "OK";
            if (!locked) return;
          } catch { /* The bounded LLM queue still protects a standalone process. */ }
        }
        try {
          if (await cacheReadTheme(jobKey)) return;
          let themes: SurveyThemeGroup[];
          let aggregation: ThemeSnapshot["aggregation"] = "semantic";
          let cacheSeconds = CACHE_SECONDS;
          try {
            themes = conservativeThemeGroups(await model.consolidate!(title, evidence), evidence, title);
          } catch {
            themes = exactEvidenceGroups(evidence, title);
            aggregation = "exact-fallback";
            cacheSeconds = THEME_FALLBACK_SECONDS;
            console.warn("[survey-themes] Semantic grouping failed validation; displaying verified exact evidence and retrying later.");
          }
          const snapshot = createThemeSnapshot(themes, evidence, analyses, aggregation);
          await Promise.all([cacheWriteValue(jobKey, snapshot, cacheSeconds), cacheWriteValue(latestKey, snapshot)]);
          failures.delete(jobKey);
        } catch {
          const retrySeconds = 60;
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

function updateCoverage(question: SurveyTextAnalytics, entries: Array<string[] | null>, mode: SurveyKeywordMode) {
  const represented = new Set(question.terms.flatMap((term) => term.studentIds ?? []));
  question.keywordRepresentedCount = question.responses.filter(({ studentId }) => represented.has(studentId)).length;
  question.keywordUnrepresentedResponses = question.responses.flatMap(({ studentId }, index) => {
    if (represented.has(studentId)) return [];
    const reason = mode === "local" && entries[index] !== null ? entries[index].length ? "no-theme" as const : "no-keywords" as const
      : entries[index] === null
      ? question.keywordStatus === "unavailable" ? "analysis-unavailable" as const : "pending" as const
      : question.keywordStatus === "processing" ? "pending" as const
        : question.keywordStatus === "unavailable" ? "analysis-unavailable" as const
          : mode === "llm" ? "no-theme" as const : "no-keywords" as const;
    return [{ studentId, reason }];
  });
}

/** Reuse cached per-response evidence, then build a question-wide theme snapshot in LLM mode. */
export async function populateSurveyTerms(scope: string, questions: SurveyQuestionAnalytics[], defer: Defer, inlineWaitMs = 500, mode: SurveyKeywordMode = "local"): Promise<void> {
  questions.forEach((question) => {
    if (question.type !== "short-text") return;
    question.keywordMode = mode;
    question.keywordAggregation = undefined;
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
    const extractionJobKey = key(["evidence", scope, question.id, question.title, model.cacheKey]);
    const analyses = responseAnalyses(scope, question, model);
    const documents = analyses.flatMap((analysis) => analysis.documents);
    const refresh = async () => {
      const documentEntries = await Promise.all(documents.map((document) => cacheRead(document.key)));
      const entryByKey = new Map(documents.map((document, index) => [document.key, documentEntries[index]]));
      const responseEntries = analyses.map((analysis) => {
        const terms = analysis.documents.map((document) => entryByKey.get(document.key));
        if (!terms.every((entry) => entry != null)) return null;
        const unique = [...new Set(terms.flat() as string[])];
        return mode === "llm" ? unique.slice(0, 3) : unique;
      });
      question.keywordAnalyzedCount = responseEntries.filter((entry) => entry !== null).length;
      const missing = [...new Map(documents.filter((_, index) => documentEntries[index] === null).map((document) => [document.key, document])).values()];
      const extractionRetry = await retryUntil(extractionJobKey);

      if (mode === "local") {
        question.terms = aggregateLocalTerms(question, responseEntries.map((entry) => entry ?? []));
        question.keywordStatus = !missing.length ? "ready" : extractionRetry > Date.now() ? "unavailable" : "processing";
        updateCoverage(question, responseEntries, mode);
        return missing;
      }

      const themeCacheKey = model.themeCacheKey ?? model.cacheKey;
      const latestKey = key(["themes-latest", scope, question.id, question.title, themeCacheKey]);
      question.terms = [];
      const latest = await cacheReadTheme(latestKey);
      if (latest) applyThemeSnapshot(question, analyses, latest);
      if (missing.length) {
        question.keywordStatus = extractionRetry > Date.now() ? "unavailable" : "processing";
        updateCoverage(question, responseEntries, mode);
        return missing;
      }

      const evidence: SurveyThemeEvidence[] = [];
      responseEntries.forEach((terms, responseId) => terms?.forEach((text) => {
        evidence.push({ id: evidence.length, responseId, text });
      }));
      if (!evidence.length) {
        question.terms = [];
        question.keywordStatus = "ready";
        updateCoverage(question, responseEntries, mode);
        return [];
      }

      const themeJobKey = key(["themes", scope, question.id, question.title, themeCacheKey,
        ...analyses.map((analysis, index) => `${analysis.fingerprint}:${JSON.stringify(responseEntries[index])}`)]);
      const exact = await cacheReadTheme(themeJobKey);
      if (exact) {
        applyThemeSnapshot(question, analyses, exact);
        question.keywordStatus = "ready";
      } else if (!model.consolidate) {
        question.keywordStatus = "unavailable";
      } else {
        const themeRetry = await retryUntil(themeJobKey);
        question.keywordStatus = themeRetry > Date.now() ? "unavailable" : "processing";
        if (question.keywordStatus === "processing") {
          scheduleThemeAggregation(themeJobKey, latestKey, question.title, evidence, analyses, model, (job) => jobs.push(job));
        }
      }
      updateCoverage(question, responseEntries, mode);
      return [];
    };

    const missing = await refresh();
    refreshers.push(async () => { await refresh(); });
    if (missing.length && question.keywordStatus === "processing") {
      scheduleBatch(extractionJobKey, missing, question.title, model, (job) => jobs.push(job), mode);
    }
  }));

  if (!jobs.length) return;
  if (inlineWaitMs <= 0 || mode === "llm") {
    jobs.forEach(defer);
    return;
  }
  const work = Promise.all(jobs.map((job) => job())).then(() => undefined);
  defer(() => work);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<void>((resolve) => { timeout = setTimeout(resolve, inlineWaitMs); })]);
  } finally { if (timeout) clearTimeout(timeout); }
  await Promise.all(refreshers.map((refresh) => refresh()));
}
