/** Approved-reference acceptance through the production generation path.
 * Default --mode=prepare makes no model call. After protocol/compiler freeze:
 * NODE_OPTIONS=--conditions=import pnpm exec tsx scripts/benchmark-approved-teaching-visuals.ts
 *   --mode=model --output=.openpbl-runtime/approved-visuals/new-run --deployment-secrets
 * --mode=replay --input=<saved-model-run> uses all saved first responses only.
 * --case-set=course selects four unchanged source-course slides (15/16/18/22).
 * No audio, source course/DB writes, deployment, or handwritten visual scenes.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GeneratedSlideContent, SceneOutline } from '../src/lib/openmaic/types/generation';
import type { AICallFn } from '../src/lib/openmaic/generation/pipeline-types';
import type { Scene } from '../src/lib/openmaic/types/stage';
import type { PblTemplateDesign } from '../src/lib/platform/pbl-template';
import { deployedReadOnlyEnvironment } from './benchmark-teaching-visuals';
import { createApprovedVisualInputs, type ApprovedVisualInput } from './fixtures/approved-teaching-visual-inputs';
import { createApprovedCourseVisualInputs, type ApprovedCourseVisualInput, type CourseVisualImage } from './fixtures/approved-course-visual-inputs';
import type { FrozenSlideSample } from './fixtures/teaching-visual-samples';
import type { PdfImage } from '../src/lib/openmaic/types/generation';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map(process.argv.slice(2).map((arg) => { const [key, ...values] = arg.replace(/^--/, '').split('='); return [key, values.join('=') || 'true']; }));
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const secrets = new Set<string>();
type BenchmarkInput = ApprovedVisualInput | ApprovedCourseVisualInput;
const isCourseInput = (input: BenchmarkInput): input is ApprovedCourseVisualInput => 'coursePage' in input;
async function json<T>(filename: string): Promise<T> { return JSON.parse(await fs.readFile(filename, 'utf8')) as T; }
function safe(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) message = message.split(secret).join('[redacted]');
  return message.replace(/(?:postgres(?:ql)?|https?):\/\/[^\s/@]+:[^\s/@]+@/giu, '[redacted-url]@').replace(/Bearer\s+\S+/giu, 'Bearer [redacted]');
}
async function save(directory: string, filename: string, value: unknown): Promise<void> {
  const target = path.join(directory, filename); await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(value, (key, item) => {
    if (/^(?:apiKey|api_key|secret|password|authorization|cookie|databaseUrl|providerEncryptionKey)$/iu.test(key)) return undefined;
    if (typeof item === 'string') for (const secret of secrets) if (secret && item.includes(secret)) return '[redacted]';
    return item;
  }, 2) + '\n', { mode: 0o600 });
}
function isolated(value: string): string {
  const result = path.resolve(root, value);
  if (!result.startsWith(path.join(root, '.openpbl-runtime') + path.sep)) throw new Error('所有输入输出必须位于 .openpbl-runtime');
  return result;
}

/** Seal the already adopted file bytes into this isolated run. No fetch,
 * transcode, image generation or database mutation is involved. Replay reads
 * only its saved data URI and verifies the original asset digest. */
