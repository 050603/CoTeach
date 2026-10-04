import { describe, expect, it } from 'vitest';
import type { SceneOutline } from '@/lib/openmaic/types/generation';
import { SLIDE_VISUAL_AUTHORING_VERSION, SLIDE_VISUAL_LAYOUT_VERSION, SLIDE_VISUAL_PROJECTION_OPERATION } from '@/lib/openmaic/generation/slide-visual-projection';
import { NATIVE_LECTURE_AUTHORING_VERSION, NATIVE_LECTURE_OPERATION } from '@/lib/openmaic/generation/slide-native-authoring';
import { fingerprintGenerationValue, fingerprintSceneOutline, restoreSceneCheckpoint, restoreSceneStageCheckpoint } from './page-checkpoints';
import { fingerprintStageAuthoringInput, restoreAuthoringResponse } from './authoring-checkpoints';
import { legacySlideVisualContentFingerprint, previousSlideVisualContentFingerprints, slideVisualContentFingerprint, slideVisualRequestFingerprint, SLIDE_VISUAL_STRATEGY_VERSION } from './slide-visual-checkpoints';

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
  it('versions restored native PPT authoring independently of the saved display-item contract', () => {
    const restored = { ...page, teachingBrief: undefined };
    expect(slideVisualContentFingerprint(restored, 'adopted-source')).toBe(fingerprintGenerationValue({
      pageInputFingerprint: 'adopted-source', slideVisualStrategyVersion: SLIDE_VISUAL_STRATEGY_VERSION,
    }));
    expect(previousSlideVisualContentFingerprints(restored, 'adopted-source')).toEqual([]);
    expect(slideVisualContentFingerprint(restored, 'changed-source')).not.toBe(slideVisualContentFingerprint(restored, 'adopted-source'));
  });
  it('keeps completed page content, speech and media under the unchanged page identity on ordinary resume', () => {
    const speech = { id: 'saved-speech', type: 'speech' as const, text: '完整且连贯的授课讲稿。', audioUrl: '/saved.wav' };
    const scene = { id: 'saved-scene', type: 'slide' as const, title: page.title, stageId: 'old-stage', order: 0,
      content: { type: 'slide' as const, canvas: { id: 'saved-canvas', viewportSize: 1000, viewportRatio: 0.5625,
        theme: { backgroundColor: '#fff', themeColors: ['#2563eb'], fontColor: '#333', fontName: 'Arial' },
        elements: [{ id: 'saved-image', type: 'image' as const,
        src: '/saved-textbook.png', left: 50, top: 50, width: 300, height: 300, rotate: 0, fixedRatio: true }] } },
      actions: [speech], createdAt: 1, updatedAt: 1 };
    const saved = { pageKey: page.id, outlineFingerprint: fingerprintSceneOutline(page),
      modelFingerprint: 'model', inputFingerprint: 'original-input', scene };
    const restored = restoreSceneCheckpoint(page, saved, 'current-stage', 'model', 'original-input');
    expect(slideVisualContentFingerprint(page, 'original-input')).not.toBe('original-input');
    expect(restored?.content).toEqual(scene.content);
    expect(restored?.actions).toEqual([speech]);
    expect(restoreSceneCheckpoint(page, saved, 'current-stage', 'model', 'different-request')).toBeNull();
  });
  it('never replays another source catalog or a legacy native response as the single visual draft', () => {
    const projection = slideVisualRequestFingerprint('content', SLIDE_VISUAL_PROJECTION_OPERATION, 'source');
    const legacy = slideVisualRequestFingerprint('content', 'native components', 'source');
    const nativeLecture = slideVisualRequestFingerprint('content', NATIVE_LECTURE_OPERATION, 'source');
    expect(nativeLecture).not.toBe(projection);
    expect(nativeLecture).not.toBe(legacy);
    expect(projection).not.toBe(legacy);
    expect(projection).not.toBe(slideVisualRequestFingerprint('content', SLIDE_VISUAL_PROJECTION_OPERATION, 'changed adopted sources'));
    expect(projection).toBe(slideVisualRequestFingerprint('content', SLIDE_VISUAL_PROJECTION_OPERATION, 'source'));
  });
  it('reconstructs the previous completed visual-stage key without sharing raw response identity', () => {
    const legacy = legacySlideVisualContentFingerprint(page, 'original-input');
    expect(legacy).toBe(fingerprintGenerationValue({ pageInputFingerprint: 'original-input',
      slideVisualLayoutVersion: SLIDE_VISUAL_LAYOUT_VERSION }));
    const current = slideVisualContentFingerprint(page, 'original-input');
    expect(current).not.toBe(legacy);
    expect(slideVisualRequestFingerprint(current, SLIDE_VISUAL_PROJECTION_OPERATION, 'source'))
      .not.toBe(slideVisualRequestFingerprint(legacy, SLIDE_VISUAL_PROJECTION_OPERATION, 'source'));
  });
  it('isolates changed vision attachments even when the source catalog and text prompt stay the same', () => {
    const identity = (images?: readonly { id: string; src: string }[]) => slideVisualRequestFingerprint('same-content',
      NATIVE_LECTURE_OPERATION, 'same-prompt', images);
    const image = (src: string) => [{ id: 'image-1', src }];
    expect(identity()).toBe(identity([]));
    expect(identity(image('data:image/png;base64,original'))).toBe(identity(image('data:image/png;base64,original')));
    expect(identity(image('data:image/png;base64,original'))).not.toBe(identity(image('data:image/png;base64,replaced')));
    expect(identity([{ id: 'first', src: 'a' }, { id: 'second', src: 'b' }]))
      .not.toBe(identity([{ id: 'second', src: 'b' }, { id: 'first', src: 'a' }]));
    expect(identity(image('data:image/png;base64,original'))).not.toBe(identity());
  });
  it('retains the prior v2 completed authoring identity while isolating the new exact request', () => {
    const previous = previousSlideVisualContentFingerprints(page, 'same-source-input');
    expect(previous).toEqual([fingerprintGenerationValue({ pageInputFingerprint: 'same-source-input',
      slideVisualLayoutVersion: SLIDE_VISUAL_LAYOUT_VERSION,
      slideVisualAuthoringVersion: SLIDE_VISUAL_AUTHORING_VERSION }),
    fingerprintGenerationValue({ pageInputFingerprint: 'same-source-input',
      slideVisualLayoutVersion: SLIDE_VISUAL_LAYOUT_VERSION,
      slideVisualAuthoringVersion: 'ppt-visual-authoring-v10-sentence-and-process-design' }),
    fingerprintGenerationValue({ pageInputFingerprint: 'same-source-input',
      slideVisualLayoutVersion: SLIDE_VISUAL_LAYOUT_VERSION,
      slideVisualAuthoringVersion: 'ppt-visual-authoring-v5-unique-bound-goals-and-facts-only-cases' }),
    fingerprintGenerationValue({ pageInputFingerprint: 'same-source-input',
      slideVisualLayoutVersion: SLIDE_VISUAL_LAYOUT_VERSION,
      slideVisualAuthoringVersion: 'ppt-visual-authoring-v4-complete-case-elements-and-canonical-basis' }),
    fingerprintGenerationValue({ pageInputFingerprint: 'same-source-input',
      slideVisualLayoutVersion: SLIDE_VISUAL_LAYOUT_VERSION,
      slideVisualAuthoringVersion: 'ppt-visual-authoring-v3-owned-explanation-and-claim-correspondences' }),
    fingerprintGenerationValue({ pageInputFingerprint: 'same-source-input',
      slideVisualLayoutVersion: SLIDE_VISUAL_LAYOUT_VERSION,
      slideVisualAuthoringVersion: 'ppt-visual-authoring-v2-mapping-and-optional-emphasis' }),
    legacySlideVisualContentFingerprint(page, 'same-source-input'),
    fingerprintGenerationValue({ pageInputFingerprint: 'same-source-input', nativeLectureAuthoringVersion: NATIVE_LECTURE_AUTHORING_VERSION }),
    fingerprintGenerationValue({ pageInputFingerprint: 'same-source-input', nativeLectureAuthoringVersion: 'native-lecture-composition-v4-source-fact-sets-and-measured-paragraphs' }),
    fingerprintGenerationValue({ pageInputFingerprint: 'same-source-input', nativeLectureAuthoringVersion: 'native-lecture-composition-v1' })]);
    const current = slideVisualContentFingerprint(page, 'same-source-input');
    expect(previous).not.toContain(current);
    for (const fingerprint of previous) expect(slideVisualRequestFingerprint(fingerprint, SLIDE_VISUAL_PROJECTION_OPERATION, 'same-draft'))
      .not.toBe(slideVisualRequestFingerprint(current, SLIDE_VISUAL_PROJECTION_OPERATION, 'same-draft'));
    expect(previousSlideVisualContentFingerprints(page, 'changed-source-input')).not.toEqual(previous);
  });
  it('reuses a source-valid completed native v1 page without replaying its old raw response', () => {
    const old = fingerprintGenerationValue({ pageInputFingerprint: 'same-source',
      nativeLectureAuthoringVersion: 'native-lecture-composition-v1' });
    const current = slideVisualContentFingerprint(page, 'same-source');
    expect(previousSlideVisualContentFingerprints(page, 'same-source')).toContain(old);
    expect(current).not.toBe(old);
    expect(slideVisualRequestFingerprint(old, NATIVE_LECTURE_OPERATION, 'old hierarchy-free request'))
      .not.toBe(slideVisualRequestFingerprint(current, NATIVE_LECTURE_OPERATION, 'source membership contract'));
    expect(previousSlideVisualContentFingerprints(page, 'changed-source')).not.toContain(old);
  });
  it.each([NATIVE_LECTURE_AUTHORING_VERSION,
    'native-lecture-composition-v4-source-fact-sets-and-measured-paragraphs'])('restores completed %s content under exact guards while rejecting its raw response for restored authoring', (nativeLectureAuthoringVersion) => {
    const previous = fingerprintGenerationValue({ pageInputFingerprint: 'same-source',
      nativeLectureAuthoringVersion });
    const current = slideVisualContentFingerprint(page, 'same-source');
    expect(previousSlideVisualContentFingerprints(page, 'same-source')).toContain(previous);
    expect(previousSlideVisualContentFingerprints(page, 'changed-source')).not.toContain(previous);
    const checkpoint = { schemaVersion: 1 as const, pageKey: page.id, stage: 'content' as const,
      outlineFingerprint: fingerprintSceneOutline(page), modelFingerprint: 'original-model',
      inputFingerprint: previous, payload: { content: { elements: ['accepted-native-elements'] } } };
    expect(restoreSceneStageCheckpoint({ outline: page, stage: 'content', modelFingerprint: 'original-model',
      inputFingerprint: previous, checkpoint })).toBe(checkpoint.payload);
    expect(restoreSceneStageCheckpoint({ outline: page, stage: 'content', modelFingerprint: 'changed-model',
      inputFingerprint: previous, checkpoint })).toBeNull();
    expect(restoreSceneStageCheckpoint({ outline: { ...page, keyPoints: ['changed source responsibility'] }, stage: 'content',
      modelFingerprint: 'original-model', inputFingerprint: previous, checkpoint })).toBeNull();

    const oldRequest = fingerprintStageAuthoringInput(page, 'content', slideVisualRequestFingerprint(previous,
      NATIVE_LECTURE_OPERATION, 'same exact prompt'));
    const currentRequest = fingerprintStageAuthoringInput(page, 'content', slideVisualRequestFingerprint(current,
      NATIVE_LECTURE_OPERATION, 'same exact prompt'));
    const raw = { ...checkpoint, contractVersion: 'course-first-pass-v1', inputFingerprint: oldRequest,
      source: 'scene-content', text: 'saved display-items raw response', complete: true, systemCharacters: 1, promptCharacters: 1 };
    expect(restoreAuthoringResponse({ outline: page, stage: 'content', modelFingerprint: 'original-model',
      inputFingerprint: oldRequest, checkpoint: raw })).toBe(raw.text);
    expect(restoreAuthoringResponse({ outline: page, stage: 'content', modelFingerprint: 'original-model',
      inputFingerprint: currentRequest, checkpoint: raw })).toBeNull();
    // The old interrupted stream is also ignored for the new request rather
    // than blocking it as though it were this restored authoring operation.
    expect(restoreAuthoringResponse({ outline: page, stage: 'content', modelFingerprint: 'original-model',
      inputFingerprint: currentRequest, checkpoint: { ...raw, complete: false } })).toBeNull();
  });
  it.each([{ ...page, audience: 'teacher' as const }, { ...page, type: 'quiz' as const }])('retains the existing content protocol for non-PPT paths', (outline) => {
    expect(slideVisualContentFingerprint(outline, 'existing')).toBe('existing');
    expect(legacySlideVisualContentFingerprint(outline, 'existing')).toBe('existing');
  });
  it.each([{ ...page, visualIntent: { representation: 'native-chart' as const, observationGoal: '观察定量变化' } },
    { ...page, mediaGenerations: [{ type: 'video' as const, elementId: 'video', prompt: '视频' }] }])('versions native chart and video PPT authoring without adopting legacy projection responses', (outline) => {
    expect(slideVisualContentFingerprint(outline, 'existing')).not.toBe('existing');
    expect(previousSlideVisualContentFingerprints(outline, 'existing')).toEqual([fingerprintGenerationValue({
      pageInputFingerprint: 'existing', nativeLectureAuthoringVersion: NATIVE_LECTURE_AUTHORING_VERSION,
    }), fingerprintGenerationValue({
      pageInputFingerprint: 'existing', nativeLectureAuthoringVersion: 'native-lecture-composition-v4-source-fact-sets-and-measured-paragraphs',
    }), fingerprintGenerationValue({
      pageInputFingerprint: 'existing', nativeLectureAuthoringVersion: 'native-lecture-composition-v1',
    })]);
    expect(legacySlideVisualContentFingerprint(outline, 'existing')).toBe('existing');
  });
});
