import { describe, expect, it, vi } from 'vitest';
import type { GeneratedSlideContent, SceneOutline } from '@/lib/openmaic/types/generation';
import type { Scene } from '@/lib/openmaic/types/stage';
import type { FigureSequenceContract } from '@/lib/textbook/course-visual-binding';
import { fingerprintSceneOutline, type SceneStageCheckpointSnapshot } from './page-checkpoints';
import {
  createSourceNarrationBaselineCheckpoint, fingerprintCourseFinalizationRequest,
  restoreOrGenerateFinalizedClassroom, restoreSourceNarrationBaselineCheckpoint, restoreSourceNarrationBaselineStage,
  sourceNarrationBaselineInputFingerprints,
  type PersistedCourseGenerationRequest,
} from './job-runner';
import { SOURCE_CONTENT_RECOVERY_POLICY, type SourceContentRecoveryCheckpoint } from './source-content-acceptance';

const modelFingerprint = 'original-resolved-model-and-budget';
const sourceContextFingerprint = 'actual-adopted-passages-quotes-knowledge-and-lists';
const clause = '在协作学习中注意小组分工的合理安排';
const otherClause = '注意对学生自主完成项目的过程进行监督和调整';
const completeClauses = `${clause}。${otherClause}。`;
const explanation = '如果任务分配不均，有的学生可能觉得自己被忽视，学习动力和信心都会受影响。';
const outline: SceneOutline = { id: 'reflection', type: 'slide', order: 0, title: '项目反思',
  description: '解释合理分工的原因', keyPoints: [clause, otherClause], targetDurationSec: 120,
  lectureSectionId: 'reflection-section', generationPurpose: 'knowledge-teaching', knowledgePointIds: ['project-kp'] };
const other: SceneOutline = { ...outline, id: 'other', order: 1, lectureSectionId: 'other-section',
  knowledgePointIds: ['other-kp'], keyPoints: ['已经正确的案例'], targetDurationSec: 80 };
const outlines = [outline, other];
const request: PersistedCourseGenerationRequest = { courseId: 'isolated', courseTitle: '项目教学',
  requirement: '保留已确认的教学案例和原文条件', generationModelString: 'original-teacher-model', sceneOutlines: outlines };
const contract: FigureSequenceContract = { resourceId: 'book-project-list', required: true,
  scope: 'knowledge-point', knowledgePointIds: ['project-kp'], sequenceSemantics: 'enumerated-items',
  orderedSteps: [{ label: clause }, { label: otherClause }] };
const sourceIdentity = { sectionId: outline.lectureSectionId!, sourceFingerprint: 'adopted-book-and-request',
  inputFingerprint: 'current-input', modelFingerprint };
const sourceCheckpoint: SourceContentRecoveryCheckpoint = { schemaVersion: 1, planningPolicy: SOURCE_CONTENT_RECOVERY_POLICY,
  ...sourceIdentity, status: 'pending', attemptsStarted: 2, issues: [], failedNarrationFingerprints: {} };

function fixture(options: { sameSection?: boolean; sameNarrationFingerprint?: boolean; completeSource?: boolean } = {}) {
  const actualOutlines = options.sameSection ? [outline, { ...other, lectureSectionId: outline.lectureSectionId }] : outlines;
  const actualRequest = { ...request, sceneOutlines: actualOutlines };
  const stages: SceneStageCheckpointSnapshot[] = [];
  const scenes = actualOutlines.map((page) => {
    const text = page.id === outline.id ? explanation + (options.completeSource ? completeClauses : '') : '这个案例的操作、观察和推理已验收。';
    const content = { elements: [{ id: `body-${page.id}`, type: 'text', content: page.title,
      left: 60, top: 140, width: 900, height: 100 }] } as GeneratedSlideContent;
    const teachingNarration = { pageId: page.id, segments: [{ id: `${page.id}:speech-1`, pageId: page.id,
      text, semanticIds: [`${page.id}:teaching`] }] };
    for (const stage of ['content', 'narration'] as const) stages.push({ schemaVersion: 1,
      pageKey: page.id, stage, outlineFingerprint: fingerprintSceneOutline(page), modelFingerprint,
      inputFingerprint: stage === 'narration' && options.sameNarrationFingerprint
        ? `${page.lectureSectionId}:original-narration-context` : `${page.id}:original-${stage}-context`,
      payload: stage === 'content' ? { content } : { teachingNarration } });
    return { id: page.id, outlineId: page.id, stageId: 'classroom', title: page.title, order: page.order,
      type: 'slide', content: { type: 'slide', canvas: { id: `canvas-${page.id}`, elements: content.elements } },
      actions: [{ id: `${page.id}:speech-1`, type: 'speech', text, audioUrl: `/original-${page.id}.wav` }] } as Scene;
  });
  const finalization = { schemaVersion: 1, inputFingerprint: fingerprintCourseFinalizationRequest(actualRequest),
    generated: { stage: { id: 'classroom' }, scenes, assetContext: { outlines: actualOutlines } } };
  const baseline = createSourceNarrationBaselineCheckpoint({ finalization, request: actualRequest, preparedOutlines: actualOutlines,
    stageCheckpoints: stages, sourceContextFingerprint });
  if (!baseline) throw new Error('Fixture must be a complete identity-checked baseline');
  return { finalization, baseline, stages };
}

