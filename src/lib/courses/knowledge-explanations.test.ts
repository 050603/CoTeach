// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedModel } from '@openmaic/lib/server/resolve-model';
const mocks = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn(), call: vi.fn(), cache: vi.fn(), durable: true }));
vi.mock('@/lib/db/client', () => ({ isDatabaseConfigured: () => mocks.durable, prisma: { $queryRaw: mocks.query, $executeRaw: mocks.execute } }));
vi.mock('@/lib/knowledge-lecture-settings', () => ({ getKnowledgeLectureTutorSettings: vi.fn() }));
vi.mock('@openmaic/lib/server/resolve-model', () => ({ resolveModel: vi.fn() }));
vi.mock('@openmaic/lib/ai/llm', () => ({ callLLM: mocks.call }));
vi.mock('@/lib/observability/classroom-ai', () => ({ recordAiCacheEvent: mocks.cache, withClassroomAiUsage: (_scope: unknown, fn: () => unknown) => fn() }));
import { explanationCacheKey, getSharedExplanation, objectiveExplanation, type ExplanationInput } from './knowledge-explanations';
const model = { modelString: 'configured/model', model: {} } as ResolvedModel;
const input: ExplanationInput = { classroomId: 'classroom', sceneId: 'scene', knowledgePointNames: ['关系'], answer: 'A',
  question: { id: 'q', type: 'single', question: '哪个正确？', options: [{ value: 'A', label: '同向' }, { value: 'B', label: '反向' }], answer: ['A'], analysis: '两者同向变化' } };
const valid = JSON.stringify({ answer: '依据给定关系，两者同向变化。', boardNotes: [] });
type Row = { id: string; status: string; token: string | null; raw: string | null; retryAt?: Date; lease?: Date; error?: string };
let rows: Map<string, Row>;
beforeEach(() => {
  vi.clearAllMocks(); mocks.durable = true; rows = new Map(); mocks.call.mockResolvedValue({ text: valid });
  mocks.query.mockImplementation(async (sql: TemplateStringsArray, ...values: unknown[]) => {
    const query = sql.join('?'); const id = values[0] as string;
    if (query.includes('INSERT INTO "KnowledgeExplanation"')) {
      const current = rows.get(id);
      if (!current || (current.status === 'FAILED' && current.retryAt!.getTime() <= Date.now()) || (current.status === 'RUNNING' && current.lease!.getTime() < Date.now())) {
        rows.set(id, { id, status: 'RUNNING', raw: current?.raw ?? null, token: values[2] as string, lease: values[3] as Date }); return [{ id }];
      }
      return [];
    }
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
describe('shared objective explanations', () => {
  it('coalesces 30 simultaneous readers through one persistent claim and reuses completed output', async () => {
    const output = await Promise.all(Array.from({ length: 30 }, () => getSharedExplanation(input, model, AbortSignal.timeout(3_000))));
    expect(new Set(output)).toEqual(new Set([valid])); expect(mocks.call).toHaveBeenCalledOnce();
    expect(await getSharedExplanation(input, model, AbortSignal.timeout(3_000))).toBe(valid);
    expect(mocks.call).toHaveBeenCalledOnce(); expect(mocks.cache).toHaveBeenCalledWith('shared-explanation', 'hit');
  });
  it('keys by answer, authored answer/reference/options, classroom and model, normalizing multi-answer order', () => {
    const key = explanationCacheKey(input, model);
    expect(explanationCacheKey({ ...input, answer: ['A'] }, model)).toBe(key);
    for (const changed of [{ ...input, answer: 'B' }, { ...input, classroomId: 'new' }, { ...input, question: { ...input.question, answer: ['B'] } }, { ...input, question: { ...input.question, analysis: '修订' } }]) expect(explanationCacheKey(changed, model)).not.toBe(key);
    expect(explanationCacheKey(input, { ...model, modelString: 'new' })).not.toBe(key);
    expect(explanationCacheKey({ ...input, question: { ...input.question, type: 'multiple' }, answer: ['A', 'B'] }, model)).toBe(explanationCacheKey({ ...input, question: { ...input.question, type: 'multiple' }, answer: ['B', 'A'] }, model));
  });
  it('keeps invalid raw output as a failed diagnostic and permits a later bounded retry', async () => {
    mocks.call.mockResolvedValueOnce({ text: '{broken' });
    await expect(getSharedExplanation(input, model, AbortSignal.timeout(3_000))).rejects.toThrow('TUTOR_INVALID_OUTPUT');
    const row = [...rows.values()][0]; expect(row).toMatchObject({ status: 'FAILED', raw: '{broken', error: 'TUTOR_INVALID_OUTPUT' });
    await expect(getSharedExplanation(input, model, AbortSignal.timeout(3_000))).rejects.toThrow('SHARED_EXPLANATION_FAILED');
    expect(mocks.call).toHaveBeenCalledOnce(); row.retryAt = new Date(0);
    await expect(getSharedExplanation(input, model, AbortSignal.timeout(3_000))).resolves.toBe(valid); expect(mocks.call).toHaveBeenCalledTimes(2);
  });
  it('reuses a valid retained answer after completion storage fails instead of paying for regeneration', async () => {
    mocks.execute.mockRejectedValueOnce(new Error('completion write failed'));
    await expect(getSharedExplanation(input, model, AbortSignal.timeout(3_000))).rejects.toThrow('completion write failed');
    const row = [...rows.values()][0];
    expect(row).toMatchObject({ status: 'FAILED', raw: valid }); row.retryAt = new Date(0);
    expect(await getSharedExplanation(input, model, AbortSignal.timeout(3_000))).toBe(valid);
    expect(mocks.call).toHaveBeenCalledOnce(); expect([...rows.values()][0].status).toBe('COMPLETED');
    expect(mocks.cache).toHaveBeenCalledWith('shared-explanation', 'hit');
  });
  it('resumes an abandoned lease, and an aborted follower does not cancel the shared owner', async () => {
    rows.set(explanationCacheKey(input, model), { id: explanationCacheKey(input, model), status: 'RUNNING', raw: null, token: 'dead', lease: new Date(0) });
    await expect(getSharedExplanation(input, model, AbortSignal.timeout(3_000))).resolves.toBe(valid);
    await expect(getSharedExplanation(input, model, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.call).toHaveBeenCalledOnce(); expect([...rows.values()][0].status).toBe('COMPLETED');
  });
  it('composes selected and missed multi-choice options without generating answer combinations', async () => {
    const multiple: ExplanationInput = { ...input, answer: ['B'], question: { ...input.question, type: 'multiple' } };
    const first = JSON.parse(await objectiveExplanation(multiple, model, AbortSignal.timeout(3_000)));
    expect(first.answer).toContain('未选，此项应选'); expect(first.answer).toContain('已选，此项不应选');
    const second = JSON.parse(await objectiveExplanation({ ...multiple, answer: ['A'] }, model, AbortSignal.timeout(3_000)));
    expect(second.answer).toContain('已选，选择正确'); expect(second.answer).toContain('未选，判断正确');
    expect(mocks.call).toHaveBeenCalledTimes(2);
    expect(mocks.call.mock.calls[0][0].prompt).toContain('不把这一个选项当作学生完整作答');
  });
  it('does not share subjective answers', async () => {
    await expect(getSharedExplanation({ ...input, question: { ...input.question, type: 'short_answer' } }, model, AbortSignal.timeout(3_000))).rejects.toThrow('OBJECTIVE_ONLY');
    expect(mocks.call).not.toHaveBeenCalled();
  });
});
