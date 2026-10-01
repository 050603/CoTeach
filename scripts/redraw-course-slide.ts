/**
 * Isolated single-slide production redraw. Never writes a course/job or authors
 * narration, audio, media or another page.
 *
 * NODE_OPTIONS=--conditions=import pnpm exec tsx scripts/redraw-course-slide.ts \
 *   --classroom .openpbl-data/classrooms/txNvGrC6Sz.json --slide 19 \
 *   --output .openpbl-runtime/slide-redraw/example --deployment-secrets
 * Add --generate to author the selected PPT. A saved --snapshot-dir can be used
 * as input for a new isolated output. --no-render skips the offline screenshots.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import type { PPTElement, SlidePresentationProjection } from '@openmaic/dsl';
import type { GeneratedSlideContent, SceneOutline } from '../src/lib/openmaic/types/generation';
import type { Scene } from '../src/lib/openmaic/types/stage';
import type { Action, SpeechAnchor, VisualTargetSelector } from '../src/lib/openmaic/types/action';
import type { PersistedClassroomData } from '../src/lib/openmaic/server/classroom-storage';
import type { GenerateClassroomInput } from '../src/lib/openmaic/server/classroom-generation';
import type { PblTemplateDesign } from '../src/lib/platform/pbl-template';
import type { ThinkingConfig } from '../src/lib/openmaic/types/provider';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secrets = new Set<string>();
type Request = GenerateClassroomInput & { courseId: string };
type Snapshot = {
  schemaVersion: 1; requestId: string; classroomFile: string; classroomSha256: string;
  classroomId: string; sceneId: string; outlineId: string; slide: number;
  courseId: string; templateVersionId: string; jobId: string; courseTitle: string;
  originalSceneSha256: string; originalOutlineSha256: string;
  policy: { modelString: string; thinking?: ThinkingConfig; outputWindow?: number; budgetPolicy: string };
  media: Array<{ url: string; file?: string; sha256?: string; unavailable?: string }>;
};
type SourcePoint = { id: string; text: string };
type TargetMapping = { actionId: string; from: string; to?: string; sources?: string[]; diagnostic?: string };

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 需要参数值`);
  return value;
}
function sha(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function valueHash(value: unknown): string { return sha(JSON.stringify(value)); }
async function json<T>(file: string): Promise<T> { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
function safeError(error: unknown): string {
  let value = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) value = value.split(secret).join('[redacted]');
  return value.replace(/(?:postgres(?:ql)?|https?):\/\/[^\s/@]+:[^\s/@]+@/giu, '[redacted-url]@');
}
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(?:apiKey|webSearchApiKey|api_key|secret|password|authorization|cookie|databaseUrl|providerEncryptionKey)$/iu.test(key))
    .map(([key, item]) => [key, redact(item)]));
  if (typeof value === 'string') {
    for (const secret of secrets) if (secret && value.includes(secret)) return '[redacted]';
  }
  return value;
}
async function save(directory: string, name: string, value: unknown): Promise<void> {
  const filename = path.join(directory, name);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, `${JSON.stringify(redact(value), null, 2)}\n`, { mode: 0o600 });
}
function runtimePath(value: string): string {
  const resolved = path.resolve(repository, value);
  if (!resolved.startsWith(path.join(repository, '.openpbl-runtime') + path.sep)) {
    throw new Error('输出及重放快照必须位于 .openpbl-runtime 隔离目录');
  }
  return resolved;
}

function runReadOnlyDatabaseOperation<T>(model: string | undefined, operation: string, query: () => Promise<T>): Promise<T> {
  const allowed = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy']);
  if (!allowed.has(operation)) throw new Error(`单页重绘禁止数据库写入：${model ?? 'raw'}.${operation}`);
  return query();
}

function assertOriginalSlideSnapshot(original: Scene, outline: SceneOutline, snapshot: Pick<Snapshot,
  'originalSceneSha256' | 'originalOutlineSha256' | 'sceneId' | 'outlineId'>): void {
  if (original.id !== snapshot.sceneId || outline.id !== snapshot.outlineId
    || valueHash(original) !== snapshot.originalSceneSha256 || valueHash(outline) !== snapshot.originalOutlineSha256) {
    throw new Error('原页面或大纲快照在调用前发生变化');
  }
}

async function initializeReadOnlyDatabase(): Promise<void> {
  if (process.argv.includes('--deployment-secrets')) {
    const directory = process.env.OPENPBL_SECRET_DIR || path.join(repository, 'deploy/secrets');
    for (const [name, filename] of [['DATABASE_URL', 'database_url.txt'], ['PROVIDER_ENCRYPTION_KEY', 'provider_encryption_key.txt']]) {
      process.env[name] = (await fs.readFile(path.join(directory, filename), 'utf8')).trim();
    }
  }
  for (const name of ['DATABASE_URL', 'PROVIDER_CONFIG_DATABASE_URL', 'PROVIDER_ENCRYPTION_KEY']) {
    if (process.env[name]) secrets.add(process.env[name]!);
  }
  if (!process.env.DATABASE_URL) throw new Error('需要只读数据库连接；可使用 --deployment-secrets');
  const { PrismaClient } = await import('@prisma/client');
  const client = (databaseUrl?: string) => new PrismaClient({ ...(databaseUrl ? { datasourceUrl: databaseUrl } : {}), log: [] }).$extends({
    query: { $allOperations({ model, operation, args, query }) {
      return runReadOnlyDatabaseOperation(model, operation, () => query(args));
    } },
  }) as unknown as PrismaClient;
  globalThis.__openPblPrisma = client();
  const providerUrl = process.env.PROVIDER_CONFIG_DATABASE_URL?.trim();
  if (providerUrl && providerUrl !== process.env.DATABASE_URL) globalThis.__openPblProviderPrisma = client(providerUrl);
}
async function disconnect(): Promise<void> {
  await globalThis.__openPblPrisma?.$disconnect();
  if (globalThis.__openPblProviderPrisma !== globalThis.__openPblPrisma) await globalThis.__openPblProviderPrisma?.$disconnect();
}

function collectMedia(value: unknown, urls = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => collectMedia(item, urls));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (['src', 'audioUrl', 'poster'].includes(key) && typeof item === 'string' && !item.startsWith('data:')) urls.add(item);
    else collectMedia(item, urls);
  }
  return urls;
}
async function snapshotMedia(scene: Scene, source: string, directory: string): Promise<Snapshot['media']> {
  const root = path.dirname(source);
  const output: Snapshot['media'] = [];
  for (const url of collectMedia(scene)) {
    const pathname = new URL(url, 'http://localhost').pathname;
    const prefix = '/api/openmaic/classroom-media/';
    if (!pathname.startsWith(prefix)) { output.push({ url, unavailable: '保留原资源绑定；此 URL 不属于课堂本地媒体目录' }); continue; }
    const relative = pathname.slice(prefix.length).split('/').map(decodeURIComponent).join('/');
    const filename = path.resolve(root, relative);
    if (!filename.startsWith(root + path.sep)) throw new Error('无效媒体路径');
    try {
      const body = await fs.readFile(filename);
      const file = `media/${relative}`;
      await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      await fs.writeFile(path.join(directory, file), body, { mode: 0o600 });
      output.push({ url, file, sha256: sha(body) });
    } catch (error) { output.push({ url, unavailable: safeError(error) }); }
  }
  return output;
}

async function prepareSnapshot(directory: string): Promise<Snapshot> {
  const source = path.resolve(repository, arg('--classroom') ?? '.openpbl-data/classrooms/txNvGrC6Sz.json');
  const classroomBytes = await fs.readFile(source);
  const classroom = JSON.parse(classroomBytes.toString()) as PersistedClassroomData;
  const slide = Number(arg('--slide') ?? 19);
  if (!Number.isInteger(slide) || slide < 1) throw new Error('--slide 必须是从 1 开始的页面序号');
  const scene = classroom.scenes?.[slide - 1];
  if (!scene || scene.type !== 'slide' || scene.content?.type !== 'slide' || !scene.outlineId) throw new Error('所选页面不是可溯源的原生 PPT');
  const db = globalThis.__openPblPrisma!;
  const versions = await db.classroomTemplateVersion.findMany({
    where: { ...(arg('--course-id') ? { templateId: arg('--course-id') } : {}), OR: [
      { snapshot: { path: ['design', 'aiLearningClassroomId'], equals: classroom.id } },
      { snapshot: { path: ['design', 'content', '_openmaicClassroomId'], equals: classroom.id } },
    ] }, orderBy: { createdAt: 'desc' }, take: 2,
    select: { id: true, templateId: true, version: true, snapshot: true },
  });
  const version = versions[0];
  if (!version || versions.some((item) => item.templateId !== version.templateId)) throw new Error('不能唯一定位原课堂的课程模板');
  const { decodePblTemplate } = await import('../src/lib/platform/pbl-template');
  const design = decodePblTemplate(version.snapshot);
  if (!design) throw new Error('课程模板无法解析');
  const outlines = (design.content._openmaicSceneOutlines ?? []) as unknown as SceneOutline[];
  const outline = outlines.find((item) => item.id === scene.outlineId);
  if (!outline || outline.type !== 'slide' || outline.title !== scene.title || outline.order !== scene.order
    || outline.targetDurationSec !== scene.targetDurationSec) throw new Error('当前课程大纲与所选原页面身份或时长不一致');
  const job = await db.generationJob.findFirst({
    where: { targetId: version.templateId, jobType: 'COURSE_CONTENT', ...(arg('--job-id') ? { id: arg('--job-id') } : {}) },
    orderBy: { createdAt: 'desc' }, select: { id: true, targetId: true, request: true, status: true },
  });
  const request = job?.request as unknown as Request | undefined;
  if (!job || !request || request.courseId !== version.templateId || !request.generationModelString) throw new Error('缺少同课程的原模型请求');
  const checkpoints = await db.generationCheckpoint.findMany({
    where: { jobId: job.id, step: { in: ['prepared-outlines', `page:${outline.id}`, `stage:${outline.id}:content`,
      `stage:${outline.id}:narration`, `stage:${outline.id}:actions`, `authoring-response:${outline.id}:content`] } },
    select: { step: true, state: true },
  });
  const { initializeServerProviderConfig, resolveServerThinkingConfig } = await import('../src/lib/openmaic/server/provider-config');
  const { resolveModel } = await import('../src/lib/openmaic/server/resolve-model');
  const { COURSE_OUTPUT_BUDGET_VERSION } = await import('../src/lib/openmaic/generation/course-output-budget');
  await initializeServerProviderConfig();
  const model = await resolveModel({ modelString: request.generationModelString });
  secrets.add(model.apiKey);
  const snapshot: Snapshot = {
    schemaVersion: 1, requestId: randomUUID(), classroomFile: source, classroomSha256: sha(classroomBytes),
    classroomId: classroom.id, sceneId: scene.id, outlineId: outline.id, slide,
    courseId: version.templateId, templateVersionId: version.id, jobId: job.id, courseTitle: design.name,
    originalSceneSha256: valueHash(scene), originalOutlineSha256: valueHash(outline),
    policy: { modelString: model.modelString, thinking: resolveServerThinkingConfig(model.providerId, 'scene-content') ?? model.thinkingConfig,
      outputWindow: model.modelInfo?.outputWindow, budgetPolicy: COURSE_OUTPUT_BUDGET_VERSION },
    media: await snapshotMedia(scene, source, directory),
  };
  const { pageOriginalTeachingSources } = await import('../src/lib/openmaic/generation/source-grounding');
  const { resolveCourseSourceSequenceContracts } = await import('../src/lib/textbook/course-evidence-types');
  const sourceSequenceContracts = resolveCourseSourceSequenceContracts(design.content.courseEvidence, design.content.knowledgePoints);
  await save(directory, 'original-classroom.json', classroom);
  await save(directory, 'original-scene.json', scene);
  await save(directory, 'outline.json', outline);
  await save(directory, 'outlines.json', outlines);
  await save(directory, 'template.json', version);
  await save(directory, 'request.json', request);
  await save(directory, 'checkpoints.json', checkpoints);
  await save(directory, 'source-sequence-contracts.json', sourceSequenceContracts);
  await save(directory, 'original-sources.json', pageOriginalTeachingSources(outline, {
    sourceEvidence: design.content.courseEvidence, sourceKnowledgePoints: design.content.knowledgePoints, sourceSequenceContracts,
  }));
  await save(directory, 'snapshot.json', snapshot);
  return snapshot;
}

function plain(element: PPTElement | undefined): string {
  if (!element) return '';
  const record = element as unknown as { content?: string; text?: { content?: string } };
  return (record.content ?? record.text?.content ?? '').replace(/<br\s*\/?>|<\/p>/giu, '\n').replace(/<[^>]*>/gu, '')
    .replace(/&nbsp;|&#160;/giu, ' ').replace(/&amp;/giu, '&').replace(/&lt;/giu, '<').replace(/&gt;/giu, '>');
}
function compact(value: string): string { return value.replace(/[\s\p{P}\p{S}]+/gu, ''); }
/** Contiguous source wording, with a unique winner, never first-keyword guessing. */
function sharedPhrase(a: string, b: string): number {
  a = compact(a); b = compact(b);
  let best = 0;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    let length = 0;
    while (a[i + length] && a[i + length] === b[j + length]) length++;
    best = Math.max(best, length);
  }
  return best;
}
function uniqueAnchored<T>(items: T[], text: (item: T) => string, anchor?: SpeechAnchor): T | undefined {
  if (items.length === 1) return items[0];
  if (!anchor) return undefined;
  const ranked = items.map((item) => ({ item, score: sharedPhrase(text(item), anchor.quote) })).sort((a, b) => b.score - a.score);
  return ranked[0]?.score >= 6 && ranked[0].score > (ranked[1]?.score ?? 0) ? ranked[0].item : undefined;
}

