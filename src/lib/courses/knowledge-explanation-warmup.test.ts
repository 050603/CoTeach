// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import type { Course } from '@/lib/session/types';
const mocks = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn(), classroom: vi.fn(), model: vi.fn(), shared: vi.fn(), background: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ isDatabaseConfigured: () => true, prisma: { $queryRaw: mocks.query, $executeRaw: mocks.execute } }));
vi.mock('@openmaic/lib/server/classroom-storage', () => ({ readClassroom: mocks.classroom }));
vi.mock('@/lib/llm/classroom-capacity', () => ({ withBackgroundAiPriority: (fn: () => unknown) => { mocks.background(); return fn(); } }));
vi.mock('./knowledge-explanations', () => ({ getSharedExplanation: mocks.shared, resolveKnowledgeTutorModel: mocks.model }));
import { enqueueKnowledgeExplanationWarmup, runKnowledgeExplanationWarmup } from './knowledge-explanation-warmup';
const warmup = { id: 'job', attempts: 1, input: { classroomId: 'classroom', sections: [{ quizOutlineId: 'quiz', knowledgePointIds: ['kp'] }], knowledgePoints: [{ id: 'kp', name: '关系' }] } };
beforeEach(() => {
  vi.clearAllMocks(); mocks.query.mockResolvedValue([warmup]); mocks.execute.mockResolvedValue(1); mocks.model.mockResolvedValue({}); mocks.shared.mockResolvedValue('{}');
  const question = { id: 'q', question: '选择', options: [{ value: 'A', label: '正' }, { value: 'B', label: '误' }], answer: ['A'] };
  mocks.classroom.mockResolvedValue({ scenes: [{ id: 'scene', outlineId: 'quiz', content: { type: 'quiz', questions: [
    { ...question, type: 'single' }, { ...question, id: 'm', type: 'multiple' }, { ...question, id: 's', type: 'short_answer' },
  ] } }] });
});
describe('durable explanation warmup', () => {
  it('only enqueues during publication, and workers prewarm single and independent multi-select options', async () => {
    const course = { id: 'course', version: 1, aiLearningClassroomId: 'classroom', content: { knowledgeLectureSections: warmup.input.sections, knowledgePoints: warmup.input.knowledgePoints } } as Course;
    await enqueueKnowledgeExplanationWarmup({ $executeRaw: mocks.execute } as unknown as Prisma.TransactionClient, course);
    expect(mocks.shared).not.toHaveBeenCalled(); expect(mocks.execute.mock.calls[0][0].join('')).toContain('ON CONFLICT (id) DO NOTHING');
    await runKnowledgeExplanationWarmup(AbortSignal.timeout(3_000));
    expect(mocks.shared).toHaveBeenCalledTimes(4); expect(mocks.background).toHaveBeenCalledTimes(4);
    expect(mocks.shared.mock.calls[2][0]).toMatchObject({ mode: 'option', answer: 'A', knowledgePointNames: ['关系'] });
    expect(mocks.execute.mock.calls.at(-1)?.[0].join('')).toContain("status = 'COMPLETED'");
    expect(mocks.query.mock.calls[0][0].join('')).toContain('FOR UPDATE SKIP LOCKED');
  });
  it('retains a failed job for bounded retry without affecting publication or generating a fallback', async () => {
    mocks.shared.mockRejectedValue(new Error('provider unavailable'));
    expect(await runKnowledgeExplanationWarmup(AbortSignal.timeout(3_000))).toBe(true);
    expect(mocks.execute.mock.calls.at(-1)?.slice(1)).toContain('FAILED');
    expect(mocks.execute.mock.calls.at(-1)?.slice(1)).toContain('WARMUP_GENERATION_FAILED');
    expect(mocks.shared).toHaveBeenCalledOnce();
  });
  it('defers background capacity pressure without consuming the technical failure budget', async () => {
    mocks.shared.mockRejectedValue(Object.assign(new Error('busy'), { name: 'LlmRateLimitError' }));
    await runKnowledgeExplanationWarmup(AbortSignal.timeout(3_000));
    const values = mocks.execute.mock.calls.at(-1)!.slice(1);
    expect(values).toContain('PENDING'); expect(values).toContain('CLASSROOM_AI_BUSY');
    expect(values).toContain(1);
  });
  it('returns without work if another process claimed the queue', async () => {
    mocks.query.mockResolvedValue([]);
    expect(await runKnowledgeExplanationWarmup(AbortSignal.timeout(3_000))).toBe(false);
    expect(mocks.shared).not.toHaveBeenCalled();
  });
});
