import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneOutline, GeneratedSlideContent } from '../types/generation';
import { TEACHING_ENHANCEMENT_VERSION } from '../generation/teaching-contract-version';
import { legacySlideVisualContentFingerprint, slideVisualContentFingerprint, slideVisualRequestFingerprint } from '@/lib/course-generation/slide-visual-checkpoints';
import { SLIDE_VISUAL_LAYOUT_VERSION } from '../generation/slide-visual-projection';
import { fingerprintGenerationValue, fingerprintSceneOutline, restoreSceneCheckpoint, restoreSceneStageCheckpoint, type PageCheckpointSnapshot, type SceneStageCheckpointSnapshot } from '@/lib/course-generation/page-checkpoints';
import { COURSE_FIRST_PASS_CONTRACT_VERSION } from '@/lib/course-generation/first-pass-policy';
import { COURSE_GENERATION_POLICY_VERSION } from '../generation/course-generation-policy';
import { compileOriginalSlideDraft } from '../generation/slide-infographic-layout';
import type { Scene } from '../types/stage';

const mocks = vi.hoisted(() => ({ ai: vi.fn(), persist: vi.fn(), previousPageInputs: new Map<string, string>(),
  previousActionInputs: new Map<string, string>(), v36PageInputs: new Map<string, string>(),
  v36ActionInputs: new Map<string, string>(), v37PageInputs: new Map<string, string>(),
  v37ActionInputs: new Map<string, string>(), v38PageInputs: new Map<string, string>(),
  v38ActionInputs: new Map<string, string>() }));
vi.mock('@/lib/course-generation/page-checkpoints', async (original) => {
  const actual = await original<typeof import('@/lib/course-generation/page-checkpoints')>();
  return { ...actual, fingerprintGenerationValue: (value: unknown) => {
    const current = actual.fingerprintGenerationValue(value);
    if (value && typeof value === 'object' && 'pipeline' in value && value.pipeline === 'adaptive-course-page-v4') {
      const input = value as Record<string, unknown>;
      const { teachingAuthoringFingerprint: _newDirectory, ...previousInput } = input;
      mocks.previousPageInputs.set(current, actual.fingerprintGenerationValue({ ...previousInput,
        assessmentPolicy: 'predeclared-understanding-standard-v3',
        teachingNarrationPolicy: 'section-continuous-narration-v34-owned-slots-and-case-premises',
        quizPolicy: input.quizPolicy === null ? null : 'grounded-section-quiz-v17-bound-premises-and-shared-speech-budget',
      }));
      mocks.v36PageInputs.set(current, actual.fingerprintGenerationValue({ ...input,
        assessmentPolicy: 'predeclared-understanding-standard-v3',
        teachingNarrationPolicy: 'section-continuous-narration-v36-complete-case-elements-and-canonical-basis',
        quizPolicy: input.quizPolicy === null ? null : 'grounded-section-quiz-v19-complete-canonical-assessment-basis',
      }));
      mocks.v37PageInputs.set(current, actual.fingerprintGenerationValue({ ...input,
        assessmentPolicy: 'predeclared-understanding-standard-v3',
        teachingNarrationPolicy: 'section-continuous-narration-v37-novel-reasoning-and-facts-only-cases',
        quizPolicy: input.quizPolicy === null ? null : 'grounded-section-quiz-v20-unique-bound-goals-and-facts-only-cases',
      }));
      mocks.v38PageInputs.set(current, actual.fingerprintGenerationValue({ ...input,
        assessmentPolicy: 'predeclared-understanding-standard-v4-reference-actions',
        teachingNarrationPolicy: 'section-continuous-narration-v38-source-excerpt-duties-and-reference-actions',
        quizPolicy: input.quizPolicy === null ? null : 'grounded-section-quiz-v21-reference-actions-and-source-answer-catalog',
      }));
    }
    if (value && typeof value === 'object' && 'actionPolicy' in value && 'pageInputFingerprint' in value) {
      const previousPageInput = mocks.previousPageInputs.get(String(value.pageInputFingerprint));
      if (previousPageInput) mocks.previousActionInputs.set(current,
        actual.fingerprintGenerationValue({ ...value, pageInputFingerprint: previousPageInput }));
      const v36PageInput = mocks.v36PageInputs.get(String(value.pageInputFingerprint));
      if (v36PageInput) mocks.v36ActionInputs.set(current,
        actual.fingerprintGenerationValue({ ...value, pageInputFingerprint: v36PageInput }));
      const v37PageInput = mocks.v37PageInputs.get(String(value.pageInputFingerprint));
      if (v37PageInput) mocks.v37ActionInputs.set(current,
        actual.fingerprintGenerationValue({ ...value, pageInputFingerprint: v37PageInput }));
      const v38PageInput = mocks.v38PageInputs.get(String(value.pageInputFingerprint));
      if (v38PageInput) mocks.v38ActionInputs.set(current,
        actual.fingerprintGenerationValue({ ...value, pageInputFingerprint: v38PageInput }));
    }
    return current;
  } };
});
vi.mock('./resolve-model', () => ({ resolveModel: async () => ({
  model: {}, modelInfo: { capabilities: { vision: false }, outputWindow: 12000 },
  modelString: 'test-model', providerId: 'openai', apiKey: 'test',
}) }));
vi.mock('./course-generation-ai-call', () => ({
  createCourseGenerationAiCall: () => mocks.ai,
  withCourseGenerationAiCallContext: (call: unknown) => call,
}));
vi.mock('./classroom-media-readiness', () => ({ assertRequestedClassroomMediaProviders: () => {} }));
vi.mock('./classroom-media-generation', () => ({ resolveServerTtsTimingSelection: () => ({
  providerId: 'qwen-tts', modelId: 'qwen3-tts-flash', voiceId: 'Serena', language: 'zh-CN', speed: 1,
}) }));
vi.mock('./classroom-storage', () => ({ persistClassroom: mocks.persist }));
vi.mock('./provider-config', async (original) => ({
  ...await original<typeof import('./provider-config')>(), getClassroomSceneConcurrency: () => 1,
}));