/** Only target geometry changes. All speech, alignment, timing and anchors survive. */
function remapActions(original: Scene, outline: SceneOutline, content: GeneratedSlideContent, points: SourcePoint[]): {
  actions: Action[]; content: GeneratedSlideContent; mappings: TargetMapping[];
} {
  if (original.content.type !== 'slide') throw new Error('原页面不是 PPT');
  const projection = content.presentationProjection as SlidePresentationProjection | undefined;
  const old = new Map(original.content.canvas.elements.map((element) => [element.id, element]));
  const elements = [...content.elements];
  const current = new Map(elements.map((element) => [element.id, element]));
  const mappings: TargetMapping[] = [];
  const groups = new Map<string, string>();
  const target = (id: string, anchor: SpeechAnchor | undefined, actionId: string): string | undefined => {
    if (current.has(id)) return id;
    const oldText = compact(plain(old.get(id)));
    const sourcePoints = points.filter((point) => oldText.includes(compact(point.text)));
    const source = uniqueAnchored(sourcePoints, (point) => point.text, anchor);
    if (projection && source) {
      const ids = [...new Set(projection.elementIdsBySource[source.id] ?? [])].filter((item) => current.has(item));
      const items = projection.items.filter((item) => ids.includes(item.id));
      const precise = uniqueAnchored(items, (item) => `${item.label ?? ''}${item.text}`, anchor);
      if (precise) { mappings.push({ actionId, from: id, to: precise.id, sources: [source.id] }); return precise.id; }
      if (ids.length === 1) { mappings.push({ actionId, from: id, to: ids[0], sources: [source.id] }); return ids[0]; }
      if (ids.length > 1) {
        let group = groups.get(source.id);
        if (!group) {
          const boxes = ids.map((item) => current.get(item)!).filter((item) => 'width' in item && 'height' in item);
          if (boxes.length !== ids.length) return undefined;
          const left = Math.min(...boxes.map((item) => item.left)), top = Math.min(...boxes.map((item) => item.top));
          const right = Math.max(...boxes.map((item) => item.left + (item as { width: number }).width));
          const bottom = Math.max(...boxes.map((item) => item.top + (item as { height: number }).height));
          group = `redraw-source-focus-${source.id}`;
          const focus: PPTElement = { id: group, type: 'shape', left, top, width: right - left, height: bottom - top,
            rotate: 0, fill: 'transparent', fixedRatio: false, viewBox: [1, 1], path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z' };
          elements.push(focus); current.set(group, focus); groups.set(source.id, group);
        }
        mappings.push({ actionId, from: id, to: group, sources: [source.id] }); return group;
      }
    }
    const nodes = outline.visualIntent?.diagram?.nodes.filter((node) => id.endsWith(`-node-${node.id}`)
      || compact(node.label) === oldText) ?? [];
    const node = nodes.length === 1 ? nodes[0] : undefined;
    if (node) {
      const matches = elements.filter((element) => element.id.endsWith(`-node-${node.id}`)
        && compact(plain(element)) === compact(node.label));
      if (matches.length === 1) {
        mappings.push({ actionId, from: id, to: matches[0].id }); return matches[0].id;
      }
    }
    mappings.push({ actionId, from: id, diagnostic: '无法用完整原要点与讲述锚点唯一定位新版视觉目标；保留原动作并报告未解析目标' });
    return undefined;
  };
  const selector = (id: string, value?: VisualTargetSelector): VisualTargetSelector | undefined => {
    if (!value || !('quote' in value) || !value.quote) return value;
    return plain(current.get(id)).includes(value.quote) ? value : undefined;
  };
  const actions = (original.actions ?? []).map((action): Action => {
    if (action.type !== 'spotlight' && action.type !== 'laser') return structuredClone(action);
    const id = target(action.elementId, action.speechAnchor, action.id) ?? action.elementId;
    return { ...structuredClone(action), elementId: id, selector: selector(id, action.selector),
      ...(action.type === 'laser' && action.waypoints ? { waypoints: action.waypoints.map((waypoint) => {
        const mapped = target(waypoint.elementId, waypoint.speechAnchor, action.id) ?? waypoint.elementId;
        return { ...structuredClone(waypoint), elementId: mapped, selector: selector(mapped, waypoint.selector) };
      }) } : {}) };
  });
  return { actions, content: { ...content, elements }, mappings };
}
function nonVisualActions(actions: Action[] = []): unknown[] {
  return actions.map((action) => {
    if (action.type !== 'spotlight' && action.type !== 'laser') return action;
    const value: Record<string, unknown> = { ...action };
    delete value.elementId; delete value.selector;
    if (action.type === 'laser' && action.waypoints) value.waypoints = action.waypoints.map((point) => {
      const item: Record<string, unknown> = { ...point }; delete item.elementId; delete item.selector; return item;
    });
    return value;
  });
}

async function generate(directory: string, output: string, snapshot: Snapshot): Promise<void> {
  const original = await json<Scene>(path.join(directory, 'original-scene.json'));
  const outline = await json<SceneOutline>(path.join(directory, 'outline.json'));
  if (original.type !== 'slide' || original.content.type !== 'slide') throw new Error('原页面不是 PPT');
  assertOriginalSlideSnapshot(original, outline, snapshot);
  if (await fs.stat(path.join(output, 'generation-started.json')).catch(() => null)) throw new Error('此请求已经开始；禁止隐式重发，请用已保存的生成结果');
  const version = await json<{ snapshot: { design: PblTemplateDesign } }>(path.join(directory, 'template.json'));
  const design = version.snapshot.design;
  const outlines = await json<SceneOutline[]>(path.join(directory, 'outlines.json'));
  const request = await json<Request>(path.join(directory, 'request.json'));
  const { initializeServerProviderConfig } = await import('../src/lib/openmaic/server/provider-config');
  const { resolveModel } = await import('../src/lib/openmaic/server/resolve-model');
  const { createCourseGenerationAiCall, withCourseGenerationAiCallContext } = await import('../src/lib/openmaic/server/course-generation-ai-call');
  const { createCourseOutputBudget, COURSE_OUTPUT_BUDGET_VERSION, resolveCourseExecutionBudgetOptions } = await import('../src/lib/openmaic/generation/course-output-budget');
  const { runWithCourseGenerationLlmContext } = await import('../src/lib/course-generation/llm-concurrency');
  const { generateOpenMaicBaselineContent } = await import('../src/lib/openmaic/generation/openmaic-baseline');
  const { withTeachingSlideGuidance } = await import('../src/lib/openmaic/generation/teaching-narration');
  const { measureAuthoredSlideText, closeSpatialMeasurementBrowser } = await import('../src/lib/openmaic/generation/slide-spatial-measurement');
  const { adoptedPageAuthoringContent } = await import('../src/lib/openmaic/generation/adopted-page-content');
  const { resolveLlmRequestTimeoutMs } = await import('../src/lib/llm/request-policy');
  await initializeServerProviderConfig();
  const model = await resolveModel({ modelString: snapshot.policy.modelString });
  secrets.add(model.apiKey);
  if (model.modelString !== snapshot.policy.modelString || model.modelInfo?.outputWindow !== snapshot.policy.outputWindow
    || COURSE_OUTPUT_BUDGET_VERSION !== snapshot.policy.budgetPolicy) throw new Error('原模型或输出容量策略发生变化');
  const requestEvents: unknown[] = [], usage: unknown[] = [];
  let rawIndex = 0;
  const aiCall = createCourseGenerationAiCall({
    model: model.model, vision: model.modelInfo?.capabilities?.vision === true,
    source: 'scene-content', thinking: snapshot.policy.thinking,
    outputBudget: createCourseOutputBudget({ resource: 'slide', modelOutputWindow: snapshot.policy.outputWindow, thinking: snapshot.policy.thinking }),
    timeoutMs: resolveLlmRequestTimeoutMs('long-generation'), executionBudget: resolveCourseExecutionBudgetOptions(),
    maxRetries: 1, streamResponse: true, responseFormat: 'json', requireResponsePersistence: true,
    onResponse: (response) => save(output, `model-responses/${String(++rawIndex).padStart(3, '0')}.json`, response),
  });
  // Each projection/review/layout call owns a fresh execution context; all use
  // the unchanged production model, thinking and slide-output budget policy.
  const trackedCall = (system: string, prompt: string, images?: Array<{ id: string; src: string }>) => withCourseGenerationAiCallContext(aiCall, {
    onStarted: (event) => { requestEvents.push(event); },
  })(system, prompt, images);
  const selectedImageIds = new Set([...(outline.suggestedImageIds ?? []), ...(outline.visualIntent?.resourceRefs ?? []).map((item) => item.resourceId)]);
  const assignedImages = (request.textbookImages ?? []).filter((image) => selectedImageIds.has(image.id));
  const originalImages = original.content.canvas.elements.filter((item) => item.type === 'image').map((item) => ({ id: item.id, src: item.src }));
  const generatedMediaMapping = Object.fromEntries(originalImages.flatMap((image) => [
    [image.id, image.src], [`gen_img_${image.id}`, image.src],
  ]));
  const sourceSequenceContracts = await json<NonNullable<Parameters<typeof generateOpenMaicBaselineContent>[2]>['sourceSequenceContracts']>(path.join(directory, 'source-sequence-contracts.json'));
  const sourceOptions = { sourceEvidence: design.content.courseEvidence, sourceKnowledgePoints: design.content.knowledgePoints, sourceSequenceContracts };
  const failedDrafts: unknown[] = [];
  await save(output, 'generation-started.json', { requestId: snapshot.requestId, startedAt: new Date().toISOString(), selectedPage: snapshot.outlineId, policy: snapshot.policy });
  try {
    const generated = await runWithCourseGenerationLlmContext(() => generateOpenMaicBaselineContent(outline,
      withTeachingSlideGuidance(trackedCall, outline), {
        componentAuthoring: true, slideAuthoring: 'native', textMeasure: measureAuthoredSlideText, visualProjection: true,
        visualBaseline: original.content.canvas,
        websiteReferenceContext: { courseTitle: snapshot.courseTitle, slideTitles: outlines.filter((item) => item.type === 'slide').map((item) => item.title) },
        assignedImages, imageMapping: Object.fromEntries(assignedImages.map((image) => [image.id, image.publicSrc ?? image.src])), generatedMediaMapping,
        visionEnabled: model.modelInfo?.capabilities?.vision === true, languageDirective: request.languageDirective,
        ...sourceOptions, onFailure: (failure) => { failedDrafts.push(failure); },
      }), { onCallUsage: async (call) => { usage.push(call); await save(output, 'model-usage.json', usage); } });
    await save(output, 'model-request-policies.json', requestEvents);
    await save(output, 'generation-diagnostics.json', failedDrafts);
    if (!generated || !('elements' in generated) || generated.continuationPages?.length) throw new Error('所选单页没有产生可执行的完整原生页面；保留原稿和生成诊断');
    await save(output, 'generated-content.json', generated);
    const retainedImageSources = new Set(generated.elements.filter((item) => item.type === 'image').map((item) => item.src));
    if (originalImages.some((image) => !retainedImageSources.has(image.src))) throw new Error('重绘草稿未保留原图片绑定；保留原稿与候选，不接受删图结果');
    const points = [...adoptedPageAuthoringContent(outline), ...(outline.visualIntent?.diagram?.annotation ? [{ id: 'diagram-annotation', text: outline.visualIntent.diagram.annotation }] : [])];
    const mapped = remapActions(original, outline, generated, points);
    const canvas = original.content.type === 'slide' ? original.content.canvas : undefined;
    if (!canvas) throw new Error('原画布缺失');
    const after: Scene = { ...structuredClone(original), type: 'slide', actions: mapped.actions, content: { type: 'slide', canvas: {
      ...canvas, ...mapped.content, id: canvas.id, viewportSize: canvas.viewportSize, viewportRatio: canvas.viewportRatio,
      theme: mapped.content.theme ?? { ...canvas.theme, fontName: 'Noto Sans SC' },
    } } };
    const preserved = valueHash(nonVisualActions(original.actions)) === valueHash(nonVisualActions(after.actions));
    if (!preserved) throw new Error('讲稿、音频、锚点或动作时间发生变化');
    await save(output, 'after-scene.json', after);
    const originalClassroom = await json<PersistedClassroomData>(path.join(directory, 'original-classroom.json'));
    const afterClassroom = { ...originalClassroom, scenes: originalClassroom.scenes.map((scene) => scene.id === original.id ? after : scene) };
    await save(output, 'after-classroom.json', afterClassroom);
    await save(output, 'action-target-mapping.json', mapped.mappings);
    const afterImages = mapped.content.elements.filter((item) => item.type === 'image').map((item) => ({ id: item.id, src: item.src }));
    await save(output, 'invariants.json', { selectedPageOnly: true, originalSceneHash: valueHash(original),
      narrationAudioTimingAndAnchorsPreserved: preserved, pageOrderPreserved: after.order === original.order,
      pageDurationPreserved: after.targetDurationSec === original.targetDurationSec,
      allOtherPagesPreserved: originalClassroom.scenes.every((scene, index) => scene.id === original.id || valueHash(scene) === valueHash(afterClassroom.scenes[index])),
      originalImages, afterImages, unresolvedVisualTargets: mapped.mappings.filter((item) => item.diagnostic),
      projectionVerified: generated.presentationProjection?.verified ?? false,
      providerCalls: usage.length, narrationCalls: 0, audioCalls: 0, mediaCalls: 0, entireCourseQualityVerified: false,
      historicalRequestPolicyAvailable: false,
      budgetVerification: 'Same teacher-selected model and production scene-content thinking/output-budget policy; the original job did not persist historical numeric request policy.',
    });
  } catch (error) {
    await save(output, 'model-request-policies.json', requestEvents);
    await save(output, 'generation-diagnostics.json', failedDrafts);
    await save(output, 'generation-error.json', { error: safeError(error), originalDraftPreserved: true, implicitRetry: false });
    throw error;
  } finally { await closeSpatialMeasurementBrowser(); }
}

async function render(directory: string, output: string): Promise<void> {
  const args = [path.join(repository, 'scripts/render-slide-comparison.mjs'), '--before', path.join(directory, 'original-scene.json'),
    '--snapshot-dir', directory, '--output', output,
    ...(await fs.stat(path.join(output, 'after-scene.json')).catch(() => null) ? ['--after', path.join(output, 'after-scene.json')] : []),
    ...(arg('--storage-state') ? ['--storage-state', path.resolve(arg('--storage-state')!)] : []),
    ...(arg('--base-url') ? ['--base-url', arg('--base-url')!] : []),
  ];
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: repository, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', (status) => resolve(status ?? 1));
  });
  if (code) throw new Error('单页真实渲染截图失败，生成结果已保留');
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log('单页 PPT 重绘：--output <.openpbl-runtime 下新目录> [--classroom <课堂 JSON>] [--slide 19] [--course-id <模板>] [--job-id <原内容任务>] [--snapshot-dir <已保存快照>] [--deployment-secrets] [--generate] [--no-render] [--storage-state <授权浏览器状态>] [--base-url http://127.0.0.1:3000]\n默认只读保存来源快照并截图；--generate 只生成选定 PPT，讲稿/音频/媒体/课程不写入。新模型调用须使用新输出目录。');
    return;
  }
  const allowed = new Set(['--output', '--classroom', '--slide', '--course-id', '--job-id', '--snapshot-dir', '--deployment-secrets', '--generate', '--no-render', '--storage-state', '--base-url']);
  for (const value of process.argv.slice(2)) if (value.startsWith('--') && !allowed.has(value)) throw new Error(`未知参数 ${value}`);
  if (!arg('--output')) throw new Error('需要独立 --output 目录');
  const output = runtimePath(arg('--output')!);
  if (await fs.stat(output).catch(() => null)) throw new Error('输出目录已经存在；禁止覆盖先前快照或隐式重发');
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const directory = path.join(output, 'snapshot');
  let snapshot: Snapshot;
  try {
    if (arg('--snapshot-dir')) {
      const source = runtimePath(arg('--snapshot-dir')!);
      if (source === output || source.startsWith(output + path.sep)) throw new Error('输出不能包含输入快照');
      await fs.cp(source, directory, { recursive: true });
      snapshot = await json<Snapshot>(path.join(directory, 'snapshot.json'));
      if (snapshot.schemaVersion !== 1) throw new Error('无法识别的单页快照版本');
      snapshot.requestId = randomUUID();
      await save(directory, 'snapshot.json', snapshot);
      if (process.argv.includes('--generate')) await initializeReadOnlyDatabase();
    } else {
      await initializeReadOnlyDatabase();
      snapshot = await prepareSnapshot(directory);
    }
    // Fail-safe redirection before any production modules are imported. The
    // baseline content entrypoint itself has no classroom persistence path.
    process.env.CLASSROOM_DATA_DIR = path.join(output, 'isolated-classrooms');
    if (process.argv.includes('--generate')) await generate(directory, output, snapshot);
    if (!process.argv.includes('--no-render')) await render(directory, output);
    const sourceUnchanged = sha(await fs.readFile(snapshot.classroomFile)) === snapshot.classroomSha256;
    await save(output, 'source-preservation.json', { originalClassroomFileUnchanged: sourceUnchanged, originalClassroomFile: snapshot.classroomFile });
    if (!sourceUnchanged) throw new Error('原课堂在运行期间发生外部变动；结果保留，不能声明快照相同');
    console.log(JSON.stringify({ output, slide: snapshot.slide, outlineId: snapshot.outlineId,
      generated: process.argv.includes('--generate'), originalClassroomUnchanged: true }));
  } finally { await disconnect(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(safeError(error)); process.exitCode = 1; });
}

export { remapActions, nonVisualActions, runReadOnlyDatabaseOperation, assertOriginalSlideSnapshot };
