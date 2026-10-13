import { tutorEvidencePrompt, type TutorEvidence } from "./knowledge-tutor-evidence";
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { prisma, isDatabaseConfigured } from '@/lib/db/client';
import { getKnowledgeLectureTutorSettings } from '@/lib/knowledge-lecture-settings';
import { resolveModel, type ResolvedModel } from '@openmaic/lib/server/resolve-model';
import { callLLM } from '@openmaic/lib/ai/llm';
import type { QuizQuestion } from '@openmaic/lib/types/stage';
import { parseTutorPayload, TUTOR_EXECUTION_MS, TUTOR_LEASE_MS, TUTOR_PROMPT_VERSION, TUTOR_SYSTEM } from './knowledge-tutor-payload';
import { recordAiCacheEvent, withClassroomAiUsage } from '@/lib/observability/classroom-ai';

export type ExplanationInput = {
  classroomId: string; sceneId: string; question: QuizQuestion;
  knowledgePointNames: string[]; sourceEvidence?: TutorEvidence; answer: string | string[]; mode?: 'option';
};
type CacheRow = { id: string; status: string; raw: string | null; token: string | null; retryAt: Date | null };
export async function resolveKnowledgeTutorModel(): Promise<ResolvedModel> {
  const settings = await getKnowledgeLectureTutorSettings();
  return resolveModel(settings.modelString ? { modelString: settings.modelString } : { stage: 'quiz-grade' });
}
export function explanationCacheKey(input: ExplanationInput, model: Pick<ResolvedModel, 'modelString' | 'baseUrl' | 'thinkingConfig'>): string {
  const q = input.question;
  const answer = q.type === 'single' ? (Array.isArray(input.answer) ? input.answer[0] ?? '' : input.answer)
    : Array.isArray(input.answer) ? [...new Set(input.answer)].sort() : input.answer;
  // Enumerate authored fields: never let a caller's identity/history enter a shared key or prompt.
  return createHash('sha256').update(JSON.stringify({ version: TUTOR_PROMPT_VERSION,
    classroomId: input.classroomId, sceneId: input.sceneId, mode: input.mode ?? 'answer',
    question: { id: q.id, type: q.type, format: q.format, question: q.question, options: q.options,
      answer: q.answer, matchingPairs: q.matchingPairs, analysis: q.analysis, referenceAnswer: q.referenceAnswer,
      commentPrompt: q.commentPrompt, scoringRubric: q.scoringRubric, points: q.points },
    knowledgePointNames: input.knowledgePointNames, sourceEvidence: input.sourceEvidence, answer,
    model: model.modelString, endpoint: model.baseUrl, thinking: model.thinkingConfig,
  })).digest('hex');
}
export function explanationPrompt(input: ExplanationInput): string {
  const q = input.question;
  const choices = q.options?.length ? `选项：\n${q.options.map(o => `${o.value}. ${o.label}`).join('\n')}`
    : q.matchingPairs?.map(pair => `${pair.leftId}:${pair.rightId} ${pair.left} → ${pair.right}`).join('\n') ?? '';
  return `${tutorEvidencePrompt(input.sourceEvidence)}\n知识点：${input.knowledgePointNames.join('、')}\n题目：${q.question}\n${choices}\n标准答案：${q.answer?.join('、') || '未提供'}\n参考讲解：${q.referenceAnswer || q.analysis || '未提供'}\n${input.mode === 'option'
    ? `仅解释选项 ${input.answer} 本身应选或不应选的依据，不把这一个选项当作学生完整作答，也不要猜测学生想法。`
    : `本次作答：${Array.isArray(input.answer) ? [...input.answer].sort().join('、') : input.answer || '未作答'}。请给出该作答的首次讲解，不引用任何个人经历或历史对话。`}`;
}

async function readRow(id: string): Promise<CacheRow> {
  const [row] = await prisma.$queryRaw<CacheRow[]>`SELECT id, status, raw, token, "retryAt" FROM "KnowledgeExplanation" WHERE id = ${id}`;
  return row;
}
async function claim(id: string, input: ExplanationInput, token: string): Promise<boolean> {
  const now = new Date(); const lease = new Date(now.getTime() + TUTOR_LEASE_MS);
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`INSERT INTO "KnowledgeExplanation"
    (id, status, input, token, "leaseUntil", "updatedAt") VALUES (${id}, 'RUNNING', ${JSON.stringify(input)}::jsonb, ${token}, ${lease}, ${now})
    ON CONFLICT (id) DO UPDATE SET status = 'RUNNING', token = EXCLUDED.token, "leaseUntil" = EXCLUDED."leaseUntil", "updatedAt" = EXCLUDED."updatedAt", error = NULL
    WHERE ("KnowledgeExplanation".status = 'FAILED' AND "KnowledgeExplanation"."retryAt" <= ${now})
       OR ("KnowledgeExplanation".status = 'RUNNING' AND "KnowledgeExplanation"."leaseUntil" < ${now})
    RETURNING id`;
  return rows.length === 1;
}
async function generate(input: ExplanationInput, model: ResolvedModel, signal: AbortSignal): Promise<string> {
  return withClassroomAiUsage({ feature: 'shared-explanation' }, async () => {
    const result = await callLLM({ model: model.model, system: TUTOR_SYSTEM, prompt: explanationPrompt(input), abortSignal: signal, maxRetries: 0 }, 'knowledge-shared-explanation', undefined, model.thinkingConfig);
    parseTutorPayload(result.text, new Date().toISOString());
    return result.text;
  });
}

