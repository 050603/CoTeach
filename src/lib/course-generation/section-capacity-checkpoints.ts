import type { SceneOutline } from '@/lib/openmaic/types/generation';
import { fingerprintGenerationValue, fingerprintSceneOutline } from './page-checkpoints';

export const SECTION_CAPACITY_CHECKPOINT_PREFIX = 'section-capacity:';
export const SECTION_CAPACITY_RECOVERY_POLICY = 'measured-section-capacity-recovery-v1';
export const MAX_SECTION_CAPACITY_REPLANS = 2;

export type SectionCapacityDiagnostic = {
  outlineId: string;
  category: 'page-capacity' | 'section-overload';
  detail: string;
  requestedPageCount?: number;
};

export type SectionCapacityRecoveryCheckpoint = {
  schemaVersion: 1;
  planningPolicy: typeof SECTION_CAPACITY_RECOVERY_POLICY;
  sectionId: string;
  sourceFingerprint: string;
  inputFingerprint: string;
  modelFingerprint: string;
  beforePlanFingerprint: string;
  attemptsStarted: number;
  status: 'pending' | 'replanned' | 'local-layout' | 'infeasible';
  /** A measured-fit contract may repair its authored grouping once, using
   * only the page's remaining original model-call budget. */
  localLayoutRepairs?: number;
  diagnostic: SectionCapacityDiagnostic;
  replannedOutlines?: SceneOutline[];
  failureReason?: string;
};

export function fingerprintSectionCapacityPlan(outlines: readonly SceneOutline[]): string {
  return fingerprintGenerationValue(outlines.map((outline) => ({ id: outline.id,
    fingerprint: fingerprintSceneOutline(outline) })));
}

/** Capacity attempts survive worker restarts only for this immutable request,
 * model, source contract and supported recovery policy. */
export function restoreSectionCapacityCheckpoint(value: unknown, identity: {
  sectionId: string; sourceFingerprint: string; inputFingerprint: string; modelFingerprint: string;
}): SectionCapacityRecoveryCheckpoint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const checkpoint = value as Partial<SectionCapacityRecoveryCheckpoint>;
  if (checkpoint.schemaVersion !== 1 || checkpoint.planningPolicy !== SECTION_CAPACITY_RECOVERY_POLICY
    || checkpoint.sectionId !== identity.sectionId || checkpoint.sourceFingerprint !== identity.sourceFingerprint
    || checkpoint.inputFingerprint !== identity.inputFingerprint || checkpoint.modelFingerprint !== identity.modelFingerprint
    || !Number.isInteger(checkpoint.attemptsStarted) || checkpoint.attemptsStarted! < 0
    || checkpoint.attemptsStarted! > MAX_SECTION_CAPACITY_REPLANS
    || (checkpoint.localLayoutRepairs !== undefined && (!Number.isInteger(checkpoint.localLayoutRepairs)
      || checkpoint.localLayoutRepairs < 0 || checkpoint.localLayoutRepairs > 1))
    || typeof checkpoint.beforePlanFingerprint !== 'string'
    || !checkpoint.diagnostic || typeof checkpoint.diagnostic.outlineId !== 'string'
    || typeof checkpoint.diagnostic.detail !== 'string'
    || (checkpoint.diagnostic.requestedPageCount !== undefined
      && (!Number.isInteger(checkpoint.diagnostic.requestedPageCount) || checkpoint.diagnostic.requestedPageCount < 1))
    || !['page-capacity', 'section-overload'].includes(checkpoint.diagnostic.category)
    || !['pending', 'replanned', 'local-layout', 'infeasible'].includes(checkpoint.status ?? '')
    || (checkpoint.status === 'replanned' && (!Array.isArray(checkpoint.replannedOutlines)
      || !checkpoint.replannedOutlines.length
      || checkpoint.replannedOutlines.some((outline) => !outline || typeof outline.id !== 'string'
        || outline.type !== 'slide' || outline.lectureSectionId !== checkpoint.sectionId)))) return null;
  return checkpoint as SectionCapacityRecoveryCheckpoint;
}

/** Do not route a measured capacity failure back through the single-page
 * model-output retry loop. Keep its structured signal through context wraps. */
export class SectionCapacityRecoveryError extends Error {
  readonly isRetryable = false;
  constructor(readonly sectionId: string, readonly diagnostic: SectionCapacityDiagnostic,
    readonly inputFingerprint: string, readonly reason?: string) {
    super(reason ? `小节 ${sectionId} 的实测容量重规划不可行：${reason}（${diagnostic.detail}）`
      : `小节 ${sectionId} 需要实测容量重规划：${diagnostic.detail}`);
    this.name = 'SectionCapacityRecoveryError';
  }
}

export function findSectionCapacityRecoveryError(error: unknown): SectionCapacityRecoveryError | null {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    if (current instanceof SectionCapacityRecoveryError) return current;
    seen.add(current);
    current = 'cause' in current ? current.cause : undefined;
  }
  return null;
}