import { generateClassroom, type GenerateClassroomOptions } from './classroom-generation';
import { closeSpatialMeasurementBrowser } from '../generation/slide-spatial-measurement';
afterAll(async () => { await closeSpatialMeasurementBrowser(); });

const page: SceneOutline = {
  id: 'accepted-visual-page', type: 'slide', title: '依据与结论', description: '独立来源支持事实判断。',
  keyPoints: ['独立来源支持事实判断'], order: 0, audience: 'student', generationPurpose: 'knowledge-teaching',
  stageKey: 'ai-learning', lectureSectionId: 'accepted-section', targetDurationSec: 31, estimatedDuration: 31,
  plannedTiming: { role: 'teaching', narrationSec: 31, learnerActivitySec: 0, transitionSec: 0 },
  teachingBrief: {
    schemaVersion: 1, designVersion: TEACHING_ENHANCEMENT_VERSION, explanation: '独立来源支持事实判断。',
    examples: [], conditions: [], evidence: [], assessmentFocus: '区分依据与结论',
    teachingPlan: { purpose: '理解依据与结论', priorKnowledge: '知道资料可以被引用', newContent: '独立来源支持事实判断',
      learnerQuestion: '依据怎样支持结论', reasoningSteps: ['追溯独立来源'], takeaway: '表达流畅不能证明事实',
      visibleContent: ['独立来源支持事实判断'], presentationContent: ['独立来源支持事实判断'], narrationFocus: ['解释依据与结论'] },
  },
};
const acceptedContent: GeneratedSlideContent = { elements: [
  { id: 'accepted-text', type: 'text', left: 60, top: 160, width: 580, height: 80,
    rotate: 0, defaultFontName: 'Arial', defaultColor: '#000000',
    content: '<p style="font-size:24px">独立来源支持事实判断。</p>' },
  { id: 'accepted-book-image', type: 'image', left: 720, top: 160, width: 180, height: 180,
    src: '/preserved-book-image.png', fixedRatio: true, rotate: 0 },
] };
const acceptedSpeech = { id: 'accepted-speech', type: 'speech' as const,
  text: '独立来源支持事实判断，表达流畅不能证明事实。', audioUrl: '/preserved-audio.wav' };
const input = { requirement: '续跑原确认课程', teachingSourceContext: '不可变教材版本：revision-1',
  agentMode: 'default' as const, enableImageGeneration: false, enableVideoGeneration: false, enableTTS: false };

