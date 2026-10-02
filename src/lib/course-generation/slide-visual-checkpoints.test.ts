import { describe, expect, it } from 'vitest';
import type { SceneOutline } from '@/lib/openmaic/types/generation';
import { SLIDE_VISUAL_PROJECTION_OPERATION } from '@/lib/openmaic/generation/slide-visual-projection';
import { TEACHING_VISUAL_OPERATION } from '@/lib/openmaic/generation/teaching-visual-scene';
import { fingerprintSceneOutline, restoreSceneStageCheckpoint } from './page-checkpoints';
import { restoreAuthoringResponse, type AuthoringResponseCheckpoint } from './authoring-checkpoints';
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
    const scene = slideVisualRequestFingerprint('content', TEACHING_VISUAL_OPERATION, 'source');
    const projection = slideVisualRequestFingerprint('content', SLIDE_VISUAL_PROJECTION_OPERATION, 'source');
    const legacy = slideVisualRequestFingerprint('content', 'native components', 'source');
    expect(projection).not.toBe(legacy);
    expect(projection).not.toBe(slideVisualRequestFingerprint('content', SLIDE_VISUAL_PROJECTION_OPERATION, 'changed adopted sources'));
    expect(projection).toBe(slideVisualRequestFingerprint('content', SLIDE_VISUAL_PROJECTION_OPERATION, 'source'));
    expect(scene).not.toBe(projection);
    expect(scene).not.toBe(legacy);
    expect(scene).not.toBe(slideVisualRequestFingerprint('content', TEACHING_VISUAL_OPERATION, 'changed adopted sources'));
    expect(scene).toBe(slideVisualRequestFingerprint('content', TEACHING_VISUAL_OPERATION, 'source'));
  });

  it.each([SLIDE_VISUAL_PROJECTION_OPERATION, 'native components'])('cannot restore %s authoring bytes as a visual scene or vice versa', (legacyOperation) => {
    const sceneFingerprint = slideVisualRequestFingerprint('content', TEACHING_VISUAL_OPERATION, 'source');
    const legacyFingerprint = slideVisualRequestFingerprint('content', legacyOperation, 'source');
    const checkpoint: AuthoringResponseCheckpoint = { schemaVersion: 1, pageKey: page.id, stage: 'content',
      outlineFingerprint: fingerprintSceneOutline(page), modelFingerprint: 'model', inputFingerprint: legacyFingerprint,
      source: 'slide-visual-projection', text: '{"items":[]}', complete: true, systemCharacters: 1, promptCharacters: 1 };
    expect(restoreAuthoringResponse({ outline: page, stage: 'content', modelFingerprint: 'model', inputFingerprint: sceneFingerprint, checkpoint })).toBeNull();
    expect(restoreAuthoringResponse({ outline: page, stage: 'content', modelFingerprint: 'model', inputFingerprint: legacyFingerprint,
      checkpoint: { ...checkpoint, inputFingerprint: sceneFingerprint, source: 'slide-visual-scene', text: '{"pages":[]}' } })).toBeNull();
  });

  it('upgrades native-chart page identities for source-grounded editable data components', () => {
    const chart: SceneOutline = { ...page, visualIntent: { representation: 'native-chart', observationGoal: '观察定量变化' } };
    expect(slideVisualContentFingerprint(chart, 'existing')).not.toBe('existing');
    expect(slideVisualContentFingerprint(chart, 'existing')).toBe(slideVisualContentFingerprint(chart, 'existing'));
  });

  it('keeps an accepted legacy content stage available under its exact original identity', () => {
    const payload = { content: { elements: [{ id: 'accepted-native-element' }], qualityDiagnostics: ['已保存诊断'] } };
    const checkpoint = { schemaVersion: 1 as const, pageKey: page.id, stage: 'content' as const,
      outlineFingerprint: fingerprintSceneOutline(page), modelFingerprint: 'model', inputFingerprint: 'original-input', payload };
    expect(restoreSceneStageCheckpoint({ outline: page, stage: 'content', modelFingerprint: 'model',
      inputFingerprint: slideVisualContentFingerprint(page, 'original-input'), checkpoint })).toBeNull();
    expect(restoreSceneStageCheckpoint({ outline: page, stage: 'content', modelFingerprint: 'model',
      inputFingerprint: 'original-input', checkpoint })).toEqual(payload);
    expect(restoreSceneStageCheckpoint({ outline: page, stage: 'content', modelFingerprint: 'changed-model',
      inputFingerprint: 'original-input', checkpoint })).toBeNull();
  });
  it.each([{ ...page, audience: 'teacher' as const }, { ...page, type: 'quiz' as const },
    { ...page, visualIntent: { representation: 'video' as const, observationGoal: '观察动态变化' } },
    { ...page, mediaGenerations: [{ type: 'video' as const, elementId: 'video', prompt: '视频' }] }])('retains the existing content protocol for non-PPT paths', (outline) => {
    expect(slideVisualContentFingerprint(outline, 'existing')).toBe('existing');
  });
});
