/** Replay the production classroom pipeline against snapshots, without course/job writes. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { GenerateClassroomInput, GenerateClassroomOptions } from '../src/lib/openmaic/server/classroom-generation';
import type { SceneOutline } from '../src/lib/openmaic/types/generation';
import type {
  PageCheckpointSnapshot,
  SceneStageCheckpointSnapshot,
  SceneStageAttemptSnapshot,
} from '../src/lib/course-generation/page-checkpoints';

type SnapshotJob = {
  id: string;
  targetId: string;
  jobType: string;
  request: GenerateClassroomInput & { courseId: string };
};
type SnapshotCheckpoint = { jobId: string; step: string; state: unknown };
const secrets = new Set<string>();
const pendingFileWrites = new Map<string, Promise<void>>();

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 需要参数值`);
  return value;
}

function safeError(error: unknown): string {
  let text = error instanceof Error ? error.message : String(error);
  for (const value of secrets) if (value) text = text.split(value).join('[redacted]');
  return text.replace(/(?:postgres(?:ql)?|https?):\/\/[^\s/@]+:[^\s/@]+@/giu, '[redacted-url]@');
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const operation = (pendingFileWrites.get(file) ?? Promise.resolve()).then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body, 'utf8');
  });
  pendingFileWrites.set(file, operation);
  await operation;
}

async function readOnlyClient(databaseUrl?: string): Promise<PrismaClient> {
  const { PrismaClient } = await import('@prisma/client');
  const allowed = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy']);
  return new PrismaClient({ ...(databaseUrl ? { datasourceUrl: databaseUrl } : {}), log: ['error'] }).$extends({
    query: { $allOperations({ model, operation, args, query }) {
      if (!allowed.has(operation)) throw new Error(`只读重放禁止数据库操作：${model ?? 'raw'}.${operation}`);
      return query(args);
    } },
  }) as unknown as PrismaClient;
}

function durationBySection(outlines: readonly SceneOutline[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const page of outlines) {
    const section = page.lectureSectionId ?? page.id;
    result.set(section, (result.get(section) ?? 0) + (page.targetDurationSec ?? page.estimatedDuration ?? 0));
  }
  return result;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log('只读重放实际课堂页面，不排队生产任务、不保存课程、不生成媒体资产。\nNODE_OPTIONS=--conditions=import pnpm exec tsx scripts/verify-course-page-generation.ts --snapshot-dir <目录> [--output <目录>] [--deployment-secrets] [--job-id <任务>] [--section-id <完整小节>] [--generate]\n快照目录需含 recent-jobs.json 与 content-checkpoints.json。默认只测量页面；--generate 必须指定 job-id，使用原模型运行实际页面、讲稿和组装链路。section-id 仅限定完整小节，不改变原请求教学内容。');
    return;
  }
  const allowed = new Set(['--snapshot-dir', '--output', '--deployment-secrets', '--job-id', '--section-id', '--generate']);
  for (const value of process.argv.slice(2)) if (value.startsWith('--') && !allowed.has(value)) throw new Error(`未知参数：${value}`);
  const directory = argument('--snapshot-dir');
  if (!directory) throw new Error('需要 --snapshot-dir');
  const snapshotDirectory = path.resolve(directory);
  const output = path.resolve(argument('--output') ?? `.openpbl-runtime/course-page-replay/${new Date().toISOString().replace(/[:.]/g, '-')}`);
  if (output === snapshotDirectory) throw new Error('输出目录不能覆盖输入快照');
  // Classroom assembly writes a JSON snapshot as well as database checkpoints.
  // Redirect it before importing the runtime storage module.
  process.env.CLASSROOM_DATA_DIR = path.join(output, 'classrooms');
  const generate = process.argv.includes('--generate');
  const jobId = argument('--job-id');
  const sectionId = argument('--section-id');
  if (generate && !jobId) throw new Error('真实模型重放需要显式 --job-id');
  if (process.argv.includes('--deployment-secrets')) {
    const secretDirectory = process.env.OPENPBL_SECRET_DIR || path.resolve('deploy/secrets');
    for (const [name, file] of [['DATABASE_URL', 'database_url.txt'], ['PROVIDER_ENCRYPTION_KEY', 'provider_encryption_key.txt']]) {
      process.env[name] = (await fs.readFile(path.join(secretDirectory, file), 'utf8')).trim();
    }
  }
  for (const name of ['DATABASE_URL', 'PROVIDER_CONFIG_DATABASE_URL', 'PROVIDER_ENCRYPTION_KEY']) if (process.env[name]) secrets.add(process.env[name]!);
  const jobBytes = await fs.readFile(path.join(snapshotDirectory, 'recent-jobs.json'), 'utf8');
  const checkpointBytes = await fs.readFile(path.join(snapshotDirectory, 'content-checkpoints.json'), 'utf8');
  const jobs = JSON.parse(jobBytes) as SnapshotJob[];
  const snapshots = JSON.parse(checkpointBytes) as SnapshotCheckpoint[];
  if (!Array.isArray(jobs) || !Array.isArray(snapshots)) throw new Error('任务与检查点快照必须是数组');
  const candidates = jobs.filter((job) => job.jobType === 'COURSE_CONTENT' && (!jobId || job.id === jobId));
  if (!candidates.length) throw new Error('没有匹配的内容生成任务');
  globalThis.__openPblPrisma = await readOnlyClient();
  const providerUrl = process.env.PROVIDER_CONFIG_DATABASE_URL?.trim();
  if (providerUrl && providerUrl !== process.env.DATABASE_URL) globalThis.__openPblProviderPrisma = await readOnlyClient(providerUrl);
  const { prisma, providerPrisma } = await import('../src/lib/db/client');
  try {
    const { evaluateSemanticPageCapacity, canonicalVisibleContent } = await import('../src/lib/openmaic/generation/semantic-page-capacity');
    const { generateClassroom } = await import('../src/lib/openmaic/server/classroom-generation');
    const { initializeServerProviderConfig } = await import('../src/lib/openmaic/server/provider-config');
    const { auditSlideLayout } = await import('../src/lib/openmaic/generation/slide-layout-audit');
    const {
      fingerprintGenerationValue, fingerprintSceneOutline, restoreSceneCheckpoint,
      restoreSceneStageCheckpoint, restoreSceneStageAttemptCount, migrateSceneStageAttemptInputFingerprint,
    } = await import('../src/lib/course-generation/page-checkpoints');
    const { restoreSectionCapacityCheckpoint, SECTION_CAPACITY_CHECKPOINT_PREFIX } = await import('../src/lib/course-generation/section-capacity-checkpoints');
    const {
      restoreSourceContentCheckpoint, SOURCE_CONTENT_CHECKPOINT_PREFIX, findFinalizedSourceContentIssues,
    } = await import('../src/lib/course-generation/source-content-acceptance');
    const { getCourse } = await import('../src/lib/session/server-store');
    const { hydrateCourseEvidenceFigureReferences, resolveCourseTextbookFigures } = await import('../src/lib/textbook/course-evidence');
    const { resolveCourseSourceSequenceContracts } = await import('../src/lib/textbook/course-evidence-types');
    const { restoreCourseFinalizationCheckpoint } = await import('../src/lib/course-generation/job-runner');
    const results: Array<Record<string, unknown>> = [];
    if (generate) await initializeServerProviderConfig();
    for (const job of candidates) {
      if (job.targetId !== job.request.courseId || path.basename(job.id) !== job.id || job.id === '..') throw new Error('快照任务身份不匹配');
      const folder = path.join(output, job.id);
      const checkpoints = new Map(snapshots.filter((item) => item.jobId === job.id).map((item) => [item.step, item.state]));
      const input = job.request;
      const original = input.sceneOutlines ?? [];
      const prepared = checkpoints.get('prepared-outlines');
      const preparedOutlines = Array.isArray(prepared) ? prepared as SceneOutline[] : [];
      const source = preparedOutlines.length ? preparedOutlines : original;
      const course = await getCourse(input.courseId);
      if (!course) throw new Error('原课程来源不存在，无法验证实际采用的内容');
      const completeEvidence = course.content.courseEvidence ? { ...course.content.courseEvidence,
        items: await hydrateCourseEvidenceFigureReferences(course.content.courseEvidence.items) } : undefined;
      const textbookResources = await resolveCourseTextbookFigures(completeEvidence, course.content.knowledgePoints);
      const capacityOptions = {
        explanationNodes: course.content.teachingBlueprint?.sections
          .flatMap((section) => section.units.flatMap((unit) => unit.explanationNodes ?? [])),
        resourceDimensions: Object.fromEntries(textbookResources.flatMap((resource) => resource.width && resource.height
          ? [[resource.id, { width: resource.width, height: resource.height }]] : [])),
        resourceSequences: Object.fromEntries(textbookResources.flatMap((resource) =>
          resource.orderedSteps?.length ? [[resource.id, resource.orderedSteps]] : [])),
      };
      input.teachingExplanationNodes = capacityOptions.explanationNodes;
      const sourceSequenceContracts = [
        ...textbookResources.filter((resource) => resource.required && resource.orderedSteps?.length).map((resource) => ({
          resourceId: resource.id, required: true, knowledgePointIds: resource.knowledgePointIds,
          orderedSteps: resource.orderedSteps, scope: 'single-page' as const,
        })),
        ...resolveCourseSourceSequenceContracts(completeEvidence, course.content.knowledgePoints),
      ];
      const selected = sectionId ? source.filter((page) => page.lectureSectionId === sectionId) : source;
      if (!selected.length) throw new Error('快照不含请求的小节');
      const assessments = [];
      for (const page of selected.filter((page) => page.type === 'slide')) assessments.push(await evaluateSemanticPageCapacity(page, capacityOptions));
      await writeJson(path.join(folder, 'capacity-before.json'), assessments);
      if (!generate) {
        results.push({ jobId: job.id, mode: 'measurement', modelCalls: 0, pagesMeasured: assessments.length,
          decisions: assessments.map((item) => ({ id: item.outlineId, decision: item.decision, reason: item.reason })) });
        continue;
      }
      const restoredStages: string[] = [], savedStages: string[] = [];
      const modelAttempts: Array<{ pageId: string; stage: string; attempts: number }> = [];
      const events: unknown[] = [];
      let finalOutlines = source;
      let lastProgress = '';
      const validatePlan = (outlines: SceneOutline[]) => {
        const before = durationBySection(original), after = durationBySection(outlines);
        for (const [id, seconds] of before) if (after.get(id) !== seconds) throw new Error(`小节 ${id} 时长预算发生变化`);
        for (const page of source.filter((item) => item.type === 'slide')) {
          const section = outlines.filter((item) => item.type === 'slide' && item.lectureSectionId === page.lectureSectionId);
          const visible = section.flatMap((item) => [...(item.keyPoints ?? []), ...(item.teachingBrief?.teachingPlan?.visibleContent ?? []),
            item.visualIntent?.diagram?.annotation ?? '']);
          const normalized = (value: string) => value.replace(/[\s\p{P}\p{S}]/gu, '');
          const required = canonicalVisibleContent({ required: page.keyPoints, inherited: page.teachingBrief?.teachingPlan?.visibleContent });
          for (const point of required) {
            if (visible.some((item) => normalized(item).includes(normalized(point)))) continue;
            const claims = section.flatMap((item) => item.semanticSourceClaims ?? []);
            const claim = claims.find((item) => item.text === point && item.parts.join('') === point);
            if (claim) {
              let cursor = 0;
              const text = visible.map(normalized).join('\n');
              if (claim.parts.every((part) => {
                const index = text.indexOf(normalized(part), cursor);
                if (index < 0) return false;
                cursor = index + normalized(part).length;
                return true;
              })) continue;
            }
            throw new Error(`小节 ${page.lectureSectionId} 遗漏已确认教学内容：${point}`);
          }
          const diagram = page.visualIntent?.diagram;
          if (diagram && !section.some((item) => {
            const current = item.visualIntent?.diagram;
            return current?.topology === diagram.topology && current.annotation === diagram.annotation
              && fingerprintGenerationValue(current.nodes) === fingerprintGenerationValue(diagram.nodes)
              && fingerprintGenerationValue(current.edges) === fingerprintGenerationValue(diagram.edges)
              && (!diagram.sequenceGroups || fingerprintGenerationValue(current.sequenceGroups) === fingerprintGenerationValue(diagram.sequenceGroups));
          })) throw new Error(`小节 ${page.lectureSectionId} 遗漏或改动了完整图示关系`);
          const mediaIds = new Set(section.flatMap((item) => [
            ...(item.mediaGenerations ?? []).map((asset) => asset.elementId),
            ...(item.visualIntent?.resourceRefs ?? []).map((asset) => asset.resourceId),
          ]));
          if ([...(page.mediaGenerations ?? []).map((asset) => asset.elementId),
            ...(page.visualIntent?.resourceRefs ?? []).map((asset) => asset.resourceId)].some((id) => !mediaIds.has(id))) {
            throw new Error(`小节 ${page.lectureSectionId} 遗漏已确认媒体`);
          }
        }
      };
      let responseIndex = 0;
      const options: GenerateClassroomOptions = {
        onAuthoringResponse: async (response) => {
          const index = ++responseIndex;
          const source = response.source.replace(/[^a-zA-Z0-9_-]/g, '-');
          await writeJson(path.join(folder, 'model-responses', `${String(index).padStart(3, '0')}-${source}.json`), response);
        },
        ...(sectionId ? { generationOutlineIds: selected.map((page) => page.id) } : {}),
        preparedOutlines,
        sourceEvidence: completeEvidence,
        sourceKnowledgePoints: course.content.knowledgePoints,
        sourceSequenceContracts,
        hasSceneContentCheckpoint: (outline, modelFingerprint) => {
          const stage = checkpoints.get(`stage:${outline.id}:content`) as SceneStageCheckpointSnapshot | undefined;
          const page = checkpoints.get(`page:${outline.id}`) as PageCheckpointSnapshot | undefined;
          const payload = restoreSceneStageCheckpoint({ outline, stage: 'content', checkpoint: stage,
            modelFingerprint, inputFingerprint: stage?.inputFingerprint });
          if (payload && typeof payload === 'object' && 'content' in payload && payload.content
            && typeof payload.content === 'object' && 'elements' in payload.content
            && Array.isArray(payload.content.elements)) return true;
          return Boolean(page && restoreSceneCheckpoint(outline, page, page.scene.stageId, modelFingerprint, page.inputFingerprint));
        },
        loadTeachingSectionCheckpoint: (sectionKey, inputFingerprint, modelFingerprint) => {
          const stored = checkpoints.get(`teaching-section:${sectionKey}`) as {
            inputFingerprint?: string; modelFingerprint?: string; briefs?: Array<[string, unknown]>;
          } | undefined;
          return stored?.inputFingerprint === inputFingerprint && stored.modelFingerprint === modelFingerprint
            && Array.isArray(stored.briefs) ? stored.briefs : null;
        },
        onTeachingSectionCompleted: async (sectionKey, inputFingerprint, modelFingerprint, briefs) => {
          checkpoints.set(`teaching-section:${sectionKey}`, { schemaVersion: 1, sectionKey,
            inputFingerprint, modelFingerprint, briefs });
          await writeJson(path.join(folder, 'teaching-section-checkpoints.json'), [...checkpoints]
            .filter(([key]) => key.startsWith('teaching-section:')));
        },
        sourceRecoveryScenes: restoreCourseFinalizationCheckpoint(checkpoints.get('course-finalization'), input, preparedOutlines)
          ?.generated.scenes,
        validateReplannedOutlines: validatePlan,
        loadSourceContentCheckpoint: (sectionId, sourceFingerprint, inputFingerprint, modelFingerprint) =>
          restoreSourceContentCheckpoint(checkpoints.get(`${SOURCE_CONTENT_CHECKPOINT_PREFIX}${sectionId}`),
            { sectionId, sourceFingerprint, inputFingerprint, modelFingerprint }),
        onSourceContentCheckpoint: async (checkpoint) => {
          checkpoints.set(`${SOURCE_CONTENT_CHECKPOINT_PREFIX}${checkpoint.sectionId}`, checkpoint);
          await writeJson(path.join(folder, 'source-content-checkpoints.json'), [...checkpoints]
            .filter(([key]) => key.startsWith(SOURCE_CONTENT_CHECKPOINT_PREFIX)));
        },
        loadSectionCapacityCheckpoint: (sectionId, sourceFingerprint, inputFingerprint, modelFingerprint) =>
          restoreSectionCapacityCheckpoint(checkpoints.get(`${SECTION_CAPACITY_CHECKPOINT_PREFIX}${sectionId}`),
            { sectionId, sourceFingerprint, inputFingerprint, modelFingerprint }),
        onSectionCapacityCheckpoint: async (checkpoint) => {
          checkpoints.set(`${SECTION_CAPACITY_CHECKPOINT_PREFIX}${checkpoint.sectionId}`, checkpoint);
          await writeJson(path.join(folder, 'section-capacity-checkpoints.json'), [...checkpoints]
            .filter(([key]) => key.startsWith(SECTION_CAPACITY_CHECKPOINT_PREFIX)));
        },
        onOutlinesPrepared: async (outlines) => {
          finalOutlines = outlines;
          validatePlan(outlines);
          checkpoints.set('prepared-outlines', outlines);
          await writeJson(path.join(folder, 'prepared-outlines.json'), outlines);
        },
        onProgress: async (progress) => {
          const key = `${progress.step}:${progress.scenesGenerated}:${progress.stageProgress?.map((stage) => stage.completedPages.length).join(',')}`;
          if (key === lastProgress) return;
          lastProgress = key;
          events.push(progress);
          await writeJson(path.join(folder, 'progress.json'), events);
          console.log(JSON.stringify({ phase: 'page-replay', jobId: job.id, step: progress.step,
            scenesGenerated: progress.scenesGenerated, totalScenes: progress.totalScenes,
            stages: progress.stageProgress?.map((stage) => ({ stage: stage.stage, completed: stage.completedPages.length, failed: stage.failedPages.length })) }));
        },
        loadSceneCheckpoint: (outline, _index, stageId, modelFingerprint, inputFingerprint) => restoreSceneCheckpoint(
          outline, checkpoints.get(`page:${outline.id}`) as PageCheckpointSnapshot | undefined,
          stageId, modelFingerprint, inputFingerprint),
        loadSceneStageCheckpoint: (outline, stage, modelFingerprint, inputFingerprint) => {
          const payload = restoreSceneStageCheckpoint({ outline, stage, modelFingerprint, inputFingerprint,
            checkpoint: checkpoints.get(`stage:${outline.id}:${stage}`) as SceneStageCheckpointSnapshot | undefined });
          if (payload) restoredStages.push(`${outline.id}:${stage}`);
          return payload;
        },
        onSceneStageCompleted: async (outline, stage, payload, modelFingerprint, inputFingerprint) => {
          const key = `stage:${outline.id}:${stage}`;
          checkpoints.set(key, { schemaVersion: 1, pageKey: outline.id, stage, outlineFingerprint: fingerprintSceneOutline(outline),
            modelFingerprint, inputFingerprint, payload });
          savedStages.push(key);
          await writeJson(path.join(folder, 'stage-checkpoints.json'), [...checkpoints].filter(([key]) => key.startsWith('stage:')));
        },
        loadSceneStageAttemptCount: async (outline, stage, modelFingerprint, inputFingerprint, legacyInputFingerprint) => {
          const key = `stage-attempt:${outline.id}:${stage}`;
          const stored = checkpoints.get(key) as SceneStageAttemptSnapshot | undefined;
          const migrated = migrateSceneStageAttemptInputFingerprint({ outline, stage, modelFingerprint, inputFingerprint,
            legacyInputFingerprint, checkpoint: stored });
          if (migrated) {
            checkpoints.set(key, migrated);
            await writeJson(path.join(folder, 'stage-attempt-checkpoints.json'), [...checkpoints]
              .filter(([step]) => step.startsWith('stage-attempt:')));
          }
          return restoreSceneStageAttemptCount({ outline, stage, modelFingerprint, inputFingerprint,
            checkpoint: migrated ?? stored });
        },
        onSceneStageAttempt: async (outline, stage, attempts, modelFingerprint, inputFingerprint) => {
          modelAttempts.push({ pageId: outline.id, stage, attempts });
          checkpoints.set(`stage-attempt:${outline.id}:${stage}`, { schemaVersion: 1, pageKey: outline.id, stage,
            outlineFingerprint: fingerprintSceneOutline(outline), modelFingerprint, inputFingerprint, attemptsStarted: attempts, status: 'started' });
          await writeJson(path.join(folder, 'model-attempts.json'), modelAttempts);
        },
        onSceneStageAttemptSettled: async (outline, stage, attempts, outcome, modelFingerprint, inputFingerprint) => {
          const key = `stage-attempt:${outline.id}:${stage}`;
          const existing = checkpoints.get(key) as SceneStageAttemptSnapshot | undefined;
          if (existing && existing.attemptsStarted === attempts && existing.modelFingerprint === modelFingerprint
            && existing.inputFingerprint === inputFingerprint && existing.outlineFingerprint === fingerprintSceneOutline(outline)) {
            checkpoints.set(key, { ...existing, status: outcome });
          }
          await writeJson(path.join(folder, 'stage-attempt-checkpoints.json'), [...checkpoints]
            .filter(([step]) => step.startsWith('stage-attempt:')));
        },
        onSceneCompleted: async (outline, scene, _index, modelFingerprint, inputFingerprint) => {
          checkpoints.set(`page:${outline.id}`, { schemaVersion: 1, pageKey: outline.id, scene,
            outlineFingerprint: fingerprintSceneOutline(outline), modelFingerprint, inputFingerprint });
          await writeJson(path.join(folder, 'scene-checkpoints.json'), [...checkpoints].filter(([key]) => key.startsWith('page:')));
        },
      };
      try {
        const generated = await generateClassroom(input, options);
        await writeJson(path.join(folder, 'classroom.json'), generated);
        const sourceIssues = findFinalizedSourceContentIssues(generated.assetContext.outlines,
          generated.scenes, sourceSequenceContracts);
        await writeJson(path.join(folder, 'source-content-audit.json'), { issues: sourceIssues,
          contracts: sourceSequenceContracts, scope: '实际采用的完整条目、原图步骤与真实输出；不以计划或元数据代替输出' });
        if (sourceIssues.length) throw new Error(`课堂实际来源内容不完整：${sourceIssues.map((issue) => issue.detail).join('；')}`);
        const audits = [];
        for (const scene of generated.scenes) {
          if (scene.content.type !== 'slide') continue;
          const audit = await auditSlideLayout({ ...scene.content.canvas, elements: scene.content.canvas.elements }, scene.outlineId ?? scene.id);
          if (audit.status !== 'checked') throw new Error(`页面真实渲染未验证：${audit.reason}`);
          const severe = (audit.findings ?? []).filter((finding) => /:(?:overflow|box-overflow|invisible-text|small-type|overlap-|collision-|occluded-)/.test(finding.id));
          audits.push({ sceneId: scene.id, outlineId: scene.outlineId, audit });
          if (severe.length) throw new Error(`页面真实渲染不合格：${severe.map((finding) => finding.evidence).join('; ')}`);
        }
        await writeJson(path.join(folder, 'render-audits.json'), audits);
        results.push({ jobId: job.id, courseId: job.targetId, status: 'validated', originalModel: input.generationModelString,
          sectionId: sectionId ?? null, requestFingerprint: fingerprintGenerationValue(input), scenes: generated.scenesCount,
          renderedSlides: audits.length, restoredStages, savedStages, modelAttempts, sectionBudgetsPreserved: true,
          confirmedVisibleContentDiagramsAndMediaPreserved: true,
          generatedSourceContractsPassed: true, generatedSourceContractCount: sourceSequenceContracts.length,
          finalOutlinesFingerprint: fingerprintGenerationValue(finalOutlines), qualityReport: generated.qualityReport });
      } catch (error) {
        results.push({ jobId: job.id, courseId: job.targetId, status: 'failed', error: safeError(error), restoredStages, savedStages, modelAttempts });
        process.exitCode = 1;
      }
    }
    await writeJson(path.join(output, 'manifest.json'), { completedAt: new Date().toISOString(), databaseAccess: 'read-only',
      productionCourseOrJobWrites: false, modelCallsEnabled: generate,
      classroomSnapshotsDirectory: process.env.CLASSROOM_DATA_DIR,
      snapshots: { jobsSha256: createHash('sha256').update(jobBytes).digest('hex'), checkpointsSha256: createHash('sha256').update(checkpointBytes).digest('hex') },
      limits: '运行真实页面、讲稿和组装链路，校验实际来源条目与步骤以及浏览器文字几何；不发布课堂，不生成图片或配音资产。布局审计按生产规则使用图片占位几何。', results });
    console.log(JSON.stringify({ phase: 'complete', output, results: results.map((result) => ({ jobId: result.jobId, status: result.status, scenes: result.scenes, error: result.error })) }));
  } finally {
    const { closeSpatialMeasurementBrowser } = await import('../src/lib/openmaic/generation/slide-spatial-measurement');
    const { closeSlideLayoutAuditBrowser } = await import('../src/lib/openmaic/generation/slide-layout-audit');
    await closeSpatialMeasurementBrowser();
    await closeSlideLayoutAuditBrowser();
    await prisma.$disconnect();
    if (providerPrisma !== prisma) await providerPrisma.$disconnect();
  }
}

main().catch((error) => { console.error(safeError(error)); process.exitCode = 1; });
