/** Re-author an existing draft course from its stored teaching inputs for isolated visual acceptance. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main(): Promise<void> {
  const templateId = argument('--template-id');
  const inputPath = argument('--input');
  if (!templateId && !inputPath) throw new Error('Pass --template-id <draft course template ID>');
  const output = path.resolve(argument('--output') ?? `.openpbl-runtime/first-pass-acceptance/${templateId}`);
  const phase = argument('--phase') ?? 'course';
  if (phase !== 'blueprint' && phase !== 'course') throw new Error('--phase must be blueprint or course');
  for (const [key, name] of [
    ['DATABASE_URL', 'database_url.txt'],
    ['PROVIDER_ENCRYPTION_KEY', 'provider_encryption_key.txt'],
  ] as const) {
    if (!process.env[key]) process.env[key] = (await fs.readFile(path.join('deploy/secrets', name), 'utf8')).trim();
  }

  const database = new PrismaClient();
  try {
    const version = templateId ? await database.classroomTemplateVersion.findFirst({
      where: { templateId }, orderBy: { version: 'desc' }, select: { snapshot: true },
    }) : { snapshot: { design: { content: {} } } };
    if (!version) throw new Error('Draft course template not found');
    const wrapper = version.snapshot as Record<string, unknown>;
    const design = wrapper.design as Record<string, unknown> | undefined;
    const content = design?.content as Record<string, unknown> | undefined;
    if (!design || !content) throw new Error('Template has no design input');

    const { initializeServerProviderConfig } = await import('../src/lib/openmaic/server/provider-config');
    const { resolveModel } = await import('../src/lib/openmaic/server/resolve-model');
    const { createCourseGenerationAiCall } = await import('../src/lib/openmaic/server/course-generation-ai-call');
    const { generateTeachingBlueprint, teachingBlueprintToOutlines } = await import('../src/lib/course-design/teaching-blueprint');
    const { buildCourseTeachingSourceContext, buildTeachingBlueprintSectionPlans, precedingAiLectureStages } = await import('../src/lib/course-design/job-runner');
    const { buildCourseTeachingConstraints } = await import('../src/lib/openmaic/pbl/course-request');
    const { generateClassroom } = await import('../src/lib/openmaic/server/classroom-generation');
    const { generateClassroomAssets } = await import('../src/lib/openmaic/server/classroom-asset-generation');
    const { sanitizeTeachingReferenceText } = await import('../src/lib/course-design/job-runner');
    await initializeServerProviderConfig();
    const resolved = await resolveModel({ stage: 'generate-classroom' });
    const allocation = (content.moduleTimingPlan as { allocations?: Array<{ stageKey?: string; durationMin?: number }> } | undefined)?.allocations ?? [];
    const totalDurationSec = allocation.filter((item) => item.stageKey === 'ai-learning')
      .reduce((total, item) => total + (item.durationMin ?? 0), 0) * 60;
    if (totalDurationSec <= 0 && !inputPath) throw new Error('Teaching-time budget missing');
    const teacherBrief = String((content.designGenerationTrace as { teacherBrief?: string } | undefined)?.teacherBrief ?? '').trim();
    const sourceContext = sanitizeTeachingReferenceText(buildCourseTeachingSourceContext(
      content.resourcePackage as Parameters<typeof buildCourseTeachingSourceContext>[0], teacherBrief, [],
    ));
    const objectives = Array.isArray(design.learningObjectives)
      ? design.learningObjectives.filter((value): value is string => typeof value === 'string') : [];
    const knowledgePoints = content.knowledgePoints as Parameters<typeof generateTeachingBlueprint>[0]['knowledgePoints'];
    const knowledgeGraph = content.knowledgeGraph as Parameters<typeof generateTeachingBlueprint>[0]['knowledgeGraph'];
    let blueprintInput: Parameters<typeof generateTeachingBlueprint>[0] = {
      generationModelFingerprint: resolved.modelString,
      courseTitle: String(design.name ?? ''), subject: String(design.subject ?? ''), grade: String(design.grade ?? ''),
      learningObjectives: objectives,
      teachingConstraints: buildCourseTeachingConstraints(
        design as Parameters<typeof buildCourseTeachingConstraints>[0],
        content as Parameters<typeof buildCourseTeachingConstraints>[1],
      ),
      projectContext: [design.drivingQuestion, design.expectedOutcome].filter(Boolean).join('；'),
      knowledgePoints, knowledgeGraph,
      teachingOrder: (content.knowledgeScopePlan as { teachingOrder?: Parameters<typeof generateTeachingBlueprint>[0]['teachingOrder'] } | undefined)?.teachingOrder,
      totalDurationSec, assessmentMode: 'adaptive', generationMode: 'standard',
      teacherBrief: [teacherBrief, '系统资源能力（生成前固定约束）：原生可编辑图表可用。图片生成已启用。视频生成未启用，不得设计 video 资源；动态过程使用分步图、状态对照或因果图。'].filter(Boolean).join('\n'),
      teachingRequirements: content.teachingRequirements as Parameters<typeof generateTeachingBlueprint>[0]['teachingRequirements'],
      precedingStageActivities: precedingAiLectureStages(content as Parameters<typeof precedingAiLectureStages>[0]),
      sourceContext,
      sectionPlans: inputPath ? undefined : buildTeachingBlueprintSectionPlans(
        content as Parameters<typeof buildTeachingBlueprintSectionPlans>[0], totalDurationSec,
      ),
    };
    if (inputPath) blueprintInput = { ...JSON.parse(await fs.readFile(inputPath, 'utf8')), generationModelFingerprint: resolved.modelString };
    await fs.mkdir(output, { recursive: true });
    await writeJson(path.join(output, 'input.json'), blueprintInput);
    const resumeAssets = process.argv.includes('--resume-assets');
    const reuseBlueprint = process.argv.includes('--reuse-blueprint') || resumeAssets;
    console.log(JSON.stringify({ phase: 'blueprint', output, model: resolved.modelString, reuse: reuseBlueprint }));
    const startedAt = Date.now();
    const priorMetrics = reuseBlueprint ? JSON.parse(await fs.readFile(path.join(output, 'metrics.json'), 'utf8').catch(() => '{}')) as { blueprintCalls?: number; elapsedMs?: number; pageAttempts?: Array<{ pageId: string; stage: string; attempts: number }> } : {};
    let blueprintCalls = priorMetrics.blueprintCalls ?? 0;
    const elapsedMs = () => (priorMetrics.elapsedMs ?? 0) + Date.now() - startedAt;
    const pageAttempts: Array<{ pageId: string; stage: string; attempts: number }> = resumeAssets ? priorMetrics.pageAttempts ?? [] : [];
    const checkpointPath = (pageId: string, stage: string, model: string, fingerprint?: string) => path.join(output, 'checkpoints', `${createHash('sha256').update(JSON.stringify([pageId, stage, model, fingerprint])).digest('hex')}.json`);
    const rawBlueprintCall = createCourseGenerationAiCall({
      model: resolved.model, vision: false, source: 'first-pass-course-acceptance',
      maxOutputTokens: 131_072, thinking: resolved.thinkingConfig,
      timeoutMs: 180_000, maxRetries: 2, streamResponse: true, streamMaxDurationMs: 600_000,
    });
    const blueprint = reuseBlueprint
      ? JSON.parse(await fs.readFile(path.join(output, 'blueprint.json'), 'utf8')) as Awaited<ReturnType<typeof generateTeachingBlueprint>>
      : await generateTeachingBlueprint(blueprintInput, async (...args) => {
        blueprintCalls += 1;
        const response = await rawBlueprintCall(...args);
        await writeJson(path.join(output, `blueprint-response-${blueprintCalls}.json`), { response });
        return response;
      }, {
        resourceCapabilities: { imageGenerationEnabled: true, videoGenerationEnabled: false },
        onValidation: ({ issues, responseCharacters }) => {
          if (issues.length) console.log(JSON.stringify({ phase: 'blueprint-validation', responseCharacters, issues }));
        },
      });
    const outlines = teachingBlueprintToOutlines(blueprint, '学生可见内容和讲解使用简体中文。');
    if (!reuseBlueprint) await writeJson(path.join(output, 'blueprint.json'), blueprint);
    await writeJson(path.join(output, 'outlines.json'), outlines);
    if (!reuseBlueprint) await writeJson(path.join(output, 'metrics.json'), { phase: 'blueprint', blueprintCalls, elapsedMs: elapsedMs(), status: 'completed', pages: outlines.length, images: outlines.flatMap((item) => item.mediaGenerations ?? []).length });
    if (phase === 'blueprint') return;
    console.log(JSON.stringify({ phase: 'classroom', pages: outlines.length }));
    const generated: Awaited<ReturnType<typeof generateClassroom>> = resumeAssets
      ? JSON.parse(await fs.readFile(path.join(output, 'classroom-before-media.json'), 'utf8'))
      : await generateClassroom({
      generationModelString: resolved.modelString,
      teachingSourceContext: blueprintInput.sourceContext,
      requirement: blueprintInput.teacherBrief ?? '',
      generationMode: 'standard', knowledgePoints: blueprintInput.knowledgePoints.map(({ id, name }) => ({ id, name })),
      courseTitle: blueprintInput.courseTitle, languageDirective: '学生可见内容和讲解使用简体中文。',
      sceneOutlines: outlines, enableWebSearch: false, enableImageGeneration: true,
      enableVideoGeneration: false, enableTTS: process.argv.includes('--tts'), agentMode: 'default',
    }, {
      loadSceneStageCheckpoint: async (outline, stage, model, fingerprint) => {
        const saved = await fs.readFile(checkpointPath(outline.id, stage, model, fingerprint), 'utf8').catch(() => null);
        return saved ? JSON.parse(saved).payload : null;
      },
      onSceneStageCompleted: (outline, stage, payload, model, fingerprint) => writeJson(
        checkpointPath(outline.id, stage, model, fingerprint), { pageId: outline.id, stage, model, fingerprint, payload },
      ),
      onOutlinesPrepared: (prepared) => writeJson(path.join(output, 'prepared-outlines.json'), prepared),
      onSceneStageAttempt: async (outline, stage, attempts) => {
        pageAttempts.push({ pageId: outline.id, stage, attempts });
        await writeJson(path.join(output, 'page-attempts.json'), pageAttempts);
      },
      onProgress: (progress) => console.log(JSON.stringify({ phase: progress.step, progress: progress.progress, message: progress.message })),
    });
    if (!resumeAssets) {
      await writeJson(path.join(output, 'classroom-before-media.json'), generated);
      await writeJson(path.join(output, 'metrics.json'), { phase: 'content', blueprintCalls, pageAttempts, elapsedMs: elapsedMs(), status: 'completed', pages: generated.scenes.length });
    }
    const { readClassroom } = await import('../src/lib/openmaic/server/classroom-storage');
    const beforeAssets = await readClassroom(generated.id);
    let media: Awaited<ReturnType<typeof generateClassroomAssets>>;
    try {
      media = await generateClassroomAssets({
        ...generated.assetContext, baseUrl: 'http://127.0.0.1:3000',
        studentClassroomId: generated.id, studentScenes: beforeAssets?.scenes ?? generated.scenes,
        onProgress: (progress) => console.log(JSON.stringify({ phase: progress.phase, status: progress.status, completed: progress.completed, total: progress.total })),
      });
    } finally {
      const latest = await readClassroom(generated.id);
      await writeJson(path.join(output, 'classroom.json'), { ...generated, ...latest });
      await writeJson(path.join(output, resumeAssets ? 'media-recovery-metrics.json' : 'metrics.json'), { phase: 'assets', blueprintCalls, pageAttempts, elapsedMs: elapsedMs(), status: latest?.assetGeneration?.status, pages: generated.scenes.length, assets: latest?.assetGeneration });
    }
    const persisted = await readClassroom(generated.id);
    await writeJson(path.join(output, 'classroom.json'), { ...generated, ...persisted, media });
    await writeJson(path.join(output, 'metrics.json'), { phase: 'course', blueprintCalls, pageAttempts, elapsedMs: elapsedMs(), status: 'completed', pages: generated.scenes.length, assets: persisted?.assetGeneration });
    await writeJson(path.join(output, 'course.json'), {
      ...design,
      id: `acceptance-${generated.id}`,
      content: { ...content, teachingBlueprint: blueprint, _openmaicSceneOutlines: outlines,
        _openmaicClassroomId: generated.id, qualityReviewRequired: true },
    });
    console.log(JSON.stringify({ phase: 'done', classroomId: generated.id, output }));
  } finally {
    await database.$disconnect();
  }
}

main().catch(async (error) => {
  const output = argument('--output');
  if (output) await writeJson(path.join(path.resolve(output), 'failure.json'), { message: error instanceof Error ? error.message : String(error), at: new Date().toISOString() });
  console.error(error); process.exitCode = 1;
});
