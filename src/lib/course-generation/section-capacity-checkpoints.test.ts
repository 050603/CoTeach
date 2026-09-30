import { describe, expect, it } from 'vitest';
import type { SceneOutline } from '@/lib/openmaic/types/generation';
import {
  MAX_SECTION_CAPACITY_REPLANS, SECTION_CAPACITY_RECOVERY_POLICY, SectionCapacityRecoveryError,
  findSectionCapacityRecoveryError, fingerprintSectionCapacityPlan, restoreSectionCapacityCheckpoint,
  type SectionCapacityRecoveryCheckpoint,
} from './section-capacity-checkpoints';

const page: SceneOutline = { id: 'page', type: 'slide', title: '完整步骤', description: '解释全部步骤',
  keyPoints: ['辨识主张', '追溯证据'], order: 0, lectureSectionId: 'section', targetDurationSec: 60 };
const identity = { sectionId: 'section', sourceFingerprint: 'confirmed-source', inputFingerprint: 'request', modelFingerprint: 'teacher-model' };
const checkpoint: SectionCapacityRecoveryCheckpoint = { schemaVersion: 1, planningPolicy: SECTION_CAPACITY_RECOVERY_POLICY,
  ...identity, beforePlanFingerprint: fingerprintSectionCapacityPlan([page]), attemptsStarted: 1, status: 'replanned',
  diagnostic: { outlineId: page.id, category: 'section-overload', detail: '完整步骤不能放入一页', requestedPageCount: 3 },
  replannedOutlines: [{ ...page, sourcePageIds: [page.id], sectionPlanVersion: 'measured-v2' }] };

describe('durable measured section recovery', () => {
  it('restores only the exact immutable source, request, model and policy', () => {
    expect(restoreSectionCapacityCheckpoint(checkpoint, identity)).toBe(checkpoint);
    for (const field of ['sectionId', 'sourceFingerprint', 'inputFingerprint', 'modelFingerprint'] as const) {
      expect(restoreSectionCapacityCheckpoint(checkpoint, { ...identity, [field]: 'changed' })).toBeNull();
    }
    expect(restoreSectionCapacityCheckpoint({ ...checkpoint, planningPolicy: 'old-policy' }, identity)).toBeNull();
    expect(restoreSectionCapacityCheckpoint({ ...checkpoint, replannedOutlines: [{ ...page, lectureSectionId: 'foreign' }] }, identity)).toBeNull();
    expect(restoreSectionCapacityCheckpoint({ ...checkpoint, replannedOutlines: [] }, identity)).toBeNull();
  });

  it('keeps bounded replan and local-layout consumption across restarts', () => {
    const exhausted = { ...checkpoint, status: 'infeasible', attemptsStarted: MAX_SECTION_CAPACITY_REPLANS, localLayoutRepairs: 1 };
    expect(restoreSectionCapacityCheckpoint(exhausted, identity)).toMatchObject({ attemptsStarted: 2, localLayoutRepairs: 1 });
    expect(restoreSectionCapacityCheckpoint({ ...exhausted, attemptsStarted: 3 }, identity)).toBeNull();
    expect(restoreSectionCapacityCheckpoint({ ...exhausted, localLayoutRepairs: 2 }, identity)).toBeNull();
    expect(restoreSectionCapacityCheckpoint({ ...checkpoint, diagnostic: { ...checkpoint.diagnostic, requestedPageCount: -1 } }, identity)).toBeNull();
  });

  it('preserves capacity category through normal page error wrapping without making it retryable', () => {
    const capacity = new SectionCapacityRecoveryError('section', checkpoint.diagnostic, 'request');
    const wrapped = new Error('Scene 7 failed', { cause: new Error('body failed', { cause: capacity }) });
    expect(findSectionCapacityRecoveryError(wrapped)).toBe(capacity);
    expect(capacity.isRetryable).toBe(false);
    expect(capacity.diagnostic.requestedPageCount).toBe(3);
    const cyclic = { cause: undefined as unknown };
    cyclic.cause = cyclic;
    expect(findSectionCapacityRecoveryError(cyclic)).toBeNull();
    expect(findSectionCapacityRecoveryError(new Error('ordinary layout collision'))).toBeNull();
  });

  it('does not invalidate a plan for display order but detects changed teaching responsibility', () => {
    expect(fingerprintSectionCapacityPlan([{ ...page, order: 7 }])).toBe(fingerprintSectionCapacityPlan([page]));
    expect(fingerprintSectionCapacityPlan([{ ...page, keyPoints: ['遗漏了第二步'] }])).not.toBe(fingerprintSectionCapacityPlan([page]));
    expect(fingerprintSectionCapacityPlan([{ ...page, targetDurationSec: 59 }])).not.toBe(fingerprintSectionCapacityPlan([page]));
  });
});