function legacyStageStore(mismatch?: 'outline' | 'model' | 'source-input',
  version: 'layout-only' | 'previous-page-and-v2' | 'previous-page-and-v4' | 'previous-page-and-v5' | 'previous-v38-and-v5' = 'layout-only') {
  let identity: { inputFingerprint: string; modelFingerprint: string } | undefined;
  const migrated = vi.fn();
  const reads: string[] = [];
  const callbacks: GenerateClassroomOptions = {
    preparedOutlines: [structuredClone(page)], slideVisualProjection: true,
    loadSourceContentCheckpoint: (_section, _source, inputFingerprint, modelFingerprint) => {
      identity = { inputFingerprint, modelFingerprint }; return null;
    },
    loadSceneStageCheckpoint: (outline, stage, modelFingerprint, inputFingerprint) => {
      if (!identity) throw new Error('Missing production source/input identity');
      if (stage === 'content' && inputFingerprint) reads.push(inputFingerprint);
      const originalPageInput = version === 'previous-page-and-v2'
        ? mocks.previousPageInputs.get(identity.inputFingerprint)
        : version === 'previous-page-and-v4' ? mocks.v36PageInputs.get(identity.inputFingerprint)
          : version === 'previous-page-and-v5' ? mocks.v37PageInputs.get(identity.inputFingerprint)
            : version === 'previous-v38-and-v5' ? mocks.v38PageInputs.get(identity.inputFingerprint) : identity.inputFingerprint;
      if (!originalPageInput) throw new Error('Missing exact previous authoring input');
      const storedSourceInput = mismatch === 'source-input' ? `${originalPageInput}-different-source` : originalPageInput;
      const contentFingerprint = version === 'layout-only'
        ? legacySlideVisualContentFingerprint(outline, storedSourceInput)
        : fingerprintGenerationValue({ pageInputFingerprint: storedSourceInput,
          slideVisualLayoutVersion: SLIDE_VISUAL_LAYOUT_VERSION,
          slideVisualAuthoringVersion: version === 'previous-page-and-v5' || version === 'previous-v38-and-v5'
            ? 'ppt-visual-authoring-v5-unique-bound-goals-and-facts-only-cases'
            : version === 'previous-page-and-v4' ? 'ppt-visual-authoring-v4-complete-case-elements-and-canonical-basis'
              : 'ppt-visual-authoring-v2-mapping-and-optional-emphasis' });
      const narrationFingerprint = version !== 'layout-only'
        ? fingerprintGenerationValue({ pageInputFingerprint: originalPageInput,
          policy: COURSE_GENERATION_POLICY_VERSION,
          independentNarration: version === 'previous-v38-and-v5'
            ? 'section-continuous-narration-v38-source-excerpt-duties-and-reference-actions'
            : version === 'previous-page-and-v5'
            ? 'section-continuous-narration-v37-novel-reasoning-and-facts-only-cases'
            : version === 'previous-page-and-v4' ? 'section-continuous-narration-v36-complete-case-elements-and-canonical-basis'
              : 'section-continuous-narration-v34-owned-slots-and-case-premises' }) : inputFingerprint;
      const checkpoint: SceneStageCheckpointSnapshot = {
        schemaVersion: 1, pageKey: outline.id, stage,
        outlineFingerprint: fingerprintSceneOutline(stage === 'content' && mismatch === 'outline'
          ? { ...outline, keyPoints: ['已改变的页面'] } : outline),
        modelFingerprint: stage === 'content' && mismatch === 'model' ? 'different-model' : identity.modelFingerprint,
        inputFingerprint: stage === 'content' ? contentFingerprint
          : stage === 'narration' ? narrationFingerprint
            : version !== 'layout-only' && inputFingerprint
              ? (version === 'previous-v38-and-v5' ? mocks.v38ActionInputs
                : version === 'previous-page-and-v5' ? mocks.v37ActionInputs
                : version === 'previous-page-and-v4' ? mocks.v36ActionInputs : mocks.previousActionInputs).get(inputFingerprint)
              : inputFingerprint,
        payload: stage === 'content' ? { content: structuredClone(acceptedContent) }
          : stage === 'narration' ? { teachingNarration: { pageId: outline.id, segments: [{
              id: acceptedSpeech.id, pageId: outline.id, text: acceptedSpeech.text, semanticIds: [`${outline.id}:teaching`],
            }] } } : { actions: [structuredClone(acceptedSpeech)] },
      };
      return restoreSceneStageCheckpoint({ outline, stage, modelFingerprint, inputFingerprint, checkpoint });
    },
    onSceneStageCompleted: migrated,
  };
  return { callbacks, migrated, reads, identity: () => identity! };
}

