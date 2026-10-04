import { describe, expect, it, vi } from 'vitest';
import type { SceneOutline } from '@/lib/openmaic/types/generation';
import type { Scene } from '@openmaic/lib/types/stage';
import type { FigureSequenceContract } from '@/lib/textbook/course-visual-binding';
import { fingerprintGenerationValue, fingerprintSceneOutline, type SceneStageCheckpointSnapshot } from './page-checkpoints';
import { fingerprintCourseFinalizationRequest, restoreCourseFinalizationCheckpoint, restoreCompletedTestLessonContext, restoreOrGenerateFinalizedClassroom, type PersistedCourseGenerationRequest } from './job-runner';
import type { TeachingManuscript } from '@/lib/course-design/teaching-manuscript';

const original = [
  { id: 'a', type: 'slide', title: 'A', description: 'Explain A', keyPoints: [], order: 0, targetDurationSec: 120 },
  { id: 'b', type: 'quiz', title: 'B', description: 'Assess A', keyPoints: [], order: 1, targetDurationSec: 30 },
] satisfies SceneOutline[];
const expanded: SceneOutline[] = [
  { ...original[0], spatialParentId: 'a', targetDurationSec: 60 },
  { ...original[0], id: 'a--continuation-2', spatialParentId: 'a', targetDurationSec: 60 },
  original[1],
];
const request = { courseId: 'isolated', courseTitle: 'Course', requirement: 'Confirmed input', sceneOutlines: original, enableTTS: true } as PersistedCourseGenerationRequest;
const generated = { stage: { id: 'classroom' }, scenes: expanded.map((outline) => ({ id: outline.id, outlineId: outline.id, actions: [{ id: `${outline.id}:speech`, type: 'speech', text: '讲解', audioUrl: `/audio/${outline.id}.wav` }] })), assetContext: { outlines: expanded } };
const checkpoint = (inputFingerprint: string) => ({ schemaVersion: 1, inputFingerprint, generated, split: { studentClassroomId: 'classroom', studentScenes: generated.scenes, teacherScenes: [] }, assetsCompletedAt: 'legacy-incorrect-completed-marker' });