describe('immutable source narration baseline recovery', () => {
  it('restores original narration and media despite source-content differences without an intermediate baseline capture', async () => {
    const { finalization, stages, baseline } = fixture();
    const persist = vi.fn(async () => baseline);
    const generate = vi.fn();
    const before = JSON.stringify({ finalization, stages });
    const result = await restoreOrGenerateFinalizedClassroom({ checkpoint: finalization, request, preparedOutlines: outlines,
      stageCheckpoints: stages, sourceContextFingerprint, sourceSequenceContracts: [contract], onSourceNarrationBaseline: persist, generate });
    expect(result.restoredFinalization).toBe(finalization);
    expect(result.generated).toBe(finalization.generated);
    expect(result.generated.scenes[0]!.actions![0]).toMatchObject({ text: explanation, audioUrl: '/original-reflection.wav' });
    expect(result.generated.scenes[1]!.actions![0]).toMatchObject({ text: '这个案例的操作、观察和推理已验收。', audioUrl: '/original-other.wav' });
    expect(persist).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(JSON.stringify({ finalization, stages })).toBe(before);
  });

  it('does not invoke removed content-baseline callbacks, even if they would fail or return a mismatched draft', async () => {
    const { finalization, stages, baseline } = fixture();
    const generate = vi.fn();
    const failedCapture = vi.fn(async () => { throw new Error('checkpoint write failed'); });
    const mismatchedCapture = vi.fn(() => ({ ...baseline, requestFingerprint: 'different-request' }));
    const first = await restoreOrGenerateFinalizedClassroom({ checkpoint: finalization, request, preparedOutlines: outlines,
      stageCheckpoints: stages, sourceContextFingerprint, sourceSequenceContracts: [contract], generate,
      onSourceNarrationBaseline: failedCapture });
    const second = await restoreOrGenerateFinalizedClassroom({ checkpoint: finalization, request, preparedOutlines: outlines,
      stageCheckpoints: stages, sourceContextFingerprint, sourceSequenceContracts: [contract], generate,
      onSourceNarrationBaseline: mismatchedCapture });
    expect(first.generated).toBe(finalization.generated);
    expect(second.generated).toBe(finalization.generated);
    expect(failedCapture).not.toHaveBeenCalled();
    expect(mismatchedCapture).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('keeps the existing finalization without replacing it with later shortened narration', async () => {
    const { finalization, stages, baseline } = fixture();
    const revised = stages.map((stage) => stage.stage === 'narration' ? { ...stage,
      payload: { teachingNarration: { pageId: stage.pageKey, segments: [{ id: `${stage.pageKey}:speech-1`, text: '后来缩写的稿子' }] } } } : stage);
    const generate = vi.fn();
    const persist = vi.fn();
    const original = JSON.stringify(baseline);
    const result = await restoreOrGenerateFinalizedClassroom({ checkpoint: finalization, request, preparedOutlines: outlines,
      sourceNarrationBaseline: baseline, stageCheckpoints: revised, sourceContextFingerprint, sourceSequenceContracts: [contract],
      onSourceNarrationBaseline: persist, generate });
    expect(result.generated).toBe(finalization.generated);
    expect(result.generated.scenes[0]!.actions![0]).toMatchObject({ text: explanation, audioUrl: '/original-reflection.wav' });
    expect(persist).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(JSON.stringify(baseline)).toBe(original);
  });

  it('resumes the same full original on every attempt without a new model call or content baseline rewrite', async () => {
    const { finalization, stages, baseline } = fixture();
    const generate = vi.fn();
    const persist = vi.fn(async () => baseline);
    const args = { checkpoint: finalization, request, preparedOutlines: outlines,
      stageCheckpoints: stages, sourceContextFingerprint, sourceSequenceContracts: [contract],
      onSourceNarrationBaseline: persist, generate };
    const first = await restoreOrGenerateFinalizedClassroom(args);
    const second = await restoreOrGenerateFinalizedClassroom({ ...args, sourceNarrationBaseline: baseline });
    expect(first.generated).toBe(finalization.generated);
    expect(second.generated).toBe(first.generated);
    expect(second.generated.scenes[0]!.actions![0]).toMatchObject({ text: explanation, audioUrl: '/original-reflection.wav' });
    expect(persist).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('retains the source-valid finalization fast path without recapturing or reassembling an old course', async () => {
    const { finalization, baseline, stages } = fixture();
    const valid = structuredClone(finalization);
    valid.generated.scenes[0]!.actions!.push({ id: 'complete-source', type: 'speech', text: completeClauses });
    const generate = vi.fn();
    const persist = vi.fn();
    const result = await restoreOrGenerateFinalizedClassroom({ checkpoint: valid, request, preparedOutlines: outlines,
      sourceNarrationBaseline: baseline, stageCheckpoints: stages, sourceContextFingerprint, sourceSequenceContracts: [contract],
      onSourceNarrationBaseline: persist, generate });
    expect(result.restoredFinalization).toBe(valid);
    expect(generate).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('copies the original evidence instead of retaining mutable references to the current stages', () => {
    const { baseline, stages } = fixture();
    (stages.find((stage) => stage.stage === 'narration')!.payload as { teachingNarration: { segments: { text: string }[] } })
      .teachingNarration.segments[0]!.text = '后来替换的讲稿';
    expect(restoreSourceNarrationBaselineCheckpoint(baseline, request, outlines, sourceContextFingerprint)).toBe(baseline);
    expect(baseline.finalization.generated.scenes[0]!.actions![0]).toMatchObject({ text: explanation });
  });

  it('rejects changed requests, exact outline duties, missing pages, models and altered original speech', () => {
    const { baseline } = fixture();
    expect(restoreSourceNarrationBaselineCheckpoint(baseline, { ...request, requirement: '不同来源要求' }, outlines, sourceContextFingerprint)).toBeNull();
    expect(restoreSourceNarrationBaselineCheckpoint(baseline, { ...request, generationModelString: 'new-model' }, outlines, sourceContextFingerprint)).toBeNull();
    expect(restoreSourceNarrationBaselineCheckpoint(baseline, request, [{ ...outline, keyPoints: ['新归属'] }, other], sourceContextFingerprint)).toBeNull();
    expect(restoreSourceNarrationBaselineCheckpoint(baseline, request, [outline], sourceContextFingerprint)).toBeNull();
    expect(restoreSourceNarrationBaselineCheckpoint(baseline, request,
      [{ ...outline, targetDurationSec: 121 }, other], sourceContextFingerprint)).toBeNull();
    expect(restoreSourceNarrationBaselineCheckpoint({ ...baseline, modelFingerprint: 'new-budget' }, request, outlines, sourceContextFingerprint)).toBeNull();
    expect(restoreSourceNarrationBaselineCheckpoint({ ...baseline, narrationStages: baseline.narrationStages.slice(1) }, request, outlines, sourceContextFingerprint)).toBeNull();
    expect(restoreSourceNarrationBaselineCheckpoint({ ...baseline, bodyStages: baseline.bodyStages.slice(1) }, request, outlines, sourceContextFingerprint)).toBeNull();
    expect(restoreSourceNarrationBaselineCheckpoint(baseline, request, outlines, 'changed-original-source')).toBeNull();
    const changedSpeech = structuredClone(baseline);
    const action = changedSpeech.finalization.generated.scenes[0]!.actions![0]!;
    if (action.type === 'speech') action.text = '只剩合理分工，没有原因';
    expect(restoreSourceNarrationBaselineCheckpoint(changedSpeech, request, outlines, sourceContextFingerprint)).toBeNull();
  });

  it('reuses one complete matching old context per section without excluding source-content differences', () => {
    const { baseline } = fixture();
    expect(sourceNarrationBaselineInputFingerprints(baseline, [contract])).toEqual({
      'reflection-section': ['reflection:original-narration-context'],
      'other-section': ['other:original-narration-context'],
    });
    const shared = fixture({ sameSection: true, sameNarrationFingerprint: true, completeSource: true });
    expect(sourceNarrationBaselineInputFingerprints(shared.baseline, [contract])).toEqual({
      'reflection-section': ['reflection-section:original-narration-context'],
    });
    const inconsistent = fixture({ sameSection: true, completeSource: true });
    expect(sourceNarrationBaselineInputFingerprints(inconsistent.baseline, [contract])).toEqual({});
  });

  it('still excludes incomplete scene or narration context bindings from section fingerprint reuse', () => {
    const { baseline } = fixture({ sameSection: true, sameNarrationFingerprint: true });
    expect(sourceNarrationBaselineInputFingerprints(baseline, [contract])).toEqual({
      'reflection-section': ['reflection-section:original-narration-context'],
    });
    const missingScene = structuredClone(baseline);
    missingScene.finalization.generated.scenes = missingScene.finalization.generated.scenes.slice(1);
    expect(sourceNarrationBaselineInputFingerprints(missingScene, [contract])).toEqual({});
    const missingNarration = { ...baseline, narrationStages: baseline.narrationStages.slice(1) };
    expect(sourceNarrationBaselineInputFingerprints(missingNarration, [contract])).toEqual({});
  });
});

describe('original narration stage priority', () => {
  const restore = (overrides: Partial<Parameters<typeof restoreSourceNarrationBaselineStage>[0]> = {}) => {
    const { baseline, stages } = fixture();
    return restoreSourceNarrationBaselineStage({ baseline, outline, stage: 'narration', modelFingerprint,
      inputFingerprint: 'reflection:original-narration-context', bodyCheckpoint: stages[0],
      sourceIdentity, sourceCheckpoint, ...overrides });
  };

  it('prioritizes the actual original while keeping spent old source attempts intact', () => {
    expect(restore()).toMatchObject({ teachingNarration: { segments: [{ text: explanation }] } });
    expect(sourceCheckpoint.attemptsStarted).toBe(2);
  });

  it('lets identity-matched accepted insertion stages win over the old original', () => {
    expect(restore({ sourceCheckpoint: { ...sourceCheckpoint, status: 'accepted', authoringMode: 'insertion-v1',
      insertionAttemptsStarted: 1 } })).toBeNull();
    expect(restore({ sourceCheckpoint: { ...sourceCheckpoint, status: 'accepted', authoringMode: 'insertion-v1',
      insertionAttemptsStarted: 1, sourceFingerprint: 'other-book' } })).not.toBeNull();
    expect(restore({ sourceCheckpoint: { ...sourceCheckpoint, status: 'accepted' } })).not.toBeNull();
  });

  it('never bypasses the original context hash, model, current body, outline or source identity chain', () => {
    expect(restore({ inputFingerprint: 'new-section-bridge' })).toBeNull();
    expect(restore({ modelFingerprint: 'different-model' })).toBeNull();
    expect(restore({ stage: 'content' })).toBeNull();
    expect(restore({ sourceIdentity: undefined })).toBeNull();
    expect(restore({ bodyCheckpoint: undefined })).toBeNull();
    expect(restore({ outline: { ...outline, description: '改为新的职责' } })).toBeNull();
    const { stages } = fixture();
    const changed = structuredClone(stages[0]!);
    (changed.payload as { content: GeneratedSlideContent }).content.elements[0]!.left += 20;
    expect(restore({ bodyCheckpoint: changed })).toBeNull();
  });
});
