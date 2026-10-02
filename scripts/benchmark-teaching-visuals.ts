/** Isolated design specimens and the 24 × 2 production-model benchmark.
 * NODE_OPTIONS=--conditions=import pnpm exec tsx scripts/benchmark-teaching-visuals.ts \
 *   --mode=samples --output=.openpbl-runtime/teaching-visuals/samples
 * Use --mode=model --deployment-secrets for real production calls. Existing
 * results are never overwritten and no course, narration or audio is saved.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import type { GeneratedSlideContent, PdfImage, SceneOutline } from '../src/lib/openmaic/types/generation';
import type { AICallFn } from '../src/lib/openmaic/generation/pipeline-types';
import type { PblTemplateDesign } from '../src/lib/platform/pbl-template';
import type { Scene } from '../src/lib/openmaic/types/stage';
import { createTeachingVisualBenchmarkCases, type FrozenSlideSample, type VisualBenchmarkCase } from './fixtures/teaching-visual-samples';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map(process.argv.slice(2).map((value) => {
  const [name, ...pieces] = value.replace(/^--/, '').split('=');
  return [name, pieces.join('=') || 'true'];
}));
const sensitive = new Set<string>();
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function json<T>(filename: string): Promise<T> { return JSON.parse(await fs.readFile(filename, 'utf8')) as T; }
function safeError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of sensitive) if (secret) message = message.split(secret).join('[redacted]');
  return message.replace(/(?:postgres(?:ql)?|https?):\/\/[^\s/@]+:[^\s/@]+@/giu, '[redacted-url]@').replace(/Bearer\s+\S+/giu, 'Bearer [redacted]');
}
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(?:apiKey|api_key|secret|password|authorization|cookie|databaseUrl|providerEncryptionKey)$/iu.test(key))
    .map(([key, item]) => [key, redact(item)]));
  if (typeof value === 'string') for (const secret of sensitive) if (secret && value.includes(secret)) return '[redacted]';
  return value;
}
async function save(directory: string, filename: string, value: unknown) {
  const destination = path.join(directory, filename);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, JSON.stringify(redact(value), null, 2) + '\n', { mode: 0o600 });
}
function isolatedPath(value: string): string {
  const resolved = path.resolve(root, value);
  if (!resolved.startsWith(path.join(root, '.openpbl-runtime') + path.sep)) throw new Error('基准输出及快照必须位于 .openpbl-runtime 隔离目录');
  return resolved;
}
export async function deployedReadOnlyEnvironment(): Promise<void> {
  const pid = execFileSync('systemctl', ['--user', 'show', 'openpbl.service', '--property=MainPID', '--value'], { encoding: 'utf8' }).trim();
  if (pid !== '0' && /^\d+$/u.test(pid)) {
    const allowed = new Set(['DATABASE_URL', 'PROVIDER_CONFIG_DATABASE_URL', 'PROVIDER_ENCRYPTION_KEY', 'MODEL_ROUTES', 'DEFAULT_MODEL', 'OPENPBL_OUTBOUND_PROXY', 'PARALLEL_SCENE_CONCURRENCY', 'OPENPBL_SECRET_DIR']);
    for (const entry of (await fs.readFile(`/proc/${pid}/environ`, 'utf8')).split('\0')) {
      const separator = entry.indexOf('=');
      if (allowed.has(entry.slice(0, separator))) process.env[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
  }
  if (args.has('deployment-secrets')) {
    const secretDirectory = process.env.OPENPBL_SECRET_DIR || path.join(root, 'deploy/secrets');
    for (const [name, filename] of [['DATABASE_URL', 'database_url.txt'], ['PROVIDER_ENCRYPTION_KEY', 'provider_encryption_key.txt']]) {
      process.env[name] = (await fs.readFile(path.join(secretDirectory, filename), 'utf8')).trim();
    }
  }
  for (const name of ['DATABASE_URL', 'PROVIDER_CONFIG_DATABASE_URL', 'PROVIDER_ENCRYPTION_KEY']) if (process.env[name]) sensitive.add(process.env[name]!);
  if (!process.env.DATABASE_URL) throw new Error('真实模型基准需要部署只读配置或 --deployment-secrets');
  const { PrismaClient } = await import('@prisma/client');
  const allowedOperations = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy']);
  const client = (databaseUrl?: string) => new PrismaClient({ ...(databaseUrl ? { datasourceUrl: databaseUrl } : {}), log: [] }).$extends({
    query: { $allOperations({ model, operation, args, query }) {
      if (!allowedOperations.has(operation)) throw new Error(`教学视觉基准禁止数据库写入：${model ?? 'raw'}.${operation}`);
      return query(args);
    } },
  }) as unknown as PrismaClient;
  globalThis.__openPblPrisma = client();
  if (process.env.PROVIDER_CONFIG_DATABASE_URL && process.env.PROVIDER_CONFIG_DATABASE_URL !== process.env.DATABASE_URL) {
    globalThis.__openPblProviderPrisma = client(process.env.PROVIDER_CONFIG_DATABASE_URL);
  }
}

const implementationFiles = [
  'packages/@openmaic/dsl/src/teaching-visual.ts',
  'src/lib/openmaic/generation/teaching-visual-compiler.ts',
  'src/lib/openmaic/generation/teaching-visual-scene.ts',
  'src/lib/openmaic/generation/teaching-visual-arithmetic.ts',
  'src/lib/openmaic/generation/teaching-visual-theme.ts',
  'src/lib/openmaic/generation/openmaic-baseline.ts',
  'scripts/benchmark-teaching-visuals.ts',
  'scripts/fixtures/teaching-visual-samples.ts',
  'scripts/fixtures/first-pass-slide-samples.json',
];
async function implementationFingerprint(): Promise<string> {
  const files = await Promise.all(implementationFiles.map(async (filename) => ({ filename, body: await fs.readFile(path.join(root, filename), 'utf8').catch(() => '[not-present]') })));
  return sha(JSON.stringify(files));
}
function contentAudit(content: GeneratedSlideContent | null, sources: Array<{ id: string; text: string }>): unknown {
  if (!content?.elements.length) return { executable: false, contentReview: 'pending', beautyReview: 'pending' };
  const pages = [content, ...(content.continuationPages ?? [])];
  const projectedSources = new Set(pages.flatMap((page) => page.teachingVisual?.components.flatMap((item) => item.sourceContentIds) ?? []));
  const mappedElements = pages.flatMap((page) => page.teachingVisual?.components.flatMap((item) => item.elementIds) ?? []);
  const elements = pages.flatMap((page) => page.elements);
  return {
    executable: true, pageCount: pages.length, types: [...new Set(elements.map((element) => element.type))],
    sourceMapping: sources.map(({ id, text }) => ({ sourceId: id, text, mapped: projectedSources.has(id) })),
    mappedElementsExist: mappedElements.every((id) => elements.some((element) => element.id === id)),
    allPagesHaveVisualMetadata: pages.every((page) => Boolean(page.teachingVisual)),
    contentReview: 'pending', beautyReview: 'pending',
    limitation: '来源ID覆盖只证明追踪关系；不能替代实际事实、教学完整性与美观评审。',
  };
}

async function main(): Promise<void> {
  if (args.has('help')) {
    console.log('--mode=samples|model --output=.openpbl-runtime/新目录 [--snapshot-dir=.openpbl-runtime/slide-redraw/single-pass-20261002/snapshot] [--deployment-secrets] [--ids=case-id,...] [--concurrency=2]');
    return;
  }
  const mode = args.get('mode') ?? 'samples';
  if (!['samples', 'model'].includes(mode)) throw new Error('--mode 只允许 samples 或 model');
  if (!args.get('output')) throw new Error('需要新的 --output 隔离目录');
  const output = isolatedPath(args.get('output')!);
  if (await fs.stat(output).catch(() => null)) throw new Error('输出目录已存在；禁止覆盖原结果或隐式重新调用模型');
  const snapshotDirectory = isolatedPath(args.get('snapshot-dir') ?? '.openpbl-runtime/slide-redraw/single-pass-20261002/snapshot');
  const original = await json<SceneOutline>(path.join(snapshotDirectory, 'outline.json'));
  const snapshot = await json<{ classroomFile: string; classroomSha256: string; originalOutlineSha256: string }>(path.join(snapshotDirectory, 'snapshot.json'));
  if (sha(JSON.stringify(original)) !== snapshot.originalOutlineSha256) throw new Error('第19页大纲快照指纹不匹配');
  const originalClassroomBytes = await fs.readFile(snapshot.classroomFile);
  const sourceInitialHash = sha(originalClassroomBytes);
  const fixtureText = await fs.readFile(path.join(root, 'scripts/fixtures/first-pass-slide-samples.json'), 'utf8');
  const cases = createTeachingVisualBenchmarkCases(JSON.parse(fixtureText) as FrozenSlideSample[], original, path.relative(root, snapshotDirectory));
  if (mode === 'model') cases.push({
    id: 'original-page-19', kind: 'process', sample: false, outline: structuredClone(original),
    scene: { schemaVersion: 1, designVersion: 'teaching-visual-v2', pages: [{ id: original.id, title: original.title,
      focus: original.teachingObjective ?? original.title, components: [{ id: 'original-page-19-input', kind: 'text',
        nodes: original.keyPoints.map((text, index) => ({ id: `original-page-19-point-${index}`, text, sourceContentIds: [`adopted-content-${index + 1}`] })) }] }] },
    source: { kind: 'course-snapshot', title: '人工智能学科教师素养提升（第三章）', reference: path.relative(root, snapshotDirectory), originalPageId: original.id,
      note: '额外真实模型重设计：完整原第19页大纲、实际教材证据及原五环节拓扑；由模型规划1至3页；保留97秒课程责任。未改写原课程。' },
  });
  const selectedIds = args.get('ids')?.split(',');
  if (selectedIds?.some((id) => !cases.some((item) => item.id === id))) throw new Error('--ids 包含未知基准案例');
  const targets = cases.filter((item) => !selectedIds || selectedIds.includes(item.id));
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  process.env.CLASSROOM_DATA_DIR = path.join(output, 'isolated-classrooms');
  await fs.cp(snapshotDirectory, path.join(output, 'source-snapshot'), { recursive: true });
  await save(output, 'fixtures.json', cases);
  const fingerprint = await implementationFingerprint();
  const metadata: Record<string, unknown> = {
    schemaVersion: 1, mode, startedAt: new Date().toISOString(), implementationSha256: fingerprint,
    fixtureSha256: sha(JSON.stringify(cases)), fixedSampleSha256: sha(fixtureText), repetitions: mode === 'model' ? 2 : 1,
    plannedCases: targets.reduce((sum, item) => sum + (mode === 'model' && item.id !== 'original-page-19' ? 2 : 1), 0), fullBenchmarkCases: 48,
    originalPage19AdditionalAttempts: mode === 'model' ? 1 : 0, samplePages: cases.filter((item) => item.sample).length,
    source: snapshotDirectory, sourceScope: '第19页使用真实保存教材来源；其他案例为标记的固定基准示例，非教材原文。',
    sample19: { splitSeconds: [40, 57], totalSeconds: 97, originalDurationSec: original.targetDurationSec, sampleOnly: true, narrationOrAudioGenerated: false },
    courseWrites: 0, narrationCalls: 0, audioCalls: 0, mediaGenerationCalls: 0,
    contentReview: 'pending', beautyReview: 'pending', fullStudentScreenReview: 'not-run', pptxReview: 'not-run', renderReview: 'not-run',
  };
  await save(output, 'metadata.json', metadata);
  const { compileTeachingVisualScene } = await import('../src/lib/openmaic/generation/teaching-visual-compiler');
  const { slideVisualSourceContent } = await import('../src/lib/openmaic/generation/slide-visual-projection');
  const { measureAuthoredSlideText, closeSpatialMeasurementBrowser } = await import('../src/lib/openmaic/generation/slide-spatial-measurement');
  let produce: (target: VisualBenchmarkCase, directory: string) => Promise<GeneratedSlideContent | null>;
  if (mode === 'samples') {
    produce = (target) => compileTeachingVisualScene(target.outline, target.scene, {
      measure: measureAuthoredSlideText, images: target.images, allowSplit: true, sourceCatalog: slideVisualSourceContent(target.outline),
    });
  } else {
    const sourceVersion = await json<{ snapshot: { design: PblTemplateDesign } }>(path.join(snapshotDirectory, 'template.json'));
    const sourceOutlines = await json<SceneOutline[]>(path.join(snapshotDirectory, 'outlines.json'));
    const originalScene = await json<Scene>(path.join(snapshotDirectory, 'original-scene.json'));
    await deployedReadOnlyEnvironment();
    const { initializeServerProviderConfig, resolveServerThinkingConfig } = await import('../src/lib/openmaic/server/provider-config');
    const { resolveModel } = await import('../src/lib/openmaic/server/resolve-model');
    const { createCourseGenerationAiCall, withCourseGenerationAiCallContext } = await import('../src/lib/openmaic/server/course-generation-ai-call');
    const { createCourseOutputBudget, COURSE_OUTPUT_BUDGET_VERSION, resolveCourseExecutionBudgetOptions } = await import('../src/lib/openmaic/generation/course-output-budget');
    const { runWithCourseGenerationLlmContext } = await import('../src/lib/course-generation/llm-concurrency');
    const { generateOpenMaicBaselineContent } = await import('../src/lib/openmaic/generation/openmaic-baseline');
    const { parseTeachingVisualScene } = await import('../src/lib/openmaic/generation/teaching-visual-scene');
    const { withTeachingSlideGuidance } = await import('../src/lib/openmaic/generation/teaching-narration');
    const { resolveLlmRequestTimeoutMs } = await import('../src/lib/llm/request-policy');
    const sourceSequenceContracts = await json<NonNullable<Parameters<typeof generateOpenMaicBaselineContent>[2]>['sourceSequenceContracts']>(path.join(snapshotDirectory, 'source-sequence-contracts.json'));
    await initializeServerProviderConfig();
    const model = await resolveModel({ stage: 'generate-classroom' });
    sensitive.add(model.apiKey);
    const thinking = resolveServerThinkingConfig(model.providerId, 'scene-content') ?? model.thinkingConfig;
    metadata.policy = { modelString: model.modelString, thinking, outputWindow: model.modelInfo?.outputWindow, budgetPolicy: COURSE_OUTPUT_BUDGET_VERSION, route: 'generate-classroom', unchangedProductionBudget: true };
    await save(output, 'metadata.json', metadata);
    produce = async (target, directory) => {
      const policies: unknown[] = [], usage: unknown[] = [], failures: unknown[] = [];
      const calls: Array<{ systemSha256: string; prompt: string; imageCount: number; response?: string; error?: string; elapsedMs: number }> = [];
      let responseIndex = 0;
      const aiCall = createCourseGenerationAiCall({
        model: model.model, vision: model.modelInfo?.capabilities?.vision === true, source: 'scene-content', thinking,
        outputBudget: createCourseOutputBudget({ resource: 'slide', modelOutputWindow: model.modelInfo?.outputWindow, thinking }),
        timeoutMs: resolveLlmRequestTimeoutMs('long-generation'), executionBudget: resolveCourseExecutionBudgetOptions(),
        maxRetries: 1, streamResponse: true, responseFormat: 'json', requireResponsePersistence: true,
        onResponse: (response) => save(directory, `raw/${String(++responseIndex).padStart(3, '0')}.json`, response),
      });
      const tracked: AICallFn = async (system, prompt, images) => {
        const started = Date.now();
        const record: typeof calls[number] = { systemSha256: sha(system), prompt, imageCount: images?.length ?? 0, elapsedMs: 0 };
        calls.push(record);
        try {
          record.response = await withCourseGenerationAiCallContext(aiCall, { onStarted: (event) => { policies.push(event); } })(system, prompt, images);
          return record.response;
        } catch (error) {
          record.error = safeError(error);
          throw error;
        } finally {
          record.elapsedMs = Date.now() - started;
          await save(directory, 'calls.json', calls);
        }
      };
      try {
        const content = await runWithCourseGenerationLlmContext(() => generateOpenMaicBaselineContent(target.outline,
          withTeachingSlideGuidance(tracked, target.outline), {
            visualProjection: true, teachingVisual: true, componentAuthoring: true, slideAuthoring: 'native', textMeasure: measureAuthoredSlideText,
            assignedImages: target.images?.map((image): PdfImage => ({ ...image, pageNumber: 1, description: image.caption, sourceTitle: target.source.title, required: true })),
            imageMapping: Object.fromEntries((target.images ?? []).map((image) => [image.id, image.src])), visionEnabled: model.modelInfo?.capabilities?.vision === true,
            languageDirective: target.outline.courseLanguageDirective,
            ...(target.source.kind === 'course-snapshot' ? { sourceEvidence: sourceVersion.snapshot.design.content.courseEvidence,
              sourceKnowledgePoints: sourceVersion.snapshot.design.content.knowledgePoints, sourceSequenceContracts } : {}),
            ...(target.id === 'original-page-19' && originalScene.content.type === 'slide' ? { visualBaseline: originalScene.content.canvas } : {}),
            websiteReferenceContext: target.id === 'original-page-19'
              ? { courseTitle: sourceVersion.snapshot.design.name, slideTitles: sourceOutlines.filter((page) => page.type === 'slide').map((page) => page.title) }
              : { courseTitle: '教学图解24例固定基准', slideTitles: cases.filter((item) => item.id !== 'original-page-19').map((item) => item.outline.title) },
            onFailure: (failure) => failures.push(failure),
          }), { onCallUsage: async (call) => { usage.push(call); await save(directory, 'usage.json', usage); } });
        if (calls[0]?.response) {
          try {
            const firstScene = parseTeachingVisualScene(calls[0].response);
            firstScene.pages.forEach((page, index) => { page.id = index ? `${target.outline.id}:visual-${index + 1}` : target.outline.id; });
            await save(directory, 'first-scene.json', firstScene);
            const first = await compileTeachingVisualScene(target.outline, firstScene, {
              measure: measureAuthoredSlideText, images: target.images, allowSplit: true, sourceCatalog: slideVisualSourceContent(target.outline),
            });
            await save(directory, 'first-content.json', first);
          } catch (error) { await save(directory, 'first-preparation-error.json', { error: safeError(error), rawResponsePreserved: true }); }
        }
        if (!content || !('elements' in content)) return null;
        return content;
      } finally {
        await save(directory, 'policies.json', policies);
        await save(directory, 'diagnostics.json', failures);
        await save(directory, 'usage.json', usage);
        await save(directory, 'calls.json', calls);
      }
    };
  }
  const tasks = targets.flatMap((target) => Array.from({ length: mode === 'model' && target.id !== 'original-page-19' ? 2 : 1 }, (_, index) => ({ target, repetition: index + 1 })));
  const reports: Array<Record<string, unknown>> = [];
  let progressWrite = Promise.resolve();
  const concurrency = mode === 'samples' ? 1 : Math.max(1, Math.min(5, Number(args.get('concurrency') ?? 2)));
  if (!Number.isInteger(concurrency)) throw new Error('--concurrency 必须是1到5的整数');
  try {
    const queue = [...tasks];
    await Promise.all(Array.from({ length: concurrency }, async () => {
      let task: typeof tasks[number] | undefined;
      while ((task = queue.shift())) {
        const { target, repetition } = task;
        const id = `${target.id}-${repetition}`;
        const directory = path.join(output, 'attempts', id);
        const started = Date.now();
        await save(directory, 'input.json', { target, repetition, implementationSha256: fingerprint });
        let result: Record<string, unknown>;
        try {
          const content = await produce(target, directory);
          const first = await json<GeneratedSlideContent | null>(path.join(directory, 'first-content.json')).catch(() => undefined);
          const calls = await json<Array<{ response?: string; error?: string }>>(path.join(directory, 'calls.json')).catch(() => []);
          result = { id, caseId: target.id, kind: target.kind, sample: target.sample, repetition, status: content?.elements.length ? 'completed' : 'failed',
            elapsedMs: Date.now() - started, source: target.source, final: content, first, audit: contentAudit(content, slideVisualSourceContent(target.outline)),
            qualityDiagnostics: content?.qualityDiagnostics ?? [], model: mode === 'model', contentReview: 'pending', beautyReview: 'pending',
            attemptClassification: { providerCalls: calls.length, firstResponsePrepared: Boolean(first?.elements.length),
              localRepairOrFallbackDiagnostics: content?.qualityDiagnostics?.filter((detail) => /fallback|回退|replan|重规划|split|拆页|原稿|repair|修复/iu.test(detail)) ?? [],
              limitation: '质量提示和模型调用数量完整记录；仍需核对场景与首稿差异，不能只凭提示数量判定质量通过。' } };
        } catch (error) {
          result = { id, caseId: target.id, kind: target.kind, sample: target.sample, repetition, status: 'failed', elapsedMs: Date.now() - started, error: safeError(error), model: mode === 'model' };
        }
        await save(output, `results/${id}.json`, result);
        reports.push({ id, caseId: target.id, kind: target.kind, sample: target.sample, repetition, status: result.status, elapsedMs: result.elapsedMs, error: result.error, audit: result.audit });
        const progress = { planned: tasks.length, complete: reports.length, completed: reports.filter((item) => item.status === 'completed').length, failed: reports.filter((item) => item.status === 'failed').length, reports: [...reports] };
        progressWrite = progressWrite.then(() => save(output, 'progress.json', progress));
        await progressWrite;
        console.log(JSON.stringify({ id, status: result.status, elapsedMs: result.elapsedMs, error: result.error }));
      }
    }));
  } finally {
    await closeSpatialMeasurementBrowser();
    await globalThis.__openPblPrisma?.$disconnect();
    if (globalThis.__openPblProviderPrisma !== globalThis.__openPblPrisma) await globalThis.__openPblProviderPrisma?.$disconnect();
    const unchanged = sha(await fs.readFile(snapshot.classroomFile)) === sourceInitialHash;
    const implementationUnchanged = fingerprint === await implementationFingerprint();
    await save(output, 'source-preservation.json', { originalClassroomUnchanged: unchanged, sourceSnapshotMatchedAtStart: sourceInitialHash === snapshot.classroomSha256, implementationUnchanged, originalClassroomFile: snapshot.classroomFile });
    await save(output, 'summary.json', { ...metadata, finishedAt: new Date().toISOString(), attempted: reports.length,
      completed: reports.filter((item) => item.status === 'completed').length, failed: reports.filter((item) => item.status === 'failed').length,
      originalClassroomUnchanged: unchanged, implementationUnchanged,
      all48ModelAttemptsRun: mode === 'model' && reports.filter((item) => item.caseId !== 'original-page-19').length === 48,
      originalPage19AdditionalAttemptRun: mode === 'model' && reports.some((item) => item.caseId === 'original-page-19'), reports });
    if (!unchanged || !implementationUnchanged) throw new Error('原课堂或实现指纹在运行期间变化；保留结果，不能声称完整同版本验证');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(safeError(error)); process.exitCode = 1; })
  .finally(async () => {
    await globalThis.__openPblPrisma?.$disconnect();
    if (globalThis.__openPblProviderPrisma !== globalThis.__openPblPrisma) await globalThis.__openPblProviderPrisma?.$disconnect();
  });
