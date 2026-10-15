/** Explicit, resumable concept-map update. Runtime artifacts never enter Git.
 * NODE_OPTIONS=--conditions=import pnpm exec tsx scripts/update-course-mind-map.ts \
 *   --course-id <id> --source-version <number> --output .openpbl-runtime/course-mind-map/<run> \
 *   --deployment-secrets [--mode snapshot|generate|apply]
 * Default: snapshot. Generate saves a candidate; apply publishes only that map.
 * Teaching pages/audio and existing classroom instances retain their original content.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { PblTemplateSnapshot } from '../src/lib/platform/pbl-template';
import type { CourseMindMapPublicationSource } from '../src/lib/platform/course-mind-map-publication';
import type { PersistedClassroomData } from '../src/lib/openmaic/server/classroom-storage';
import type { ThinkingConfig } from '../src/lib/openmaic/types/provider';
import type { CourseGenerationAuthoringResponse } from '../src/lib/openmaic/server/course-generation-ai-call';
import type { CourseMindMapCheckpoint } from '../src/lib/course-mind-map/generation';

type Manifest = Omit<CourseMindMapPublicationSource, 'sourceClassroom' | 'snapshot'> & {
  schemaVersion: 1;
  sourceClassroomId: string;
  jobId: string;
  policy: { modelString: string; thinking?: ThinkingConfig; outputWindow?: number; budgetVersion: string };
};
const repository = process.cwd();
const secretValues = new Set<string>();
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
    console.log('Usage: --course-id <id> --source-version <number> --output .openpbl-runtime/<run> [--deployment-secrets] [--mode snapshot|generate|apply]. Default: snapshot.');
    return;
  }
  const allowed = new Set(['--course-id', '--source-version', '--output', '--deployment-secrets', '--mode']);
  for (const arg of process.argv.slice(2)) if (arg.startsWith('--') && !allowed.has(arg)) throw new Error(`未知参数 ${arg}`);
  const courseId = argument('--course-id');
  const sourceVersion = Number(argument('--source-version'));
  const outputArg = argument('--output');
  const mode = argument('--mode') ?? 'snapshot';
  if (!['snapshot', 'generate', 'apply'].includes(mode)) throw new Error('mode 必须是 snapshot、generate 或 apply');
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
    const { readCourseMindMapPublicationSource, publishCourseMindMapVersion } = await import('../src/lib/platform/course-mind-map-publication');
    const { hashJson } = await import('../src/lib/course-quality-review/audio-publication');
    const { normalizePersistedClassroom } = await import('../src/lib/openmaic/server/classroom-storage');
    const { initializeServerProviderConfig, resolveServerThinkingConfig } = await import('../src/lib/openmaic/server/provider-config');
    const { resolveModel } = await import('../src/lib/openmaic/server/resolve-model');
    const { COURSE_OUTPUT_BUDGET_VERSION, createCourseOutputBudget, resolveCourseExecutionBudgetOptions } = await import('../src/lib/openmaic/generation/course-output-budget');
    const manifestFile = path.join(output, 'manifest.json');
    let manifest: Manifest;
    if (await exists(manifestFile)) {
      manifest = await readJson<Manifest>(manifestFile);
      if (manifest.schemaVersion !== 1 || manifest.courseId !== courseId || manifest.sourceVersion !== sourceVersion) throw new Error('恢复目录属于不同课程或来源版本');
    } else {
      if (mode !== 'snapshot') throw new Error('请先以默认 snapshot 模式锁定来源');
      const source = await readCourseMindMapPublicationSource(courseId, sourceVersion, db);
      const job = await db.generationJob.findFirst({ where: { targetId: courseId, jobType: 'COURSE_CONTENT' }, orderBy: { createdAt: 'desc' }, select: { id: true, request: true } });
      const request = job?.request as { generationModelString?: string } | undefined;
      if (!job || !request?.generationModelString) throw new Error('找不到原课程模型请求');
      await initializeServerProviderConfig();
      const model = await resolveModel({ modelString: request.generationModelString });
      if (model.apiKey) secretValues.add(model.apiKey);
      const { snapshot, sourceClassroom, ...lock } = source;
      manifest = { ...lock, schemaVersion: 1, sourceClassroomId: sourceClassroom.id, jobId: job.id,
        policy: { modelString: model.modelString, outputWindow: model.modelInfo?.outputWindow,
          thinking: resolveServerThinkingConfig(model.providerId, 'generate-classroom') ?? model.thinkingConfig,
          budgetVersion: COURSE_OUTPUT_BUDGET_VERSION } };
      await save(path.join(output, 'source-snapshot.json'), snapshot);
      await save(path.join(output, 'source-classroom.json'), sourceClassroom);
      await save(path.join(output, 'source-request.json'), job.request);
      await save(manifestFile, manifest);
    }
    const snapshot = await readJson<PblTemplateSnapshot>(path.join(output, 'source-snapshot.json'));
    const original = normalizePersistedClassroom(await readJson<PersistedClassroomData>(path.join(output, 'source-classroom.json')));
    if (hashJson(snapshot) !== manifest.sourceSnapshotFingerprint || hashJson(original) !== manifest.sourceClassroomFingerprint
      || original.id !== manifest.sourceClassroomId) throw new Error('已保存的来源快照发生变化');
    if (mode === 'generate') {
      const current = await readCourseMindMapPublicationSource(courseId, sourceVersion, db);
      if (current.sourceVersionId !== manifest.sourceVersionId || current.expectedCourseUpdatedAt !== manifest.expectedCourseUpdatedAt
        || current.sourceSnapshotFingerprint !== manifest.sourceSnapshotFingerprint || current.sourceClassroomFingerprint !== manifest.sourceClassroomFingerprint) {
        throw new Error('课程来源已改变，请保留原候选并重新读取来源');
      }
      const { createPblTemplateCourse } = await import('../src/lib/platform/pbl-template');
      const { generateCourseMindMap } = await import('../src/lib/course-mind-map/generation');
      const { createCourseGenerationAiCall, withCourseGenerationAiCallContext } = await import('../src/lib/openmaic/server/course-generation-ai-call');
      const { runWithCourseGenerationLlmContext } = await import('../src/lib/course-generation/llm-concurrency');
      const { resolveLlmRequestTimeoutMs } = await import('../src/lib/llm/request-policy');
      await initializeServerProviderConfig();
      const model = await resolveModel({ modelString: manifest.policy.modelString });
      if (model.apiKey) secretValues.add(model.apiKey);
      if (model.modelString !== manifest.policy.modelString || model.modelInfo?.outputWindow !== manifest.policy.outputWindow
        || COURSE_OUTPUT_BUDGET_VERSION !== manifest.policy.budgetVersion) throw new Error('原模型或输出预算发生变化');
      const aiCall = async (system: string, prompt: string): Promise<string> => {
        const name = hashJson({ system, prompt, policy: manifest.policy });
        const responseFile = path.join(output, 'responses', `${name}.json`);
        const marker = path.join(output, 'requests', `${name}.json`);
        if (await exists(responseFile)) {
          const response = await readJson<CourseGenerationAuthoringResponse>(responseFile);
          if (response.system !== system || response.prompt !== prompt || response.complete !== true) throw new Error('保留已保存的模型响应，不能隐式重写');
          return response.text;
        }
        if (await exists(marker)) throw new Error('请求已开始但没有完整响应，请保留恢复目录，禁止隐式重发');
        const call = createCourseGenerationAiCall({ model: model.model, vision: false, source: 'course-mind-map', thinking: manifest.policy.thinking,
          outputBudget: createCourseOutputBudget({ resource: 'planning', modelOutputWindow: manifest.policy.outputWindow, thinking: manifest.policy.thinking }),
          executionBudget: resolveCourseExecutionBudgetOptions(), timeoutMs: resolveLlmRequestTimeoutMs('long-generation'),
          maxRetries: 1, streamResponse: true, responseFormat: 'json', requireResponsePersistence: true,
          onResponse: (response) => save(responseFile, response) });
        let started = false;
        const tracked = withCourseGenerationAiCallContext(call, { onAttemptStarting: async (event) => {
          await fs.mkdir(path.dirname(marker), { recursive: true });
          if (!started) { await fs.writeFile(marker, JSON.stringify(event), { flag: 'wx', mode: 0o600 }); started = true; }
          else await save(marker, event);
        } });
        console.log(`Authoring concept map ${name.slice(0, 12)}`);
        return runWithCourseGenerationLlmContext(() => tracked(system, prompt));
      };
      const checkpointFile = path.join(output, 'checkpoint.json');
      const checkpoint = await exists(checkpointFile) ? await readJson<CourseMindMapCheckpoint>(checkpointFile) : undefined;
      const course = createPblTemplateCourse(courseId, snapshot.design);
      const map = await generateCourseMindMap({ course, scenes: original.scenes, aiCall, checkpoint,
        saveCheckpoint: (state) => save(checkpointFile, state) });
      const candidate = structuredClone(snapshot);
      candidate.design.content.courseMindMap = map;
      await save(path.join(output, 'candidate-mind-map.json'), map);
      await save(path.join(output, 'candidate-snapshot.json'), candidate);
      console.log(`Candidate saved: nodes=${map.nodes.length}, relations=${map.relations.length}, pages=${map.bindings.length}, diagnostics=${map.diagnostics.length}`);
    }
    if (mode === 'apply') {
      const result = await publishCourseMindMapVersion({ courseId, sourceVersion, sourceVersionId: manifest.sourceVersionId,
        sourceSnapshotFingerprint: manifest.sourceSnapshotFingerprint, expectedCourseUpdatedAt: manifest.expectedCourseUpdatedAt,
        sourceClassroomFingerprint: manifest.sourceClassroomFingerprint, sourceClassroom: original,
        snapshot: await readJson<PblTemplateSnapshot>(path.join(output, 'candidate-snapshot.json')) }, db);
      await save(path.join(output, 'publication.json'), result);
      console.log(JSON.stringify(result));
    }
    if (mode === 'snapshot') console.log(`Snapshot saved: ${output}`);
  } finally {
    await db.$disconnect();
    if (globalThis.__openPblProviderPrisma && globalThis.__openPblProviderPrisma !== db) await globalThis.__openPblProviderPrisma.$disconnect();
  }
}
main().catch((error) => { console.error(safeError(error)); process.exitCode = 1; });
