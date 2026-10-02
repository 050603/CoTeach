/** Isolated history-page content + real production narration integration.
 * NODE_OPTIONS=--conditions=import pnpm exec tsx scripts/verify-teaching-slide-redesign.ts \
 *   --model-input=.openpbl-runtime/teaching-visuals/model-20261002-v2 \
 *   --output=.openpbl-runtime/teaching-visuals/history-new-directory --deployment-secrets
 * Content reuses the saved original-page-19 response. Narration is one actual
 * section request using the deployed scene-actions route and production budget.
 * --narration-replay=<saved-history-dir> --expect-retained-draft instead uses
 * its saved real narration response, with zero provider calls, to verify guards.
 * This tool never saves a classroom, writes DB data, generates audio or media.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PersistedClassroomData } from '../src/lib/openmaic/server/classroom-storage';
import type { SceneOutline, GeneratedSlideContent } from '../src/lib/openmaic/types/generation';
import type { TeachingVisualRedesign } from '../src/lib/openmaic/agent/tools/redesign-teaching-slide';
import type { SceneContext } from '../src/lib/openmaic/agent/tools/regenerate-scene-actions';
import type { PblTemplateDesign } from '../src/lib/platform/pbl-template';
import { deployedReadOnlyEnvironment } from './benchmark-teaching-visuals';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map(process.argv.slice(2).map((item) => {
  const [key, ...values] = item.replace(/^--/, '').split('=');
  return [key, values.join('=') || 'true'];
}));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const secrets = new Set<string>();
function safe(error: unknown): string {
  let value = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) value = value.split(secret).join('[redacted]');
  return value.replace(/(?:postgres(?:ql)?|https?):\/\/[^\s/@]+:[^\s/@]+@/giu, '[redacted-url]@')
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]');
}
async function json<T>(filename: string): Promise<T> { return JSON.parse(await fs.readFile(filename, 'utf8')) as T; }
async function save(directory: string, filename: string, value: unknown): Promise<void> {
  const target = path.join(directory, filename);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(value, (_key, item) => {
    if (typeof item !== 'string') return item;
    for (const secret of secrets) if (secret && item.includes(secret)) return '[redacted]';
    return item;
  }, 2) + '\n', { mode: 0o600 });
}
function isolated(value: string): string {
  const result = path.resolve(root, value);
  if (!result.startsWith(path.join(root, '.openpbl-runtime') + path.sep)) throw new Error('输入输出必须位于 .openpbl-runtime 隔离目录');
  return result;
}
const implementationFiles = [
  'packages/@openmaic/dsl/src/teaching-visual.ts',
  'src/lib/openmaic/agent/tools/redesign-teaching-slide.ts',
  'src/lib/openmaic/generation/scene-generator.ts',
  'src/lib/openmaic/generation/openmaic-baseline.ts',
  'src/lib/openmaic/generation/teaching-visual-scene.ts',
  'src/lib/openmaic/generation/teaching-visual-arithmetic.ts',
  'src/lib/openmaic/generation/teaching-visual-compiler.ts',
  'src/lib/openmaic/generation/teaching-visual-theme.ts',
  'src/lib/openmaic/generation/compiled-slide-pages.ts',
  'src/lib/openmaic/generation/teaching-narration.ts',
  'src/lib/openmaic/generation/semantic-visual-cues.ts',
  'src/lib/openmaic/generation/activity-gate.ts',
  'scripts/verify-teaching-slide-redesign.ts',
  'scripts/benchmark-teaching-visuals.ts',
];
async function fingerprint(): Promise<string> {
  return hash(JSON.stringify(await Promise.all(implementationFiles.map(async (filename) => ({ filename, content: await fs.readFile(path.join(root, filename), 'utf8') })))));
}
async function audioManifest(classroom: PersistedClassroomData, sourceFilename: string, excludedId: string) {
  const folder = path.dirname(sourceFilename), entries = new Map<string, { url: string; filename: string; sha256?: string; unavailable?: string }>();
  for (const scene of classroom.scenes.filter((page) => page.id !== excludedId)) {
    for (const action of scene.actions ?? []) {
      if (action.type !== 'speech' || !action.audioUrl || entries.has(action.audioUrl)) continue;
      const pathname = new URL(action.audioUrl, 'http://localhost').pathname;
      const prefix = '/api/openmaic/classroom-media/';
      if (!pathname.startsWith(prefix)) {
        entries.set(action.audioUrl, { url: action.audioUrl, filename: '', unavailable: '非本地课堂媒体，仅核对原URL绑定未改' });
        continue;
      }
      const filename = path.resolve(folder, pathname.slice(prefix.length).split('/').map(decodeURIComponent).join('/'));
      if (!filename.startsWith(folder + path.sep)) throw new Error('原音频存在越界路径');
      try { entries.set(action.audioUrl, { url: action.audioUrl, filename, sha256: hash(await fs.readFile(filename)) }); }
      catch (error) { entries.set(action.audioUrl, { url: action.audioUrl, filename, unavailable: safe(error) }); }
    }
  }
  return [...entries.values()];
}

/** Read the actual local PCM bytes; the saved action duration alone is not a measurement. */
function pcmWavTiming(bytes: Buffer): { durationSec: number; sampleRate: number; frames: number } {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('原音频不是可核对的 RIFF/WAVE');
  let sampleRate = 0, blockAlign = 0, dataBytes = 0;
  for (let cursor = 12; cursor + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', cursor, cursor + 4), size = bytes.readUInt32LE(cursor + 4);
    const start = cursor + 8;
    if (start + size > bytes.length) throw new Error('原 WAV chunk 不完整');
    if (kind === 'fmt ') {
      if (size < 16 || bytes.readUInt16LE(start) !== 1) throw new Error('原 WAV 不是 PCM，不能把文件长度当作音频实测');
      sampleRate = bytes.readUInt32LE(start + 4);
      blockAlign = bytes.readUInt16LE(start + 12);
    }
    if (kind === 'data') dataBytes += size;
    cursor = start + size + size % 2;
  }
  if (!sampleRate || !blockAlign || !dataBytes || dataBytes % blockAlign) throw new Error('原 PCM 采样信息不可用');
  const frames = dataBytes / blockAlign;
  return { durationSec: frames / sampleRate, sampleRate, frames };
}

