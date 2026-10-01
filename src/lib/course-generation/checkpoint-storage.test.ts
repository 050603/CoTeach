import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  lockJob: vi.fn(),
  findJob: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    $transaction: mocks.transaction,
    generationCheckpoint: { upsert: mocks.upsert, deleteMany: mocks.deleteMany },
  },
}));

import { resetGenerationCheckpoints, saveGenerationCheckpoint, saveSourceNarrationBaselineCheckpoint } from "./checkpoint-storage";
import { SOURCE_NARRATION_BASELINE_STEP } from './source-content-acceptance';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation((operation) => operation({
    $queryRaw: mocks.lockJob,
    generationJob: { findUnique: mocks.findJob },
    generationCheckpoint: { upsert: mocks.upsert },
  }));
  mocks.findJob.mockResolvedValue({
    status: "RUNNING",
    trace: { state: { executionId: "execution-current" } },
  });
});

describe("generation checkpoint execution ownership", () => {
  it.each([undefined, 'execution-current'])('saves synthesis and routed media origins atomically with finalization (%s)', async (executionId) => {
    await saveGenerationCheckpoint('job-1', 'course-finalization', {
      generated: { id: 'synthesis-classroom' },
      split: { studentClassroomId: 'student-classroom', teacherClassroomId: 'teacher-classroom' },
    }, { executionId });
    expect(mocks.lockJob).toHaveBeenCalledOnce();
    expect(mocks.upsert.mock.calls.slice(0, 3).map(([args]) => args.create)).toEqual([
      { jobId: 'job-1', step: 'classroom-media-origin:synthesis-classroom', state: { classroomId: 'synthesis-classroom' } },
      { jobId: 'job-1', step: 'classroom-media-origin:student-classroom', state: { classroomId: 'student-classroom' } },
      { jobId: 'job-1', step: 'classroom-media-origin:teacher-classroom', state: { classroomId: 'teacher-classroom' } },
    ]);
    expect(mocks.upsert.mock.calls.at(-1)?.[0].create.step).toBe('course-finalization');
  });

  it('does not grant media ownership from a finalization whose execution lease was lost', async () => {
    await expect(saveGenerationCheckpoint('job-1', 'course-finalization', {
      generated: { id: 'expired-classroom' },
    }, { executionId: 'execution-expired' })).rejects.toThrow('GENERATION_JOB_EXECUTION_LOST');
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('creates the immutable original once and returns it when a later recovery races to save another draft', async () => {
    let stored: unknown;
    mocks.upsert.mockImplementation(async (input) => {
      if (!stored) stored = input.create.state;
      return { state: stored };
    });
    const original = { original: '正确案例和因果解释' };
    expect(await saveSourceNarrationBaselineCheckpoint('job-1', original, { executionId: 'execution-current' }))
      .toEqual(original);
    expect(await saveSourceNarrationBaselineCheckpoint('job-1', { original: '后来缩写的稿子' },
      { executionId: 'execution-current' })).toEqual(original);
    await saveGenerationCheckpoint('job-1', SOURCE_NARRATION_BASELINE_STEP, { original: 'generic writer cannot replace it' });
    expect(stored).toEqual(original);
    for (const [input] of mocks.upsert.mock.calls) {
      expect(input).toMatchObject({ where: { jobId_step: { jobId: 'job-1', step: SOURCE_NARRATION_BASELINE_STEP } }, update: {} });
    }
  });

  it('does not create or change the original baseline after the execution lease is lost', async () => {
    await expect(saveSourceNarrationBaselineCheckpoint('job-1', { original: 'saved' },
      { executionId: 'execution-expired' })).rejects.toThrow('GENERATION_JOB_EXECUTION_LOST');
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("retains paid responses, spent requests, usage and trusted media when projections are reset", async () => {
    await resetGenerationCheckpoints('job-1');
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: { jobId: 'job-1', NOT: [
        'classroom-media-origin:', 'model-usage:', 'authoring-history:', 'authoring-response:',
        'aux-authoring:', 'stage-attempt:', 'course-design:', 'course-design-attempt:', 'design-authoring:', 'teaching-blueprint',
      ].map((prefix) => ({ step: { startsWith: prefix } })) },
    });
  });

  it("persists a checkpoint while the execution lease is still owned", async () => {
    await saveGenerationCheckpoint("job-1", "page:one", { ready: true }, {
      executionId: "execution-current",
    });

    expect(mocks.lockJob).toHaveBeenCalledOnce();
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { jobId_step: { jobId: "job-1", step: "page:one" } },
    }));
  });

  it("rejects a checkpoint from an expired execution", async () => {
    await expect(saveGenerationCheckpoint("job-1", "page:one", { stale: true }, {
      executionId: "execution-expired",
    })).rejects.toThrow("GENERATION_JOB_EXECUTION_LOST");

    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects a checkpoint after cancellation changed the job status", async () => {
    mocks.findJob.mockResolvedValue({
      status: "CANCELLING",
      trace: { state: { executionId: "execution-current" } },
    });

    await expect(saveGenerationCheckpoint("job-1", "page:one", { stale: true }, {
      executionId: "execution-current",
    })).rejects.toThrow("GENERATION_JOB_EXECUTION_LOST");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