describe('completed PPT checkpoints from the previous visual authoring policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.previousPageInputs.clear();
    mocks.previousActionInputs.clear();
    mocks.v36PageInputs.clear();
    mocks.v36ActionInputs.clear();
    mocks.v37PageInputs.clear();
    mocks.v37ActionInputs.clear();
    mocks.v38PageInputs.clear();
    mocks.v38ActionInputs.clear();
    mocks.ai.mockRejectedValue(new Error('fresh model authoring was invoked'));
    mocks.persist.mockImplementation(async (classroom) => classroom);
  });

  it('restores the old layout-only content stage and its media without a model call', async () => {
    const store = legacyStageStore();
    const result = await generateClassroom(input, store.callbacks);
    expect(mocks.ai).not.toHaveBeenCalled();
    const scene = result.scenes[0];
    if (!scene || scene.content.type !== 'slide') throw new Error('Expected the restored native slide');
    expect(scene.content.canvas.elements).toEqual(acceptedContent.elements);
    expect(scene.actions).toContainEqual(expect.objectContaining(acceptedSpeech));
    expect(store.reads).toContain(legacySlideVisualContentFingerprint(page, store.identity().inputFingerprint));
    expect(store.migrated).toHaveBeenCalledWith(expect.objectContaining({ id: page.id }), 'content',
      { content: acceptedContent }, store.identity().modelFingerprint,
      slideVisualContentFingerprint(page, store.identity().inputFingerprint));
  });

  it.each([true, false])('restores every fallback page without another PPT call (independent narration=%s)', async (independent) => {
    if (independent) mocks.ai.mockImplementation(async (system: string, prompt: string) => {
      if (!system.includes('MANUSCRIPT_VISUAL_ACTIONS_V1')) throw new Error('fresh PPT or narration authoring was invoked');
      return JSON.stringify({ pageId: JSON.parse(prompt).pageId, cues: [] });
    });
    const source: SceneOutline = independent ? { ...page, teachingBrief: { ...page.teachingBrief!,
      manuscript: { sectionId: 'accepted-section', segmentIds: ['saved-speech'] } } } : structuredClone(page);
    const images = Array.from({ length: 5 }, (_, index) => ({ id: `saved-source-${index + 1}`,
      src: `/preserved-source-${index + 1}.png`, width: 640, height: 480, caption: `教材图${index + 1}` }));
    const fallback = await compileOriginalSlideDraft(source, [{ id: 'adopted-content-1',
      text: page.teachingBrief!.teachingPlan!.presentationContent![0]! }], {
      images,
      measure: ({ text, width, fontSize, padding, lineHeight }) => {
        const length = Math.max(1, Math.floor((width - padding * 2) / fontSize));
        const lines = text.match(new RegExp(`.{1,${length}}`, 'gu')) ?? [''];
        return { naturalWidth: text.length * fontSize, height: lines.length * fontSize * lineHeight + padding * 2, lines };
      },
    });
    const saved = structuredClone(fallback);
    const pages = [fallback, ...(fallback.continuationPages ?? [])];
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((content) => content.paginationVersion === 'balanced-v1')).toBe(true);
    const migrated = vi.fn();
    const checkpoints = new Map<string, SceneStageCheckpointSnapshot>();
    const restore = vi.fn<NonNullable<GenerateClassroomOptions['loadSceneStageCheckpoint']>>((outline, stage, modelFingerprint, inputFingerprint) => {
      if (stage !== 'content' && (independent || stage !== 'actions') || stage === 'content' && outline.id !== source.id) return null;
      const key = `${outline.id}:${stage}`;
      if (!checkpoints.has(key)) checkpoints.set(key, { schemaVersion: 1, pageKey: outline.id, stage,
        outlineFingerprint: fingerprintSceneOutline(outline), modelFingerprint, inputFingerprint,
        payload: stage === 'content' ? { content: structuredClone(fallback) } : { actions: [structuredClone(acceptedSpeech)] } });
      return restoreSceneStageCheckpoint({ outline, stage, modelFingerprint, inputFingerprint, checkpoint: checkpoints.get(key)! });
    });
    const result = await generateClassroom(input, { preparedOutlines: [source], slideVisualProjection: true,
      ...(independent ? { teachingManuscripts: [{ sectionId: 'accepted-section', segments: [{ id: 'saved-speech', text: acceptedSpeech.text }] }] } : {}),
      loadSceneStageCheckpoint: restore, onSceneStageCompleted: migrated });
    if (independent) expect(mocks.ai).toHaveBeenCalledOnce();
    else expect(mocks.ai).not.toHaveBeenCalled();
    expect(result.scenes).toHaveLength(pages.length);
    expect(result.scenes.map((scene) => scene.content.type === 'slide' ? scene.content.canvas.elements : []))
      .toEqual(pages.map((content) => content.elements));
    expect(result.scenes.map((scene) => scene.order)).toEqual(pages.map((_, index) => index));
    expect(result.scenes.flatMap((scene) => scene.content.type === 'slide' ? scene.content.canvas.elements : [])
      .filter((element) => element.type === 'image').map((element) => element.id)).toEqual(images.map((image) => image.id));
    expect(result.assetContext.outlines.reduce((sum, outline) => sum + outline.targetDurationSec!, 0)).toBe(page.targetDurationSec);
    if (independent) expect(result.scenes.flatMap((scene) => (scene.actions ?? []).filter((action) => action.type === 'speech').map((action) => action.text).filter((text) => text.trim())))
      .toEqual([acceptedSpeech.text]);
    expect(restore).toHaveBeenCalledWith(expect.objectContaining({ id: source.id }), 'content', expect.any(String), expect.any(String));
    for (const outline of result.assetContext.outlines) expect(migrated.mock.calls.some(([savedOutline, stage]) =>
      savedOutline.id === outline.id && stage === 'content')).toBe(true);
    expect(fallback).toEqual(saved);
  });

  it.each([false, true])('locks a completed native scene and counts it once when a prior page splits=%s', async (precedingSplit) => {
    const completedPage: SceneOutline = precedingSplit ? { ...page, id: 'already-complete-page', order: 1 } : structuredClone(page);
    const fallback = precedingSplit ? await compileOriginalSlideDraft(page, [{ id: 'adopted-content-1', text: page.keyPoints[0]! }], {
      images: Array.from({ length: 5 }, (_, index) => ({ id: `prior-source-${index}`, src: `/prior-source-${index}.png`, width: 640, height: 480 })),
      measure: ({ text, fontSize, padding, lineHeight }) => ({ naturalWidth: text.length * fontSize,
        height: fontSize * lineHeight + padding * 2, lines: [text] }),
    }) : undefined;
    let checkpoint: PageCheckpointSnapshot | undefined;
    const load = vi.fn<NonNullable<GenerateClassroomOptions['loadSceneCheckpoint']>>((outline, _index, stageId, modelFingerprint, inputFingerprint) => {
      if (outline.id !== completedPage.id) return null;
      checkpoint ??= { pageKey: outline.id, outlineFingerprint: fingerprintSceneOutline(outline),
        modelFingerprint, inputFingerprint, scene: { id: 'completed-native-page', stageId, outlineId: outline.id,
          type: 'slide', title: outline.title, order: completedPage.order, actions: [structuredClone(acceptedSpeech)],
          content: { type: 'slide', canvas: { id: 'completed-canvas', viewportSize: 1000, viewportRatio: 0.5625,
            ...structuredClone(acceptedContent) } }, createdAt: 1, updatedAt: 1,
          narrationRevision: COURSE_GENERATION_POLICY_VERSION } as Scene };
      return restoreSceneCheckpoint(outline, checkpoint, stageId, modelFingerprint, inputFingerprint);
    });
    const stageCheckpoints = new Map<string, SceneStageCheckpointSnapshot>();
    const loadStage = vi.fn<NonNullable<GenerateClassroomOptions['loadSceneStageCheckpoint']>>((outline, stage, modelFingerprint, inputFingerprint) => {
      if (!fallback || outline.id === completedPage.id || stage !== 'content' && stage !== 'actions') return null;
      if (stage === 'content' && outline.id !== page.id) return null;
      const key = `${outline.id}:${stage}`;
      if (!stageCheckpoints.has(key)) stageCheckpoints.set(key, { schemaVersion: 1, pageKey: outline.id, stage,
        outlineFingerprint: fingerprintSceneOutline(outline), modelFingerprint, inputFingerprint,
        payload: stage === 'content' ? { content: structuredClone(fallback) } : { actions: [structuredClone(acceptedSpeech)] } });
      return restoreSceneStageCheckpoint({ outline, stage, modelFingerprint, inputFingerprint, checkpoint: stageCheckpoints.get(key)! });
    });
    const progress = vi.fn(), complete = vi.fn();
    const result = await generateClassroom(input, { preparedOutlines: precedingSplit ? [structuredClone(page), completedPage] : [completedPage], slideVisualProjection: true,
      loadSceneCheckpoint: load, loadSceneStageCheckpoint: loadStage, onProgress: progress, onSceneCompleted: complete });
    expect(mocks.ai).not.toHaveBeenCalled();
    expect(load.mock.calls.filter(([outline]) => outline.id === completedPage.id)).toHaveLength(1);
    expect(loadStage.mock.calls.filter(([outline]) => outline.id === completedPage.id)).toHaveLength(0);
    expect(complete.mock.calls.filter(([outline]) => outline.id === completedPage.id)).toHaveLength(0);
    const index = precedingSplit ? 1 + fallback!.continuationPages!.length : 0;
    expect(result.scenes).toHaveLength(index + 1);
    expect({ ...result.scenes[index], updatedAt: checkpoint!.scene.updatedAt })
      .toEqual({ ...checkpoint!.scene, order: index });
    expect(result.assetContext.outlines[index]!.id).toBe(completedPage.id);
    expect(result.assetContext.outlines[index]!.targetDurationSec).toBe(page.targetDurationSec);
    expect(result.assetContext.outlines.reduce((sum, outline) => sum + outline.targetDurationSec!, 0))
      .toBe(page.targetDurationSec! * (precedingSplit ? 2 : 1));
    const counts = progress.mock.calls.map(([value]) => value.scenesGenerated).filter((value) => typeof value === 'number');
    expect(Math.max(...counts)).toBe(index + 1);
    expect(result.scenes[index]!.actions).toContainEqual(acceptedSpeech);
  });

  it('restores an exact previous page policy, visual v2 and saved audio without fresh authoring', async () => {
    const store = legacyStageStore(undefined, 'previous-page-and-v2');
    const result = await generateClassroom(input, store.callbacks);
    expect(mocks.ai).not.toHaveBeenCalled();
    const scene = result.scenes[0];
    if (!scene || scene.content.type !== 'slide') throw new Error('Expected the preserved native slide');
    expect(scene.content.canvas.elements).toEqual(acceptedContent.elements);
    expect(scene.actions).toContainEqual(expect.objectContaining(acceptedSpeech));
    const previousPageInput = mocks.previousPageInputs.get(store.identity().inputFingerprint)!;
    expect(store.reads).toContain(fingerprintGenerationValue({ pageInputFingerprint: previousPageInput,
      slideVisualLayoutVersion: SLIDE_VISUAL_LAYOUT_VERSION,
      slideVisualAuthoringVersion: 'ppt-visual-authoring-v2-mapping-and-optional-emphasis' }));
    expect(store.migrated.mock.calls.some(([, stage]) => stage === 'actions')).toBe(true);
  });

  it('restores completed v36 narration, visual v4 and saved audio under the new first-writing policy', async () => {
    const store = legacyStageStore(undefined, 'previous-page-and-v4');
    const result = await generateClassroom(input, store.callbacks);
    expect(mocks.ai).not.toHaveBeenCalled();
    const scene = result.scenes[0];
    if (!scene || scene.content.type !== 'slide') throw new Error('Expected the preserved native slide');
    expect(scene.content.canvas.elements).toEqual(acceptedContent.elements);
    expect(scene.actions).toContainEqual(expect.objectContaining(acceptedSpeech));
    const previousPageInput = mocks.v36PageInputs.get(store.identity().inputFingerprint)!;
    expect(store.reads).toContain(fingerprintGenerationValue({ pageInputFingerprint: previousPageInput,
      slideVisualLayoutVersion: SLIDE_VISUAL_LAYOUT_VERSION,
      slideVisualAuthoringVersion: 'ppt-visual-authoring-v4-complete-case-elements-and-canonical-basis' }));
    expect(store.migrated.mock.calls.some(([, stage]) => stage === 'actions')).toBe(true);
  });

  it('restores completed v37 narration, visual v5 and saved audio after reference-mode authoring changes', async () => {
    const store = legacyStageStore(undefined, 'previous-page-and-v5');
    const result = await generateClassroom(input, store.callbacks);
    expect(mocks.ai).not.toHaveBeenCalled();
    const scene = result.scenes[0];
    if (!scene || scene.content.type !== 'slide') throw new Error('Expected the preserved native slide');
    expect(scene.content.canvas.elements).toEqual(acceptedContent.elements);
    expect(scene.actions).toContainEqual(expect.objectContaining(acceptedSpeech));
    const previousPageInput = mocks.v37PageInputs.get(store.identity().inputFingerprint)!;
    expect(store.reads).toContain(fingerprintGenerationValue({ pageInputFingerprint: previousPageInput,
      slideVisualLayoutVersion: SLIDE_VISUAL_LAYOUT_VERSION,
      slideVisualAuthoringVersion: 'ppt-visual-authoring-v5-unique-bound-goals-and-facts-only-cases' }));
    expect(store.migrated.mock.calls.some(([, stage]) => stage === 'actions')).toBe(true);
  });

  it('restores a completed v38 page and its original audio after contribution-based authoring changes', async () => {
    const store = legacyStageStore(undefined, 'previous-v38-and-v5');
    const result = await generateClassroom(input, store.callbacks);
    expect(mocks.ai).not.toHaveBeenCalled();
    const scene = result.scenes[0];
    if (!scene || scene.content.type !== 'slide') throw new Error('Expected the preserved native slide');
    expect(scene.content.canvas.elements).toEqual(acceptedContent.elements);
    expect(scene.actions).toContainEqual(expect.objectContaining(acceptedSpeech));
    expect(store.reads).toContain(fingerprintGenerationValue({
      pageInputFingerprint: mocks.v38PageInputs.get(store.identity().inputFingerprint)!,
      slideVisualLayoutVersion: SLIDE_VISUAL_LAYOUT_VERSION,
      slideVisualAuthoringVersion: 'ppt-visual-authoring-v5-unique-bound-goals-and-facts-only-cases',
    }));
    expect(store.migrated.mock.calls.some(([, stage]) => stage === 'actions')).toBe(true);
  });

  it.each(['outline', 'model', 'source-input'] as const)('keeps the original %s identity guard', async (mismatch) => {
    const store = legacyStageStore(mismatch);
    await expect(generateClassroom(input, store.callbacks)).rejects.toThrow('fresh model authoring was invoked');
    expect(mocks.ai).toHaveBeenCalledOnce();
    expect(store.migrated.mock.calls.some(([, stage]) => stage === 'content')).toBe(false);
  });

  it.each(['outline', 'model', 'source-input'] as const)('keeps the previous page policy %s identity guard', async (mismatch) => {
    const store = legacyStageStore(mismatch, 'previous-page-and-v2');
    await expect(generateClassroom(input, store.callbacks)).rejects.toThrow('fresh model authoring was invoked');
    expect(mocks.ai).toHaveBeenCalledOnce();
    expect(store.migrated.mock.calls.some(([, stage]) => stage === 'content')).toBe(false);
  });

  it('does not search an old raw-response request when the completed content cannot be restored', async () => {
    const store = legacyStageStore('source-input');
    const loadStageAuthoringResponse = vi.fn(() => null);
    await expect(generateClassroom(input, { ...store.callbacks, loadStageAuthoringResponse }))
      .rejects.toThrow('fresh model authoring was invoked');
    const [system, prompt] = mocks.ai.mock.calls[0] as [string, string];
    const authoringFingerprint = (contentFingerprint: string) => fingerprintGenerationValue({
      inputFingerprint: slideVisualRequestFingerprint(contentFingerprint, system, prompt),
      contract: COURSE_FIRST_PASS_CONTRACT_VERSION, protocol: 'source-catalog-v1',
    });
    const current = authoringFingerprint(slideVisualContentFingerprint(page, store.identity().inputFingerprint));
    const legacy = authoringFingerprint(legacySlideVisualContentFingerprint(page, store.identity().inputFingerprint));
    expect(current).not.toBe(legacy);
    expect(loadStageAuthoringResponse).toHaveBeenCalledOnce();
    expect(loadStageAuthoringResponse).toHaveBeenCalledWith(expect.objectContaining({ id: page.id }),
      'content', store.identity().modelFingerprint, current);
  });
});
