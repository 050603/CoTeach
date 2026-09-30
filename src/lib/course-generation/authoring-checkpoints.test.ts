import { describe, expect, it } from 'vitest';
import type { SceneOutline } from '@/lib/openmaic/types/generation';
import { fingerprintSceneOutline } from './page-checkpoints';
import { restoreAuthoringResponse, type AuthoringResponseCheckpoint } from './authoring-checkpoints';

const outline = { id: 'page', type: 'slide', title: '定义', description: '', keyPoints: ['定义'], order: 0 } as SceneOutline;
const checkpoint: AuthoringResponseCheckpoint = { schemaVersion: 1, pageKey: outline.id, stage: 'content',
  outlineFingerprint: fingerprintSceneOutline(outline), modelFingerprint: 'model', inputFingerprint: 'input',
  source: 'scene-content', text: '{incomplete', systemCharacters: 10, promptCharacters: 30 };

describe('raw first-pass responses', () => {
  it.each(['{incomplete', ''])('replays even unusable output for local validation without reauthoring', (text) => {
    expect(restoreAuthoringResponse({ outline, stage: 'content', modelFingerprint: 'model', inputFingerprint: 'input',
      checkpoint: { ...checkpoint, text } })).toBe(text);
  });
  it('stops on a saved interrupted response even when its JSON is parseable', () => {
    expect(() => restoreAuthoringResponse({
      outline, stage: 'content', modelFingerprint: 'model', inputFingerprint: 'input',
      checkpoint: { ...checkpoint, text: '{"elements":[]}', complete: false },
    })).toThrow(expect.objectContaining({ code: 'LLM_STREAM_INCOMPLETE', isRetryable: false }));
  });
  it.each([true, undefined])('replays complete and legacy saved responses without a provider call', (complete) => {
    const text = '{"elements":[]}';
    expect(restoreAuthoringResponse({
      outline, stage: 'content', modelFingerprint: 'model', inputFingerprint: 'input',
      checkpoint: { ...checkpoint, text, complete },
    })).toBe(text);
  });
  it('does not reuse a different source, model, stage or page responsibility', () => {
    const input = { outline, stage: 'content' as const, modelFingerprint: 'model', inputFingerprint: 'input', checkpoint };
    for (const changed of [{ ...input, modelFingerprint: 'other' }, { ...input, inputFingerprint: 'other' },
      { ...input, stage: 'narration' as const }, { ...input, outline: { ...outline, keyPoints: ['新定义'] } }]) {
      expect(restoreAuthoringResponse(changed)).toBeNull();
    }
  });
});
