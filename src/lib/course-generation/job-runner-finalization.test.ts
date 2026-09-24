import { describe, expect, it, vi } from 'vitest';
import type { SceneOutline } from '@/lib/openmaic/types/generation';
import type { Scene } from '@openmaic/lib/types/stage';
import { fingerprintGenerationValue } from './page-checkpoints';
import { fingerprintCourseFinalizationRequest, restoreCourseFinalizationCheckpoint, restoreOrGenerateFinalizedClassroom, type PersistedCourseGenerationRequest } from './job-runner';

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

describe('finalization recovery after compiled page expansion', () => {
  it('keeps submitted identity stable when recovery count and prepared pages change', () => {
    expect(fingerprintCourseFinalizationRequest({ ...request, managedRecoveryCount: 3 })).toBe(fingerprintCourseFinalizationRequest(request));
    expect(restoreCourseFinalizationCheckpoint(checkpoint(fingerprintCourseFinalizationRequest(request)), { ...request, managedRecoveryCount: 0 }, expanded)?.generated).toBe(generated);
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
    const author = vi.fn(async () => ({ ...generated, scenes: [draftScene] }) as never);
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
});
