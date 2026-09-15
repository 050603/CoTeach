/**
 * Resumable offline slide comparison. Never creates or updates a teacher course.
 * node scripts/run-first-pass-slide-benchmark.mjs --service-env --concurrency=3
 * Optional: --groups=official,custom,adapted --limit=3 --output=/absolute/path
 * Runtime inputs and raw generations stay in ignored .openpbl-runtime by default.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { SceneOutline, GeneratedSlideContent } from '../src/lib/openmaic/types/generation';
import type { AICallFn } from '../src/lib/openmaic/generation/pipeline-types';
import type { SlideComposition } from '../src/lib/openmaic/generation/slide-visual-plan';

const root = process.cwd();
const args = new Map(process.argv.slice(2).map((arg) => { const [key, ...value] = arg.replace(/^--/, '').split('='); return [key, value.join('=') || 'true']; }));
const output = path.resolve(args.get('output') ?? '.openpbl-runtime/first-pass-benchmark');
const sourceRoot = path.join(output, 'legacy-source');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const LEGACY_CUSTOM_ENGINE_COMMIT = '843847af93106f9b6ac64f10154fb056d7141303';
const benchmarkGroups = ['official', 'custom', 'adapted'] as const;
type BenchmarkGroup = typeof benchmarkGroups[number];
const groups = (args.get('groups') ?? benchmarkGroups.join(',')).split(',')
  .filter((group): group is BenchmarkGroup => benchmarkGroups.includes(group as BenchmarkGroup));
let concurrency = 1;
const limit = Number(args.get('limit') ?? Infinity);

async function serviceEnvironment() {
  if (!args.has('service-env')) return;
  const pid = execFileSync('systemctl', ['--user', 'show', 'openpbl.service', '--property=MainPID', '--value'], { encoding: 'utf8' }).trim();
  if (!/^\d+$/.test(pid) || pid === '0') throw new Error('Running openpbl.service is required for --service-env');
  const environment = (await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0');
  const names = new Set(['DATABASE_URL', 'PROVIDER_ENCRYPTION_KEY', 'JWT_SECRET', 'MODEL_ROUTES', 'DEFAULT_MODEL', 'OPENPBL_OUTBOUND_PROXY', 'PARALLEL_SCENE_CONCURRENCY']);
  for (const entry of environment) {
    const separator = entry.indexOf('=');
    const name = entry.slice(0, separator);
    if (names.has(name)) process.env[name] = entry.slice(separator + 1);
  }
}

async function snapshotLegacyEngine(commit: string) {
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', commit, 'src/lib/openmaic/generation', 'src/lib/openmaic/prompts'], { encoding: 'utf8' }).trim().split('\n');
  for (const file of files) {
    const destination = path.join(sourceRoot, file);
    try { await access(destination); continue; } catch { /* Snapshot each source once. */ }
    let content = execFileSync('git', ['show', `${commit}:${file}`], { encoding: 'utf8', maxBuffer: 8_000_000 });
    if (file.endsWith('.ts')) {
      content = content.replace(/(['"])(?:@openmaic\/lib|@\/lib\/openmaic)\/(generation|prompts)(\/[^'"\n]+)?\1/g,
        (_match, quote, folder, suffix = '') => `${quote}${path.join(sourceRoot, 'src/lib/openmaic', folder)}${suffix}${quote}`);
      if (file.endsWith('/prompts/loader.ts')) content = content.replace("path.join(process.cwd(), 'src', 'lib', 'openmaic', 'prompts')", JSON.stringify(path.join(sourceRoot, 'src/lib/openmaic/prompts')));
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  const localRequire = createRequire(path.join(root, 'package.json'));
  const { build } = createRequire(localRequire.resolve('tsx'))('esbuild');
  await build({ entryPoints: [path.join(sourceRoot, 'src/lib/openmaic/generation/scene-generator.ts')], outfile: path.join(sourceRoot, 'scene-generator.mjs'), bundle: true, packages: 'external', platform: 'node', format: 'esm', tsconfig: path.join(root, 'tsconfig.json'), banner: { js: "import {createRequire as __baselineCreateRequire} from 'node:module'; const require = __baselineCreateRequire(import.meta.url);" } });
}

type Sample = { composition: SlideComposition; title: string; keyPoints: string[] };
type CallRecord = { systemSha256: string; prompt: string; imageCount: number; elapsedMs: number; response?: string; error?: string };
type Result = {
  id: string; group: string; sampleIndex: number; repetition: number; composition: string;
  outline: SceneOutline; status: 'completed' | 'failed'; error?: string; elapsedMs: number;
  calls: CallRecord[]; final?: GeneratedSlideContent | null;
  first?: GeneratedSlideContent | null; implementationSha256?: string; firstGeometry?: unknown; finalGeometry?: unknown; visibleText?: string;
  coverage: { required: string[]; exactTextPresent: boolean[]; manualReview: 'pending' };
};

async function main() {
  await mkdir(output, { recursive: true });
  await serviceEnvironment();
  const { getModelInfo } = await import('../src/lib/openmaic/ai/providers');
  const { initializeServerProviderConfig, getServerProviders, getClassroomSceneConcurrency } = await import('../src/lib/openmaic/server/provider-config');
  const { resolveModel } = await import('../src/lib/openmaic/server/resolve-model');
  const { createCourseGenerationAiCall } = await import('../src/lib/openmaic/server/course-generation-ai-call');
  const { generateSceneContent } = await import('../src/lib/openmaic/generation/scene-generator');
  const { adaptOutlineToOpenMaicBaseline } = await import('../src/lib/openmaic/generation/openmaic-baseline');
  const { generateSceneContent: generateOfficialSceneContent } = await import('@openmaic/generation');
  const { fallbackSlideVisualPlan } = await import('../src/lib/openmaic/generation/slide-visual-plan');
  const { parseJsonResponse } = await import('../src/lib/openmaic/generation/json-repair');
  const { auditGeneratedSlide } = await import('../src/lib/openmaic/generation/slide-quality');
  await initializeServerProviderConfig();
  const resolved = await resolveModel(args.has('model') ? { modelString: args.get('model') } : { stage: 'generate-classroom' });
  concurrency = Math.max(1, Math.min(5, Number(args.get('concurrency') ?? getClassroomSceneConcurrency())));
  const configured = Object.entries(getServerProviders()).flatMap(([provider, config]) => (config.models ?? (config.defaultModel ? [config.defaultModel] : [])).map((model) => ({ provider, model, vision: getModelInfo(provider as Parameters<typeof getModelInfo>[0], model)?.capabilities?.vision === true })));
  await writeFile(path.join(output, 'configured-model-capabilities.json'), JSON.stringify(configured, null, 2));
  if (args.has('list-models')) { console.log(JSON.stringify(configured)); process.exit(0); }
  const redact = (error: unknown) => String(error instanceof Error ? error.message : error).split(resolved.apiKey || '\0').join('[redacted]').replace(/Bearer\s+\S+/g, 'Bearer [redacted]').slice(0, 1500);
  const implementationSources = [
    'src/lib/openmaic/generation/scene-generator.ts',
    'src/lib/openmaic/generation/openmaic-baseline.ts',
    'packages/@openmaic/generation/src/scene-generator.ts',
    'packages/@openmaic/generation/templates/slide-content/system.md',
    'packages/@openmaic/generation/templates/slide-content/user.md',
  ];
  const implementationSha256 = sha((await Promise.all(implementationSources.map((file) => readFile(path.join(root, file), 'utf8')))).join('\n'));
  const fixtureText = await readFile(path.join(root, 'scripts/fixtures/first-pass-slide-samples.json'), 'utf8');
  const samples = JSON.parse(fixtureText) as Sample[];
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(await readFile(path.join(output, 'metadata.json'), 'utf8'));
    if (metadata.model !== resolved.modelString || metadata.samplesSha256 !== sha(fixtureText) || metadata.implementationSha256 !== implementationSha256) throw new Error('The resume model/sample set has changed; use a new --output');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    metadata = { startedAt: new Date().toISOString(), implementationSha256, legacyCommit: args.get('legacy-commit') ?? LEGACY_CUSTOM_ENGINE_COMMIT, model: resolved.modelString, vision: resolved.modelInfo?.capabilities?.vision === true,
      upstreamBaseline: '@openmaic/generation@0.3.7 / OpenMAIC v1.0.2 / 9fe650d9947ec2feccdfffcdbf8262b2fb16b44c',
      samplesSha256: sha(fixtureText), groups: benchmarkGroups, repetitions: 3, plannedCases: samples.length * benchmarkGroups.length * 3,
      baselineScope: 'official = pinned upstream package; custom = frozen pre-migration engine; adapted = pinned upstream package through the CoTeach semantic adapter',
      measurement: 'Generation artifacts are rendered separately with the current CoTeach renderer; knowledge coverage requires blinded manual review.',
      media: 'No image generation or TTS calls; exact diagram/data evidence supplied as text; no teaching course persisted.' };
    await writeFile(path.join(output, 'metadata.json'), JSON.stringify(metadata, null, 2));
  }
  await snapshotLegacyEngine(String(metadata.legacyCommit));
  const legacy = await import(pathToFileURL(path.join(sourceRoot, 'scene-generator.mjs')).href) as { generateSceneContent: typeof generateSceneContent };
  const call = createCourseGenerationAiCall({ model: resolved.model, vision: resolved.modelInfo?.capabilities?.vision === true, source: 'benchmark-first-pass-slides', maxOutputTokens: Math.min(resolved.modelInfo?.outputWindow ?? 12000, 16000), thinking: resolved.thinkingConfig, timeoutMs: 120000 });
  const work = samples.flatMap((sample, sampleIndex) => [0, 1, 2].flatMap((repetition) => groups.map((group) => ({ sample, sampleIndex, repetition, group })))).slice(0, limit);
  let done = 0;
  let cursor = 0;
  const results: Result[] = [];
  const inspect = (content: unknown) => {
    try {
      if (!content || typeof content !== 'object' || !Array.isArray((content as GeneratedSlideContent).elements)) return { passed: false, reasons: ['No parseable elements'] };
      return auditGeneratedSlide((content as GeneratedSlideContent).elements, { canvasWidth: 1000, canvasHeight: 562.5, checkComposition: true });
    } catch (error) { return { passed: false, reasons: [redact(error)] }; }
  };
  async function worker() {
    while (cursor < work.length) {
      const task = work[cursor++];
      const { sample, sampleIndex, repetition, group } = task;
      const id = `${String(sampleIndex + 1).padStart(2, '0')}-${group}-${repetition + 1}`;
      const file = path.join(output, 'results', `${id}.json`);
      try { const saved = JSON.parse(await readFile(file, 'utf8')) as Result; results.push(saved); done++; continue; } catch { /* New case */ }
      const base: SceneOutline = { id: `benchmark-${sampleIndex + 1}`, type: 'slide', title: sample.title, description: sample.keyPoints.join('\n'), keyPoints: sample.keyPoints,
        knowledgePointIds: sample.keyPoints.map((_, i) => `kp-${sampleIndex + 1}-${i + 1}`), order: sampleIndex,
        estimatedDuration: 90, targetDurationSec: 90, teachingObjective: `解释并准确呈现：${sample.title}`, audience: 'student' };
      const start = performance.now();
      const result: Result = { implementationSha256, id, group, sampleIndex, repetition, composition: sample.composition, outline: base, status: 'failed', elapsedMs: 0, calls: [], coverage: { required: sample.keyPoints, exactTextPresent: [], manualReview: 'pending' } };
      const trackedCall: AICallFn = async (system, prompt, images) => {
        const started = performance.now();
        const record: CallRecord = { systemSha256: sha(system), prompt, imageCount: images?.length ?? 0, elapsedMs: 0 };
        result.calls.push(record);
        try { record.response = await call(system, prompt, images); return record.response; }
        catch (error) { record.error = redact(error); throw error; }
        finally { record.elapsedMs = Math.round(performance.now() - started); }
      };
      try {
        const options = { visionEnabled: resolved.modelInfo?.capabilities?.vision === true,
          languageDirective: sampleIndex % 3 === 2 ? 'Use English for all visible content.' : '所有教学文字使用简体中文。',
          userRequirements: { requirement: '清晰、可编辑的科学与计算机教学课件。严格依据给定资料，禁止虚构数据。', teachingSourceContext: sample.keyPoints.join('\n') } };
        let content: unknown;
        if (group === 'official') {
          content = await generateOfficialSceneContent(
            adaptOutlineToOpenMaicBaseline(base),
            trackedCall,
            { visionEnabled: options.visionEnabled, languageDirective: options.languageDirective },
          );
        } else if (group === 'custom') {
          const legacyOutline = {
            ...base,
            visualPlan: { ...fallbackSlideVisualPlan(base), composition: sample.composition },
          };
          result.outline = legacyOutline;
          content = await legacy.generateSceneContent(legacyOutline, trackedCall, options);
        } else {
          content = await generateSceneContent(base, trackedCall, options);
        }
        result.final = content as GeneratedSlideContent | null;
        result.status = content ? 'completed' : 'failed';
        result.first = parseJsonResponse<GeneratedSlideContent>(result.calls[0]?.response ?? '');
        if (result.first && content && 'theme' in content) result.first.theme ??= content.theme;
        result.firstGeometry = inspect(result.first);
        result.finalGeometry = inspect(content);
        result.visibleText = content && 'elements' in content ? content.elements.map((element) => 'content' in element ? String(element.content).replace(/<[^>]*>/g, ' ') : 'text' in element ? JSON.stringify(element.text) : element.type === 'table' ? JSON.stringify(element.data) : '').join('\n') : '';
        result.coverage.exactTextPresent = sample.keyPoints.map((point) => result.visibleText!.replace(/\s/g, '').includes(point.replace(/\s/g, '')));
      } catch (error) { result.error = redact(error); }
      if (!result.first && result.calls[0]?.response) { result.first = parseJsonResponse<GeneratedSlideContent>(result.calls[0].response); result.firstGeometry = inspect(result.first); }
      result.elapsedMs = Math.round(performance.now() - start);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(result, null, 2));
      results.push(result); done++;
      console.log(JSON.stringify({ completed: done, total: work.length, id, status: result.status, calls: result.calls.length, elapsedMs: result.elapsedMs, error: result.error }));
      await writeSummary(results, metadata);
    }
  }
  console.log(JSON.stringify({ starting: work.length, model: resolved.modelString, vision: metadata.vision, concurrency, output }));
  await Promise.all(Array.from({ length: concurrency }, worker));
  await writeSummary(results, metadata);
  // The cached measurement browser is deliberately reused across all cases.
  process.exit(0);
}