describe('canonical speech identity at finalization recovery', () => {
  const manuscripts: TeachingManuscript[] = [{ sectionId: 'spoken-section', segments: [{ id: 'paragraph', text: '已确认的完整口播。' }] }];
  const spokenOutlines: SceneOutline[] = original.map((outline) => ({ ...outline,
    teachingBrief: { schemaVersion: 1, manuscript: { sectionId: 'spoken-section', segmentIds: ['paragraph'] },
      explanation: '', examples: [], conditions: [], evidence: [], assessmentFocus: '', reviewItems: [] },
  }));
  const spokenRequest = { ...request, sceneOutlines: spokenOutlines };
  const spokenGenerated = { ...generated, assetContext: { outlines: spokenOutlines },
    scenes: spokenOutlines.map((outline) => ({ id: outline.id, outlineId: outline.id,
      actions: [{ id: 'paragraph', type: 'speech', text: '已确认的完整口播。', audioUrl: '/accepted.wav' }] })) };
  const identity = fingerprintGenerationValue({ manuscripts });
  const saved = () => ({ schemaVersion: 1, inputFingerprint: fingerprintCourseFinalizationRequest(spokenRequest),
    sourceContextFingerprint: identity, generated: spokenGenerated });

  it('restores an exact canonical speech identity and retains accepted audio without authoring', async () => {
    const checkpoint = saved();
    const author = vi.fn();
    const result = await restoreOrGenerateFinalizedClassroom({ checkpoint, request: spokenRequest,
      preparedOutlines: spokenOutlines, sourceContextFingerprint: identity, teachingManuscripts: manuscripts, generate: author });
    expect(author).not.toHaveBeenCalled();
    expect(result.restoredFinalization).toBe(checkpoint);
    expect(result.sourceContextFingerprint).toBe(identity);
    expect(result.generated.scenes[0]?.actions?.[0]).toMatchObject({ audioUrl: '/accepted.wav' });
  });

  it('does not revive old speech when only canonical text changes beneath stable outline references', async () => {
    const checkpoint = saved();
    const nextManuscripts = [{ ...manuscripts[0]!, segments: [{ id: 'paragraph', text: '教师已修订的完整口播。' }] }];
    const nextIdentity = fingerprintGenerationValue({ manuscripts: nextManuscripts });
    const nextGenerated = { ...spokenGenerated, scenes: spokenGenerated.scenes.map((scene) => ({ ...scene,
      actions: [{ id: 'paragraph', type: 'speech', text: '教师已修订的完整口播。' }] })) };
    const author = vi.fn(async () => nextGenerated as never);
    const result = await restoreOrGenerateFinalizedClassroom({ checkpoint, request: spokenRequest,
      preparedOutlines: spokenOutlines, sourceContextFingerprint: nextIdentity, teachingManuscripts: nextManuscripts, generate: author });
    expect(author).toHaveBeenCalledOnce();
    expect(result.restoredFinalization).toBeNull();
    expect(result.sourceContextFingerprint).toBe(nextIdentity);
    expect(result.generated.scenes[0]?.actions?.[0]).not.toHaveProperty('audioUrl');
    expect(checkpoint.generated).toBe(spokenGenerated);
  });

  it('requires an explicit canonical identity on a spoken checkpoint even when the submitted request matches', async () => {
    const checkpoint = { schemaVersion: 1, inputFingerprint: fingerprintCourseFinalizationRequest(spokenRequest), generated: spokenGenerated };
    const author = vi.fn(async () => spokenGenerated as never);
    const result = await restoreOrGenerateFinalizedClassroom({ checkpoint, request: spokenRequest,
      preparedOutlines: spokenOutlines, sourceContextFingerprint: identity, teachingManuscripts: manuscripts, generate: author });
    expect(result.restoredFinalization).toBeNull();
    expect(author).toHaveBeenCalledOnce();
  });

  it.each([0, 1])('resolves page %i references before reuse or another generation call, including quiz scope', async (index) => {
    const invalid = structuredClone(spokenOutlines);
    invalid[index]!.teachingBrief!.manuscript!.segmentIds = ['missing-paragraph'];
    const author = vi.fn();
    await expect(restoreOrGenerateFinalizedClassroom({ checkpoint: saved(), request: { ...spokenRequest, sceneOutlines: invalid },
      preparedOutlines: invalid, sourceContextFingerprint: identity, teachingManuscripts: manuscripts, generate: author }))
      .rejects.toThrow('不存在的讲稿段落 missing-paragraph');
    expect(author).not.toHaveBeenCalled();
  });

  it('does not introduce source quality invalidation for legacy completed courses', async () => {
    const legacy = { ...checkpoint(fingerprintCourseFinalizationRequest(request)), sourceContextFingerprint: 'old-source' };
    const author = vi.fn();
    const result = await restoreOrGenerateFinalizedClassroom({ checkpoint: legacy, request,
      preparedOutlines: expanded, sourceContextFingerprint: 'current-source', teachingManuscripts: [], generate: author });
    expect(result.restoredFinalization).toBe(legacy);
    expect(author).not.toHaveBeenCalled();
  });
});

