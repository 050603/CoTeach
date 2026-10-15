// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import type { Course } from '@/lib/session/types';
import type { PersistedClassroomData } from '@openmaic/lib/server/classroom-storage';
const mocks = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn(), classroom: vi.fn(), model: vi.fn(), prepare: vi.fn(), background: vi.fn(), instance: vi.fn(), template: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ isDatabaseConfigured: () => true, prisma: { $queryRaw: mocks.query, $executeRaw: mocks.execute,
  classroomInstance: { findUnique: mocks.instance }, classroomTemplate: { findUnique: mocks.template } } }));
vi.mock('@openmaic/lib/server/classroom-storage', () => ({ readClassroom: mocks.classroom }));
vi.mock('@/lib/llm/classroom-capacity', () => ({ withBackgroundAiPriority: (fn: () => unknown) => { mocks.background(); return fn(); } }));
vi.mock('./knowledge-explanations', async importOriginal => ({ ...await importOriginal<typeof import('./knowledge-explanations')>(),
  prepareKnowledgeExplanation: mocks.prepare, resolveKnowledgeTutorModel: mocks.model }));
import { EXPLANATION_VERSION } from './knowledge-explanations';
import { authoredQuestionFingerprint } from './knowledge-tutor-evidence';
import { buildKnowledgeExplanationWarmupInput, type KnowledgeExplanationWarmupInput } from './knowledge-explanation-enqueue';
import { enqueueKnowledgeExplanationWarmup, runKnowledgeExplanationWarmup, snapshotKnowledgeExplanationInputs } from './knowledge-explanation-warmup';

const receipt = (): KnowledgeExplanationWarmupInput => ({ version: EXPLANATION_VERSION, classroomId: 'classroom', classroomRevision: 4,
  sections: [{ id: 'section', quizOutlineId: 'quiz', knowledgePointIds: ['kp'] }], knowledgePoints: [{ id: 'kp', name: '关系', description: '' }] });
const question = { id: 'single', type: 'single', question: '选择', options: [{ value: 'A', label: '正' }, { value: 'B', label: '误' }], answer: ['A'] } as const;
const classroom = (): PersistedClassroomData => ({ id: 'classroom', revision: 4, scenes: [{ id: 'scene', outlineId: 'quiz', content: { type: 'quiz', questions: [
  question, { ...question, id: 'multiple', type: 'multiple' }, { ...question, id: 'true-false', format: 'true_false' },
  { id: 'matching', type: 'matching', question: '配对', matchingPairs: [{ leftId: 'a', rightId: 'b', left: '甲', right: '乙' }] },
  { id: 'blank', type: 'short_answer', format: 'fill_blank', question: '填空', referenceAnswer: '答案' },
  { id: 'essay', type: 'short_answer', question: '深入分析' }, { ...question, id: 'scenario', format: 'scenario_task' },
] } }] } as unknown as PersistedClassroomData);
let job: { id: string; courseId: string; attempts: number; input: KnowledgeExplanationWarmupInput };
beforeEach(() => {
  vi.resetAllMocks(); job = { id: 'job', courseId: 'course', attempts: 1, input: receipt() };
  mocks.query.mockImplementation(async () => [job]); mocks.execute.mockResolvedValue(1); mocks.model.mockResolvedValue({}); mocks.prepare.mockResolvedValue({});
  mocks.classroom.mockResolvedValue(classroom()); mocks.instance.mockResolvedValue(null);
  mocks.template.mockResolvedValue({ versions: [{ snapshot: { schemaVersion: 2, kind: 'pbl-course', design: {
    name: '课程', stages: [], aiLearningClassroomId: 'classroom', content: { knowledgeLectureSections: receipt().sections, knowledgePoints: receipt().knowledgePoints },
  } } }] });
});
afterEach(() => { vi.useRealTimers(); });

