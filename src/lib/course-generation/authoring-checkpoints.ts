import type { SceneOutline } from '@/lib/openmaic/types/generation';
import { fingerprintSceneOutline, type SceneGenerationCheckpointStage } from './page-checkpoints';

export const AUTHORING_RESPONSE_PREFIX = 'authoring-response:';

/** Raw drafts are deliberately separate from accepted, playable stage results. */
export type AuthoringResponseCheckpoint = {
  schemaVersion: 1;
  contractVersion?: string;
  pageKey: string;
  stage: SceneGenerationCheckpointStage;
  outlineFingerprint: string;
  modelFingerprint: string;
  inputFingerprint?: string;
  source: string;
  text: string;
  /** False means an interrupted provider stream, even if its text looks parseable. */
  complete?: boolean;
  systemCharacters: number;
  promptCharacters: number;
};

export function restoreAuthoringResponse(input: {
  outline: SceneOutline;
  stage: SceneGenerationCheckpointStage;
  modelFingerprint: string;
  inputFingerprint?: string;
  checkpoint?: AuthoringResponseCheckpoint;
}): string | null {
  const saved = input.checkpoint;
  const matches = saved?.schemaVersion === 1 && saved.pageKey === input.outline.id
    && saved.stage === input.stage
    && saved.outlineFingerprint === fingerprintSceneOutline(input.outline)
    && saved.modelFingerprint === input.modelFingerprint
    && saved.inputFingerprint === input.inputFingerprint
    && typeof saved.text === 'string';
  if (matches && saved.complete === false) throw Object.assign(new Error('已保存响应来自截断请求，保留首稿并停止，不能将其作为完整输出继续生成。'),
    { code: 'LLM_STREAM_INCOMPLETE', isRetryable: false });
  return matches ? saved.text : null;
}