async function writeSummary(results: Result[], metadata: Record<string, unknown>) {
  const summary = { ...metadata, updatedAt: new Date().toISOString(), completedCases: results.length,
    conditions: Object.fromEntries(benchmarkGroups.map((group) => {
      const rows = results.filter((row) => row.group === group);
      const firstGeometryPass = rows.filter((row) => (row.firstGeometry as { passed?: boolean })?.passed).length;
      const finalGeometryPass = rows.filter((row) => (row.finalGeometry as { passed?: boolean })?.passed).length;
      return [group, { cases: rows.length, successful: rows.filter((row) => row.status === 'completed').length, modelCalls: rows.reduce((sum, row) => sum + row.calls.length, 0),
        elapsedMs: rows.reduce((sum, row) => sum + row.elapsedMs, 0), staticFirstGeometryPass: firstGeometryPass, staticFinalGeometryPass: finalGeometryPass,
        browserLayoutAcceptance: 'not measured', knowledgeCoverageAcceptance: 'manual review pending' }];
    })) };
  await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : 'Benchmark setup failed';
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'setup-failure.json'), JSON.stringify({ at: new Date().toISOString(), name: error instanceof Error ? error.name : 'Error', message }, null, 2));
  console.error(`Benchmark setup failed: ${message}`);
  process.exit(1);
});
