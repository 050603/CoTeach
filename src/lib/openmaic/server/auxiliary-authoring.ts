import type { AICallFn } from '../generation/pipeline-types';
import { fingerprintGenerationValue } from '@/lib/course-generation/page-checkpoints';
import { COURSE_FIRST_PASS_CONTRACT_VERSION } from '@/lib/course-generation/first-pass-policy';
import { withCourseGenerationAiCallContext } from './course-generation-ai-call';

export type AuxiliaryAuthoringIdentity = {
  key: 'freeform-outlines' | 'agent-profiles' | 'search-query';
  modelFingerprint: string;
  inputFingerprint: string;
};
export type AuxiliaryAuthoringState = {
  modelFingerprint: string;
  inputFingerprint: string;
  attemptsStarted: number;
  rawResponse?: string;
  complete?: boolean;
};
export type AuxiliaryAuthoringHooks = {
  /** Return the existing same-key state even when its hashes do not match. */
  loadAuxiliaryAuthoringState?: (identity: AuxiliaryAuthoringIdentity) => Promise<AuxiliaryAuthoringState | null> | AuxiliaryAuthoringState | null;
  onAuxiliaryAuthoringAttempt?: (input: AuxiliaryAuthoringIdentity & { attemptsStarted: number }) => Promise<void> | void;
  onAuxiliaryAuthoringResponse?: (input: AuxiliaryAuthoringIdentity & {
    source: string; system: string; prompt: string; text: string; complete?: boolean;
  }) => Promise<void> | void;
};
export class AuxiliaryAuthoringError extends Error {
  readonly code = 'COURSE_AUXILIARY_AUTHORING_FAILED';
  readonly isRetryable = false;
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'AuxiliaryAuthoringError';
  }
}
export function isAuxiliaryAuthoringError(error: unknown): boolean {
  return error instanceof AuxiliaryAuthoringError || Boolean(error && typeof error === 'object'
    && 'code' in error && error.code === 'COURSE_AUXILIARY_AUTHORING_FAILED');
}

/** Each auxiliary stage has the same durable first-pass boundary as pages.
 * Provider-rejection retries remain inside the adapter's original invocation. */
export function withAuxiliaryAuthoring(
  call: AICallFn,
  key: AuxiliaryAuthoringIdentity['key'],
  modelFingerprint: string,
  hooks: AuxiliaryAuthoringHooks,
): AICallFn {
  let local: AuxiliaryAuthoringState | null = null;
  return async (system, prompt, images) => {
    const inputFingerprint = fingerprintGenerationValue({ key, system, prompt, images,
      contract: COURSE_FIRST_PASS_CONTRACT_VERSION });
    const identity = { key, modelFingerprint, inputFingerprint };
    try {
      const state = local ?? await hooks.loadAuxiliaryAuthoringState?.(identity) ?? null;
      if (state?.complete === false) throw new AuxiliaryAuthoringError(`辅助阶段 ${key} 已保存的首稿响应被截断，需显式重生成`);
      if (state?.modelFingerprint === modelFingerprint && state.inputFingerprint === inputFingerprint
        && typeof state.rawResponse === 'string') return state.rawResponse;
      if (state && (state.attemptsStarted > 0 || typeof state.rawResponse === 'string')) {
        throw new AuxiliaryAuthoringError(`辅助阶段 ${key} 已消耗首稿请求；请复用保存稿或显式重生成该阶段`);
      }
      let responseSaved = false;
      const persistResponse = async (response: { source: string; system: string; prompt: string; text: string; complete?: boolean }) => {
        if (responseSaved) return;
        await hooks.onAuxiliaryAuthoringResponse?.({ ...identity, ...response });
        local = { modelFingerprint, inputFingerprint, attemptsStarted: local?.attemptsStarted ?? 1, rawResponse: response.text, complete: response.complete };
        responseSaved = true;
      };
      const startAttempt = async ({ totalAttempt }: { totalAttempt: number }) => {
        // Mark in memory before awaiting persistence so even a caught storage
        // failure cannot cause another in-process request under this stage key.
        local = { modelFingerprint, inputFingerprint, attemptsStarted: totalAttempt };
        await hooks.onAuxiliaryAuthoringAttempt?.({ ...identity, attemptsStarted: totalAttempt });
      };
      const contextual = withCourseGenerationAiCallContext(call, {
        attemptsStarted: 0, onAttemptStarting: startAttempt, onResponse: persistResponse,
      });
      // Plain offline/mock adapters have no execution context. Production
      // adapters record the attempt only after acquiring their provider slot.
      if (!('withExecutionContext' in call)) await startAttempt({ totalAttempt: 1 });
      const text = await contextual(system, prompt, images);
      if (!responseSaved) await persistResponse({ source: key, system, prompt, text, complete: true });
      return text;
    } catch (error) {
      if (isAuxiliaryAuthoringError(error)) throw error;
      throw new AuxiliaryAuthoringError(`辅助阶段 ${key} 首稿未完成，保留已保存响应并停止`, error);
    }
  };
}
