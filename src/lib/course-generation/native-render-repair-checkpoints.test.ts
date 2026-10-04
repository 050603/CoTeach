import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ prisma: { generationCheckpoint: { findUnique: mocks.load } } }));
vi.mock('./checkpoint-storage', async (original) => ({ ...await original<typeof import('./checkpoint-storage')>(),
  saveGenerationCheckpoint: mocks.save }));
import { nativeRenderRepairCheckpointCallbacks } from './job-runner';
import { createNativeRenderRepairBudget, type NativeRenderRepairCheckpoint } from '../openmaic/server/classroom-generation';
import { NATIVE_RENDER_REPAIR_POLICY } from '../openmaic/generation/native-render-repair';

const checkpoint: NativeRenderRepairCheckpoint = { schemaVersion: 1, policy: NATIVE_RENDER_REPAIR_POLICY,
  sectionId: 'section', sectionPlanFingerprint: 'plan', modelFingerprint: 'model', pageId: 'page',
  canvasFingerprint: 'canvas', status: 'claimed' };
beforeEach(() => { mocks.load.mockReset().mockResolvedValue(null); mocks.save.mockReset().mockResolvedValue(undefined); });

describe('durable section render repair reservation', () => {
  it('allows one concurrent page to reserve the section and writes before granting permission', async () => {
    const callbacks = nativeRenderRepairCheckpointCallbacks('job', 'execution', 'request');
    const claim = createNativeRenderRepairBudget(callbacks);
    expect(await Promise.all([claim(checkpoint), claim({ ...checkpoint, pageId: 'other' })])).toEqual([true, false]);
    expect(mocks.load).toHaveBeenCalledOnce();
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith('job', 'native-render-repair:section',
      { ...checkpoint, requestFingerprint: 'request' }, { executionId: 'execution' });
  });
  it.each(['claimed', 'completed'])('never reopens a persisted %s budget after a worker restart', async (status) => {
    mocks.load.mockResolvedValue({ state: { ...checkpoint, status, requestFingerprint: 'request' } });
    const claim = createNativeRenderRepairBudget(nativeRenderRepairCheckpointCallbacks('job', 'new-execution', 'request'));
    expect(await claim({ ...checkpoint, pageId: 'other' })).toBe(false);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each(['sectionPlanFingerprint', 'modelFingerprint', 'requestFingerprint'])('does not reset a mismatched %s budget', async (field) => {
    mocks.load.mockResolvedValue({ state: { ...checkpoint, requestFingerprint: 'request', [field]: 'other' } });
    const claim = createNativeRenderRepairBudget(nativeRenderRepairCheckpointCallbacks('job', 'execution', 'request'));
    await expect(claim(checkpoint)).rejects.toMatchObject({ code: 'NATIVE_RENDER_REPAIR_IDENTITY_MISMATCH' });
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('propagates a failed reservation write and prevents a racing page from starting', async () => {
    const failure = new Error('GENERATION_JOB_EXECUTION_LOST');
    mocks.save.mockRejectedValue(failure);
    const claim = createNativeRenderRepairBudget(nativeRenderRepairCheckpointCallbacks('job', 'execution', 'request'));
    const results = await Promise.allSettled([claim(checkpoint), claim({ ...checkpoint, pageId: 'other' })]);
    expect(results).toEqual([{ status: 'rejected', reason: failure }, { status: 'rejected', reason: failure }]);
    expect(mocks.save).toHaveBeenCalledOnce();
  });
  it('uses an independent reservation for another section', async () => {
    const claim = createNativeRenderRepairBudget(nativeRenderRepairCheckpointCallbacks('job', 'execution', 'request'));
    expect(await Promise.all([claim(checkpoint), claim({ ...checkpoint, sectionId: 'other-section' })])).toEqual([true, true]);
    expect(mocks.save).toHaveBeenCalledTimes(2);
  });
});
