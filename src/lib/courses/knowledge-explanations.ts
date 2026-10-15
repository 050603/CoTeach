import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { prisma, isDatabaseConfigured } from '@/lib/db/client';
import { getKnowledgeLectureTutorSettings } from '@/lib/knowledge-lecture-settings';
import { resolveModel, type ResolvedModel } from '@openmaic/lib/server/resolve-model';
import { callLLM } from '@openmaic/lib/ai/llm';
import type { QuizQuestion } from '@openmaic/lib/types/stage';
import { authoredQuestionFingerprint, tutorEvidencePrompt, type TutorEvidence } from './knowledge-tutor-evidence';
import { parseTutorPayload, TUTOR_EXECUTION_MS, TUTOR_LEASE_MS } from './knowledge-tutor-payload';
import { recordAiCacheEvent, withClassroomAiUsage } from '@/lib/observability/classroom-ai';
import type { KnowledgeLectureExplanation } from './knowledge-explanation-types';
import { EXPLANATION_VERSION } from './knowledge-explanation-types';

export { EXPLANATION_VERSION } from './knowledge-explanation-types';
export type ExplanationInput = {
  classroomId: string; sceneId: string; question: QuizQuestion;
  knowledgePointNames: string[]; sourceEvidence?: TutorEvidence;
  /** Computed from the source file before JSONB can reorder object fields. */
  questionFingerprint?: string;
};
type CacheRow = {
  id: string; status: string; raw: string | null; token: string | null;
  retryAt: Date | null; input: ExplanationInput; audio?: unknown; createdAt?: Date;
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const evidenceFor = (input: ExplanationInput) => input.sourceEvidence ?? { items: [], authoredQuotes: [] };
export const isOrdinaryQuestion = (question: Pick<QuizQuestion, 'type' | 'format'>): boolean =>
  question.format !== 'scenario_task' && (question.type !== 'short_answer' || question.format === 'fill_blank');

export async function resolveKnowledgeTutorModel(): Promise<ResolvedModel> {
  const settings = await getKnowledgeLectureTutorSettings();
  return resolveModel(settings.modelString ? { modelString: settings.modelString } : { stage: 'quiz-grade' });
}
export function explanationContentKey(input: { classroomId: string; sceneId: string; questionFingerprint: string }): string {
  return hash([EXPLANATION_VERSION, input.classroomId, input.sceneId, input.questionFingerprint]);
}
export function explanationCacheKey(input: ExplanationInput, model: Pick<ResolvedModel, 'modelString' | 'baseUrl' | 'thinkingConfig'>): string {
  return hash([explanationContentKey({ ...input, questionFingerprint: input.questionFingerprint ?? authoredQuestionFingerprint(input.question, evidenceFor(input)) }),
    input.knowledgePointNames, model.modelString, model.baseUrl, model.thinkingConfig]);
}
/** Explicit item identities make omission detectable without guessing from prose. */
export function explanationItems(question: QuizQuestion): Array<{ key: string; label: string }> {
  if (question.options?.length) return question.options.map(option => ({ key: option.value,
    label: `${question.format === 'true_false' ? option.label : `${option.value}项`}：${question.answer?.includes(option.value) ? '符合题意' : '不符合题意'}` }));
  if (question.matchingPairs?.length) return question.matchingPairs.map((pair, index) => ({ key: pair.leftId, label: `第${index + 1}组配对` }));
  return [{ key: 'answer', label: `参考答案：${question.referenceAnswer || question.answer?.join('、') || ''}` }];
}
export function explanationPrompt(input: ExplanationInput): string {
  const q = input.question;
  return `${tutorEvidencePrompt(input.sourceEvidence)}\n知识点：${input.knowledgePointNames.join('、')}\n题目：${q.question}\n题型：${q.format || q.type}\n选项：${JSON.stringify(q.options ?? [])}\n正确配对：${JSON.stringify(q.matchingPairs ?? [])}\n标准答案：${q.answer?.join('、') || q.referenceAnswer || '未提供'}\n参考答案：${q.referenceAnswer || '未提供'}\n原题解析：${q.analysis || '未提供'}\n必须逐项解释以下所有条目，items 的 key 与列表一一对应，每项必须填写自己的 explanation，不能只返回 key/label 或把解释放在顶层：${JSON.stringify(explanationItems(q).map(item => ({ ...item, explanation: '填写该项简明而完整的判断依据' })))}`;
}
const SYSTEM = `你是课堂伴学助教，为一道普通小测提前准备面向全体学生的统一讲解。不知道学生选择了什么，不评价学生，不说“你选了”“你错在”，不猜测个人想法。直接讲解题目，不重复朗读整段题干和选项。
通常45–75秒，约200–300个汉字，难题可适度延长，不能为控制长度省掉条目或关键条件。选择题必须逐一说明每个选项正确或错误的依据；判断题讲清判断及适用条件；填空题说明答案与必要边界；配对题逐一解释对应关系。只按给出的题目、标准答案、原解析和实际采用的原文讲解，关键定义与条件准确，不虚构教材事实。每项通常用35–50字说明最关键的依据，不重复题干和选项原文；intro与takeaway各一句，不在每个位置重复同一套定义，更多例子留给学生追问。
严格返回JSON：{"introduction":"一句切入判断方法","items":[{"key":"给定条目的key","explanation":"该项依据"}],"takeaway":"一句核心方法或易错边界","boardNotes":[{"title":"核心板书","body":"简短内容","kind":"concept|evidence|correction|example"}]}。每个给定条目恰好出现一次，不增加条目；boardNotes最多2条，可为空。`;
export function parsePreparedExplanation(raw: string, input: ExplanationInput, now: string) {
  let value: { introduction?: unknown; items?: unknown; takeaway?: unknown; boardNotes?: unknown };
  try { value = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw); } catch { throw new Error('TUTOR_INVALID_OUTPUT'); }
  if (!value || typeof value.introduction !== 'string' || !value.introduction.trim()
    || typeof value.takeaway !== 'string' || !value.takeaway.trim() || !Array.isArray(value.items)) throw new Error('TUTOR_INVALID_OUTPUT');
  const items = value.items as Array<{ key?: unknown; explanation?: unknown }>;
  const expected = explanationItems(input.question);
  if (items.length !== expected.length || expected.some(item => items.filter(candidate => candidate?.key === item.key
    && typeof candidate.explanation === 'string' && candidate.explanation.trim()).length !== 1)) throw new Error('TUTOR_INVALID_OUTPUT');
  const answer = [value.introduction.trim(), ...expected.map(item => `${item.label}。${items.find(candidate => candidate.key === item.key)!.explanation as string}`), value.takeaway.trim()].join('\n\n');
  return parseTutorPayload(JSON.stringify({ answer, boardNotes: value.boardNotes }), now);
}
async function readRow(id: string): Promise<CacheRow> {
  const [row] = await prisma.$queryRaw<CacheRow[]>`SELECT id, status, raw, token, "retryAt", input, audio, "createdAt" FROM "KnowledgeExplanation" WHERE id = ${id}`;
  return row;
}
async function claim(id: string, input: ExplanationInput, token: string): Promise<boolean> {
  const now = new Date();
  const contentKey = explanationContentKey({ ...input, questionFingerprint: input.questionFingerprint ?? authoredQuestionFingerprint(input.question, evidenceFor(input)) });
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`INSERT INTO "KnowledgeExplanation"
    (id, status, input, token, "leaseUntil", "updatedAt", "contentKey") VALUES (${id}, 'RUNNING', ${JSON.stringify(input)}::jsonb, ${token}, ${new Date(now.getTime() + TUTOR_LEASE_MS)}, ${now}, ${contentKey})
    ON CONFLICT (id) DO UPDATE SET status = 'RUNNING', token = EXCLUDED.token, "leaseUntil" = EXCLUDED."leaseUntil", "updatedAt" = EXCLUDED."updatedAt", error = NULL
    WHERE ("KnowledgeExplanation".status = 'FAILED' AND "KnowledgeExplanation"."retryAt" <= ${now})
       OR ("KnowledgeExplanation".status = 'RUNNING' AND "KnowledgeExplanation"."leaseUntil" < ${now})
    RETURNING id`;
  return rows.length === 1;
}
/** Background generation only. Student reads must use readPreparedExplanation. */
export async function getSharedExplanation(input: ExplanationInput, model: ResolvedModel, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (!isOrdinaryQuestion(input.question)) throw new Error('SHARED_EXPLANATION_OBJECTIVE_ONLY');
  if (!isDatabaseConfigured()) throw new Error('SHARED_EXPLANATION_DATABASE_REQUIRED');
  // Enumerate shared input: neither student identity nor a legacy answer enters storage or generation.
  input = { classroomId: input.classroomId, sceneId: input.sceneId, question: input.question,
    knowledgePointNames: input.knowledgePointNames, sourceEvidence: input.sourceEvidence,
    questionFingerprint: input.questionFingerprint ?? authoredQuestionFingerprint(input.question, evidenceFor(input)) };
  const id = explanationCacheKey(input, model); const token = randomUUID();
  if (await claim(id, input, token)) {
    let raw: string | undefined;
    try {
      const retained = await readRow(id);
      if (retained?.raw) {
        try { parsePreparedExplanation(retained.raw, input, new Date().toISOString()); raw = retained.raw; } catch { /* Keep malformed output as diagnostics. */ }
      }
      if (raw !== undefined) recordAiCacheEvent('shared-explanation', 'hit');
      else {
        recordAiCacheEvent('shared-explanation', 'miss');
        const executionSignal = AbortSignal.any([signal, AbortSignal.timeout(TUTOR_EXECUTION_MS)]);
        const result = await withClassroomAiUsage({ feature: 'shared-explanation' }, () => callLLM({ model: model.model, system: SYSTEM,
          prompt: explanationPrompt(input), abortSignal: executionSignal, maxRetries: 0 }, 'knowledge-shared-explanation', undefined, model.thinkingConfig));
        raw = result.text; executionSignal.throwIfAborted();
        parsePreparedExplanation(raw, input, new Date().toISOString());
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
      parsePreparedExplanation(row.raw, input, new Date().toISOString());
      if (!joined) recordAiCacheEvent('shared-explanation', 'hit');
      return row.raw;
    }
    if (row?.status !== 'RUNNING') throw new Error('SHARED_EXPLANATION_FAILED');
    if (!joined) { recordAiCacheEvent('shared-explanation', 'joined'); joined = true; }
    await sleep(500, undefined, { signal });
  }
}
function resource(row: CacheRow, input: ExplanationInput, fingerprint?: string): KnowledgeLectureExplanation {
  const parsed = parsePreparedExplanation(row.raw!, input, new Date(row.createdAt ?? 0).toISOString());
  return { id: row.id, questionFingerprint: fingerprint ?? input.questionFingerprint ?? authoredQuestionFingerprint(input.question, evidenceFor(input)),
    text: parsed.answer, boardNotes: parsed.notes, source: 'prepared' };
}
/** Pure resource lookup: no model resolution, lease, job, personalized task, or generation. */
export async function readPreparedExplanation(input: { classroomId: string; sceneId: string; questionFingerprint: string }): Promise<KnowledgeLectureExplanation | null> {
  if (!isDatabaseConfigured()) return null;
  const contentKey = explanationContentKey(input);
  const rows = await prisma.$queryRaw<CacheRow[]>`SELECT id, status, raw, input, audio, "createdAt" FROM "KnowledgeExplanation"
    WHERE "contentKey" = ${contentKey} AND status = 'COMPLETED' ORDER BY "createdAt" DESC LIMIT 3`;
  for (const row of rows) {
    if (!row.raw || !row.input) continue;
    try {
      if (row.input.classroomId !== input.classroomId || row.input.sceneId !== input.sceneId) continue;
      // SQL already matched the source fingerprint's contentKey. Rehashing a
      // JSONB object would reject valid resources solely due to key order.
      const result = resource(row, row.input, input.questionFingerprint);
      if (row.audio) {
        const { readableExplanationAudio } = await import('./knowledge-explanation-audio');
        Object.assign(result, await readableExplanationAudio(input.classroomId, row.audio));
      }
      recordAiCacheEvent('shared-explanation', 'hit');
      return result;
    } catch { /* Bad historical resource cannot replace the original authored reference. */ }
  }
  recordAiCacheEvent('shared-explanation', 'miss');
  return null;
}
/** Text survives audio failures. Retrying the same job only completes its missing audio. */
export async function prepareKnowledgeExplanation(input: ExplanationInput, model: ResolvedModel, signal: AbortSignal): Promise<KnowledgeLectureExplanation> {
  const raw = await getSharedExplanation(input, model, signal);
  const id = explanationCacheKey(input, model);
  const row = await readRow(id);
  const result = resource({ ...row, id, raw }, input);
  const { prepareExplanationAudio } = await import('./knowledge-explanation-audio');
  Object.assign(result, await prepareExplanationAudio({ id, classroomId: input.classroomId, text: result.text, audio: row?.audio }, signal));
  return result;
}