describe('finalization recovery after compiled page expansion', () => {
  it('authorizes original trial context only for the linked completed lesson and all its adopted pages', () => {
    const outlines = expanded.map((page) => ({ ...page, lectureSectionId: 'trial-section',
      generationPurpose: 'knowledge-teaching' as const }));
    const target = { sectionId: 'trial-section', sectionTitle: '试生成小节', sceneOutlineIds: ['a', 'b'], durationSeconds: 150 };
    const context = { request: { ...request, generationScope: 'full-course' as const }, classroomId: 'classroom',
      run: { scope: 'test-lesson' as const, status: 'completed' as const, generatedOutlineIds: outlines.map((page) => page.id),
        fullOutlineCount: 5, testLesson: target },
      finalization: { ...checkpoint('trial-input'), generated: { ...generated,
        assetContext: { outlines, narrationProgression: original } } } };
    expect(restoreCompletedTestLessonContext(context)).toEqual({ target, outlines, progression: original });
    expect(restoreCompletedTestLessonContext({ ...context, classroomId: 'other-course-output' })).toBeUndefined();
    expect(restoreCompletedTestLessonContext({ ...context, run: { ...context.run, status: 'pending' } })).toBeUndefined();
    expect(restoreCompletedTestLessonContext({ ...context, run: { ...context.run,
      generatedOutlineIds: ['a', 'b'] } })).toBeUndefined();
    expect(restoreCompletedTestLessonContext({ ...context, finalization: { ...context.finalization,
      generated: { ...generated, assetContext: { outlines: [...outlines, { ...original[0], id: 'foreign', lectureSectionId: 'other-section' }] } } } })).toBeUndefined();
    const sources = { sourceKnowledgePoints: [], sourceSequenceContracts: [] };
    const oldFingerprint = fingerprintGenerationValue('accepted-trial-context');
    const stages: SceneStageCheckpointSnapshot[] = [];
    const scenes = outlines.map((outline) => {
      const content = { elements: [{ id: `${outline.id}:body`, type: 'text', content: outline.title }] };
      const segment = { id: `${outline.id}:speech`, pageId: outline.id, text: '讲解', semanticIds: [] };
      if (outline.type === 'slide') for (const stage of ['content', 'narration'] as const) stages.push({
        schemaVersion: 1, pageKey: outline.id, stage, outlineFingerprint: fingerprintSceneOutline(outline),
        modelFingerprint: 'unchanged-model', inputFingerprint: oldFingerprint,
        payload: stage === 'content' ? { content } : { teachingNarration: { pageId: outline.id, segments: [segment] } },
      });
      return { id: outline.id, outlineId: outline.id, type: outline.type,
        content: { type: 'slide', canvas: content }, actions: [{ id: segment.id, type: 'speech', text: segment.text }] };
    });
    const authenticated = { ...context, sources,
      authoringHistory: [{ request: { ...context.request, generationScope: 'test-lesson', testLesson: target,
        authoringRequestId: 'original-trial' }, stages }],
      finalization: { ...context.finalization, generated: { ...context.finalization.generated, scenes,
        assetContext: { outlines, narrationProgression: original,
          narrationSourceFingerprint: fingerprintGenerationValue(sources) } } } };
    expect(restoreCompletedTestLessonContext(authenticated)?.narrationBaseline).toEqual({ scenes, outlines,
      narrationInputFingerprints: { 'trial-section': [oldFingerprint] } });
    expect(restoreCompletedTestLessonContext(authenticated)?.narrationStages).toEqual(stages.filter((stage) => stage.stage === 'narration'));
    expect(restoreCompletedTestLessonContext({ ...authenticated, sources: { ...sources,
      sourceKnowledgePoints: [{ id: 'changed-adoption', evidenceItemIds: [] }] } })?.narrationBaseline).toBeUndefined();
    expect(restoreCompletedTestLessonContext({ ...authenticated, authoringHistory: [{ ...authenticated.authoringHistory[0],
      request: { ...authenticated.authoringHistory[0].request, generationModelString: 'other-model' } }] })?.narrationBaseline).toBeUndefined();
    expect(restoreCompletedTestLessonContext({ ...authenticated, authoringHistory: [{ ...authenticated.authoringHistory[0],
      stages: stages.slice(1) }] })?.narrationBaseline).toBeUndefined();
    expect(restoreCompletedTestLessonContext({ ...authenticated, finalization: { ...authenticated.finalization,
      generated: { ...authenticated.finalization.generated, scenes: scenes.map((scene) => ({ ...scene,
        actions: [{ ...scene.actions[0], text: '另一份讲稿' }] })) } } })?.narrationBaseline).toBeUndefined();
  });

  const sourceLabels = ['学生应用生成式人工智能需要熟悉场景与使用能力',
    '技术原理与项目任务难度须依据学生认知能力调整', '实践应用同时引导道德伦理问题思考'];
  const sourceOutline = { ...original[0], lectureSectionId: 'source-section', knowledgePointIds: ['source-kp'],
    generationPurpose: 'knowledge-teaching' as const, keyPoints: sourceLabels };
  const sourceRequest = { ...request, sceneOutlines: [sourceOutline, original[1]] };
  const sourceContract: FigureSequenceContract = { resourceId: 'source-list', scope: 'knowledge-point',
    required: true, knowledgePointIds: ['source-kp'], sequenceSemantics: 'enumerated-items',
    orderedSteps: sourceLabels.map((label) => ({ label })) };
  const sourceGenerated = (speech: string[]) => ({ ...generated, assetContext: { outlines: sourceRequest.sceneOutlines },
    scenes: [{ id: 'a', outlineId: 'a', type: 'slide', order: 0, title: 'A', stageId: 'classroom',
      content: { type: 'slide', canvas: { id: 'saved-canvas', elements: [
        { id: 'summary', type: 'text', content: '熟悉场景、认知难度、实践伦理', left: 60, top: 140, width: 880, height: 200 },
      ] } }, actions: speech.map((text, index) => ({ id: `speech-${index}`, type: 'speech', text, audioUrl: `/accepted-${index}.wav` })) },
    { id: 'b', outlineId: 'b', content: { type: 'quiz' }, actions: [] }] });

  it('restores a draft with source-content differences and all its media without another authoring call', async () => {
    const unsafe = sourceGenerated(sourceLabels.slice(0, 2));
    const saved = { ...checkpoint(fingerprintCourseFinalizationRequest(sourceRequest)), generated: unsafe };
    const repaired = sourceGenerated(sourceLabels);
    const author = vi.fn(async () => repaired as never);
    const { generated: output, restoredFinalization, sourceContentIssues, qualityDiagnostics } = await restoreOrGenerateFinalizedClassroom({ checkpoint: saved,
      request: sourceRequest, preparedOutlines: sourceRequest.sceneOutlines, sourceSequenceContracts: [sourceContract], generate: author });
    expect(author).not.toHaveBeenCalled();
    expect(restoredFinalization).toBe(saved);
    expect(output).toBe(unsafe);
    expect(output.scenes[0]!.actions).toEqual(unsafe.scenes[0]!.actions);
    expect(output.scenes[0]!.content).toEqual(unsafe.scenes[0]!.content);
    expect(saved.generated.scenes[0]?.actions).toHaveLength(2);
    expect(saved.generated).toBe(unsafe);
    expect(saved.assetsCompletedAt).toBe('legacy-incorrect-completed-marker');
    expect(sourceContentIssues[0]?.missingCanonicalLabels).toEqual([sourceLabels[2]]);
    expect(qualityDiagnostics.join('\n')).toContain(sourceLabels[2]);
  });

  it('restores strict source-valid summarized slides and full spoken teaching with no model call', async () => {
    const accepted = sourceGenerated(sourceLabels);
    const saved = { ...checkpoint(fingerprintCourseFinalizationRequest(sourceRequest)), generated: accepted };
    const author = vi.fn<Parameters<typeof restoreOrGenerateFinalizedClassroom>[0]['generate']>();
    const { generated: output, restoredFinalization } = await restoreOrGenerateFinalizedClassroom({ checkpoint: saved,
      request: sourceRequest, preparedOutlines: sourceRequest.sceneOutlines, sourceSequenceContracts: [sourceContract], generate: author });
    expect(author).not.toHaveBeenCalled();
    expect(restoredFinalization).toBe(saved);
    expect(output.scenes[0]?.actions?.[0]).toMatchObject({ audioUrl: '/accepted-0.wav' });
  });

  it('keeps the saved finalization byte-for-byte when supplied source obligations differ from the original draft', async () => {
    const unsafe = sourceGenerated(sourceLabels.slice(0, 2));
    const saved = { ...checkpoint(fingerprintCourseFinalizationRequest(sourceRequest)), generated: unsafe };
    const before = JSON.stringify(saved);
    const author = vi.fn(async () => unsafe as never);
    const result = await restoreOrGenerateFinalizedClassroom({ checkpoint: saved, request: sourceRequest,
      preparedOutlines: sourceRequest.sceneOutlines, sourceSequenceContracts: [sourceContract], generate: author });
    expect(author).not.toHaveBeenCalled();
    expect(result.generated).toBe(unsafe);
    expect(JSON.stringify(saved)).toBe(before);
  });

  it('authors at most once without a checkpoint and then reuses the full original despite a source-content difference', async () => {
    const firstDraft = sourceGenerated(sourceLabels.slice(0, 2));
    const before = JSON.stringify(firstDraft);
    const author = vi.fn(async () => firstDraft as never);
    const first = await restoreOrGenerateFinalizedClassroom({ checkpoint: null, request: sourceRequest,
      preparedOutlines: sourceRequest.sceneOutlines, sourceSequenceContracts: [sourceContract], generate: author });
    expect(first.restoredFinalization).toBeNull();
    expect(first.generated).toBe(firstDraft);
    expect(author).toHaveBeenCalledExactlyOnceWith();
    const saved = { ...checkpoint(first.inputFingerprint), generated: first.generated };
    const resumed = await restoreOrGenerateFinalizedClassroom({ checkpoint: saved, request: sourceRequest,
      preparedOutlines: sourceRequest.sceneOutlines, sourceSequenceContracts: [sourceContract], generate: author });
    expect(resumed.generated).toBe(firstDraft);
    expect(resumed.generated.scenes[0]!.actions).toEqual(firstDraft.scenes[0]!.actions);
    expect(JSON.stringify(firstDraft)).toBe(before);
    expect(author).toHaveBeenCalledOnce();
  });

  it('propagates a technical first-authoring failure without retrying or inserting source content', async () => {
    const author = vi.fn(async () => { throw new Error('provider response incomplete'); });
    await expect(restoreOrGenerateFinalizedClassroom({ checkpoint: null, request: sourceRequest,
      preparedOutlines: sourceRequest.sceneOutlines, sourceSequenceContracts: [sourceContract], generate: author }))
      .rejects.toThrow('provider response incomplete');
    expect(author).toHaveBeenCalledExactlyOnceWith();
  });
  it('does not turn an empty technical generation into completed output', async () => {
    const author = vi.fn(async () => ({ ...generated, scenes: [] }) as never);
    await expect(restoreOrGenerateFinalizedClassroom({ checkpoint: null, request,
      preparedOutlines: original, generate: author })).rejects.toThrow('No scenes were generated');
    expect(author).toHaveBeenCalledOnce();
  });
  it('rejects a completed checkpoint when a required textbook original is added to the course contract', () => {
    const before = checkpoint(fingerprintCourseFinalizationRequest(request));
    const withOriginal = { ...request,
      sceneOutlines: [{ ...original[0], suggestedImageIds: ['textbook_fig_32'],
        visualIntent: { observationGoal: '观察教材流程', representation: 'source-image' as const,
          resourceRefs: [{ kind: 'source-image' as const, resourceId: 'textbook_fig_32',
            required: true, reason: '教材原图' }] } }, original[1]],
      textbookImages: [{ id: 'textbook_fig_32', figureId: 'figure-32', assetId: 'asset-32',
        src: '/api/uploads/asset-32', textbookRelation: 'direct' as const, required: true,
        evidenceItemIds: ['e-32'], knowledgePointIds: ['kp'], sourceTitle: '教材',
        pageNumber: 32 }],
    } as PersistedCourseGenerationRequest;
    expect(restoreCourseFinalizationCheckpoint(before, withOriginal, withOriginal.sceneOutlines ?? [])).toBeNull();
  });
  it('keeps submitted identity stable when recovery count and prepared pages change', () => {
    expect(fingerprintCourseFinalizationRequest({ ...request, managedRecoveryCount: 3 })).toBe(fingerprintCourseFinalizationRequest(request));
    expect(restoreCourseFinalizationCheckpoint(checkpoint(fingerprintCourseFinalizationRequest(request)), { ...request, managedRecoveryCount: 0 }, expanded)?.generated).toBe(generated);
  });
  it('preserves free-form finalization recovery without submitted outlines', () => {
    const freeform = { ...request, sceneOutlines: undefined };
    const saved = checkpoint(fingerprintCourseFinalizationRequest(freeform));
    expect(restoreCourseFinalizationCheckpoint(saved, freeform, expanded)?.generated).toBe(generated);
    expect(restoreCourseFinalizationCheckpoint(saved, freeform, [])?.generated).toBe(generated);
  });
  it('restores legacy expanded output so an asset-only resume skips all authoring calls', async () => {
    const legacy = checkpoint(fingerprintGenerationValue({ request, outlines: original }));
    const author = vi.fn<Parameters<typeof restoreOrGenerateFinalizedClassroom>[0]['generate']>();
    const { generated: output, restoredFinalization: restored } = await restoreOrGenerateFinalizedClassroom({
      checkpoint: legacy, request: { ...request, managedRecoveryCount: 0 }, preparedOutlines: expanded, generate: author,
    });
    expect(author).not.toHaveBeenCalled();
    expect(output.scenes).toHaveLength(3);
    expect(output.scenes[0]?.actions?.[0]).toMatchObject({ audioUrl: '/audio/a.wav' });
    expect(restored?.split?.studentClassroomId).toBe('classroom');
  });
  it('promotes accepted test media when a grouped page bypasses its whole-page checkpoint', async () => {
    const draftScene = {
      id: 'a', outlineId: 'a', stageId: 'classroom', title: 'A', type: 'slide', order: 0,
      content: { type: 'slide', canvas: { id: 'draft-canvas', elements: [
        { id: 'case-image', type: 'image', resourceId: 'gen_img_case', src: 'gen_img_case' },
      ] } },
      actions: [{ id: 'speech-a', type: 'speech', text: '同一段讲解' }],
    } as unknown as Scene;
    const accepted = {
      ...draftScene,
      content: { type: 'slide', canvas: { id: 'accepted-canvas', elements: [
        { id: 'case-image', type: 'image', resourceId: 'gen_img_case', src: '/api/openmaic/classroom-media/test/media/case.png' },
      ] } },
      actions: [{ id: 'speech-a', type: 'speech', text: '同一段讲解',
        audioUrl: '/api/openmaic/classroom-media/test/audio/a.wav',
        speechAlignment: { status: 'aligned' } }],
    } as unknown as Scene;
    const author = vi.fn(async () => ({ ...generated, scenes: [draftScene, ...generated.scenes.slice(1)] }) as never);
    const { generated: output } = await restoreOrGenerateFinalizedClassroom({
      checkpoint: null, request, preparedOutlines: expanded, generate: author,
      previousScenes: new Map([['a', accepted]]),
    });
    expect(author).toHaveBeenCalledOnce();
    expect(output.scenes[0]?.actions?.[0]).toMatchObject({
      audioUrl: '/api/openmaic/classroom-media/test/audio/a.wav',
      speechAlignment: { status: 'aligned' },
    });
    expect(output.scenes[0]?.content).toMatchObject({ canvas: { id: 'accepted-canvas', elements: [
      { src: '/api/openmaic/classroom-media/test/media/case.png' },
    ] } });
    expect(draftScene.actions?.[0]).not.toHaveProperty('audioUrl');
    expect(draftScene.content).toMatchObject({ canvas: { elements: [{ src: 'gen_img_case' }] } });
  });
  it('accepts only the selected test parents from a full submitted outline', () => {
    const testRequest: PersistedCourseGenerationRequest = { ...request, generationScope: 'test-lesson', fullSceneCount: 2,
      testLesson: { sectionId: 'section', sectionTitle: 'Section', sceneOutlineIds: ['a'], durationSeconds: 120 } };
    const testGenerated = { ...generated, scenes: generated.scenes.slice(0, 2), assetContext: { outlines: expanded.slice(0, 2) } };
    const legacy = { ...checkpoint(fingerprintGenerationValue({ request: testRequest, outlines: original })), generated: testGenerated };
    expect(restoreCourseFinalizationCheckpoint(legacy, { ...testRequest, managedRecoveryCount: 0 }, expanded)?.generated).toBe(testGenerated);
    expect(restoreCourseFinalizationCheckpoint({ ...legacy, generated }, { ...testRequest, managedRecoveryCount: 0 }, expanded)).toBeNull();
  });
  it('also restores legacy hashes saved from already-expanded preparation', () => {
    expect(restoreCourseFinalizationCheckpoint(checkpoint(fingerprintGenerationValue({ request, outlines: expanded })), { ...request, managedRecoveryCount: 0 }, expanded)).not.toBeNull();
  });
  it.each([
    { requirement: 'Different teaching request' },
    { courseId: 'other-course' },
    { generationModelString: 'different-model' },
    { generationScope: 'test-lesson', testLesson: { sectionId: 'section', sectionTitle: 'section', sceneOutlineIds: ['a'], durationSeconds: 120 } },
  ])('rejects a legacy checkpoint for changed semantic input %j', (change) => {
    const legacy = checkpoint(fingerprintGenerationValue({ request, outlines: original }));
    expect(restoreCourseFinalizationCheckpoint(legacy, { ...request, ...change } as PersistedCourseGenerationRequest, expanded)).toBeNull();
  });
  it('rejects mismatched legacy output parents, duration, and scene binding', () => {
    const legacy = checkpoint(fingerprintGenerationValue({ request, outlines: original }));
    for (const mutation of [
      { ...generated, assetContext: { outlines: [{ ...expanded[0]!, spatialParentId: 'unknown' }, ...expanded.slice(1)] } },
      { ...generated, assetContext: { outlines: [{ ...expanded[0]!, targetDurationSec: 61 }, ...expanded.slice(1)] } },
      { ...generated, scenes: generated.scenes.slice(1) },
    ]) expect(restoreCourseFinalizationCheckpoint({ ...legacy, generated: mutation }, { ...request, managedRecoveryCount: 0 }, expanded)).toBeNull();
  });

  it('restores cross-parent reallocation only for the exact persisted section revision', () => {
    const before = [
      { ...original[0], lectureSectionId: 'section' },
      { ...original[0], id: 'a2', lectureSectionId: 'section', targetDurationSec: 80 },
      { ...original[1], lectureSectionId: 'section' },
    ];
    const after = [
      { ...before[0]!, id: 'reflow-1', sourcePageIds: ['a', 'a2'], sectionPlanVersion: 'v2', targetDurationSec: 100 },
      { ...before[1]!, id: 'reflow-2', sourcePageIds: ['a', 'a2'], sectionPlanVersion: 'v2', targetDurationSec: 100 },
      { ...before[2]!, sectionPlanVersion: 'v2' },
    ];
    const revisedRequest = { ...request, sceneOutlines: before };
    const revisedGenerated = { ...generated, scenes: after.map((outline) => ({ id: outline.id, outlineId: outline.id })),
      assetContext: { outlines: after } };
    for (const fingerprint of [fingerprintCourseFinalizationRequest(revisedRequest),
      fingerprintGenerationValue({ request: revisedRequest, outlines: before })]) {
      const saved = { ...checkpoint(fingerprint), generated: revisedGenerated };
      expect(restoreCourseFinalizationCheckpoint(saved, revisedRequest, after)).not.toBeNull();
      expect(restoreCourseFinalizationCheckpoint(saved, revisedRequest,
        after.map((outline) => ({ ...outline, sectionPlanVersion: 'v3' })))).toBeNull();
      expect(restoreCourseFinalizationCheckpoint(saved, revisedRequest, before)).toBeNull();
      const restricted = { ...revisedRequest, generationScope: 'test-lesson' as const,
        testLesson: { sectionId: 'section', sectionTitle: 'Section', sceneOutlineIds: ['a'], durationSeconds: 120 } };
      expect(restoreCourseFinalizationCheckpoint({ ...saved, inputFingerprint: fingerprintCourseFinalizationRequest(restricted) },
        restricted, after)).toBeNull();
    }
  });

  it('rejects stale unversioned finalization after a section receives its first revision', () => {
    const prepared = expanded.map((outline) => ({ ...outline, sectionPlanVersion: 'v1', lectureSectionId: 'section' }));
    expect(restoreCourseFinalizationCheckpoint(checkpoint(fingerprintCourseFinalizationRequest(request)), request, prepared)).toBeNull();
  });
});
