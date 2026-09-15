import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db/client';
import { initializeServerProviderConfig } from '@openmaic/lib/server/provider-config';
import type { PersistedCourseGenerationRequest } from '@/lib/course-generation/job-runner';
import { generateClassroom } from './classroom-generation';
import { readClassroom } from './classroom-storage';
import { auditSlideLayout } from '@/lib/openmaic/generation/slide-layout-audit';

const verificationJobId = process.env.OPENPBL_DECK_JOB_ID;
const liveIt = verificationJobId ? it : it.skip;
const existingDeckId = process.env.OPENPBL_EXISTING_DECK_ID;
const existingIt = existingDeckId ? it : it.skip;

describe('live OpenMAIC website-reference deck', () => {
  afterAll(async () => {
    if (verificationJobId) await prisma.$disconnect();
  });

  liveIt('keeps a complete resource-package lecture rich, consistent and sectioned', async () => {
    await initializeServerProviderConfig();
    const row = await prisma.generationJob.findUniqueOrThrow({
      where: { id: verificationJobId! },
      select: { request: true },
    });
    const request = row.request as unknown as PersistedCourseGenerationRequest;
    const result = await generateClassroom({
      ...request,
      generationModelString:
        process.env.OPENPBL_BASELINE_MODEL ?? request.generationModelString,
      enableImageGeneration: false,
      enableVideoGeneration: false,
      enableTTS: false,
    }, {
      onProgress(progress) {
        if (progress.step === 'generating_scenes' && progress.scenesGenerated > 0) {
          console.info('OPENMAIC_LIVE_DECK_PROGRESS', JSON.stringify({
            scenesGenerated: progress.scenesGenerated,
            totalScenes: progress.totalScenes,
          }));
        }
      },
    });

    const slides = result.scenes.filter((scene) => scene.content.type === 'slide');
    const quizIndexes = result.scenes.flatMap((scene, index) =>
      scene.content.type === 'quiz' ? [index] : [],
    );
    const tablePages = slides.filter((scene) =>
      scene.content.type === 'slide'
      && scene.content.canvas.elements.some((element) => element.type === 'table'),
    ).length;
    console.info('OPENMAIC_LIVE_DECK', JSON.stringify({
      classroomId: result.id,
      stageStyle: result.stage.style,
      sceneTypes: result.scenes.map((scene) => scene.type),
      quizIndexes,
      tablePages,
      visualConsistency: result.qualityReport.visualConsistency,
      layoutStatus: result.qualityReport.layoutAudit?.status,
      unresolvedLayoutPages: result.qualityReport.layoutAudit?.pages.filter((page) =>
        page.finalIssues.length > 0,
      ).length,
    }));

    expect(result.qualityReport.generationModelString).toBe(
      process.env.OPENPBL_BASELINE_MODEL ?? request.generationModelString,
    );
    expect(result.stage.style).toBe('professional');
    expect(slides).toHaveLength(6);
    expect(quizIndexes).toEqual([2, 5, 8]);
    expect(tablePages).toBeLessThan(slides.length / 2);
    expect(result.qualityReport.visualConsistency).toMatchObject({
      matchingBackgroundCount: 6,
      deepBlueTitleCount: 6,
      paletteDeviationCount: 0,
    });
    expect(result.qualityReport.visualConsistency?.subtitleCount).toBeGreaterThanOrEqual(5);
    expect(result.qualityReport.visualConsistency?.averageVisibleTextCharacters)
      .toBeGreaterThanOrEqual(150);
    expect(result.qualityReport.visualConsistency?.averageElementCount).toBeGreaterThanOrEqual(8);
    const repairedPages = result.qualityReport.layoutAudit?.pages.filter((page) =>
      page.adopted === 'repair'
    ) ?? [];
    expect(repairedPages.every((page) =>
      (page.finalQualityScore ?? Number.NEGATIVE_INFINITY)
        > (page.initialQualityScore ?? Number.POSITIVE_INFINITY)
      && (page.finalKnowledgeCoverage ?? 0) + 0.02 >= (page.initialKnowledgeCoverage ?? 0)
    )).toBe(true);
  }, 1_200_000);

  existingIt('reports browser evidence for an already generated validation deck', async () => {
    const classroom = await readClassroom(existingDeckId!);
    if (!classroom) throw new Error(`Missing classroom ${existingDeckId}`);
    const results = [];
    for (const scene of classroom.scenes) {
      if (scene.content.type !== 'slide') continue;
      results.push({
        title: scene.title,
        audit: await auditSlideLayout({
          elements: scene.content.canvas.elements,
          background: scene.content.canvas.background,
          theme: scene.content.canvas.theme,
        }, scene.id),
      });
    }
    console.info('OPENMAIC_EXISTING_DECK_LAYOUT', JSON.stringify(results.map(({ title, audit }) => ({
      title,
      status: audit.status,
      issues: audit.issues,
      reason: audit.reason,
    }))));
    expect(results).toHaveLength(6);
    expect(results.filter((result) => result.audit.status === 'checked')).toHaveLength(6);
  }, 180_000);
});
