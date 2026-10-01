import { describe, expect, it } from 'vitest';
import type { SceneOutline } from '@/lib/openmaic/types/generation';
import { SLIDE_VISUAL_PROJECTION_OPERATION } from '@/lib/openmaic/generation/slide-visual-projection';
import { fingerprintSceneOutline, restoreSceneStageCheckpoint } from './page-checkpoints';
import { slideVisualContentFingerprint, slideVisualRequestFingerprint } from './slide-visual-checkpoints';

const page: SceneOutline = { id: 'page', type: 'slide', title: '支架撤除', description: '', keyPoints: [], order: 0,
  audience: 'student', generationPurpose: 'knowledge-teaching', teachingBrief: {
    schemaVersion: 1, explanation: '', examples: [], conditions: [], evidence: [], assessmentFocus: '',
    teachingPlan: { purpose: '', priorKnowledge: '', newContent: '', learnerQuestion: '', reasoningSteps: [],
      takeaway: '', visibleContent: [], presentationContent: ['独立解决问题后逐步撤除支架'], narrationFocus: [] },
  } };

describe('PPT-only visual checkpoint identities', () => {
  it('changes only the unfinished content identity and keeps original outlines usable for narration', () => {
    const saved = structuredClone(page);
    const visual = slideVisualContentFingerprint(page, 'original-input');
    expect(visual).not.toBe('original-input');
    expect(page).toEqual(saved);
    expect(restoreSceneStageCheckpoint({ outline: page, stage: 'narration', modelFingerprint: 'model',
      inputFingerprint: 'original-input', checkpoint: { schemaVersion: 1, pageKey: page.id, stage: 'narration',
        outlineFingerprint: fingerprintSceneOutline(page), modelFingerprint: 'model', inputFingerprint: 'original-input',
        payload: { teachingNarration: ['完整讲稿'] } } })).toEqual({ teachingNarration: ['完整讲稿'] });
  });
  it('never replays another source catalog or a legacy native response as the single visual draft', () => {
    const projection = slideVisualRequestFingerprint('content', SLIDE_VISUAL_PROJECTION_OPERATION, 'source');
    const legacy = slideVisualRequestFingerprint('content', 'native components', 'source');
    expect(projection).not.toBe(legacy);
    expect(projection).not.toBe(slideVisualRequestFingerprint('content', SLIDE_VISUAL_PROJECTION_OPERATION, 'changed adopted sources'));
    expect(projection).toBe(slideVisualRequestFingerprint('content', SLIDE_VISUAL_PROJECTION_OPERATION, 'source'));
  });
  it.each([{ ...page, audience: 'teacher' as const }, { ...page, type: 'quiz' as const },
    { ...page, visualIntent: { representation: 'native-chart' as const, observationGoal: '观察定量变化' } },
    { ...page, mediaGenerations: [{ type: 'video' as const, elementId: 'video', prompt: '视频' }] }])('retains the existing content protocol for non-PPT paths', (outline) => {
    expect(slideVisualContentFingerprint(outline, 'existing')).toBe('existing');
  });
});