describe('durable question lecture warmup', () => {
  it('queues pure receipts and prepares each ordinary question once, including blank and matching questions', async () => {
    const course = { id: 'course', version: 1, aiLearningClassroomId: 'classroom', content: {
      knowledgeLectureSections: receipt().sections, knowledgePoints: receipt().knowledgePoints,
    } } as Course;
    await enqueueKnowledgeExplanationWarmup({ $executeRaw: mocks.execute } as unknown as Prisma.TransactionClient, course);
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.classroom).not.toHaveBeenCalled();
    expect(mocks.execute.mock.calls[0][0].join('')).toContain('ON CONFLICT (id) DO NOTHING');
    await runKnowledgeExplanationWarmup(AbortSignal.timeout(3_000));
    expect(mocks.prepare).toHaveBeenCalledTimes(5); expect(mocks.background).toHaveBeenCalledTimes(5);
    expect(mocks.prepare.mock.calls.map(call => call[0].question.id)).toEqual(['single', 'multiple', 'true-false', 'matching', 'blank']);
    expect(mocks.prepare.mock.calls[1][0]).toMatchObject({ knowledgePointNames: ['关系'] });
    expect(mocks.prepare.mock.calls.every(call => !('answer' in call[0]) && !('mode' in call[0]))).toBe(true);
    const frozen = mocks.execute.mock.calls.find(call => call[0].join('').includes('SET input ='));
    expect(JSON.parse(frozen![1]).questionInputs).toHaveLength(5);
    expect(mocks.execute.mock.calls.at(-1)?.[0].join('')).toContain("status = 'COMPLETED'");
    expect(mocks.query.mock.calls[0][0].join('')).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('continues after a failed item and retains the job for bounded retry', async () => {
    mocks.prepare.mockRejectedValueOnce(new Error('provider unavailable'));
    expect(await runKnowledgeExplanationWarmup(AbortSignal.timeout(3_000))).toBe(true);
    expect(mocks.prepare).toHaveBeenCalledTimes(5);
    expect(mocks.execute.mock.calls.at(-1)?.slice(1)).toContain('FAILED');
    expect(mocks.execute.mock.calls.at(-1)?.slice(1)).toContain('WARMUP_GENERATION_FAILED');
  });

  it('defers capacity pressure without consuming the technical failure budget', async () => {
    mocks.prepare.mockRejectedValue(Object.assign(new Error('busy'), { name: 'LlmRateLimitError' }));
    await runKnowledgeExplanationWarmup(AbortSignal.timeout(3_000));
    const values = mocks.execute.mock.calls.at(-1)!.slice(1);
    expect(values).toContain('PENDING'); expect(values).toContain('CLASSROOM_AI_BUSY'); expect(values[1]).toBe(0);
    expect(mocks.prepare).toHaveBeenCalledTimes(5);
  });

  it('retries only its frozen question and evidence snapshots after the classroom changes', async () => {
    job.input.questionInputs = snapshotKnowledgeExplanationInputs(job.input, classroom());
    job.input.questionInputs[0].sourceEvidence = { items: [], authoredQuotes: [{ unitId: 'u', quotes: ['已采用原文'] }] };
    mocks.classroom.mockResolvedValue({ ...classroom(), revision: 10, scenes: [] });
    await runKnowledgeExplanationWarmup(AbortSignal.timeout(3_000));
    expect(mocks.classroom).not.toHaveBeenCalled(); expect(mocks.template).not.toHaveBeenCalled();
    expect(mocks.prepare.mock.calls[0][0]).toMatchObject({ question: { id: 'single' }, sourceEvidence: { authoredQuotes: [{ quotes: ['已采用原文'] }] } });
  });

  it('retains the authored fingerprint when a JSONB roundtrip reorders frozen question fields', async () => {
    const frozen = snapshotKnowledgeExplanationInputs(job.input, classroom());
    const expected = authoredQuestionFingerprint(frozen[0].question, frozen[0].sourceEvidence!);
    expect(frozen[0].questionFingerprint).toBe(expected);
    job.input.questionInputs = JSON.parse(JSON.stringify(frozen.map(input => ({ ...input,
      question: Object.fromEntries(Object.entries(input.question).reverse()),
    }))));
    await runKnowledgeExplanationWarmup(AbortSignal.timeout(3_000));
    expect(mocks.classroom).not.toHaveBeenCalled();
    expect(mocks.prepare.mock.calls[0][0].questionFingerprint).toBe(expected);
  });

  it('rejects an obsolete classroom revision before binding questions or using a model', async () => {
    mocks.classroom.mockResolvedValue({ ...classroom(), revision: 5 });
    await runKnowledgeExplanationWarmup(AbortSignal.timeout(3_000));
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.execute.mock.calls.at(-1)?.slice(1)).toContain('WARMUP_CLASSROOM_VERSION_CHANGED');
    expect(mocks.execute.mock.calls.at(-1)?.[2]).toBe(3);
  });

  it('authorizes legacy receipts against the current snapshot before freezing them', async () => {
    delete job.input.classroomRevision;
    await runKnowledgeExplanationWarmup(AbortSignal.timeout(3_000));
    expect(mocks.template).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'course' } }));
    expect(mocks.prepare).toHaveBeenCalledTimes(5);
  });

  it('rejects a legacy receipt if the adopted evidence or its ownership cannot be verified', async () => {
    delete job.input.classroomRevision;
    mocks.template.mockResolvedValue(null);
    await runKnowledgeExplanationWarmup(AbortSignal.timeout(3_000));
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.classroom).not.toHaveBeenCalled();
    expect(mocks.execute.mock.calls.at(-1)?.slice(1)).toContain('WARMUP_SOURCE_VERSION_CHANGED');
  });

  it('rejects a legacy receipt whose current template changed its knowledge point content', async () => {
    delete job.input.classroomRevision;
    job.input.knowledgePoints[0].name = '旧知识点';
    await runKnowledgeExplanationWarmup(AbortSignal.timeout(3_000));
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.execute.mock.calls.at(-1)?.slice(1)).toContain('WARMUP_SOURCE_VERSION_CHANGED');
  });

  it('does not generate if the snapshot write lost its owner token', async () => {
    mocks.execute.mockImplementation(async (sql: TemplateStringsArray) => sql.join('').includes('SET input =') ? 0 : 1);
    await runKnowledgeExplanationWarmup(AbortSignal.timeout(3_000));
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.model).not.toHaveBeenCalled();
  });

  it('renews its lease during a long question without a whole-question timeout', async () => {
    vi.useFakeTimers();
    job.input.questionInputs = snapshotKnowledgeExplanationInputs(job.input, classroom()).slice(0, 1);
    mocks.prepare.mockImplementationOnce(async (_input, _model, signal: AbortSignal) => {
      await new Promise(resolve => setTimeout(resolve, 210_000));
      signal.throwIfAborted();
    });
    const running = runKnowledgeExplanationWarmup(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(210_001);
    await running;
    const leaseWrites = mocks.execute.mock.calls.filter(call => call[0].join('').includes('SET "leaseUntil"'));
    expect(leaseWrites.length).toBeGreaterThanOrEqual(7);
    expect(mocks.execute.mock.calls.at(-1)?.[0].join('')).toContain("status = 'COMPLETED'");
  });

  it('returns without work when another process claimed the queue', async () => {
    mocks.query.mockResolvedValue([]);
    expect(await runKnowledgeExplanationWarmup(AbortSignal.timeout(3_000))).toBe(false);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('builds a receipt with the latest authored classroom revision', () => {
    const input = buildKnowledgeExplanationWarmupInput({ id: 'course', aiLearningClassroomId: 'classroom', content: {
      knowledgeLectureSections: receipt().sections, knowledgePoints: receipt().knowledgePoints,
      teacherReviewVersion: { classroomRevision: 2 }, teachingRevisionState: { classroomRevision: 4 },
    } } as Course);
    expect(input?.classroomRevision).toBe(4);
    const regenerated = buildKnowledgeExplanationWarmupInput({ id: 'course', aiLearningClassroomId: 'classroom', content: {
      knowledgeLectureSections: receipt().sections, knowledgePoints: receipt().knowledgePoints,
      teacherReviewVersion: { classroomRevision: 6 }, teachingRevisionState: { classroomRevision: 4 },
    } } as Course);
    expect(regenerated?.classroomRevision).toBe(6);
  });
});
