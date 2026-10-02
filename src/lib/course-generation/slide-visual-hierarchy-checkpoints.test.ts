import { describe, expect, it } from 'vitest';
import { teachingVisualEditFixture } from '../openmaic/edit/teaching-visual-edit-fixture';
import { makeScene } from '../openmaic/types/stage';
import type { SceneOutline } from '../openmaic/types/generation';
import { TEACHING_VISUAL_DESIGN_VERSION, TEACHING_VISUAL_PLANNING_VERSION } from '../openmaic/generation/teaching-visual-scene';
import { TEACHING_VISUAL_COMPILER_VERSION, TEACHING_VISUAL_THEME_VERSION } from '../openmaic/generation/teaching-visual-theme';
import { fingerprintGenerationValue, fingerprintSceneOutline, restoreSceneCheckpoint, restoreSceneStageCheckpoint } from './page-checkpoints';
import { slideVisualContentFingerprint } from './slide-visual-checkpoints';

const outline: SceneOutline = { id: 'page', type: 'slide', title: '观察教学支持', description: '支持如何撤除',
  keyPoints: ['逐步撤除'], order: 0, audience: 'student', generationPurpose: 'knowledge-teaching',
  teachingBrief: { schemaVersion: 1, explanation: '逐步撤除', examples: [], conditions: [], evidence: [], assessmentFocus: '',
    teachingPlan: { purpose: '', priorKnowledge: '', newContent: '逐步撤除', learnerQuestion: '', reasoningSteps: [],
      takeaway: '逐步撤除', visibleContent: ['逐步撤除'], presentationContent: ['逐步撤除'], narrationFocus: ['逐步撤除'] } },
};

function content() {
  const slide = teachingVisualEditFixture();
  const primary = slide.canvas.teachingVisual!.scene.pages[0]!.components[0]!;
  primary.role = 'primary';
  primary.nodes[0]!.icon = 'layers';
  Object.assign(slide.canvas.teachingVisual!.scene.pages[0]!.components[1]!, { role: 'support', anchorNodeId: 'withdraw' });
  slide.canvas.teachingVisual!.compilerVersion = 'saved-compiler-version';
  slide.canvas.teachingVisual!.themeVersion = 'saved-theme-version';
  slide.canvas.teachingVisual!.components[0]!.modified = true;
  return slide;
}

describe('hierarchy-aware PPT checkpoint compatibility', () => {
  it('keeps completed native elements and all optional metadata at the original source/model identity', () => {
    const slide = content();
    const scene = makeScene({ id: 'accepted-page', stageId: 'saved-stage', title: outline.title, order: 0,
      actions: [{ id: 'original-speech', type: 'speech', text: '来自原始教材的完整解释', audioId: 'accepted-audio' }] }, slide);
    const checkpoint = { pageKey: outline.id, outlineFingerprint: fingerprintSceneOutline(outline),
      modelFingerprint: 'production-model', inputFingerprint: 'accepted-source-input', scene };
    const restored = restoreSceneCheckpoint({ ...outline, order: 2 }, checkpoint, 'current-stage', 'production-model', 'accepted-source-input');
    expect(restored).not.toBeNull();
    expect(restored!.content).toBe(scene.content);
    expect(restored!.actions).toBe(scene.actions);
    expect(restored!.stageId).toBe('current-stage');
    expect(restored!.order).toBe(2);
    expect(restored!.content.type === 'slide' && restored!.content.canvas.teachingVisual).toEqual(slide.canvas.teachingVisual);
  });

  it('versions unfinished visual content without invalidating the exact previously accepted content or narration contract', () => {
    const newIdentity = slideVisualContentFingerprint(outline, 'accepted-source-input');
    expect(newIdentity).toBe(fingerprintGenerationValue({ pageInputFingerprint: 'accepted-source-input',
      slideVisualLayoutVersion: TEACHING_VISUAL_DESIGN_VERSION,
      planningVersion: TEACHING_VISUAL_PLANNING_VERSION,
      compilerVersion: TEACHING_VISUAL_COMPILER_VERSION, themeVersion: TEACHING_VISUAL_THEME_VERSION }));
    expect(newIdentity).not.toBe(fingerprintGenerationValue({ pageInputFingerprint: 'accepted-source-input',
      slideVisualLayoutVersion: TEACHING_VISUAL_DESIGN_VERSION,
      compilerVersion: TEACHING_VISUAL_COMPILER_VERSION, themeVersion: TEACHING_VISUAL_THEME_VERSION }));
    expect(newIdentity).not.toBe('accepted-source-input');
    const slide = content();
    const contentCheckpoint = { schemaVersion: 1 as const, pageKey: outline.id, stage: 'content' as const,
      outlineFingerprint: fingerprintSceneOutline(outline), modelFingerprint: 'model', inputFingerprint: 'accepted-source-input',
      payload: { content: slide.canvas } };
    expect(restoreSceneStageCheckpoint({ outline, stage: 'content', modelFingerprint: 'model', inputFingerprint: newIdentity,
      checkpoint: contentCheckpoint })).toBeNull();
    expect(restoreSceneStageCheckpoint({ outline, stage: 'content', modelFingerprint: 'model', inputFingerprint: 'accepted-source-input',
      checkpoint: contentCheckpoint })).toBe(contentCheckpoint.payload);
    const narrationCheckpoint = { ...contentCheckpoint, stage: 'narration' as const, payload: { teachingNarration: ['独立的原始资料讲稿'] } };
    expect(restoreSceneStageCheckpoint({ outline, stage: 'narration', modelFingerprint: 'model', inputFingerprint: 'accepted-source-input',
      checkpoint: narrationCheckpoint })).toBe(narrationCheckpoint.payload);
  });

  it('rejects another source or model even when the saved role, anchor and glyph happen to match', () => {
    const scene = makeScene({ id: 'accepted-page', stageId: 'stage', title: outline.title, order: 0, actions: [] }, content());
    const checkpoint = { pageKey: outline.id, outlineFingerprint: fingerprintSceneOutline(outline),
      modelFingerprint: 'production-model', inputFingerprint: 'accepted-source-input', scene };
    expect(restoreSceneCheckpoint(outline, checkpoint, 'stage', 'different-model', 'accepted-source-input')).toBeNull();
    expect(restoreSceneCheckpoint(outline, checkpoint, 'stage', 'production-model', 'different-source-input')).toBeNull();
    expect(restoreSceneCheckpoint({ ...outline, keyPoints: ['完全不同的事实'] }, checkpoint, 'stage', 'production-model', 'accepted-source-input')).toBeNull();
  });
});
