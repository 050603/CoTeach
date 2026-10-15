// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel } from '@openmaic/lib/server/resolve-model';
const mocks = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn(), call: vi.fn(), cache: vi.fn(), audio: vi.fn(), durable: true }));
vi.mock('@/lib/db/client', () => ({ isDatabaseConfigured: () => mocks.durable, prisma: { $queryRaw: mocks.query, $executeRaw: mocks.execute } }));
vi.mock('@/lib/knowledge-lecture-settings', () => ({ getKnowledgeLectureTutorSettings: vi.fn() }));
vi.mock('@openmaic/lib/server/resolve-model', () => ({ resolveModel: vi.fn() }));
vi.mock('@openmaic/lib/ai/llm', () => ({ callLLM: mocks.call }));
vi.mock('./knowledge-explanation-audio', () => ({ prepareExplanationAudio: mocks.audio, readableExplanationAudio: vi.fn(async () => ({})) }));
vi.mock('@/lib/observability/classroom-ai', () => ({ recordAiCacheEvent: mocks.cache, withClassroomAiUsage: (_scope: unknown, fn: () => unknown) => fn() }));
import { explanationCacheKey, explanationContentKey, explanationPrompt, getSharedExplanation, isOrdinaryQuestion, parsePreparedExplanation, prepareKnowledgeExplanation, readPreparedExplanation, type ExplanationInput } from './knowledge-explanations';
import { authoredQuestionFingerprint } from './knowledge-tutor-evidence';
const model = { modelString: 'configured/model', model: {} } as ResolvedModel;
const input: ExplanationInput = { classroomId: 'classroom', sceneId: 'scene', knowledgePointNames: ['关系'],
  sourceEvidence: { items: [], authoredQuotes: [] },
  question: { id: 'q', type: 'single', question: '哪个正确？', options: [{ value: 'A', label: '同向' }, { value: 'B', label: '反向' }], answer: ['A'], analysis: '两者同向变化' } };
