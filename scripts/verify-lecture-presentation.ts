/** Opt-in isolated repair of adopted display plans, followed by the production
 * page/narration pipeline. Never writes courses, jobs, or reference classrooms. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { TeachingBlueprint } from '../src/lib/session/types';
import type { GenerateClassroomInput, GenerateClassroomOptions } from '../src/lib/openmaic/server/classroom-generation';
import type { QuickDesignRequest } from '../src/lib/course-design/job-runner';
import type { Prisma } from '@prisma/client';
import type { SceneStageCheckpointSnapshot, SceneStageAttemptSnapshot } from '../src/lib/course-generation/page-checkpoints';
import type { SceneOutline } from '../src/lib/openmaic/types/generation';
import { initializeReadOnlyClients, disconnect } from './verify-course-first-pass-cost';

function arg(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
function sha(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function safeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/(?:postgres(?:ql)?|https?):\/\/[^\s/@]+:[^\s/@]+@/giu, '[redacted-url]@');
}
type Job = { id: string; targetId: string; jobType: string; request: QuickDesignRequest & GenerateClassroomInput;
  checkpoints: Array<{ step: string; state: unknown }> };
type Snapshot = { templates: Array<{ id: string; versions: Array<{ version: number; snapshot: Prisma.JsonValue }> }>; jobs: Job[] };

async function main() {
  const snapshotFile = arg('--snapshot');
  const outputArg = arg('--output');
  const courseId = arg('--course-id');
  if (!snapshotFile || !outputArg || !courseId) throw new Error('需要 --snapshot、--output .openpbl-runtime/...、--course-id');
  const output = path.resolve(outputArg);
  if (!output.startsWith(path.resolve('.openpbl-runtime') + path.sep)) throw new Error('输出必须在隔离的 .openpbl-runtime 目录');
  const refresh = process.argv.includes('--refresh');
  const replayPresentation = process.argv.includes('--replay-presentation-response');
  const generate = process.argv.includes('--generate');
  const sectionIds = arg('--sections')?.split(',').filter(Boolean);
  const pageIds = arg('--pages')?.split(',').filter(Boolean);
  const rawSnapshot = await fs.readFile(snapshotFile, 'utf8');
  const snapshot = JSON.parse(rawSnapshot) as Snapshot;
  const designJob = snapshot.jobs.find((job) => job.targetId === courseId && job.jobType === 'COURSE_DESIGN');
  const contentJob = snapshot.jobs.find((job) => job.targetId === courseId && job.jobType === 'COURSE_CONTENT');
  const template = snapshot.templates.find((entry) => entry.id === courseId);
  const saved = designJob?.checkpoints.find((checkpoint) => checkpoint.step === 'teaching-blueprint')?.state as { blueprint?: TeachingBlueprint } | undefined;
  if (!designJob || !contentJob || !template || !saved?.blueprint) throw new Error('缺少同课程原设计、页面任务和已保存蓝图');
  let saveQueue = Promise.resolve();
  const save = (name: string, data: unknown) => {
    const serialized = JSON.stringify(data, null, 2) + '\n';
    saveQueue = saveQueue.then(async () => {
      await fs.mkdir(output, { recursive: true });
      await fs.writeFile(path.join(output, name), serialized);
    });
    return saveQueue;
  };
  // A completed draft is read again, never implicitly purchased a second time.
  const savedCandidateFile = path.join(output, 'presentation-candidate.json');
  if (refresh && await fs.stat(savedCandidateFile).catch(() => null)) throw new Error('该展示请求已有草稿；重验请省略 --refresh');
  if (refresh && await fs.stat(path.join(output, 'raw-presentation-response.json')).catch(() => null)) {
    throw new Error('该展示请求已有完整响应；请使用 --replay-presentation-response 本地重验，不能重复请求同一份输入');
  }
  process.env.CLASSROOM_DATA_DIR = path.join(output, 'classrooms');
  await initializeReadOnlyClients();
  const { createPblTemplateCourse, decodePblTemplate } = await import('../src/lib/platform/pbl-template');
  const { initializeServerProviderConfig } = await import('../src/lib/openmaic/server/provider-config');
  const { resolveModel } = await import('../src/lib/openmaic/server/resolve-model');
  const { createCourseGenerationAiCall } = await import('../src/lib/openmaic/server/course-generation-ai-call');
  const { prepareTeachingBlueprintInput, assertAiOutlineKnowledgeCoverage } = await import('../src/lib/course-design/job-runner');
  const { createCourseOutputBudget, resolveCourseExecutionBudgetOptions } = await import('../src/lib/openmaic/generation/course-output-budget');
  const { resolveLlmRequestTimeoutMs } = await import('../src/lib/llm/request-policy');
  const { revalidateStoredTeachingBlueprint, teachingBlueprintToOutlines, validateTeachingBlueprintBudget } = await import('../src/lib/course-design/teaching-blueprint');
  const { bindRequiredTextbookFiguresToBlueprint, bindRequiredTextbookFiguresToOutlines, assertSourceSequencesInOutlines,
    findBlueprintFigureSequenceIssues } = await import('../src/lib/textbook/course-visual-binding');
  const { prepareTeachingPageCapacity } = await import('../src/lib/openmaic/generation/teaching-page-preflight');
  const { applyVersionedOutlinePlanToCourseContent } = await import('../src/lib/course-generation/job-runner');
  const { ZH_CN_COURSE_LANGUAGE_DIRECTIVE } = await import('../src/lib/openmaic/generation/course-language');
  const { refreshTeachingPresentation } = await import('../src/lib/course-design/teaching-presentation-refresh');
  const { closeSpatialMeasurementBrowser } = await import('../src/lib/openmaic/generation/slide-spatial-measurement');
  const { closeSlideLayoutAuditBrowser } = await import('../src/lib/openmaic/generation/slide-layout-audit');
  try {
    const version = [...template.versions].sort((a, b) => b.version - a.version)[0]!;
    const design = decodePblTemplate(version.snapshot);
    if (!design) throw new Error('原课程快照无法解码');
    const course = createPblTemplateCourse(courseId, design);
    const sourceContent = course.content;
    const minutes = sourceContent.moduleTimingPlan?.allocations.filter((allocation) => allocation.stageKey === 'ai-learning')
      .reduce((sum, allocation) => sum + allocation.durationMin, 0) ?? 0;
    if (minutes <= 0) throw new Error('原课程缺少确认时长');
    const modelString = contentJob.request.generationModelString;
    if (modelString !== designJob.request.generationModelString) throw new Error('原设计与页面模型不一致');
    await initializeServerProviderConfig();
    const resolved = await resolveModel({ modelString, stage: 'scene-outlines-stream' });
    const { input, textbookFigureResources } = await prepareTeachingBlueprintInput(course, sourceContent, designJob.request, minutes, sha({ model: modelString, thinking: resolved.thinkingConfig }));
    await save('original-blueprint.json', saved.blueprint);
    await save('original-course.json', course);
    await save('teaching-input.json', input);
    await save('provenance.json', { courseId, originalDesignJobId: designJob.id, originalContentJobId: contentJob.id,
      modelString, snapshotSha256: createHash('sha256').update(rawSnapshot).digest('hex'),
      inputSha256: sha(input), blueprintSha256: sha(saved.blueprint), databaseReadOnly: true,
      sections: sectionIds ?? saved.blueprint.sections.map((section) => section.id) });
    let candidate = await fs.readFile(savedCandidateFile, 'utf8').then((text) => JSON.parse(text) as TeachingBlueprint).catch(() => saved.blueprint!);
    if (refresh || replayPresentation) {
      const storedResponse = replayPresentation
        ? (JSON.parse(await fs.readFile(path.join(output, 'raw-presentation-response.json'), 'utf8')) as {
            system: string; prompt: string; text: string; complete?: boolean;
          }) : undefined;
      const aiCall = storedResponse ? async (system: string, prompt: string) => {
        if (storedResponse.complete === false || storedResponse.system !== system || storedResponse.prompt !== prompt) {
          throw new Error('完整保存响应与当前展示请求不一致，不能复用');
        }
        return storedResponse.text;
      } : createCourseGenerationAiCall({ model: resolved.model, vision: false,
        source: 'verify-lecture-presentation', thinking: resolved.thinkingConfig, temperature: 0.2,
        outputBudget: createCourseOutputBudget({ resource: 'teaching-design', modelOutputWindow: resolved.modelInfo?.outputWindow, thinking: resolved.thinkingConfig }),
        executionBudget: resolveCourseExecutionBudgetOptions(), timeoutMs: resolveLlmRequestTimeoutMs('long-generation'),
        streamResponse: true, responseFormat: 'json', requireResponsePersistence: true,
        onResponse: (response) => save('raw-presentation-response.json', response) });
      const refreshed = await refreshTeachingPresentation({ blueprint: saved.blueprint, input,
        sectionIds: sectionIds ?? saved.blueprint.sections.map((section) => section.id), aiCall,
        onPrompt: (prompt) => save('presentation-prompt.json', prompt) });
      candidate = refreshed.candidate;
      await save('presentation-candidate.json', candidate);
      await save('presentation-refresh.json', { refreshedPageIds: refreshed.refreshedPageIds,
        modelCalls: storedResponse ? 0 : refreshed.modelCalls, reusedCompleteResponse: Boolean(storedResponse) });
    }
    const validation = revalidateStoredTeachingBlueprint(candidate, input);
    await save('blueprint-validation.json', validation);
    if (!validation.blueprint) throw new Error('展示候选完整蓝图验收失败：' + validation.issues.join('；'));
    let blueprint = bindRequiredTextbookFiguresToBlueprint(validation.blueprint, textbookFigureResources, input.sourceSequences);
    let outlines: SceneOutline[] = bindRequiredTextbookFiguresToOutlines(teachingBlueprintToOutlines(blueprint, ZH_CN_COURSE_LANGUAGE_DIRECTIVE), textbookFigureResources, input.sourceSequences);
    // Like production's partial generation, measure only the requested complete
    // sections. Other sections keep their adopted content but are not certified
    // as feasible by this isolated sample. The full-course run measures all of them.
    const capacitySource = sectionIds
      ? outlines.filter((outline) => sectionIds.includes(outline.lectureSectionId ?? '')) : outlines;
    if (!capacitySource.length || sectionIds?.some((id) => !capacitySource.some((outline) => outline.lectureSectionId === id))) {
      throw new Error('隔离容量检查的小节范围与已采用蓝图不一致');
    }
    const capacity = await prepareTeachingPageCapacity(capacitySource, {
      allOutlines: outlines, selectedSourceOutlineIds: capacitySource.map((outline) => outline.id),
      explanationNodes: blueprint.sections.flatMap((section) => section.units.flatMap((unit) => unit.explanationNodes ?? [])),
      resourceDimensions: Object.fromEntries(textbookFigureResources.flatMap((figure) => figure.width && figure.height ? [[figure.id, { width: figure.width, height: figure.height }]] : [])),
      resourceSequences: Object.fromEntries(textbookFigureResources.flatMap((figure) => figure.orderedSteps?.length ? [[figure.id, figure.orderedSteps]] : [])),
    });
    await save('capacity.json', { ...capacity, checkedSections: sectionIds ?? blueprint.sections.map((section) => section.id) });
    if (capacity.changed) {
      const emitted = new Set<string>();
      const preparedOutlines = sectionIds ? outlines.flatMap((outline) => {
        const id = outline.lectureSectionId;
        if (!id || !sectionIds.includes(id)) return [outline];
        if (emitted.has(id)) return [];
        emitted.add(id);
        return capacity.outlines.filter((page) => page.lectureSectionId === id);
      }).map((outline, order) => ({ ...outline, order })) : capacity.outlines;
      const synchronized = applyVersionedOutlinePlanToCourseContent({ ...sourceContent, teachingBlueprint: blueprint,
        _openmaicSceneOutlines: outlines.map((outline) => ({ ...outline })) }, preparedOutlines);
      blueprint = synchronized.teachingBlueprint!;
      outlines = preparedOutlines;
      const recheck = revalidateStoredTeachingBlueprint(blueprint, input);
      await save('capacity-blueprint-validation.json', recheck);
      if (!recheck.blueprint) throw new Error('重规划后完整蓝图验收失败：' + recheck.issues.join('；'));
    }
    const checkedOutlines = sectionIds
      ? outlines.filter((outline) => sectionIds.includes(outline.lectureSectionId ?? '')) : outlines;
    const checkedKnowledgeIds = new Set(checkedOutlines.flatMap((outline) => outline.knowledgePointIds ?? []));
    const issues = [...validateTeachingBlueprintBudget(blueprint, outlines), ...findBlueprintFigureSequenceIssues(blueprint,
      [...(input.textbookFigures ?? []).map((figure) => ({ ...figure, scope: 'single-page' as const })), ...(input.sourceSequences ?? [])]
        .filter((contract) => !sectionIds || contract.knowledgePointIds.some((id) => checkedKnowledgeIds.has(id)))).map((issue) => issue.detail)];
    assertAiOutlineKnowledgeCoverage(outlines, sourceContent.knowledgePoints);
    assertSourceSequencesInOutlines(checkedOutlines, (input.sourceSequences ?? []).filter((contract) =>
      !sectionIds || contract.knowledgePointIds.some((id) => checkedKnowledgeIds.has(id))), textbookFigureResources);
    await save('blueprint.json', blueprint);
    await save('outlines.json', outlines);
    if (issues.length) throw new Error('展示计划质量验收失败：' + issues.join('；'));
    if (!generate) { console.log(JSON.stringify({ output, planValidated: true, modelString })); return; }
    const { generateClassroom } = await import('../src/lib/openmaic/server/classroom-generation');
    const { findFinalizedSourceContentIssues } = await import('../src/lib/course-generation/source-content-acceptance');
    const { resolveCourseSourceSequenceContracts } = await import('../src/lib/textbook/course-evidence-types');
    const { measureLecturePresentationPage } = await import('../src/lib/openmaic/generation/lecture-presentation-reference');
    const sourceContracts = [
      ...textbookFigureResources.filter((resource) => resource.required && resource.orderedSteps?.length).map((resource) => ({
        resourceId: resource.id, required: true, knowledgePointIds: resource.knowledgePointIds,
        orderedSteps: resource.orderedSteps, scope: 'single-page' as const,
      })),
      ...resolveCourseSourceSequenceContracts(designJob.request.textbookEvidence, sourceContent.knowledgePoints),
    ];
    const selected = outlines.filter((outline) => (!sectionIds || sectionIds.includes(outline.lectureSectionId ?? ''))
      && (!pageIds || pageIds.includes(outline.id) || outline.spatialParentId && pageIds.includes(outline.spatialParentId)));
    if (!selected.length || pageIds?.some((id) => !selected.some((outline) => outline.id === id || outline.spatialParentId === id))) {
      throw new Error('隔离生成页面范围与已验收展示计划不一致');
    }
    const { fingerprintSceneOutline, restoreSceneStageCheckpoint, restoreSceneStageAttemptCount } = await import('../src/lib/course-generation/page-checkpoints');
    const stageWrites: SceneStageCheckpointSnapshot[] = await fs.readFile(path.join(output, 'accepted-stages.json'), 'utf8')
      .then((text) => JSON.parse(text)).catch(() => []);
    const attempts: SceneStageAttemptSnapshot[] = await fs.readFile(path.join(output, 'stage-attempts.json'), 'utf8')
      .then((text) => JSON.parse(text)).catch(() => []);
    const responses = await fs.readdir(output);
    type SavedStageResponse = Parameters<NonNullable<GenerateClassroomOptions['onStageAuthoringResponse']>>[0];
    const savedResponses: SavedStageResponse[] = await Promise.all(responses.filter((name) => /^raw-stage-\d+-/u.test(name))
      .sort((first, second) => Number(first.match(/^raw-stage-(\d+)/u)?.[1]) - Number(second.match(/^raw-stage-(\d+)/u)?.[1]))
      .map(async (name) => JSON.parse(await fs.readFile(path.join(output, name), 'utf8')) as SavedStageResponse));
    const authoringValidation: unknown[] = [];
    let responseNumber = responses.filter((name) => /^raw-stage-\d+-/u.test(name)).length;
    const options: GenerateClassroomOptions = { preparedOutlines: outlines,
      generationOutlineIds: selected.map((outline) => outline.id), sourceEvidence: designJob.request.textbookEvidence,
      sourceKnowledgePoints: sourceContent.knowledgePoints, sourceSequenceContracts: sourceContracts,
      onStageAuthoringResponse: async (response) => save('raw-stage-' + (++responseNumber) + '-' + response.outline.id + '-' + response.stage + '.json', response),
      onStageAuthoringValidated: async (result) => {
        authoringValidation.push(result);
        await save('authoring-validation.json', authoringValidation);
      },
      loadStageAuthoringResponse: (outline, stage, modelFingerprint, inputFingerprint) => {
        const stored = [...savedResponses].reverse().find((response) => response.stage === stage
          && response.modelFingerprint === modelFingerprint && response.inputFingerprint === inputFingerprint
          && fingerprintSceneOutline(response.outline) === fingerprintSceneOutline(outline));
        return stored ? { text: stored.text, complete: stored.complete } : null;
      },
      loadSceneStageCheckpoint: (outline, stage, modelFingerprint, inputFingerprint) => {
        for (const checkpoint of [...stageWrites].reverse()) {
          const restored = restoreSceneStageCheckpoint({ outline, stage, modelFingerprint, inputFingerprint, checkpoint });
          if (restored) return restored;
        }
        return null;
      },
      onSceneStageCompleted: async (outline, stage, payload, modelFingerprint, inputFingerprint) => {
        stageWrites.push({ schemaVersion: 1, pageKey: outline.id, stage, payload, modelFingerprint, inputFingerprint,
          outlineFingerprint: fingerprintSceneOutline(outline) });
        await save('accepted-stages.json', stageWrites);
      },
      loadSceneStageAttemptCount: (outline, stage, modelFingerprint, inputFingerprint) => Math.max(0,
        ...attempts.map((checkpoint) => restoreSceneStageAttemptCount({ outline, stage, modelFingerprint, inputFingerprint, checkpoint }))),
      onSceneStageAttempt: async (outline, stage, attemptsStarted, modelFingerprint, inputFingerprint) => {
        attempts.push({ schemaVersion: 1, pageKey: outline.id, stage, attemptsStarted, modelFingerprint, inputFingerprint,
          outlineFingerprint: fingerprintSceneOutline(outline), status: 'started' });
        await save('stage-attempts.json', attempts);
      },
      onSceneStageAttemptSettled: async (outline, stage, attemptsStarted, status, modelFingerprint, inputFingerprint) => {
        const checkpoint = [...attempts].reverse().find((attempt) => attempt.pageKey === outline.id && attempt.stage === stage
          && attempt.attemptsStarted === attemptsStarted && attempt.modelFingerprint === modelFingerprint
          && attempt.inputFingerprint === inputFingerprint && attempt.outlineFingerprint === fingerprintSceneOutline(outline));
        if (checkpoint) checkpoint.status = status;
        await save('stage-attempts.json', attempts);
      },
      onProgress: (progress) => console.log(JSON.stringify({ phase: progress.step, message: progress.message })),
    };
    const request = { ...contentJob.request, sceneOutlines: outlines, enableTTS: false,
      teachingExplanationNodes: blueprint.sections.flatMap((section) => section.units.flatMap((unit) => unit.explanationNodes ?? [])) };
    await save('page-request.json', request);
    const generated = await generateClassroom(request, options);
    await save('generated-classroom.json', generated);
    if (process.argv.includes('--media')) {
      const { generateMediaForClassroom, replaceMediaPlaceholders } = await import('../src/lib/openmaic/server/classroom-media-generation');
      const cachedMedia: Record<string, { requestFingerprint: string; url: string }> = await fs.readFile(path.join(output, 'media-cache.json'), 'utf8')
        .then((text) => JSON.parse(text)).catch(() => ({}));
      const mediaMap: Record<string, string> = {};
      const mediaOutlines = generated.assetContext.outlines.map((outline) => ({ ...outline,
        mediaGenerations: outline.mediaGenerations?.filter((item) => {
          const cached = cachedMedia[item.elementId];
          if (cached?.requestFingerprint === sha(item)) { mediaMap[item.elementId] = cached.url; return false; }
          return true;
        }) }));
      const media = await generateMediaForClassroom(mediaOutlines, generated.id, 'http://127.0.0.1:3000', {
        image: generated.assetContext.enableImageGeneration, video: generated.assetContext.enableVideoGeneration,
      });
      await save('media-result.json', media);
      Object.assign(mediaMap, media.mediaMap);
      for (const item of generated.assetContext.outlines.flatMap((outline) => outline.mediaGenerations ?? [])) {
        if (mediaMap[item.elementId]) cachedMedia[item.elementId] = { requestFingerprint: sha(item), url: mediaMap[item.elementId]! };
      }
      await save('media-cache.json', cachedMedia);
      replaceMediaPlaceholders(generated.scenes, mediaMap, generated.assetContext.outlines);
      await save('generated-classroom-with-media.json', generated);
      if (media.failures.length) throw new Error('隔离媒体生成未通过：' + media.failures.map((failure) => failure.error).join('；'));
    }
    const sourceIssues = findFinalizedSourceContentIssues(generated.assetContext.outlines, generated.scenes, sourceContracts);
    const measurements = generated.scenes.flatMap((scene) => scene.content.type === 'slide' ? [{ outlineId: scene.outlineId,
      title: scene.title, ...measureLecturePresentationPage({ title: scene.title, elements: scene.content.canvas.elements }),
      narrationCharacters: (scene.actions ?? []).filter((action) => action.type === 'speech').reduce((sum, action) => sum + (action.type === 'speech' ? action.text.length : 0), 0) }] : []);
    await save('result.json', { modelString, selectedSections: sectionIds, planValidated: true,
      generatedScenes: generated.scenesCount, sourceIssues, measurements, sourceSpeechVerified: sourceIssues.length === 0,
      visualComparisonStillRequired: true, ttsAssetsGenerated: false });
    if (sourceIssues.length) throw new Error('实际讲授来源验收失败：' + sourceIssues.map((issue) => issue.detail).join('；'));
    console.log(JSON.stringify({ output, generatedScenes: generated.scenesCount, sourceSpeechVerified: true }));
  } finally { await Promise.allSettled([closeSpatialMeasurementBrowser(), closeSlideLayoutAuditBrowser()]); }
}

main().catch(async (error) => {
  const output = arg('--output');
  if (output && path.resolve(output).startsWith(path.resolve('.openpbl-runtime') + path.sep)) {
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: safeError(error) }, null, 2));
  }
  console.error(safeError(error)); process.exitCode = 1;
}).finally(disconnect);
