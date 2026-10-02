/** Recompile every preserved real-model first response without provider calls.
 * NODE_OPTIONS=--conditions=import pnpm exec tsx scripts/replay-teaching-visuals.ts \
 *   --input=.openpbl-runtime/teaching-visuals/model-20261002-v2 \
 *   --output=.openpbl-runtime/teaching-visuals/replay-new-directory
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GeneratedSlideContent, SceneOutline, PdfImage } from '../src/lib/openmaic/types/generation';
import type { PblTemplateDesign } from '../src/lib/platform/pbl-template';
import type { Scene } from '../src/lib/openmaic/types/stage';
import type { VisualBenchmarkCase } from './fixtures/teaching-visual-samples';
import { compileTeachingVisualScene } from '../src/lib/openmaic/generation/teaching-visual-compiler';
import { parseTeachingVisualScene } from '../src/lib/openmaic/generation/teaching-visual-scene';
import { generateOpenMaicBaselineContent } from '../src/lib/openmaic/generation/openmaic-baseline';
import { slideVisualSourceContent } from '../src/lib/openmaic/generation/slide-visual-projection';
import { withTeachingSlideGuidance } from '../src/lib/openmaic/generation/teaching-narration';
import { measureAuthoredSlideText, closeSpatialMeasurementBrowser } from '../src/lib/openmaic/generation/slide-spatial-measurement';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map(process.argv.slice(2).map((value) => {
  const [name, ...pieces] = value.replace(/^--/, '').split('=');
  return [name, pieces.join('=') || 'true'];
}));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function json<T>(filename: string): Promise<T> { return JSON.parse(await fs.readFile(filename, 'utf8')) as T; }
async function save(directory: string, filename: string, value: unknown): Promise<void> {
  const destination = path.join(directory, filename);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
function isolated(value: string): string {
  const result = path.resolve(root, value);
  if (!result.startsWith(path.join(root, '.openpbl-runtime') + path.sep)) throw new Error('输入/输出必须位于 .openpbl-runtime');
  return result;
}
const implementationFiles = ['packages/@openmaic/dsl/src/teaching-visual.ts', 'src/lib/openmaic/generation/teaching-visual-scene.ts',
  'src/lib/openmaic/generation/teaching-visual-arithmetic.ts',
  'src/lib/openmaic/generation/teaching-visual-compiler.ts', 'src/lib/openmaic/generation/teaching-visual-theme.ts',
  'src/lib/openmaic/generation/openmaic-baseline.ts', 'scripts/fixtures/teaching-visual-samples.ts',
  'scripts/replay-teaching-visuals.ts'];
async function fingerprint(): Promise<string> {
  const files = await Promise.all(implementationFiles.map(async (filename) => ({ filename, body: await fs.readFile(path.join(root, filename), 'utf8') })));
  return hash(JSON.stringify(files));
}
function classify(content: GeneratedSlideContent | null | undefined): string {
  if (!content?.elements.length) return 'technical-failure';
  const components = content.teachingVisual?.scene.pages.flatMap((page) => page.components) ?? [];
  if (components.some((component) => component.id.endsWith(':original-content'))) return 'literal-scene-fallback';
  if (!content.teachingVisual) return content.qualityDiagnostics?.some((detail) => detail.includes('retained the existing usable draft'))
    ? 'retained-previous-draft' : 'native-complete-draft-fallback';
  return components.some((component) => component.kind !== 'text') ? 'model-visual-scene-adopted' : 'model-text-scene-adopted';
}
function audit(content: GeneratedSlideContent | null | undefined, outline: SceneOutline) {
  if (!content?.elements.length) return { executable: false };
  const pages = [content, ...(content.continuationPages ?? [])];
  const sourceIds = new Set(pages.flatMap((page) => page.teachingVisual?.components.flatMap((component) => component.sourceContentIds) ?? []));
  return { executable: true, pageCount: pages.length, allPagesHaveVisualMetadata: pages.every((page) => Boolean(page.teachingVisual)),
    sourceMapping: slideVisualSourceContent(outline).map(({ id, text }) => ({ sourceId: id, text, mapped: sourceIds.has(id) })),
    contentReview: 'pending', beautyReview: 'pending', limitation: '映射仅证明追踪，不代替事实与美观核对。' };
}

async function main(): Promise<void> {
  if (!args.get('input') || !args.get('output')) throw new Error('必须提供 --input 和新的 --output');
  const input = isolated(args.get('input')!), output = isolated(args.get('output')!);
  if (await fs.stat(output).catch(() => null)) throw new Error('禁止覆盖已有重放或模型结果');
  const sourceSummary = await json<Record<string, unknown>>(path.join(input, 'summary.json'));
  if (sourceSummary.mode !== 'model' || sourceSummary.implementationUnchanged !== true || sourceSummary.originalClassroomUnchanged !== true) {
    throw new Error('真实模型输入必须来自已结束且指纹/源课程未变的模型基准');
  }
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  await fs.cp(path.join(input, 'source-snapshot'), path.join(output, 'source-snapshot'), { recursive: true });
  await fs.cp(path.join(input, 'fixtures.json'), path.join(output, 'fixtures.json'));
  await fs.cp(path.join(input, 'summary.json'), path.join(output, 'original-model-summary.json'));
  const originalDirectory = path.join(output, 'source-snapshot');
  const snapshot = await json<{ classroomFile: string }>(path.join(originalDirectory, 'snapshot.json'));
  const originalClassroomHash = hash(await fs.readFile(snapshot.classroomFile));
  const sourceVersion = await json<{ snapshot: { design: PblTemplateDesign } }>(path.join(originalDirectory, 'template.json'));
  const sourceOutlines = await json<SceneOutline[]>(path.join(originalDirectory, 'outlines.json'));
  const originalScene = await json<Scene>(path.join(originalDirectory, 'original-scene.json'));
  const sourceSequenceContracts = await json<NonNullable<Parameters<typeof generateOpenMaicBaselineContent>[2]>['sourceSequenceContracts']>(
    path.join(originalDirectory, 'source-sequence-contracts.json'));
  const fixtures = await json<VisualBenchmarkCase[]>(path.join(output, 'fixtures.json'));
  const selected = args.get('ids')?.split(',');
  const inputs = (await fs.readdir(path.join(input, 'results'))).filter((filename) => filename.endsWith('.json')).sort();
  const implementationSha256 = await fingerprint();
  const metadata = { schemaVersion: 1, mode: 'deterministic-replay', startedAt: new Date().toISOString(), input,
    sourceModelImplementationSha256: sourceSummary.implementationSha256, implementationSha256,
    policy: sourceSummary.policy, providerCalls: 0, independentModelCalls: 0, courseWrites: 0, narrationCalls: 0, audioCalls: 0,
    mediaGenerationCalls: 0, sourceModelRun: '24例各两次独立模型输出+完整原19页一次；本目录只重放保存的第一response，未重生成或筛选失败。',
    contentReview: 'pending', beautyReview: 'pending', fullStudentScreenReview: 'not-run' };
  await save(output, 'metadata.json', metadata);
  const reports: Array<Record<string, unknown>> = [];
  let rawUnchanged = true;
  try {
    for (const filename of inputs) {
      const before = await json<{ id: string; caseId: string; status: string; final?: GeneratedSlideContent; first?: GeneratedSlideContent; qualityDiagnostics?: string[] }>(path.join(input, 'results', filename));
      if (selected && !selected.includes(before.caseId)) continue;
      const id = before.id, directory = path.join(output, 'attempts', id);
      const originalInput = path.join(input, 'attempts', id, 'input.json');
      const originalCalls = path.join(input, 'attempts', id, 'calls.json');
      const inputBytes = await fs.readFile(originalInput), callBytes = await fs.readFile(originalCalls);
      const { target, repetition } = JSON.parse(inputBytes.toString()) as { target: VisualBenchmarkCase; repetition: number };
      const calls = JSON.parse(callBytes.toString()) as Array<{ response?: string; prompt: string; systemSha256: string; imageCount: number }>;
      const raw = calls[0]?.response;
      await save(directory, 'input.json', { target, repetition, implementationSha256 });
      await save(output, `original-results/${filename}`, before);
      await save(directory, 'original-calls.json', calls);
      if (!raw) {
        const result = { id, caseId: before.caseId, kind: target.kind, sample: target.sample, repetition, status: 'failed', error: '原模型第一response缺失，保留真实失败；禁止追加模型请求。', model: false, providerCalls: 0 };
        await save(output, `results/${filename}`, result); reports.push(result); continue;
      }
      const sourceHashes = { inputSha256: hash(inputBytes), callsSha256: hash(callBytes), responseSha256: hash(raw) };
      await save(directory, 'source-hashes.json', sourceHashes);
      const stubCalls: Array<{ promptSha256: string; systemSha256: string; exactOriginalPrompt: boolean; exactOriginalSystem: boolean; imageCount: number }> = [];
      const diagnostics: unknown[] = [], started = Date.now();
      let final: GeneratedSlideContent | null = null, first: GeneratedSlideContent | null = null, error: string | undefined;
      try {
        const generated = await generateOpenMaicBaselineContent(target.outline, withTeachingSlideGuidance(async (system, prompt, images) => {
          if (stubCalls.length) throw new Error('重放仅允许使用保存的第一response，禁止第二模型请求');
          stubCalls.push({ promptSha256: hash(prompt), systemSha256: hash(system), exactOriginalPrompt: prompt === calls[0]!.prompt,
            exactOriginalSystem: hash(system) === calls[0]!.systemSha256, imageCount: images?.length ?? 0 });
          return raw;
        }, target.outline), {
          visualProjection: true, teachingVisual: true, componentAuthoring: true, slideAuthoring: 'native', textMeasure: measureAuthoredSlideText,
          assignedImages: target.images?.map((image): PdfImage => ({ ...image, pageNumber: 1, description: image.caption, sourceTitle: target.source.title, required: true })),
          imageMapping: Object.fromEntries((target.images ?? []).map((image) => [image.id, image.src])), languageDirective: target.outline.courseLanguageDirective,
          ...(target.source.kind === 'course-snapshot' ? { sourceEvidence: sourceVersion.snapshot.design.content.courseEvidence,
            sourceKnowledgePoints: sourceVersion.snapshot.design.content.knowledgePoints, sourceSequenceContracts } : {}),
          ...(target.id === 'original-page-19' && originalScene.content.type === 'slide' ? { visualBaseline: originalScene.content.canvas } : {}),
          websiteReferenceContext: target.id === 'original-page-19'
            ? { courseTitle: sourceVersion.snapshot.design.name, slideTitles: sourceOutlines.filter((page) => page.type === 'slide').map((page) => page.title) }
            : { courseTitle: '教学图解24例固定基准', slideTitles: fixtures.filter((item) => item.id !== 'original-page-19').map((item) => item.outline.title) },
          onFailure: (failure) => diagnostics.push(failure),
        });
        if (generated && 'elements' in generated) final = generated;
        const scene = parseTeachingVisualScene(raw);
        scene.pages.forEach((page, index) => { page.id = index ? `${target.outline.id}:visual-${index + 1}` : target.outline.id; });
        await save(directory, 'first-scene.json', scene);
        first = await compileTeachingVisualScene(target.outline, scene, { measure: measureAuthoredSlideText, images: target.images,
          allowSplit: true, sourceCatalog: slideVisualSourceContent(target.outline) });
      } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
      await save(directory, 'stub-calls.json', stubCalls);
      await save(directory, 'diagnostics.json', diagnostics);
      await save(directory, 'first-content.json', first);
      const result = { id, caseId: before.caseId, kind: target.kind, sample: target.sample, repetition, model: false,
        status: final?.elements.length ? 'completed' : 'failed', elapsedMs: Date.now() - started, final, first, error, source: target.source,
        audit: audit(final, target.outline), qualityDiagnostics: final?.qualityDiagnostics ?? [], providerCalls: 0,
        replay: { sourceModelDirectory: input, ...sourceHashes, stubCalls: stubCalls.length, classification: classify(final),
          beforeClassification: classify(before.final), beforeFirstCompiled: Boolean(before.first?.elements.length),
          actualAdoptedKinds: [...new Set(final?.teachingVisual?.scene.pages.flatMap((page) => page.components.map((component) => component.kind)) ?? [])],
          exactOriginalPrompt: stubCalls.every((call) => call.exactOriginalPrompt && call.exactOriginalSystem) },
        contentReview: 'pending', beautyReview: 'pending' };
      await save(output, `results/${filename}`, result);
      reports.push({ id, caseId: before.caseId, kind: target.kind, repetition, status: result.status, replay: result.replay, audit: result.audit, error });
      await save(output, 'progress.json', { complete: reports.length, planned: selected ? undefined : inputs.length, providerCalls: 0, reports });
      rawUnchanged = rawUnchanged && hash(await fs.readFile(originalInput)) === sourceHashes.inputSha256 && hash(await fs.readFile(originalCalls)) === sourceHashes.callsSha256;
      console.log(JSON.stringify({ id, status: result.status, adopted: result.replay.classification, elapsedMs: result.elapsedMs }));
    }
  } finally {
    await closeSpatialMeasurementBrowser();
    const originalClassroomUnchanged = hash(await fs.readFile(snapshot.classroomFile)) === originalClassroomHash;
    const implementationUnchanged = await fingerprint() === implementationSha256;
    await save(output, 'source-preservation.json', { originalClassroomUnchanged, originalModelInputsUnchanged: rawUnchanged, implementationUnchanged });
    await save(output, 'summary.json', { ...metadata, finishedAt: new Date().toISOString(), attempted: reports.length,
      completed: reports.filter((report) => report.status === 'completed').length, failed: reports.filter((report) => report.status === 'failed').length,
      originalClassroomUnchanged, originalModelInputsUnchanged: rawUnchanged, implementationUnchanged, reports });
    if (!originalClassroomUnchanged || !implementationUnchanged || !rawUnchanged) throw new Error('课程、保存的模型输入或实现指纹在重放期间改变；保留产物但不能声称同版本验证。');
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
