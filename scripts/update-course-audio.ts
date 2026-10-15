/** Explicit, resumable course speech update. Runtime artifacts never enter Git.
 * NODE_OPTIONS=--conditions=import pnpm exec tsx scripts/update-course-audio.ts \
 *   --course-id <id> --source-version <number> --output .openpbl-runtime/course-audio/<run> \
 *   --deployment-secrets [--generate] [--apply]
 * Default: snapshot only. --generate prepares complete audio/actions without switching entries.
 * --apply publishes the prepared candidate; existing classroom instances retain their versions.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { PblTemplateSnapshot } from '../src/lib/platform/pbl-template';
import type { PersistedClassroomData } from '../src/lib/openmaic/server/classroom-storage';
import type { SceneOutline } from '../src/lib/openmaic/types/generation';
import type { ThinkingConfig } from '../src/lib/openmaic/types/provider';
import type { UpdatedPageSpeech } from '../src/lib/course-generation/course-audio-update';
import type { CourseGenerationAuthoringResponse } from '../src/lib/openmaic/server/course-generation-ai-call';

const repository = process.cwd();
const secretValues = new Set<string>();
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Manifest = {
  schemaVersion: 1; courseId: string; sourceVersion: number; sourceVersionId: string;
  sourceSnapshotFingerprint: string; expectedCourseUpdatedAt: string; sourceClassroomFingerprint: string;
  sourceClassroomId: string; candidateClassroomId: string; jobId: string;
  policy: { modelString: string; thinking?: ThinkingConfig; outputWindow?: number; budgetVersion: string };
};
function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 需要参数`);
  return value;
}
async function readJson<T>(file: string): Promise<T> { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
async function exists(file: string): Promise<boolean> { return fs.stat(file).then(() => true, () => false); }
async function save(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
}
function safeError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secretValues) message = message.split(secret).join('[redacted]');
  return message.replace(/(?:postgres(?:ql)?|https?):\/\/[^\s/@]+:[^\s/@]+@/giu, '[redacted-url]@');
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log('Snapshot, generate and publish an explicitly requested audio update. See this script header and docs/agent-workflow.md.');
    return;
  }
  const allowed = new Set(['--course-id', '--source-version', '--output', '--deployment-secrets', '--generate', '--apply']);
  for (const arg of process.argv.slice(2)) if (arg.startsWith('--') && !allowed.has(arg)) throw new Error(`未知参数 ${arg}`);
  const courseId = argument('--course-id');
  const sourceVersion = Number(argument('--source-version'));
  const outputArg = argument('--output');
  if (!courseId || !Number.isInteger(sourceVersion) || sourceVersion < 1 || !outputArg) throw new Error('需要 course-id、source-version 和 output');
  const output = path.resolve(outputArg);
  if (!output.startsWith(path.join(repository, '.openpbl-runtime') + path.sep)) throw new Error('运行产物必须位于 .openpbl-runtime');
  if (process.argv.includes('--deployment-secrets')) {
    const secretDirectory = process.env.OPENPBL_SECRET_DIR ?? path.join(repository, 'deploy/secrets');
    for (const [name, file] of [['DATABASE_URL', 'database_url.txt'], ['PROVIDER_ENCRYPTION_KEY', 'provider_encryption_key.txt'], ['JWT_SECRET', 'jwt_secret.txt']]) {
      process.env[name!] = (await fs.readFile(path.join(secretDirectory, file!), 'utf8')).trim();
    }
    process.env.CLASSROOM_DATA_DIR ??= path.join(repository, '.openpbl-data/classrooms');
  }
  for (const name of ['DATABASE_URL', 'PROVIDER_CONFIG_DATABASE_URL', 'PROVIDER_ENCRYPTION_KEY', 'JWT_SECRET']) if (process.env[name]) secretValues.add(process.env[name]!);
  if (!process.env.DATABASE_URL) throw new Error('缺少数据库配置');
  const { PrismaClient } = await import('@prisma/client');
  globalThis.__openPblPrisma = new PrismaClient({ log: [] });
  const providerUrl = process.env.PROVIDER_CONFIG_DATABASE_URL;
  if (providerUrl && providerUrl !== process.env.DATABASE_URL) globalThis.__openPblProviderPrisma = new PrismaClient({ datasourceUrl: providerUrl, log: [] });
  const db: PrismaClient = globalThis.__openPblPrisma;
  try {
    const { CLASSROOMS_DIR, readClassroom, writeJsonFileAtomic } = await import('../src/lib/openmaic/server/classroom-storage');
    const { initializeServerProviderConfig, resolveServerThinkingConfig } = await import('../src/lib/openmaic/server/provider-config');
    const { resolveModel } = await import('../src/lib/openmaic/server/resolve-model');
    const { COURSE_OUTPUT_BUDGET_VERSION, createCourseOutputBudget, resolveCourseExecutionBudgetOptions } = await import('../src/lib/openmaic/generation/course-output-budget');
    const manifestFile = path.join(output, 'manifest.json');
    let manifest: Manifest;
    if (await exists(manifestFile)) {
      manifest = await readJson<Manifest>(manifestFile);
      if (manifest.courseId !== courseId || manifest.sourceVersion !== sourceVersion) throw new Error('恢复目录属于不同课程或来源版本');
    } else {
      const template = await db.classroomTemplate.findUnique({ where: { id: courseId }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } });
      const version = template?.versions[0];
      if (!template || version?.version !== sourceVersion || version.status !== 'PUBLISHED') throw new Error('指定来源必须是当前最新发布版');
      const snapshot = version.snapshot as unknown as PblTemplateSnapshot;
      const sourceClassroomId = snapshot.design.aiLearningClassroomId ?? snapshot.design.content._openmaicClassroomId;
      const classroom = sourceClassroomId && await readClassroom(sourceClassroomId);
      if (!classroom || classroom.assetGeneration?.status === 'running') throw new Error('来源课堂缺失或仍在生成');
      const job = await db.generationJob.findFirst({ where: { targetId: courseId, jobType: 'COURSE_CONTENT' }, orderBy: { createdAt: 'desc' }, select: { id: true, request: true } });
      const request = job?.request as { generationModelString?: string } | undefined;
      if (!job || !request?.generationModelString) throw new Error('找不到原课程模型请求');
      await initializeServerProviderConfig();
      const model = await resolveModel({ modelString: request.generationModelString });
      secretValues.add(model.apiKey);
      manifest = { schemaVersion: 1, courseId, sourceVersion, sourceVersionId: version.id,
        sourceSnapshotFingerprint: sha(snapshot), expectedCourseUpdatedAt: template.updatedAt.toISOString(),
        sourceClassroomFingerprint: sha(classroom), sourceClassroomId: classroom.id,
        candidateClassroomId: `${classroom.id}-audio-${randomUUID().slice(0, 8)}`, jobId: job.id,
        policy: { modelString: model.modelString, outputWindow: model.modelInfo?.outputWindow,
          thinking: resolveServerThinkingConfig(model.providerId, 'scene-content') ?? model.thinkingConfig,
          budgetVersion: COURSE_OUTPUT_BUDGET_VERSION } };
      await save(path.join(output, 'source-snapshot.json'), snapshot);
      await save(path.join(output, 'source-classroom.json'), classroom);
      await save(path.join(output, 'source-request.json'), job.request);
      await save(manifestFile, manifest);
    }
    const snapshot = await readJson<PblTemplateSnapshot>(path.join(output, 'source-snapshot.json'));
    const original = await readJson<PersistedClassroomData>(path.join(output, 'source-classroom.json'));
    if (sha(snapshot) !== manifest.sourceSnapshotFingerprint || sha(original) !== manifest.sourceClassroomFingerprint) throw new Error('来源快照发生变化');
    if (process.argv.includes('--generate')) {
      const { buildCourseAudioSectionRequest, parseCourseAudioSectionResponse, replaceCoursePageSpeech, updateCourseAudioManuscript, COURSE_AUDIO_UPDATE_POLICY } = await import('../src/lib/course-generation/course-audio-update');
      const { createCourseGenerationAiCall, withCourseGenerationAiCallContext } = await import('../src/lib/openmaic/server/course-generation-ai-call');
      const { runWithCourseGenerationLlmContext } = await import('../src/lib/course-generation/llm-concurrency');
      const { resolveLlmRequestTimeoutMs } = await import('../src/lib/llm/request-policy');
      const { generateTTSForClassroom } = await import('../src/lib/openmaic/server/classroom-media-generation');
      const { generateManuscriptVisualActions } = await import('../src/lib/openmaic/generation/manuscript-visual-actions');
      const { calibrateGeneratedVisualCues } = await import('../src/lib/openmaic/generation/semantic-visual-cues');
      const { summarizeTeachingTimingAudit } = await import('../src/lib/openmaic/server/classroom-asset-generation');
      const { mapWithConcurrency } = await import('../src/lib/openmaic/utils/concurrency');
      await initializeServerProviderConfig();
      const model = await resolveModel({ modelString: manifest.policy.modelString });
      secretValues.add(model.apiKey);
      if (model.modelString !== manifest.policy.modelString || model.modelInfo?.outputWindow !== manifest.policy.outputWindow || COURSE_OUTPUT_BUDGET_VERSION !== manifest.policy.budgetVersion) throw new Error('原模型或输出预算发生变化');
      const call = (name: string, resource: 'narration' | 'actions') => {
        const file = path.join(output, 'responses', `${name}.json`);
        const marker = path.join(output, 'requests', `${name}.json`);
        const aiCall = createCourseGenerationAiCall({ model: model.model, vision: false, source: 'scene-content', thinking: manifest.policy.thinking,
          outputBudget: createCourseOutputBudget({ resource, modelOutputWindow: manifest.policy.outputWindow, thinking: manifest.policy.thinking }),
          timeoutMs: resolveLlmRequestTimeoutMs('long-generation'), executionBudget: resolveCourseExecutionBudgetOptions(),
          maxRetries: 1, streamResponse: true, responseFormat: 'json', requireResponsePersistence: true,
          onResponse: (response) => save(file, response),
        });
        return async (system: string, prompt: string): Promise<string> => {
          if (await exists(file)) {
            const response = await readJson<CourseGenerationAuthoringResponse>(file);
            if (response.system !== system || response.prompt !== prompt || response.complete !== true) throw new Error(`保留已保存响应，不能隐式重写 ${name}`);
            return response.text;
          }
          if (await exists(marker)) throw new Error(`请求 ${name} 已开始但没有完整响应，保留原稿目录，禁止隐式重发`);
          console.log(`Authoring ${name}`);
          let started = false;
          const tracked = withCourseGenerationAiCallContext(aiCall, {
            onAttemptStarting: async (event) => {
              await fs.mkdir(path.dirname(marker), { recursive: true });
              const state = JSON.stringify({ ...event, fingerprint: sha({ system, prompt, policy: manifest.policy }), name });
              if (!started) {
                await fs.writeFile(marker, state, { flag: 'wx', mode: 0o600 });
                started = true;
              } else await save(marker, JSON.parse(state));
            },
          });
          return runWithCourseGenerationLlmContext(() => tracked(system, prompt));
        };
      };
      const groups = new Map<string, typeof original.scenes>();
      for (const scene of original.scenes) {
        const id = scene.lectureSectionId ?? scene.id;
        groups.set(id, [...(groups.get(id) ?? []), scene]);
      }
      const pages: UpdatedPageSpeech[] = [];
      for (const [id, scenes] of groups) {
        const request = buildCourseAudioSectionRequest(snapshot, scenes);
        const response = await call(`section-${sha(id).slice(0, 12)}`, 'narration')(request.system, request.prompt);
        pages.push(...parseCourseAudioSectionResponse(response, scenes));
      }
      await save(path.join(output, 'updated-speech.json'), pages);
      const candidateFile = path.join(output, 'candidate-classroom.json');
      let candidate: PersistedClassroomData;
      if (await exists(candidateFile)) candidate = await readJson(candidateFile);
      else {
        const now = new Date().toISOString();
        candidate = { id: manifest.candidateClassroomId, revision: 1, createdAt: now, updatedAt: now,
          stage: { ...original.stage, id: manifest.candidateClassroomId, updatedAt: Date.now() },
          scenes: original.scenes.map((scene) => ({ ...replaceCoursePageSpeech(scene, pages.find((page) => page.sceneId === scene.id)!),
            stageId: manifest.candidateClassroomId, updatedAt: Date.now(), visualActionRevision: COURSE_AUDIO_UPDATE_POLICY })) };
      }
      if (candidate.id !== manifest.candidateClassroomId) throw new Error('候选课堂身份冲突');
      await save(candidateFile, candidate);
      for (const scene of candidate.scenes) {
        try { await generateTTSForClassroom([scene], candidate.id, ''); }
        finally { await save(candidateFile, candidate); }
      }
      const outlines = snapshot.design.content._openmaicSceneOutlines as SceneOutline[];
      let candidateSave = Promise.resolve();
      const saveCandidate = () => {
        candidateSave = candidateSave.then(() => save(candidateFile, candidate));
        return candidateSave;
      };
      await mapWithConcurrency(candidate.scenes, 3, async (scene) => {
        if (scene.content.type !== 'slide') return;
        const outline = outlines.find((page) => page.id === scene.outlineId)!;
        const stageFile = path.join(output, 'actions', `${sha(scene.id).slice(0, 12)}-scene.json`);
        const fingerprint = sha({ policy: COURSE_AUDIO_UPDATE_POLICY, outlineId: outline.id, content: scene.content,
          speech: (scene.actions ?? []).filter((action) => action.type === 'speech')
            .map((action) => [action.id, action.text, action.speechAlignment?.audioHash]) });
        if (await exists(stageFile)) {
          const saved = await readJson<{ fingerprint: string; actions: NonNullable<typeof scene.actions> }>(stageFile);
          if (saved.fingerprint !== fingerprint) throw new Error(`页面 ${scene.id} 的已完成动作输入发生变化`);
          scene.actions = saved.actions;
          await saveCandidate();
          return;
        }
        const generated = await generateManuscriptVisualActions({ outline,
          content: { elements: scene.content.canvas.elements, background: scene.content.canvas.background },
          narration: { pageId: outline.id, segments: (scene.actions ?? []).flatMap((action) => action.type === 'speech' && action.text.trim()
            ? [{ id: action.id, pageId: outline.id, text: action.text, semanticIds: [`${outline.id}:teaching`] }] : []) },
          aiCall: call(`actions-${sha(scene.id).slice(0, 12)}`, 'actions') });
        const blocks = new Map<string, typeof generated.actions>();
        let pending: typeof generated.actions = [];
        for (const action of generated.actions) {
          if (action.type === 'speech') { blocks.set(action.id, [...pending, action]); pending = []; }
          else pending.push(action);
        }
        const actualSpeech = new Map((scene.actions ?? []).filter((action) => action.type === 'speech').map((action) => [action.id, action]));
        const actions = (scene.actions ?? []).filter((action) => action.type !== 'spotlight' && action.type !== 'laser')
          .flatMap((action) => action.type === 'speech' && action.text.trim() ? blocks.get(action.id) ?? [action] : [action])
          .map((action) => action.type === 'speech' ? actualSpeech.get(action.id)! : action);
        scene.actions = calibrateGeneratedVisualCues({ outline, elements: scene.content.canvas.elements, actions });
        await save(path.join(output, 'actions', `${sha(scene.id).slice(0, 12)}-diagnostics.json`), generated.issues);
        await save(stageFile, { fingerprint, actions: scene.actions });
        await saveCandidate();
      });
      const requested = candidate.scenes.flatMap((scene) => scene.actions ?? []).filter((action) => action.type === 'speech' && action.text.trim()).length;
      candidate.assetGeneration = { status: 'completed', requested, completed: requested, failures: [], updatedAt: new Date().toISOString() };
      await save(candidateFile, candidate);
      const next = updateCourseAudioManuscript(snapshot, pages);
      next.design.aiLearningClassroomId = candidate.id;
      next.design.content._openmaicClassroomId = candidate.id;
      next.design.content.teachingTimingAudit = summarizeTeachingTimingAudit({ outlines, studentScenes: candidate.scenes, enableTTS: true });
      next.design.content.teachingRevisionState = { schemaVersion: 1, baseClassroomRevision: original.revision ?? 1,
        classroomRevision: 1, changeType: 'narration', affectedSceneIds: candidate.scenes.map((scene) => scene.id),
        invalidated: [], updatedAt: new Date().toISOString() };
      await save(path.join(output, 'candidate-snapshot.json'), next);
      await writeJsonFileAtomic(path.join(CLASSROOMS_DIR, `${candidate.id}.json`), candidate);
      console.log(`Candidate complete: ${candidate.id}, pages=${candidate.scenes.length}, spoken clips=${requested}`);
    }
    if (process.argv.includes('--apply')) {
      if (await exists(path.join(output, 'publication.json'))) { console.log(JSON.stringify(await readJson(path.join(output, 'publication.json')))); return; }
      const { publishCourseAudioVersion, hashJson } = await import('../src/lib/platform/course-audio-publication');
      const result = await publishCourseAudioVersion({ courseId, sourceVersionId: manifest.sourceVersionId,
        sourceSnapshotFingerprint: hashJson(snapshot), expectedCourseUpdatedAt: manifest.expectedCourseUpdatedAt,
        sourceClassroom: original, candidate: await readJson(path.join(output, 'candidate-classroom.json')),
        snapshot: await readJson(path.join(output, 'candidate-snapshot.json')) });
      await save(path.join(output, 'publication.json'), result);
      console.log(JSON.stringify(result));
    }
    if (!process.argv.includes('--generate') && !process.argv.includes('--apply')) console.log(`Snapshot saved: ${output}`);
  } finally {
    await db.$disconnect();
    if (globalThis.__openPblProviderPrisma && globalThis.__openPblProviderPrisma !== db) await globalThis.__openPblProviderPrisma.$disconnect();
  }
}
main().catch((error) => { console.error(safeError(error)); process.exitCode = 1; });
