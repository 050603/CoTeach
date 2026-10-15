/** Resumable derived resources; never rewrites the course, grades or conversations.
 * NODE_OPTIONS=--conditions=import pnpm exec tsx scripts/prepare-question-explanations.ts \
 *   --course-id <template-id> --source-version <published-version> --deployment-secrets [--generate]
 * Default is a read-only inventory. Reports belong in .openpbl-runtime.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const arg = (name: string) => {
  const at = process.argv.indexOf(name); const value = at >= 0 ? process.argv[at + 1] : undefined;
  if (at >= 0 && (!value || value.startsWith('--'))) throw new Error(`缺少 ${name} 参数`);
  return value;
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function main() {
  const courseId = arg('--course-id'); const sourceVersion = Number(arg('--source-version'));
  const allowed = new Set(['--course-id', '--source-version', '--deployment-secrets', '--generate', '--output']);
  for (const flag of process.argv.slice(2)) if (flag.startsWith('--') && !allowed.has(flag)) throw new Error(`未知参数 ${flag}`);
  if (!courseId || !Number.isInteger(sourceVersion) || sourceVersion < 1) throw new Error('需要 --course-id 和 --source-version');
  if (process.argv.includes('--deployment-secrets')) {
    const secrets = process.env.OPENPBL_SECRET_DIR || path.resolve('deploy/secrets');
    for (const [name, file] of [['DATABASE_URL', 'database_url.txt'], ['PROVIDER_ENCRYPTION_KEY', 'provider_encryption_key.txt']]) {
      process.env[name!] = (await fs.readFile(path.join(secrets, file!), 'utf8')).trim();
    }
    process.env.CLASSROOM_DATA_DIR ??= path.resolve('.openpbl-data/classrooms');
  }
  if (!process.env.DATABASE_URL) throw new Error('数据库未配置');
  const db = new PrismaClient({ log: [] });
  globalThis.__openPblPrisma = db;
  try {
    const { decodePblTemplate } = await import('../src/lib/platform/pbl-template');
    const { readClassroom } = await import('../src/lib/openmaic/server/classroom-storage');
    const { buildKnowledgeExplanationWarmupInput } = await import('../src/lib/courses/knowledge-explanation-enqueue');
    const { snapshotKnowledgeExplanationInputs } = await import('../src/lib/courses/knowledge-explanation-warmup');
    const { readPreparedExplanation, prepareKnowledgeExplanation, resolveKnowledgeTutorModel, EXPLANATION_VERSION } = await import('../src/lib/courses/knowledge-explanations');
    const { authoredQuestionFingerprint } = await import('../src/lib/courses/knowledge-tutor-evidence');
    const { withBackgroundAiPriority } = await import('../src/lib/llm/classroom-capacity');
    const template = await db.classroomTemplate.findUnique({ where: { id: courseId }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } });
    const version = template?.versions[0];
    if (!template || version?.version !== sourceVersion || version.status !== 'PUBLISHED') throw new Error('指定来源必须是当前最新发布版');
    const design = decodePblTemplate(version.snapshot);
    if (!design) throw new Error('课程快照不可解析');
    const input = buildKnowledgeExplanationWarmupInput({ id: courseId, content: design.content, aiLearningClassroomId: design.aiLearningClassroomId });
    const classroom = input && await readClassroom(input.classroomId);
    if (!input || !classroom) throw new Error('学生课堂缺失');
    if (input.classroomRevision !== undefined && input.classroomRevision !== (classroom.revision ?? 0)) throw new Error('来源课堂版本已变化');
    const fingerprint = hash(classroom); const snapshotFingerprint = hash(version.snapshot);
    const questions = snapshotKnowledgeExplanationInputs(input, classroom);
    const generate = process.argv.includes('--generate');
    let model: Awaited<ReturnType<typeof resolveKnowledgeTutorModel>> | undefined;
    if (generate) {
      const { initializeServerProviderConfig } = await import('../src/lib/openmaic/server/provider-config');
      await initializeServerProviderConfig(); model = await resolveKnowledgeTutorModel();
    }
    const results: Array<Record<string, unknown>> = [];
    for (const questionInput of questions) {
      const current = await readClassroom(input.classroomId);
      if (!current || hash(current) !== fingerprint) throw new Error('生成期间来源课堂已变化，停止补生成');
      const questionFingerprint = authoredQuestionFingerprint(questionInput.question, questionInput.sourceEvidence!);
      try {
        const resource = generate ? await withBackgroundAiPriority(() => prepareKnowledgeExplanation(questionInput, model!, AbortSignal.timeout(300_000)))
          : await readPreparedExplanation({ classroomId: input.classroomId, sceneId: questionInput.sceneId, questionFingerprint });
        results.push({ sceneId: questionInput.sceneId, questionId: questionInput.question.id, format: questionInput.question.format || questionInput.question.type,
          questionFingerprint, id: resource?.id, textReady: Boolean(resource), audioReady: Boolean(resource?.audioUrl),
          durationSec: resource?.audioDurationSec, durationInTarget: resource?.audioDurationSec ? resource.audioDurationSec >= 45 && resource.audioDurationSec <= 75 : null });
      } catch {
        // Provider exceptions may include secrets; detailed raw output is already durable in the resource table.
        const retained = await readPreparedExplanation({ classroomId: input.classroomId,
          sceneId: questionInput.sceneId, questionFingerprint }).catch(() => null);
        results.push({ sceneId: questionInput.sceneId, questionId: questionInput.question.id, format: questionInput.question.format || questionInput.question.type,
          questionFingerprint, id: retained?.id, textReady: Boolean(retained), audioReady: Boolean(retained?.audioUrl),
          durationSec: retained?.audioDurationSec, error: 'RESOURCE_PREPARATION_FAILED' });
      }
      console.log(JSON.stringify(results.at(-1)));
    }
    const unchanged = await db.classroomTemplate.findUnique({ where: { id: courseId },
      select: { versions: { orderBy: { version: 'desc' }, take: 1, select: { id: true, snapshot: true } } } });
    if (unchanged?.versions[0]?.id !== version.id || hash(unchanged.versions[0].snapshot) !== snapshotFingerprint) throw new Error('发布来源发生变化');
    const report = { courseId, version: sourceVersion, classroomId: input.classroomId, classroomRevision: classroom.revision ?? 0,
      policyVersion: EXPLANATION_VERSION, checkedAt: new Date().toISOString(), generated: generate,
      ...(model ? { model: model.modelString } : {}), total: questions.length, textReady: results.filter(item => item.textReady).length,
      audioReady: results.filter(item => item.audioReady).length, results };
    if (generate) {
      const output = path.resolve(arg('--output') || `.openpbl-runtime/question-explanations/${courseId}/v${sourceVersion}`);
      if (!output.startsWith(path.resolve('.openpbl-runtime') + path.sep)) throw new Error('报告必须写入 .openpbl-runtime');
      await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    }
    console.log(JSON.stringify({ ...report, results: undefined }));
    if (results.some(item => item.error)) process.exitCode = 1;
  } finally { await db.$disconnect(); }
}
main().catch(() => { console.error('题目讲解准备失败，请核对课程版本、课堂来源和服务配置；未改写课程或学生数据。'); process.exitCode = 1; });