/** SQL uniqueness + expiring owner token coalesce across workers and processes. */
export async function getSharedExplanation(input: ExplanationInput, model: ResolvedModel, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (input.question.type === 'short_answer') throw new Error('SHARED_EXPLANATION_OBJECTIVE_ONLY');
  if (!isDatabaseConfigured()) return generate(input, model, signal);
  const id = explanationCacheKey(input, model); const token = randomUUID();
  if (await claim(id, input, token)) {
    let raw: string | undefined;
    try {
      // A previous model answer may be durable even when its completion ACK failed.
      // Validate it under this exact cache key before spending another model call.
      const retained = await readRow(id);
      if (retained?.raw) {
        try { parseTutorPayload(retained.raw, new Date().toISOString()); raw = retained.raw; }
        catch { /* Invalid historical output is diagnostic evidence, not a cache hit. */ }
      }
      if (raw !== undefined) recordAiCacheEvent('shared-explanation', 'hit');
      else {
        recordAiCacheEvent('shared-explanation', 'miss');
        // Route callers pass a server-owned deadline, never a browser-disconnect signal.
        const executionSignal = AbortSignal.any([signal, AbortSignal.timeout(TUTOR_EXECUTION_MS)]);
        const result = await withClassroomAiUsage({ feature: 'shared-explanation' }, () => callLLM({ model: model.model, system: TUTOR_SYSTEM,
          prompt: explanationPrompt(input), abortSignal: executionSignal, maxRetries: 0 }, 'knowledge-shared-explanation', undefined, model.thinkingConfig));
        raw = result.text;
        executionSignal.throwIfAborted();
        parseTutorPayload(raw, new Date().toISOString());
      }
      const count = await prisma.$executeRaw`UPDATE "KnowledgeExplanation" SET status = 'COMPLETED', raw = ${raw}, error = NULL,
        token = NULL, "leaseUntil" = NULL, "retryAt" = NULL, "updatedAt" = NOW() WHERE id = ${id} AND token = ${token} AND status = 'RUNNING'`;
      if (count !== 1) throw new Error('SHARED_EXPLANATION_LEASE_EXPIRED');
      return raw;
    } catch (error) {
      const code = error instanceof Error && error.message === 'TUTOR_INVALID_OUTPUT' ? 'TUTOR_INVALID_OUTPUT' : 'SHARED_EXPLANATION_FAILED';
      await prisma.$executeRaw`UPDATE "KnowledgeExplanation" SET status = 'FAILED', raw = COALESCE(${raw ?? null}, raw), error = ${code},
        token = NULL, "leaseUntil" = NULL, "retryAt" = ${new Date(Date.now() + 10_000)}, "updatedAt" = NOW() WHERE id = ${id} AND token = ${token}`;
      throw error;
    }
  }
  let joined = false;
  for (;;) {
    signal.throwIfAborted();
    const row = await readRow(id);
    if (row?.status === 'COMPLETED' && row.raw) {
      parseTutorPayload(row.raw, new Date().toISOString());
      if (!joined) recordAiCacheEvent('shared-explanation', 'hit');
      return row.raw;
    }
    if (row?.status !== 'RUNNING') throw new Error('SHARED_EXPLANATION_FAILED');
    if (!joined) { recordAiCacheEvent('shared-explanation', 'joined'); joined = true; }
    await sleep(500, undefined, { signal });
  }
}

/** Multi-select feedback shares each option's explanation, then composes the exact answer deterministically. */
export async function objectiveExplanation(input: ExplanationInput, model: ResolvedModel, signal: AbortSignal): Promise<string> {
  if (input.question.type !== 'multiple' || !input.question.options?.length) return getSharedExplanation(input, model, signal);
  const selected = new Set(Array.isArray(input.answer) ? input.answer : [input.answer]);
  const correct = new Set(input.question.answer ?? []);
  const answers: string[] = [];
  const notes: ReturnType<typeof parseTutorPayload>['notes'] = [];
  const optionResults = await Promise.all(input.question.options.map(async option => {
    const raw = await getSharedExplanation({ ...input, answer: option.value, mode: 'option' }, model, signal);
    const payload = parseTutorPayload(raw, new Date().toISOString());
    return { option, payload };
  }));
  for (const { option, payload } of optionResults) {
    const marker = selected.has(option.value) ? correct.has(option.value) ? '已选，选择正确' : '已选，此项不应选' : correct.has(option.value) ? '未选，此项应选' : '未选，判断正确';
    answers.push(`${option.value}. ${option.label}（${marker}）\n${payload.answer}`);
    notes.push(...payload.notes);
  }
  return JSON.stringify({ answer: answers.join('\n\n'), boardNotes: notes.slice(0, 2).map(({ title, body, kind }) => ({ title, body, kind })) });
}