async function main(): Promise<void> {
  if (!args.get('output')) throw new Error('需要新的 --output；禁止覆盖以往结果');
  const output = isolated(args.get('output')!), input = isolated(args.get('model-input') ?? '.openpbl-runtime/teaching-visuals/model-20261002-v2');
  const narrationReplay = args.get('narration-replay') ? isolated(args.get('narration-replay')!) : undefined;
  const expectRetainedDraft = args.get('expect-retained-draft') === 'true';
  if (expectRetainedDraft && !narrationReplay) throw new Error('保留原稿验证必须重放保存的真实讲稿，禁止补发模型');
  if (await fs.stat(output).catch(() => null)) throw new Error('输出目录已存在，不能隐式重跑实际讲稿模型');
  const snapshotDirectory = isolated(args.get('snapshot-dir') ?? '.openpbl-runtime/slide-redraw/single-pass-20261002/snapshot');
  const snapshot = await json<{ classroomFile: string; classroomSha256: string; sceneId: string; outlineId: string; originalOutlineSha256: string; policy: { modelString: string } }>(path.join(snapshotDirectory, 'snapshot.json'));
  const classroomBytes = await fs.readFile(snapshot.classroomFile), classroom = JSON.parse(classroomBytes.toString()) as PersistedClassroomData;
  if (hash(classroomBytes) !== snapshot.classroomSha256) throw new Error('原课堂已改变，不能用旧快照联调');
  const outline = await json<SceneOutline>(path.join(snapshotDirectory, 'outline.json'));
  const allOutlines = await json<SceneOutline[]>(path.join(snapshotDirectory, 'outlines.json'));
  const sourceVersion = await json<{ snapshot: { design: PblTemplateDesign } }>(path.join(snapshotDirectory, 'template.json'));
  const sourceSequenceContracts = await json<NonNullable<SceneContext['teachingSources']>['sourceSequenceContracts']>(path.join(snapshotDirectory, 'source-sequence-contracts.json'));
  const snapshotInputs = ['outline.json', 'outlines.json', 'template.json', 'source-sequence-contracts.json', 'original-scene.json'];
  const snapshotInputFingerprint = async () => hash(JSON.stringify(await Promise.all(snapshotInputs.map(async (filename) => ({ filename,
    sha256: hash(await fs.readFile(path.join(snapshotDirectory, filename))) })))));
  const sourceInputSha256 = await snapshotInputFingerprint();
  if (hash(JSON.stringify(outline)) !== snapshot.originalOutlineSha256) throw new Error('原大纲身份不匹配');
  const scene = classroom.scenes.find((page) => page.id === snapshot.sceneId);
  if (!scene || scene.content.type !== 'slide' || scene.outlineId !== outline.id) throw new Error('原页身份或可编辑内容不匹配');
  const outlineById = new Map(allOutlines.map((page) => [page.id, page]));
  const sectionNarrations: NonNullable<SceneContext['sectionNarrations']> = classroom.scenes
    .filter((page) => outlineById.get(page.outlineId ?? '')?.lectureSectionId === outline.lectureSectionId)
    .sort((a, b) => a.order - b.order)
    .map((page) => ({ sceneId: page.id, outlineId: page.outlineId!, title: page.title, current: page.id === scene.id,
      speeches: (page.actions ?? []).filter((action) => action.type === 'speech' && action.text.trim())
        .map((action) => ({ id: action.id, text: action.type === 'speech' ? action.text : '' })) }));
  const currentNarrationIndex = sectionNarrations.findIndex((page) => page.current);
  if (currentNarrationIndex < 0 || sectionNarrations.filter((page) => page.current).length !== 1) throw new Error('真实小节讲稿中缺少唯一当前页，禁止伪造已讲定义');
  const originalPageAudio = await Promise.all((scene.actions ?? []).filter((action) => action.type === 'speech' && action.text.trim()).map(async (action) => {
    if (action.type !== 'speech' || !action.audioUrl) throw new Error('原页真实音频绑定缺失，不能推断授课速度');
    const pathname = new URL(action.audioUrl, 'http://localhost').pathname, prefix = '/api/openmaic/classroom-media/';
    if (!pathname.startsWith(prefix)) throw new Error('原页语速参考必须来自已有本地音频');
    const folder = path.dirname(snapshot.classroomFile);
    const filename = path.resolve(folder, pathname.slice(prefix.length).split('/').map(decodeURIComponent).join('/'));
    if (!filename.startsWith(folder + path.sep)) throw new Error('原音频语速参考路径越界');
    const bytes = await fs.readFile(filename), timing = pcmWavTiming(bytes);
    if (!action.audioDurationSec || Math.abs(action.audioDurationSec - timing.durationSec) > 0.001) throw new Error('原音频采样实测与保存播放时长不一致，不能静默改变原讲稿上下文');
    return { speechId: action.id, text: action.text, speechChars: action.text.length, url: action.audioUrl, filename,
      sha256: hash(bytes), savedDurationSec: action.audioDurationSec, ...timing };
  }));
  if (!originalPageAudio.length) throw new Error('原页没有真实讲稿和音频参考');
  const modelCallsFilename = path.join(input, 'attempts/original-page-19-1/calls.json');
  const modelCallsBytes = await fs.readFile(modelCallsFilename);
  const originalCalls = JSON.parse(modelCallsBytes.toString()) as Array<{ response?: string }>;
  const contentResponse = originalCalls[0]?.response;
  if (!contentResponse) throw new Error('保存的真实原19页模型响应缺失；禁止补发内容模型');
  const narrationCallsFilename = narrationReplay ? path.join(narrationReplay, 'narration-calls.json') : undefined;
  const narrationCallsBytes = narrationCallsFilename ? await fs.readFile(narrationCallsFilename) : undefined;
  const replayedNarration = narrationCallsBytes ? (JSON.parse(narrationCallsBytes.toString()) as Array<{ response?: string }>)[0]?.response : undefined;
  if (narrationReplay && !replayedNarration) throw new Error('保存的真实讲稿响应缺失，禁止回放占位讲稿');
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  await fs.cp(snapshotDirectory, path.join(output, 'source-snapshot'), { recursive: true });
  await save(output, 'saved-content-calls.json', originalCalls);
  if (narrationCallsBytes) await fs.writeFile(path.join(output, 'saved-narration-calls.json'), narrationCallsBytes, { mode: 0o600 });
  await save(output, 'original-section-narrations.json', { sectionId: outline.lectureSectionId, currentNarrationIndex,
    precedingActualSpeechChars: sectionNarrations.slice(0, currentNarrationIndex).flatMap((page) => page.speeches).reduce((sum, speech) => sum + speech.text.length, 0),
    pages: sectionNarrations, scope: '按原课堂顺序读取；只有 current 之前真实已播放讲稿可用于已讲定义核对；后续页面仅作只读上下文。' });
  await save(output, 'original-page-audio.json', originalPageAudio);
  const implementationSha256 = await fingerprint();
  const originalAudio = await audioManifest(classroom, snapshot.classroomFile, scene.id);
  await save(output, 'original-sibling-audio.json', originalAudio);
  const contentCalls: Array<{ stage: string; prompt: string; systemSha256: string; responseSha256: string }> = [];
  const actionCalls: Array<{ stage: string; prompt: string; systemSha256: string; response?: string; error?: string }> = [];
  const policies: unknown[] = [], usages: unknown[] = [];
  let rawNarrationResponses = 0, replayedNarrationResponses = 0;
  const metadata: Record<string, unknown> = { schemaVersion: 1,
    mode: narrationReplay ? 'history-page-saved-narration-guard-replay' : 'history-page-content-and-real-narration', startedAt: new Date().toISOString(),
    implementationSha256, sourceInputSha256, sourceClassroom: snapshot.classroomFile, sourceSceneId: scene.id, sourceOutlineId: outline.id,
    content: { mode: 'deterministic-real-response-replay', responseSha256: hash(contentResponse), originalModelDirectory: input, providerCalls: 0 },
    narration: narrationReplay ? { mode: 'deterministic-real-response-replay', originalHistoryDirectory: narrationReplay,
      responseSha256: hash(replayedNarration!), providerCalls: 0, wholeSectionRequest: true }
      : { mode: 'actual-production-model', route: 'scene-actions', wholeSectionRequest: true },
    databaseWrites: 0, classroomWrites: 0, audioCalls: 0, mediaGenerationCalls: 0, teacherAcceptance: 'pending', fullStudentScreenReview: 'not-run' };
  await save(output, 'metadata.json', metadata);
  let result: Awaited<ReturnType<typeof import('../src/lib/openmaic/agent/tools/redesign-teaching-slide')['redesignTeachingSlide']>> | undefined;
  let failure: string | undefined;
  const checks: Record<string, unknown> = {};
  try {
    const { runWithCourseGenerationLlmContext } = await import('../src/lib/course-generation/llm-concurrency');
    const { redesignTeachingSlide } = await import('../src/lib/openmaic/agent/tools/redesign-teaching-slide');
    const { buildCompleteScene } = await import('../src/lib/openmaic/generation/scene-builder');
    const { getDefaultAgents } = await import('../src/lib/openmaic/orchestration/registry/store');
    const { isValidSlideVisualTarget } = await import('../src/lib/openmaic/generation/semantic-visual-cues');
    const { findSpeechCueAnchorRange } = await import('../src/lib/openmaic/generation/speech-cue-boundaries');
    const { estimateSpeechDurationSec } = await import('../src/lib/openmaic/audio/tts-timing');
    const originalDefaultEstimatedDurationSec = originalPageAudio.reduce((sum, audio) => sum + estimateSpeechDurationSec(audio.text), 0);
    const originalMeasuredDurationSec = originalPageAudio.reduce((sum, audio) => sum + audio.durationSec, 0);
    const originalSpeakerCalibrationRatio = originalMeasuredDurationSec / originalDefaultEstimatedDurationSec;
    await save(output, 'original-timing-reference.json', { originalMeasuredDurationSec, originalDefaultEstimatedDurationSec,
      originalSpeechChars: originalPageAudio.reduce((sum, audio) => sum + audio.speechChars, 0), originalSpeakerCalibrationRatio,
      method: '实际原 WAV PCM frames/sampleRate；新讲稿只按同一原 speaker 的实测/默认估计比例校准估计，不是新音频实测。' });
    let invokeNarration: (system: string, prompt: string) => Promise<string>;
    if (narrationReplay) {
      invokeNarration = async () => {
        replayedNarrationResponses++;
        await save(output, 'replayed-narration-response.json', { response: replayedNarration!, responseSha256: hash(replayedNarration!),
          originalHistoryDirectory: narrationReplay, providerCalls: 0 });
        return replayedNarration!;
      };
    } else {
      await deployedReadOnlyEnvironment();
      for (const name of ['DATABASE_URL', 'PROVIDER_CONFIG_DATABASE_URL', 'PROVIDER_ENCRYPTION_KEY']) if (process.env[name]) secrets.add(process.env[name]!);
      const { initializeServerProviderConfig, resolveServerThinkingConfig } = await import('../src/lib/openmaic/server/provider-config');
      const { resolveModel } = await import('../src/lib/openmaic/server/resolve-model');
      const { createCourseGenerationAiCall, withCourseGenerationAiCallContext } = await import('../src/lib/openmaic/server/course-generation-ai-call');
      const { createCourseOutputBudget, COURSE_OUTPUT_BUDGET_VERSION, resolveCourseExecutionBudgetOptions } = await import('../src/lib/openmaic/generation/course-output-budget');
      const { MAX_COURSE_STAGE_MODEL_REQUESTS } = await import('../src/lib/openmaic/generation/course-generation-policy');
      const { resolveLlmRequestTimeoutMs } = await import('../src/lib/llm/request-policy');
      await initializeServerProviderConfig();
      const model = await resolveModel({ stage: 'scene-actions', modelString: snapshot.policy.modelString });
      secrets.add(model.apiKey);
      const thinking = model.thinkingConfig ?? resolveServerThinkingConfig(model.providerId, 'scene-actions');
      metadata.narration = { mode: 'actual-production-model', route: 'scene-actions', modelString: model.modelString, thinking,
        outputWindow: model.modelInfo?.outputWindow, budgetPolicy: COURSE_OUTPUT_BUDGET_VERSION, unchangedProductionBudget: true,
        wholeSectionRequest: true, retries: MAX_COURSE_STAGE_MODEL_REQUESTS - 1 };
      await save(output, 'metadata.json', metadata);
      const actionAi = createCourseGenerationAiCall({ model: model.model, vision: false, source: 'scene-actions', thinking,
        outputBudget: createCourseOutputBudget({ resource: 'actions', modelOutputWindow: model.modelInfo?.outputWindow, thinking }),
        timeoutMs: resolveLlmRequestTimeoutMs('long-generation'), executionBudget: resolveCourseExecutionBudgetOptions(),
        maxRetries: MAX_COURSE_STAGE_MODEL_REQUESTS - 1, streamResponse: true, requireResponsePersistence: true,
        onResponse: (response) => save(output, `raw-narration/${String(++rawNarrationResponses).padStart(3, '0')}.json`, response) });
      invokeNarration = (system, prompt) => withCourseGenerationAiCallContext(actionAi, { onStarted: (policy) => { policies.push(policy); } })(system, prompt);
    }
    const context: SceneContext = { outline, allOutlines, content: scene.content, actions: scene.actions, sectionNarrations, stageId: scene.stageId,
      agents: getDefaultAgents().filter((agent) => classroom.stage.agentIds?.includes(agent.id)), languageDirective: classroom.stage.languageDirective,
      teachingSources: { sourceEvidence: sourceVersion.snapshot.design.content.courseEvidence,
        sourceKnowledgePoints: sourceVersion.snapshot.design.content.knowledgePoints, sourceSequenceContracts } };
    const baseline: GeneratedSlideContent = { elements: scene.content.canvas.elements, background: scene.content.canvas.background,
      theme: scene.content.canvas.theme, teachingVisual: scene.content.canvas.teachingVisual, presentationProjection: scene.content.canvas.presentationProjection };
    await save(output, 'input.json', { context, imageResources: { baseline, assignedImages: [], imageMapping: {} } });
    result = await runWithCourseGenerationLlmContext(() => redesignTeachingSlide({ context, instruction: '围绕学习者支持逐步退出和真实五环节重新构图；允许有界拆页，保留全部原始教学责任、来源、条件及总97秒。',
      imageResources: { baseline, assignedImages: [], imageMapping: {} }, deps: { getSceneContext: () => context,
        aiCall: async (stage, system, prompt) => {
          if (stage === 'scene-content:slide') {
            if (contentCalls.length) throw new Error('内容仅允许回放保存的第一response一次');
            contentCalls.push({ stage, prompt, systemSha256: hash(system), responseSha256: hash(contentResponse) });
            await save(output, 'content-replay-calls.json', contentCalls); return contentResponse;
          }
          if (stage !== 'scene-actions' || actionCalls.length) throw new Error('讲稿联调仅允许一次真实小节请求；保留失败，不自动再次生成');
          const call: typeof actionCalls[number] = { stage, prompt, systemSha256: hash(system) };
          actionCalls.push(call);
          await save(output, 'narration-calls.json', actionCalls);
          try { call.response = await invokeNarration(system, prompt); return call.response; }
          catch (error) { call.error = safe(error); throw error; }
          finally { await save(output, 'narration-calls.json', actionCalls); await save(output, 'policies.json', policies); }
        } } }), { onCallUsage: async (usage) => { usages.push(usage); await save(output, 'usage.json', usages); } });
    await save(output, 'redesign-result.json', result);
    if (!result.visualRedesign) {
      if (!expectRetainedDraft) throw new Error(`联调保留了原页，未产生可应用新内容：${result.message}`);
      const inputContext = (await json<{ context: SceneContext }>(path.join(output, 'input.json'))).context;
      const originalContentAndActionsUnchanged = hash(JSON.stringify({ content: context.content, actions: context.actions }))
        === hash(JSON.stringify({ content: inputContext.content, actions: inputContext.actions }));
      Object.assign(checks, { retainedOriginalDraft: true, diagnostic: result.message, generatedPagesApplied: 0,
        originalContentAndActionsUnchanged, originalTargetDurationSec: outline.targetDurationSec,
        originalMeasuredDurationSec, contentReplayCalls: contentCalls.length, narrationReplayCalls: actionCalls.length,
        acceptance: { structuralPassed: originalContentAndActionsUnchanged && contentCalls.length === 1 && actionCalls.length === 1
          && replayedNarrationResponses === 1 && rawNarrationResponses === 0 && Boolean(result.message) } });
      await save(output, 'retained-original-classroom.json', classroom);
      await save(output, 'retained-original-outlines.json', allOutlines);
      await save(output, 'checks.json', checks);
      if (!(checks.acceptance as { structuralPassed: boolean }).structuralPassed) throw new Error('零provider保留原稿合同未通过');
      console.log(JSON.stringify({ retainedOriginalDraft: true, providerCalls: 0, diagnostic: result.message }));
      return;
    }
    if (expectRetainedDraft) throw new Error('已保存明显超时讲稿仍被采用，保留原稿守卫未通过');
    const redesign: TeachingVisualRedesign = result.visualRedesign;
    const pages = redesign.pages;
    const localScenes = pages.map((page, index) => {
      const generated = buildCompleteScene(page.outline, page.content, page.actions, scene.stageId);
      if (!generated) throw new Error('局部新页无法构建执行场景');
      // Match the client range transaction: its first replacement preserves
      // the existing scene identity; only continuations receive new identities.
      return { ...generated, ...(index === 0 ? { id: scene.id } : {}),
        lectureSectionId: page.outline.lectureSectionId, lectureSectionTitle: page.outline.lectureSectionTitle };
    });
    const scenes = classroom.scenes.flatMap((item) => item.id === scene.id ? localScenes : [item]).map((item, order) => ({ ...item, order }));
    await save(output, 'isolated-classroom.json', { ...classroom, scenes });
    const progression = allOutlines.flatMap((item) => item.id === outline.id ? pages.map((page) => page.outline) : [item]).map((item, order) => ({ ...item, order }));
    await save(output, 'isolated-outlines.json', progression);
    const pageChecks = pages.map((page) => {
      const speeches = page.actions.filter((action) => action.type === 'speech');
      const speechById = new Map(speeches.map((speech) => [speech.id, speech]));
      const cues = page.actions.filter((action) => action.type === 'spotlight' || action.type === 'laser');
      const cueChecks = cues.map((cue) => {
        const speech = cue.speechId ? speechById.get(cue.speechId) : undefined;
        const endSpeech = cue.type === 'spotlight' && cue.endSpeechId ? speechById.get(cue.endSpeechId) : speech;
        return { id: cue.id, type: cue.type, elementId: cue.elementId,
          targetExists: isValidSlideVisualTarget(page.content.elements, cue), speechExists: Boolean(speech?.text.trim()),
          anchorExists: Boolean(speech && cue.speechAnchor && findSpeechCueAnchorRange(speech.text, cue.speechAnchor)),
          endSpeechExists: Boolean(endSpeech?.text.trim()),
          endAnchorExists: !cue.endSpeechAnchor || Boolean(endSpeech && findSpeechCueAnchorRange(endSpeech.text, cue.endSpeechAnchor)),
          waypointsValid: cue.type !== 'laser' || (cue.waypoints ?? []).every((waypoint) => isValidSlideVisualTarget(page.content.elements, waypoint)
            && (!waypoint.speechAnchor || Boolean(speech && findSpeechCueAnchorRange(speech.text, waypoint.speechAnchor)))) };
      });
      return { pageId: page.outline.id, title: page.outline.title, targetDurationSec: page.outline.targetDurationSec,
        lectureSectionId: page.outline.lectureSectionId, knowledgePointIds: page.outline.knowledgePointIds,
        nonemptySpeech: speeches.length > 0 && speeches.every((speech) => Boolean(speech.text.trim())), speechCount: speeches.length,
        estimatedSpeechDurationSec: speeches.reduce((total, speech) => total + estimateSpeechDurationSec(speech.text), 0),
        originalSpeakerCalibratedEstimatedDurationSec: speeches.reduce((total, speech) => total + estimateSpeechDurationSec(speech.text), 0) * originalSpeakerCalibrationRatio,
        speechChars: speeches.reduce((total, speech) => total + speech.text.length, 0),
        cueCount: cueChecks.length, cueChecks, everyCueValid: cueChecks.every((cue) => cue.targetExists && cue.speechExists && cue.anchorExists && cue.endSpeechExists && cue.endAnchorExists && cue.waypointsValid),
        audioGenerated: false };
    });
    const originalSiblings = classroom.scenes.filter((item) => item.id !== scene.id);
    const siblingChecks = originalSiblings.map((item) => {
      const after = scenes.find((candidate) => candidate.id === item.id);
      return { sceneId: item.id, title: item.title, sceneUnchangedExceptOrder: Boolean(after && hash(JSON.stringify({ ...after, order: item.order })) === hash(JSON.stringify(item))),
        actionsAndAudioBindingsUnchanged: Boolean(after && hash(JSON.stringify(after.actions)) === hash(JSON.stringify(item.actions))) };
    });
    const siblingOrderUnchanged = hash(JSON.stringify(scenes.filter((item) => !localScenes.some((page) => page.id === item.id)).map((item) => item.id))) === hash(JSON.stringify(originalSiblings.map((item) => item.id)));
    Object.assign(checks, { pageCount: pages.length, totalTargetDurationSec: pages.reduce((total, page) => total + (page.outline.targetDurationSec ?? 0), 0),
      originalTargetDurationSec: outline.targetDurationSec, beforeSnapshotMatches: hash(JSON.stringify(redesign.before)) === hash(JSON.stringify({ content: scene.content, actions: scene.actions })),
      siblingOrderUnchanged, siblingChecks, pageChecks, teachingOwnershipPreserved: pages.every((page) => page.outline.lectureSectionId === outline.lectureSectionId
        && hash(JSON.stringify(page.outline.knowledgePointIds ?? [])) === hash(JSON.stringify(outline.knowledgePointIds ?? []))),
      sequentialOutlines: progression.every((item, index) => item.order === index),
      originalSpeakerTimingReference: { originalMeasuredDurationSec, originalDefaultEstimatedDurationSec, originalSpeakerCalibrationRatio },
      totalDefaultEstimatedSpeechDurationSec: pageChecks.reduce((sum, page) => sum + page.estimatedSpeechDurationSec, 0),
      totalOriginalSpeakerCalibratedEstimatedDurationSec: pageChecks.reduce((sum, page) => sum + page.originalSpeakerCalibratedEstimatedDurationSec, 0),
      originalSurroundingTitles: [classroom.scenes[Math.max(0, scene.order - 1)]?.title, ...pages.map((page) => page.outline.title), classroom.scenes[scene.order + 1]?.title],
      timingKind: '原教学计划秒数；音频未生成，讲稿时长仅估计，不冒称实测97秒。' });
    const equivalent = { pageCount: pages.length === 3, duration: outline.targetDurationSec === 97 && checks.totalTargetDurationSec === 97,
      validSpeechesAndCues: pageChecks.every((page) => page.nonemptySpeech && page.everyCueValid), siblings: siblingChecks.every((page) => page.sceneUnchangedExceptOrder && page.actionsAndAudioBindingsUnchanged) && siblingOrderUnchanged };
    checks.acceptance = { ...equivalent, structuralPassed: equivalent.pageCount && equivalent.duration && equivalent.validSpeechesAndCues && equivalent.siblings
      && checks.teachingOwnershipPreserved === true && checks.beforeSnapshotMatches === true && checks.sequentialOutlines === true };
    await save(output, 'checks.json', checks);
    if (!(checks.acceptance as { structuralPassed: boolean }).structuralPassed || actionCalls.length !== 1) {
      throw new Error('历史页联调的页数/时长/讲稿目标/来源归属/原页保存合同未通过；保留实际结果，不追加模型调用');
    }
    for (const page of pages) console.log(JSON.stringify({ pageId: page.outline.id, duration: page.outline.targetDurationSec, speeches: page.actions.filter((action) => action.type === 'speech').length, cues: page.actions.filter((action) => action.type === 'laser' || action.type === 'spotlight').length }));
  } catch (error) { failure = safe(error); await save(output, 'failure.json', { error: failure, originalDraftRetained: true, redesignMessage: result?.message }); }
  finally {
    const afterAudio = await audioManifest(classroom, snapshot.classroomFile, scene.id);
    const originalClassroomUnchanged = hash(await fs.readFile(snapshot.classroomFile)) === hash(classroomBytes);
    const originalSiblingAudioUnchanged = hash(JSON.stringify(originalAudio)) === hash(JSON.stringify(afterAudio));
    const originalPageAudioUnchanged = (await Promise.all(originalPageAudio.map(async (audio) => hash(await fs.readFile(audio.filename)) === audio.sha256))).every(Boolean);
    const implementationUnchanged = await fingerprint() === implementationSha256;
    const savedContentCallsUnchanged = hash(await fs.readFile(modelCallsFilename)) === hash(modelCallsBytes);
    const savedNarrationCallsUnchanged = !narrationCallsFilename || hash(await fs.readFile(narrationCallsFilename)) === hash(narrationCallsBytes!);
    const sourceSnapshotInputsUnchanged = await snapshotInputFingerprint() === sourceInputSha256;
    await save(output, 'source-preservation.json', { originalClassroomUnchanged, originalSiblingAudioUnchanged,
      originalPageAudioUnchanged,
      originalSiblingAudioFilesChecked: originalAudio.filter((item) => item.sha256).length, originalSiblingAudioUnavailable: originalAudio.filter((item) => item.unavailable), implementationUnchanged, savedContentCallsUnchanged, savedNarrationCallsUnchanged, sourceSnapshotInputsUnchanged });
    await save(output, 'summary.json', { ...metadata, finishedAt: new Date().toISOString(), success: !failure && originalClassroomUnchanged
      && originalSiblingAudioUnchanged && originalPageAudioUnchanged && implementationUnchanged && savedContentCallsUnchanged && savedNarrationCallsUnchanged && sourceSnapshotInputsUnchanged,
      contentReplayCalls: contentCalls.length, actualNarrationLogicalCalls: narrationReplay ? 0 : actionCalls.length,
      narrationReplayCalls: narrationReplay ? actionCalls.length : 0, rawNarrationResponses, replayedNarrationResponses,
      originalClassroomUnchanged, originalSiblingAudioUnchanged, originalPageAudioUnchanged, implementationUnchanged, savedContentCallsUnchanged, savedNarrationCallsUnchanged, sourceSnapshotInputsUnchanged, checks, error: failure });
    const { closeSpatialMeasurementBrowser } = await import('../src/lib/openmaic/generation/slide-spatial-measurement');
    await closeSpatialMeasurementBrowser();
    await globalThis.__openPblPrisma?.$disconnect();
    if (globalThis.__openPblProviderPrisma !== globalThis.__openPblPrisma) await globalThis.__openPblProviderPrisma?.$disconnect();
    if (failure || !originalClassroomUnchanged || !originalSiblingAudioUnchanged || !originalPageAudioUnchanged || !implementationUnchanged || !savedContentCallsUnchanged || !savedNarrationCallsUnchanged || !sourceSnapshotInputsUnchanged) {
      throw new Error(failure || '源文件/音频/实现指纹变更，保留产物但不能宣称通过');
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(safe(error)); process.exitCode = 1; });