const valid = JSON.stringify({ introduction: '先看变量的关系。', items: [{ key: 'A', explanation: '两者同向。' }, { key: 'B', explanation: '把方向弄反了。' }], takeaway: '判断时注意变化方向。', boardNotes: [] });
type Row = { id: string; status: string; token: string | null; raw: string | null; input: ExplanationInput; contentKey: string; retryAt?: Date; lease?: Date; error?: string; createdAt: Date };
let rows: Map<string, Row>;
const lookup = () => ({ classroomId: input.classroomId, sceneId: input.sceneId, questionFingerprint: authoredQuestionFingerprint(input.question, input.sourceEvidence!) });
beforeEach(() => {
  vi.clearAllMocks(); mocks.durable = true; rows = new Map(); mocks.call.mockResolvedValue({ text: valid }); mocks.audio.mockResolvedValue({ audioUrl: '/prepared.wav', audioDurationSec: 60 });
  mocks.query.mockImplementation(async (sql: TemplateStringsArray, ...values: unknown[]) => {
    const query = sql.join('?'); const id = values[0] as string;
    if (query.includes('INSERT INTO "KnowledgeExplanation"')) {
      const current = rows.get(id);
      if (!current || (current.status === 'FAILED' && current.retryAt!.getTime() <= Date.now()) || (current.status === 'RUNNING' && current.lease!.getTime() < Date.now())) {
        rows.set(id, { id, status: 'RUNNING', raw: current?.raw ?? null, input: JSON.parse(values[1] as string), contentKey: values[5] as string, createdAt: new Date(), token: values[2] as string, lease: values[3] as Date }); return [{ id }];
      }
      return [];
    }
    if (query.includes('WHERE "contentKey"')) return [...rows.values()].filter(row => row.contentKey === id && row.status === 'COMPLETED');
    return rows.has(id) ? [{ ...rows.get(id) }] : [];
  });
  mocks.execute.mockImplementation(async (sql: TemplateStringsArray, ...values: unknown[]) => {
    const current = rows.get(values.at(-2) as string);
    if (!current || current.token !== values.at(-1)) return 0;
    current.raw = values[0] as string ?? current.raw; current.token = null;
    if (sql.join('?').includes("status = 'COMPLETED'")) current.status = 'COMPLETED';
    else { current.status = 'FAILED'; current.error = values[1] as string; current.retryAt = values[2] as Date; }
    return 1;
  });
});
describe('prepared question lectures', () => {
  it('generates once for 30 concurrent background requests, regardless of legacy student answers', async () => {
    const output = await Promise.all(Array.from({ length: 30 }, (_, index) => getSharedExplanation({ ...input, answer: index % 2 ? 'A' : 'B' } as ExplanationInput, model, AbortSignal.timeout(3_000))));
    expect(new Set(output)).toEqual(new Set([valid])); expect(mocks.call).toHaveBeenCalledOnce();
    expect([...rows.values()][0].input).not.toHaveProperty('answer');
    const prompt = mocks.call.mock.calls[0][0].prompt;
    expect(prompt).not.toContain('本次作答'); expect(prompt).not.toContain('学生答案');
  });
  it('serves 30 student reads, misses and replays without generation, audio preparation or mutation', async () => {
    expect(await readPreparedExplanation(lookup())).toBeNull();
    expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.call).not.toHaveBeenCalled();
    await getSharedExplanation(input, model, AbortSignal.timeout(3_000));
    mocks.call.mockClear(); mocks.execute.mockClear();
    const output = await Promise.all(Array.from({ length: 30 }, () => readPreparedExplanation(lookup())));
    expect(output.every(item => item?.source === 'prepared' && item.text.includes('A项：符合题意'))).toBe(true);
    expect(new Set(output.map(item => item?.id)).size).toBe(1);
    expect(mocks.call).not.toHaveBeenCalled(); expect(mocks.audio).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('keys by authored question and source version, but not student answer or generation credentials for reads', () => {
    const key = explanationCacheKey(input, model);
    expect(explanationCacheKey({ ...input, answer: 'B' } as ExplanationInput, model)).toBe(key);
    for (const changed of [{ ...input, classroomId: 'new' }, { ...input, question: { ...input.question, answer: ['B'] } }, { ...input, sourceEvidence: { ...input.sourceEvidence!, fingerprint: 'revised-book' } }]) expect(explanationCacheKey(changed, model)).not.toBe(key);
    expect(explanationCacheKey(input, { ...model, modelString: 'new' })).not.toBe(key);
    expect(explanationContentKey(lookup())).not.toBe(explanationContentKey({ ...lookup(), sceneId: 'other-scene' }));
  });
  it('does not serve a different authored or evidence version', async () => {
    await getSharedExplanation(input, model, AbortSignal.timeout(3_000));
    expect(await readPreparedExplanation({ ...lookup(), questionFingerprint: 'other-version' })).toBeNull();
  });
  it('keeps the source fingerprint across JSONB object-key reordering', async () => {
    await getSharedExplanation(input, model, AbortSignal.timeout(3_000));
    const row = [...rows.values()][0];
    row.input.question = Object.fromEntries(Object.entries(row.input.question).sort(([a], [b]) => a.localeCompare(b))) as ExplanationInput['question'];
    expect(authoredQuestionFingerprint(row.input.question, row.input.sourceEvidence!)).not.toBe(lookup().questionFingerprint);
    expect(await readPreparedExplanation(lookup())).toMatchObject({ questionFingerprint: lookup().questionFingerprint, source: 'prepared' });
    expect(explanationCacheKey(row.input, model)).toBe(row.id);
  });
  it('requires exactly one explanation for every option and keeps the raw failed output for retry', async () => {
    const incomplete = JSON.stringify({ introduction: '看方向', items: [{ key: 'A', explanation: '同向' }], takeaway: '注意关系' });
    mocks.call.mockResolvedValueOnce({ text: incomplete });
    await expect(getSharedExplanation(input, model, AbortSignal.timeout(3_000))).rejects.toThrow('TUTOR_INVALID_OUTPUT');
    const row = [...rows.values()][0]; expect(row).toMatchObject({ status: 'FAILED', raw: incomplete, error: 'TUTOR_INVALID_OUTPUT' });
    await expect(getSharedExplanation(input, model, AbortSignal.timeout(3_000))).rejects.toThrow('SHARED_EXPLANATION_FAILED');
    expect(mocks.call).toHaveBeenCalledOnce(); row.retryAt = new Date(0);
    await expect(getSharedExplanation(input, model, AbortSignal.timeout(3_000))).resolves.toBe(valid); expect(mocks.call).toHaveBeenCalledTimes(2);
  });
  it('reuses retained valid text after its completion ACK failed', async () => {
    mocks.execute.mockRejectedValueOnce(new Error('completion write failed'));
    await expect(getSharedExplanation(input, model, AbortSignal.timeout(3_000))).rejects.toThrow('completion write failed');
    const row = [...rows.values()][0]; expect(row).toMatchObject({ status: 'FAILED', raw: valid }); row.retryAt = new Date(0);
    expect(await getSharedExplanation(input, model, AbortSignal.timeout(3_000))).toBe(valid);
    expect(mocks.call).toHaveBeenCalledOnce();
  });
  it('retries only audio when synthesis fails after text committed', async () => {
    mocks.audio.mockRejectedValueOnce(new Error('audio unavailable'));
    await expect(prepareKnowledgeExplanation(input, model, AbortSignal.timeout(3_000))).rejects.toThrow('audio unavailable');
    expect([...rows.values()][0].status).toBe('COMPLETED');
    expect(await readPreparedExplanation(lookup())).toMatchObject({ source: 'prepared' });
    expect(await prepareKnowledgeExplanation(input, model, AbortSignal.timeout(3_000))).toMatchObject({ audioUrl: '/prepared.wav' });
    expect(mocks.call).toHaveBeenCalledOnce(); expect(mocks.audio).toHaveBeenCalledTimes(2);
  });
  it('covers ordinary fill blanks and matching while excluding deep responses', () => {
    expect(isOrdinaryQuestion({ type: 'short_answer', format: 'fill_blank' })).toBe(true);
    expect(isOrdinaryQuestion({ type: 'matching', format: 'matching' })).toBe(true);
    expect(isOrdinaryQuestion({ type: 'short_answer', format: 'scenario_task' })).toBe(false);
    expect(isOrdinaryQuestion({ type: 'short_answer' })).toBe(false);
    expect(explanationPrompt({ ...input, question: { ...input.question, referenceAnswer: '另一份答案' } })).toContain('两者同向变化');
    const blank = { ...input, question: { id: 'blank', type: 'short_answer', format: 'fill_blank', question: '填空', referenceAnswer: '同化' } } as ExplanationInput;
    const raw = JSON.stringify({ introduction: '判断框架是否改变。', items: [{ key: 'answer', explanation: '原框架未变。' }], takeaway: '不改变原框架。' });
    expect(parsePreparedExplanation(raw, blank, '2026-01-01').answer).toContain('参考答案：同化');
  });
  it('recovers an abandoned lease, and a disconnected reader cannot cancel the owner', async () => {
    const id = explanationCacheKey(input, model);
    rows.set(id, { id, status: 'RUNNING', raw: null, token: 'dead', lease: new Date(0), input, contentKey: explanationContentKey(lookup()), createdAt: new Date() });
    expect(await getSharedExplanation(input, model, AbortSignal.timeout(3_000))).toBe(valid);
    await expect(getSharedExplanation(input, model, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.call).toHaveBeenCalledOnce();
  });
  it('never generates on a database-free shared lookup or a deep question', async () => {
    mocks.durable = false;
    expect(await readPreparedExplanation(lookup())).toBeNull();
    await expect(getSharedExplanation(input, model, AbortSignal.timeout(3_000))).rejects.toThrow('DATABASE_REQUIRED');
    await expect(getSharedExplanation({ ...input, question: { ...input.question, type: 'short_answer' } }, model, AbortSignal.timeout(3_000))).rejects.toThrow('OBJECTIVE_ONLY');
    expect(mocks.call).not.toHaveBeenCalled();
  });
});