async function sealCourseImages(inputs: BenchmarkInput[], replay: boolean): Promise<Array<{ filename: string; sha256: string }>> {
  const sourceFiles: Array<{ filename: string; sha256: string }> = [];
  const uploadDirectory = path.resolve(root, process.env.UPLOAD_DIR?.trim() || '.openpbl-data/uploads');
  for (const target of inputs.filter(isCourseInput)) {
    target.images = await Promise.all(target.images.map(async (image): Promise<CourseVisualImage> => {
      let bytes: Buffer;
      if (replay) {
        const encoded = image.src.match(/^data:image\/[^;,]+;base64,([\s\S]+)$/u);
        if (!encoded || !image.bytesSha256) throw new Error(`回放缺少已封存的原教材图片：${image.id}`);
        bytes = Buffer.from(encoded[1]!, 'base64');
        if (sha(bytes) !== image.bytesSha256) throw new Error(`回放原教材图片字节变更：${image.id}`);
      } else {
        const assetId = image.originalSrc.match(/^\/api\/uploads\/([\da-f-]{36})$/iu)?.[1];
        if (!assetId || image.assetId && image.assetId !== assetId) throw new Error(`原教材图片身份无法核对：${image.id}`);
        const filenames = (await fs.readdir(uploadDirectory)).filter((name) => name.startsWith(`${assetId}.`)
          && /\.(?:jpe?g|png|webp|gif|avif)$/iu.test(name));
        if (filenames.length !== 1) throw new Error(`找不到唯一的原教材图片文件：${assetId}`);
        const filename = path.join(uploadDirectory, filenames[0]!);
        bytes = await fs.readFile(filename);
        sourceFiles.push({ filename, sha256: sha(bytes) });
      }
      const sharp = (await import('sharp')).default, metadata = await sharp(bytes).metadata();
      const mimeType = ({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' } as Record<string, string>)[metadata.format ?? ''];
      const rotated = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
      const width = rotated ? metadata.height : metadata.width, height = rotated ? metadata.width : metadata.height;
      if (!mimeType || !width || !height) throw new Error(`无法读取原教材图片真实尺寸：${image.id}`);
      if (replay && (image.width !== width || image.height !== height || image.mimeType !== mimeType)) throw new Error(`封存图片尺寸或格式不一致：${image.id}`);
      return { ...image, src: `data:${mimeType};base64,${bytes.toString('base64')}`, width, height, mimeType, bytesSha256: sha(bytes) };
    }));
  }
  return sourceFiles;
}

function courseBaseline(target: ApprovedCourseVisualInput, classroom: { id: string; scenes: Scene[] }): GeneratedSlideContent {
  const scene = classroom.scenes.find((candidate) => candidate.id === target.coursePage.sceneId
    && (candidate.outlineId === target.outline.id || candidate.id === target.outline.id));
  if (classroom.id !== target.coursePage.classroomId || !scene || scene.content.type !== 'slide') throw new Error(`原稿与课程页面身份不匹配：${target.id}`);
  const baseline = structuredClone(scene.content.canvas);
  baseline.elements = baseline.elements.map((element) => {
    if (element.type !== 'image') return element;
    const image = target.images.find((candidate) => candidate.originalSrc === element.src && candidate.originalElementIds.includes(element.id));
    if (!image) throw new Error(`原稿图片缺少原字节映射：${element.id}`);
    return { ...element, src: image.src };
  });
  return baseline;
}
async function implementationManifest(): Promise<Array<{ filename: string; sha256: string }>> {
  // Include newly introduced semantic glyph helpers automatically. Tests and
  // old runtime reports do not change the implementation-under-test hash.
  const teachingFiles = (await fs.readdir(path.join(root, 'src/lib/openmaic/generation')))
    .filter((name) => name.startsWith('teaching-visual-') && name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => `src/lib/openmaic/generation/${name}`);
  const files = [...teachingFiles,
    'packages/@openmaic/dsl/src/teaching-visual.ts', 'packages/@openmaic/dsl/src/index.ts', 'packages/@openmaic/dsl/src/slides.ts',
    'packages/@openmaic/generation/src/diagram-compiler.ts', 'packages/@openmaic/generation/src/outline-types.ts',
    'src/lib/openmaic/generation/openmaic-baseline.ts', 'src/lib/openmaic/generation/scene-generator.ts',
    'src/lib/openmaic/generation/adopted-diagram-plan.ts', 'src/lib/openmaic/generation/scene-builder.ts',
    'src/lib/openmaic/generation/teaching-narration.ts', 'src/lib/openmaic/generation/slide-visual-projection.ts',
    'src/lib/openmaic/generation/compiled-slide-pages.ts', 'src/lib/openmaic/generation/slide-infographic-layout.ts',
    'src/lib/openmaic/generation/slide-layout-audit.ts', 'src/lib/openmaic/generation/slide-spatial-measurement.ts',
    'src/lib/openmaic/generation/slide-spatial-types.ts',
    'scripts/benchmark-approved-teaching-visuals.ts', 'scripts/fixtures/approved-teaching-visual-inputs.ts', 'scripts/fixtures/approved-course-visual-inputs.ts',
    'scripts/approved-visual-render-inspection.ts', 'scripts/teaching-visual-acceptance-render.tsx',
    'scripts/render-teaching-visuals.mjs', 'scripts/verify-teaching-visual-student.mjs', 'scripts/audit-approved-teaching-visuals.mjs',
    'scripts/benchmark-teaching-visuals.ts', 'scripts/fixtures/teaching-visual-samples.ts', 'scripts/fixtures/first-pass-slide-samples.json'];
  return Promise.all([...new Set(files)].sort().map(async (filename) => ({ filename, sha256: sha(await fs.readFile(path.join(root, filename))) })));
}
function classify(content: GeneratedSlideContent | null, outline: SceneOutline, previous?: GeneratedSlideContent): string {
  if (!content?.elements.length) return 'technical-failure';
  if (previous && !content.continuationPages?.length && JSON.stringify(content.elements) === JSON.stringify(previous.elements)) return 'retained-previous-draft';
  const diagnostics = content.qualityDiagnostics ?? [];
  if (diagnostics.some((item) => /source quality|source.*fallback|literal.*fallback/iu.test(item))) return 'literal-source-fallback';
  if (!content.teachingVisual) return 'native-complete-draft-fallback';
  if (content.teachingVisual.components.some((component) => component.id.endsWith(':original-content'))) return 'literal-source-fallback';
  const kinds = content.teachingVisual.scene.pages.flatMap((page) => page.components.map((component) => component.kind));
  if (kinds.every((kind) => kind === 'text')) return 'model-text-scene-adopted';
  if (content.teachingVisual.scene.pages.every((page) => page.components.every((component) => component.id.startsWith('original-source:')))) return 'literal-source-fallback';
  if (content.teachingVisual.pageId !== outline.id && !content.continuationPages?.length) return 'visual-scene-with-noncanonical-page-id';
  return 'model-visual-scene-adopted';
}

async function main(): Promise<void> {
  const mode = args.get('mode') ?? 'prepare';
  if (!['prepare', 'model', 'replay'].includes(mode) || !args.get('output')) throw new Error('需要 --mode=prepare|model|replay 和新的 --output');
  const output = isolated(args.get('output')!);
  if (await fs.stat(output).catch(() => null)) throw new Error('输出已存在，禁止覆盖结果或隐式重发模型');
  const replayInput = mode === 'replay' ? isolated(args.get('input') ?? '') : undefined;
  const replayMetadata = replayInput ? await json<{ caseSet?: string }>(path.join(replayInput, 'metadata.json')) : undefined;
  const caseSet = args.get('case-set') ?? replayMetadata?.caseSet ?? 'reference';
  if (!['reference', 'course'].includes(caseSet) || replayInput && caseSet !== (replayMetadata?.caseSet ?? 'reference')) throw new Error('需要 --case-set=reference|course，回放必须保持原案例集');
  const snapshotDirectory = replayInput ? path.join(replayInput, 'source-snapshot')
    : isolated(args.get('snapshot-dir') ?? '.openpbl-runtime/slide-redraw/single-pass-20261002/snapshot');
  const referenceDirectory = isolated(args.get('reference') ?? '.openpbl-runtime/slide19-design-review-20261002-v1');
  const snapshot = await json<{ courseId: string; classroomId: string; classroomFile: string; classroomSha256: string; originalOutlineSha256: string }>(path.join(snapshotDirectory, 'snapshot.json'));
  const original = await json<SceneOutline>(path.join(snapshotDirectory, 'outline.json'));
  const originalScene = await json<Scene>(path.join(snapshotDirectory, 'original-scene.json'));
  const classroomBytes = await fs.readFile(snapshot.classroomFile);
  if (sha(classroomBytes) !== snapshot.classroomSha256 || sha(JSON.stringify(original)) !== snapshot.originalOutlineSha256) throw new Error('源19原课/大纲身份变更，不能用旧输入验证');
  const sourceFiles = ['snapshot.json', 'outline.json', 'original-scene.json', 'outlines.json', 'template.json', 'source-sequence-contracts.json',
    ...(caseSet === 'course' ? ['original-classroom.json', 'request.json'] : [])];
  const sourceFingerprint = async () => sha(JSON.stringify(await Promise.all(sourceFiles.map(async (filename) => ({ filename, sha256: sha(await fs.readFile(path.join(snapshotDirectory, filename))) })))));
  const sourceInitialHash = await sourceFingerprint();
  const frozen = await json<FrozenSlideSample[]>(path.join(root, 'scripts/fixtures/first-pass-slide-samples.json'));
  const sourceVersion = await json<{ snapshot: { design: PblTemplateDesign } }>(path.join(snapshotDirectory, 'template.json'));
  const sourceOutlines = await json<SceneOutline[]>(path.join(snapshotDirectory, 'outlines.json'));
  const sourceSequenceContracts = await json<NonNullable<Parameters<typeof import('../src/lib/openmaic/generation/openmaic-baseline').generateOpenMaicBaselineContent>[2]>['sourceSequenceContracts']>(path.join(snapshotDirectory, 'source-sequence-contracts.json'));
  const courseClassroom = caseSet === 'course' ? await json<{ id: string; stage: { id: string }; scenes: Scene[] }>(path.join(snapshotDirectory, 'original-classroom.json')) : undefined;
  const courseRequest = caseSet === 'course' ? await json<{ courseId: string; textbookImages?: PdfImage[] }>(path.join(snapshotDirectory, 'request.json')) : undefined;
  if (courseClassroom && (courseClassroom.id !== snapshot.classroomId || courseRequest?.courseId !== snapshot.courseId
    || JSON.stringify(courseClassroom) !== JSON.stringify(JSON.parse(classroomBytes.toString('utf8'))))) throw new Error('课程快照、保存课堂与请求身份不一致');
  const sourceOptions = { sourceEvidence: sourceVersion.snapshot.design.content.courseEvidence,
    sourceKnowledgePoints: sourceVersion.snapshot.design.content.knowledgePoints, sourceSequenceContracts };
  const expectedCourseInputs = courseClassroom ? createApprovedCourseVisualInputs({ courseId: snapshot.courseId,
    classroom: courseClassroom, outlines: sourceOutlines, textbookImages: courseRequest?.textbookImages ?? [], sources: sourceOptions,
    snapshotReference: path.relative(root, snapshotDirectory) }) : undefined;
  const inputs: BenchmarkInput[] = replayInput ? await json<BenchmarkInput[]>(path.join(replayInput, 'fixtures.json'))
    : expectedCourseInputs ?? createApprovedVisualInputs(original, frozen, path.relative(root, snapshotDirectory));
  if (expectedCourseInputs && (inputs.length !== expectedCourseInputs.length || inputs.some((item) => {
    const expected = expectedCourseInputs.find((candidate) => candidate.id === item.id);
    return !expected || !isCourseInput(item) || JSON.stringify(item.outline) !== JSON.stringify(expected.outline)
      || JSON.stringify(item.coursePage) !== JSON.stringify(expected.coursePage)
      || JSON.stringify(item.images.map((image) => [image.id, image.originalSrc, image.originalElementIds]))
        !== JSON.stringify(expected.images.map((image) => [image.id, image.originalSrc, image.originalElementIds]));
  }))) throw new Error('真实课程案例改变了原大纲、所属课堂或媒体身份');
  const sourceAssetFiles = await sealCourseImages(inputs, Boolean(replayInput));
  if (inputs.some((item) => 'scene' in item || 'elements' in item)) throw new Error('实际生成输入不得包含手工视觉场景或元素');
  // A subset model run still saves the complete fixture catalog. Replay the
  // cases actually attempted in that run, not fixtures without a response.
  const selected = args.get('ids')?.split(',') ?? (replayInput
    ? (await json<{ reports: Array<{ caseId: string }> }>(path.join(replayInput, 'summary.json'))).reports.map((report) => report.caseId)
    : undefined);
  if (selected?.some((id) => !inputs.some((item) => item.id === id))) throw new Error('未知验证案例');
  const targets = inputs.filter((item) => !selected || selected.includes(item.id));
  if (!targets.length || targets.length > 8) throw new Error('首批最多8例');
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  await fs.cp(snapshotDirectory, path.join(output, 'source-snapshot'), { recursive: true });
  process.env.CLASSROOM_DATA_DIR = path.join(output, 'isolated-classrooms');
  await save(output, 'fixtures.json', inputs);
  if (courseClassroom) {
    const { pageOriginalTeachingSources } = await import('../src/lib/openmaic/generation/source-grounding');
    const { slideVisualSourceContent } = await import('../src/lib/openmaic/generation/slide-visual-projection');
    for (const target of inputs.filter(isCourseInput)) {
      // Ensure every original media element also survives the usable fallback.
      courseBaseline(target, courseClassroom);
      await save(output, `prepared-sources/${target.id}.json`, { source: target.source, originalOutline: target.outline,
        adoptedDisplayContent: slideVisualSourceContent(target.outline), originalTeachingSources: pageOriginalTeachingSources(target.outline, sourceOptions),
        originalMedia: target.images.map((image) => ({ ...image, src: undefined })) });
    }
    const assets = inputs.filter(isCourseInput).flatMap((item) => item.images);
    const manifest = [];
    for (const image of assets) {
      const filename = `source-assets/${image.bytesSha256}.${image.mimeType === 'image/jpeg' ? 'jpeg' : image.mimeType!.slice(6)}`;
      await fs.mkdir(path.dirname(path.join(output, filename)), { recursive: true });
      await fs.writeFile(path.join(output, filename), Buffer.from(image.src.split(',', 2)[1]!, 'base64'), { mode: 0o600 });
      manifest.push({ id: image.id, originalSrc: image.originalSrc, originalElementIds: image.originalElementIds,
        filename, sha256: image.bytesSha256, width: image.width, height: image.height, mimeType: image.mimeType });
    }
    await save(output, 'source-assets.json', manifest);
  }
  const manifest = await implementationManifest(), implementationSha256 = sha(JSON.stringify(manifest));
  await save(output, 'implementation-manifest.json', manifest);
  const referenceFiles = ['design-spec.json', 'renders/page19-a-review-1-final-p1.png', 'renders/page19-b-review-1-final-p1.png'];
  const referenceManifest = await Promise.all(referenceFiles.map(async (filename) => ({ filename, sha256: sha(await fs.readFile(path.join(referenceDirectory, filename))) })));
  const metadata: Record<string, unknown> = { schemaVersion: 1, mode, caseSet, startedAt: new Date().toISOString(), implementationSha256,
    sourceInputSha256: sourceInitialHash, sourceScope: caseSet === 'course'
      ? '同一测试课程原15、16、18、22页；原大纲、教材证据和原媒体字节完整保留，模型输入没有手工scene/坐标/新插画。'
      : '完整真实第19页、真实撤除责任及明确标记的固定边界示例；模型输入没有手工scene/元素。',
    approvedReference: { directory: referenceDirectory, confirmedInCurrentTask: true, manifest: referenceManifest },
    fixtureSha256: sha(JSON.stringify(inputs)), plannedCases: targets.length, repetitions: 1,
    sourceModelDirectory: replayInput, databaseWrites: 0, courseWrites: 0, narrationCalls: 0, audioCalls: 0, mediaGenerationCalls: 0,
    fullStudentScreenReview: 'not-run', contentReview: 'pending', beautyReview: 'pending', teacherAcceptance: 'pending' };
  await save(output, 'metadata.json', metadata);
  const assetsUnchanged = async () => (await Promise.all(sourceAssetFiles.map(async (file) => sha(await fs.readFile(file.filename)) === file.sha256))).every(Boolean);
  if (mode === 'prepare') {
    const preservation = { originalClassroomUnchanged: sha(await fs.readFile(snapshot.classroomFile)) === sha(classroomBytes),
      sourceInputsUnchanged: await sourceFingerprint() === sourceInitialHash, originalAssetBytesUnchanged: await assetsUnchanged() };
    await save(output, 'source-preservation.json', preservation);
    await save(output, 'summary.json', { ...metadata, attempted: 0, completed: 0, providerCalls: 0, preparationOnly: true, ...preservation });
    if (!Object.values(preservation).every(Boolean)) throw new Error('准备过程中原课程/教材来源发生变化');
    return;
  }
  const { generateOpenMaicBaselineContent } = await import('../src/lib/openmaic/generation/openmaic-baseline');
  const { compileTeachingVisualScene } = await import('../src/lib/openmaic/generation/teaching-visual-compiler');
  const { parseTeachingVisualScene } = await import('../src/lib/openmaic/generation/teaching-visual-scene');
  const { slideVisualSourceContent } = await import('../src/lib/openmaic/generation/slide-visual-projection');
  const { withTeachingSlideGuidance } = await import('../src/lib/openmaic/generation/teaching-narration');
  const { measureAuthoredSlideText, closeSpatialMeasurementBrowser } = await import('../src/lib/openmaic/generation/slide-spatial-measurement');
  const { runWithCourseGenerationLlmContext } = await import('../src/lib/course-generation/llm-concurrency');
  let createAi: (directory: string, policies: unknown[]) => Promise<AICallFn>;
  let providerCalls = 0;
  if (mode === 'model') {
    await deployedReadOnlyEnvironment();
    for (const name of ['DATABASE_URL', 'PROVIDER_CONFIG_DATABASE_URL', 'PROVIDER_ENCRYPTION_KEY']) if (process.env[name]) secrets.add(process.env[name]!);
    const { initializeServerProviderConfig, resolveServerThinkingConfig } = await import('../src/lib/openmaic/server/provider-config');
    const { resolveModel } = await import('../src/lib/openmaic/server/resolve-model');
    const { createCourseGenerationAiCall, withCourseGenerationAiCallContext } = await import('../src/lib/openmaic/server/course-generation-ai-call');
    const { createCourseOutputBudget, COURSE_OUTPUT_BUDGET_VERSION, resolveCourseExecutionBudgetOptions } = await import('../src/lib/openmaic/generation/course-output-budget');
    const { MAX_COURSE_STAGE_MODEL_REQUESTS } = await import('../src/lib/openmaic/generation/course-generation-policy');
    const { resolveLlmRequestTimeoutMs } = await import('../src/lib/llm/request-policy');
    await initializeServerProviderConfig();
    const model = await resolveModel({ stage: 'generate-classroom' }); secrets.add(model.apiKey);
    const thinking = resolveServerThinkingConfig(model.providerId, 'scene-content') ?? model.thinkingConfig;
    metadata.policy = { route: 'generate-classroom', modelString: model.modelString, thinking, outputWindow: model.modelInfo?.outputWindow,
      budgetPolicy: COURSE_OUTPUT_BUDGET_VERSION, unchangedProductionBudget: true };
    createAi = async (directory, policies) => {
      let rawIndex = 0;
      const call = createCourseGenerationAiCall({ model: model.model, vision: model.modelInfo?.capabilities?.vision === true,
        source: 'scene-content', thinking, outputBudget: createCourseOutputBudget({ resource: 'slide', modelOutputWindow: model.modelInfo?.outputWindow, thinking }),
        timeoutMs: resolveLlmRequestTimeoutMs('long-generation'), executionBudget: resolveCourseExecutionBudgetOptions(),
        maxRetries: MAX_COURSE_STAGE_MODEL_REQUESTS - 1, streamResponse: true, responseFormat: 'json', requireResponsePersistence: true,
        onResponse: (response) => save(directory, `raw/${String(++rawIndex).padStart(3, '0')}.json`, response) });
      return withCourseGenerationAiCallContext(call, { onStarted: (policy) => { policies.push(policy); } });
    };
  } else {
    metadata.providerCalls = 0;
    createAi = async (directory) => {
      const id = path.basename(directory), old = await json<Array<{ response?: string }>>(path.join(replayInput!, 'attempts', id, 'calls.json'));
      if (!old[0]?.response) throw new Error(`保存的真实响应缺失：${id}`);
      await save(directory, 'original-calls.json', old);
      let used = false;
      return async () => { if (used) throw new Error('确定性回放不能补发第二响应'); used = true; return old[0].response!; };
    };
  }
  await save(output, 'metadata.json', metadata);
  const reports: Array<Record<string, unknown>> = [];
  let cursor = 0, progressWrite = Promise.resolve();
  const concurrency = Math.min(targets.length, Math.max(1, Math.min(5, Number(args.get('concurrency') ?? 3))));
  try {
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (cursor < targets.length) {
        const target = targets[cursor++], id = `${target.id}-1`, directory = path.join(output, 'attempts', id), started = Date.now();
        const assignedImages = isCourseInput(target) ? target.images : [];
        const previous = isCourseInput(target) && courseClassroom ? courseBaseline(target, courseClassroom)
          : target.id === 'original-page-19' && originalScene.content.type === 'slide' ? originalScene.content.canvas : undefined;
        const calls: Array<{ system: string; prompt: string; systemSha256: string; response?: string; error?: string; elapsedMs: number;
          imageCount?: number; imageIds?: string[] }> = [];
        const usage: unknown[] = [], failures: unknown[] = [], policies: unknown[] = [];
        await save(directory, 'input.json', { target, repetition: 1, implementationSha256 });
        let final: GeneratedSlideContent | null = null, first: GeneratedSlideContent | null = null, error: string | undefined;
        try {
          const ai = await createAi(directory, policies);
          const tracked: AICallFn = async (system, prompt, images) => {
            const callStarted = Date.now(), record: typeof calls[number] = { system, prompt, systemSha256: sha(system), elapsedMs: 0,
              ...(isCourseInput(target) ? { imageCount: images?.length ?? 0, imageIds: (images ?? []).map((image) => image.id) } : {}) }; calls.push(record);
            if (mode === 'model') providerCalls++;
            try { record.response = await ai(system, prompt, images); return record.response; }
            catch (cause) { record.error = safe(cause); throw cause; }
            finally { record.elapsedMs = Date.now() - callStarted; await save(directory, 'calls.json', calls); }
          };
          const content = await runWithCourseGenerationLlmContext(() => generateOpenMaicBaselineContent(target.outline, withTeachingSlideGuidance(tracked, target.outline), {
            visualProjection: true, teachingVisual: true, componentAuthoring: true, slideAuthoring: 'native', textMeasure: measureAuthoredSlideText,
            languageDirective: target.outline.courseLanguageDirective, assignedImages,
            imageMapping: Object.fromEntries(assignedImages.map((image) => [image.id, image.src])),
            ...(target.source.kind === 'course-snapshot' ? sourceOptions : {}),
            ...(previous ? { visualBaseline: previous } : {}),
            websiteReferenceContext: { courseTitle: target.source.kind === 'course-snapshot' ? sourceVersion.snapshot.design.name : '认可风格固定验证示例',
              slideTitles: target.source.kind === 'course-snapshot' ? sourceOutlines.filter((page) => page.type === 'slide').map((page) => page.title) : inputs.map((item) => item.outline.title) },
            onFailure: (failure) => { failures.push(failure); },
          }), { onCallUsage: async (event) => { usage.push(event); await save(directory, 'usage.json', usage); } });
          final = content && 'elements' in content ? content : null;
          if (calls[0]?.response) {
            try {
              const scene = parseTeachingVisualScene(calls[0].response);
              scene.pages.forEach((page, index) => { page.id = index ? `${target.outline.id}:visual-${index + 1}` : target.outline.id; });
              await save(directory, 'first-scene.json', scene);
              first = await compileTeachingVisualScene(target.outline, scene, { measure: measureAuthoredSlideText,
                allowSplit: true, sourceCatalog: slideVisualSourceContent(target.outline),
                images: assignedImages.map((image) => ({ id: image.id, src: image.src, width: image.width!, height: image.height!,
                  ...(image.sourceTitle ? { caption: `来源：${image.sourceTitle}${image.pageNumber > 0 ? `，第${image.pageNumber}页` : ''}` } : {}) })) });
              await save(directory, 'first-content.json', first);
            } catch (cause) { await save(directory, 'first-preparation-error.json', { error: safe(cause), rawResponsePreserved: true }); }
          }
        } catch (cause) { error = safe(cause); }
        await save(directory, 'policies.json', policies); await save(directory, 'usage.json', usage); await save(directory, 'failures.json', failures);
        const pages = final ? [final, ...(final.continuationPages ?? [])] : [];
        const result = { id, caseId: target.id, kind: target.kind, sample: target.sample, repetition: 1, model: mode === 'model',
          source: target.source, status: error || !final?.elements.length ? 'failed' : 'completed', error, elapsedMs: Date.now() - started,
          final, first, qualityDiagnostics: final?.qualityDiagnostics ?? [],
          ...(isCourseInput(target) ? { originalMedia: target.images.map((image) => ({ id: image.id, sha256: image.bytesSha256,
            retained: pages.some((page) => page.elements.some((element) => element.type === 'image' && element.src === image.src)) })) } : {}),
          attemptClassification: { classification: classify(final, target.outline, previous), providerCalls: mode === 'model' ? calls.length : 0,
            responseReplayCalls: mode === 'replay' ? calls.length : 0, firstRawGeometryCompiled: Boolean(first),
            boundedLocalReplan: final?.qualityDiagnostics?.some((item) => /one local replan/iu.test(item)) ?? false,
            actualAdoptedKinds: [...new Set(pages.flatMap((page) => page.teachingVisual?.components.map((component) => component.kind) ?? []))],
            pageCount: pages.length }, referenceChecks: target.checks, contentReview: 'pending', beautyReview: 'pending' };
        await save(output, `results/${id}.json`, result);
        reports.push({ id, caseId: target.id, kind: target.kind, sample: target.sample, repetition: 1, status: result.status, error,
          classification: result.attemptClassification, elapsedMs: result.elapsedMs });
        progressWrite = progressWrite.then(() => save(output, 'progress.json', { planned: targets.length, complete: reports.length, reports: [...reports] }));
        await progressWrite; console.log(JSON.stringify({ id, status: result.status, classification: result.attemptClassification, error }));
      }
    }));
  } finally {
    await closeSpatialMeasurementBrowser();
    await globalThis.__openPblPrisma?.$disconnect();
    if (globalThis.__openPblProviderPrisma !== globalThis.__openPblPrisma) await globalThis.__openPblProviderPrisma?.$disconnect();
    const preservation = { originalClassroomUnchanged: sha(await fs.readFile(snapshot.classroomFile)) === sha(classroomBytes),
      sourceInputsUnchanged: await sourceFingerprint() === sourceInitialHash,
      originalAssetBytesUnchanged: await assetsUnchanged(),
      implementationUnchanged: sha(JSON.stringify(await implementationManifest())) === implementationSha256,
      approvedReferenceUnchanged: true };
    // Read reference assets again, rather than trusting the initial manifest.
    preservation.approvedReferenceUnchanged = (await Promise.all(referenceManifest.map(async (item) => sha(await fs.readFile(path.join(referenceDirectory, item.filename))) === item.sha256))).every(Boolean);
    await save(output, 'source-preservation.json', preservation);
    await save(output, 'summary.json', { ...metadata, finishedAt: new Date().toISOString(), providerCalls,
      attempted: reports.length, completed: reports.filter((item) => item.status === 'completed').length,
      failed: reports.filter((item) => item.status === 'failed').length, ...preservation, reports });
    if (!Object.values(preservation).every(Boolean)) throw new Error('输入/原课/参考/实现指纹变化，保留全部结果，不宣称同版本验收');
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(safe(error)); process.exitCode = 1; });
