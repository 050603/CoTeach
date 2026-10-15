import { authoredQuestionFingerprint, knowledgeTutorEvidence } from "./knowledge-tutor-evidence";
import { randomUUID } from 'node:crypto';
import { isDatabaseConfigured, prisma } from '@/lib/db/client';
import { decodePblTemplate } from '@/lib/platform/pbl-template';
import { readClassroom, type PersistedClassroomData } from '@openmaic/lib/server/classroom-storage';
import { withBackgroundAiPriority } from '@/lib/llm/classroom-capacity';
import { EXPLANATION_VERSION, isOrdinaryQuestion, prepareKnowledgeExplanation, resolveKnowledgeTutorModel, type ExplanationInput } from './knowledge-explanations';
import { TUTOR_LEASE_MS } from './knowledge-tutor-payload';
import { buildKnowledgeExplanationWarmupInput, knowledgeExplanationWarmupKey, type KnowledgeExplanationWarmupInput } from './knowledge-explanation-enqueue';

type WarmupJob = { id: string; courseId: string; input: KnowledgeExplanationWarmupInput; attempts: number };

export { enqueueKnowledgeExplanationWarmup } from "./knowledge-explanation-enqueue";

class WarmupSnapshotError extends Error {}

/** Only authored question content and adopted course evidence enter the shared resource. */
export function snapshotKnowledgeExplanationInputs(input: KnowledgeExplanationWarmupInput, classroom: PersistedClassroomData): ExplanationInput[] {
  const questions: ExplanationInput[] = [];
  for (const scene of classroom.scenes) {
    const section = input.sections.find(item => item.quizOutlineId === (scene.outlineId || scene.id));
    if (!section || scene.content?.type !== 'quiz') continue;
    for (const question of scene.content.questions) {
      if (!isOrdinaryQuestion(question)) continue;
      const adoptedIds = (question.knowledgePointIds ?? []).filter(id => section.knowledgePointIds.includes(id));
      const pointIds = adoptedIds.length ? adoptedIds : section.knowledgePointIds;
      const sectionUnits = input.teachingBlueprint?.sections.find(item => item.id === section.id)?.units.map(unit => unit.id) ?? [];
      const adoptedUnits = (question.teachingUnitIds ?? []).filter(id => sectionUnits.includes(id));
      const unitIds = adoptedUnits.length ? adoptedUnits : sectionUnits;
      const sourceEvidence = knowledgeTutorEvidence(input, pointIds, unitIds);
      questions.push({ classroomId: input.classroomId, sceneId: scene.id, question,
        knowledgePointNames: pointIds.map(id => input.knowledgePoints.find(point => point.id === id)?.name ?? id),
        sourceEvidence, questionFingerprint: authoredQuestionFingerprint(question, sourceEvidence) });
    }
  }
  return JSON.parse(JSON.stringify(questions)) as ExplanationInput[];
}

async function verifyLegacyReceipt(job: WarmupJob): Promise<void> {
  // Legacy courses lack a classroom revision. Only the current template or the
  // instance's immutable bound snapshot can authorize binding its evidence.
  const instance = await prisma.classroomInstance.findUnique({ where: { id: job.courseId },
    select: { templateVersion: { select: { snapshot: true } } } });
  const template = instance ? null : await prisma.classroomTemplate.findUnique({ where: { id: job.courseId },
    select: { versions: { orderBy: { version: 'desc' }, take: 1, select: { snapshot: true } } } });
  const design = decodePblTemplate(instance?.templateVersion.snapshot ?? template?.versions[0]?.snapshot);
  const current = design && buildKnowledgeExplanationWarmupInput({ id: job.courseId,
    aiLearningClassroomId: design.aiLearningClassroomId, content: design.content });
  if (!current || knowledgeExplanationWarmupKey(current) !== knowledgeExplanationWarmupKey(job.input)) {
    throw new WarmupSnapshotError('WARMUP_SOURCE_VERSION_CHANGED');
  }
}

export async function runKnowledgeExplanationWarmup(signal: AbortSignal): Promise<boolean> {
  const token = randomUUID(); const now = new Date();
  const [job] = await prisma.$queryRaw<WarmupJob[]>`WITH candidate AS (
    SELECT id FROM "KnowledgeExplanationWarmup" WHERE
      ((status = 'PENDING' AND ("retryAt" IS NULL OR "retryAt" <= ${now})) OR (status = 'FAILED' AND attempts < 3 AND "retryAt" <= ${now}) OR (status = 'RUNNING' AND "leaseUntil" < ${now}))
      ORDER BY "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE "KnowledgeExplanationWarmup" j SET status = 'RUNNING', token = ${token}, attempts = attempts + 1,
      "leaseUntil" = ${new Date(Date.now() + TUTOR_LEASE_MS)}, "updatedAt" = NOW()
      FROM candidate WHERE j.id = candidate.id RETURNING j.id, j."courseId", j.input, j.attempts`;
  if (!job) return false;
  const leaseController = new AbortController();
  const executionSignal = AbortSignal.any([signal, leaseController.signal]);
  const renewLease = async () => {
    const renewed = await prisma.$executeRaw`UPDATE "KnowledgeExplanationWarmup" SET "leaseUntil" = ${new Date(Date.now() + TUTOR_LEASE_MS)}, "updatedAt" = NOW() WHERE id = ${job.id} AND token = ${token} AND status = 'RUNNING'`;
    if (renewed !== 1) throw new Error('WARMUP_LEASE_EXPIRED');
  };
  let renewal: Promise<void> | undefined;
  const renewalTimer = setInterval(() => {
    if (renewal) return;
    renewal = renewLease().catch(error => { leaseController.abort(error); }).finally(() => { renewal = undefined; });
  }, 30_000);
  renewalTimer.unref?.();
  try {
    executionSignal.throwIfAborted();
    if (job.input.version && job.input.version !== EXPLANATION_VERSION) throw new WarmupSnapshotError('WARMUP_POLICY_VERSION_CHANGED');
    if (!job.input.questionInputs) {
      if (job.input.classroomRevision === undefined) await verifyLegacyReceipt(job);
      const classroom = await readClassroom(job.input.classroomId);
      if (!classroom) throw new Error('WARMUP_CLASSROOM_MISSING');
      if (job.input.classroomRevision !== undefined && job.input.classroomRevision !== (classroom.revision ?? 0)) {
        throw new WarmupSnapshotError('WARMUP_CLASSROOM_VERSION_CHANGED');
      }
      const snapshot = { ...job.input, version: EXPLANATION_VERSION, classroomRevision: classroom.revision ?? 0,
        questionInputs: snapshotKnowledgeExplanationInputs(job.input, classroom) };
      executionSignal.throwIfAborted();
      const frozen = await prisma.$executeRaw`UPDATE "KnowledgeExplanationWarmup" SET input = ${JSON.stringify(snapshot)}::jsonb, "updatedAt" = NOW() WHERE id = ${job.id} AND token = ${token} AND status = 'RUNNING'`;
      if (frozen !== 1) throw new Error('WARMUP_LEASE_EXPIRED');
      job.input = snapshot;
    }
    const model = job.input.questionInputs!.length ? await resolveKnowledgeTutorModel() : undefined;
    let failed = false; let busy = false;
    for (const input of job.input.questionInputs!) {
      executionSignal.throwIfAborted();
      await renewLease();
      try {
        await withBackgroundAiPriority(() => prepareKnowledgeExplanation(input, model!, executionSignal));
      } catch (error) {
        executionSignal.throwIfAborted();
        if (error instanceof Error && error.name === 'LlmRateLimitError') busy = true;
        else failed = true;
        // The shared resource persists text and audio progress independently.
        // A failed item must not prevent the remaining class questions warming.
      }
    }
    if (failed) throw new Error('WARMUP_GENERATION_FAILED');
    if (busy) throw Object.assign(new Error('CLASSROOM_AI_BUSY'), { name: 'LlmRateLimitError' });
    executionSignal.throwIfAborted();
    await prisma.$executeRaw`UPDATE "KnowledgeExplanationWarmup" SET status = 'COMPLETED', token = NULL, "leaseUntil" = NULL, error = NULL, "updatedAt" = NOW() WHERE id = ${job.id} AND token = ${token}`;
  } catch (error) {
    const busy = error instanceof Error && error.name === 'LlmRateLimitError';
    const stopped = signal.aborted;
    const terminal = error instanceof WarmupSnapshotError;
    const code = stopped ? 'WORKER_STOPPED' : busy ? 'CLASSROOM_AI_BUSY' : terminal ? error.message
      : leaseController.signal.aborted ? 'WARMUP_LEASE_EXPIRED' : 'WARMUP_GENERATION_FAILED';
    await prisma.$executeRaw`UPDATE "KnowledgeExplanationWarmup" SET status = ${stopped || busy ? 'PENDING' : 'FAILED'}, attempts = ${terminal ? 3 : job.attempts - (busy || stopped ? 1 : 0)}, token = NULL,
      "leaseUntil" = NULL, error = ${code}, "retryAt" = ${new Date(Date.now() + 60_000)}, "updatedAt" = NOW() WHERE id = ${job.id} AND token = ${token}`;
  } finally {
    clearInterval(renewalTimer);
    await renewal;
  }
  return true;
}

let timer: ReturnType<typeof setInterval> | undefined;
let controller: AbortController | undefined;
let running: Promise<unknown> | undefined;
export function startKnowledgeExplanationWorker(): void {
  if (timer || process.env.KNOWLEDGE_EXPLANATION_WARMUP_ENABLED === 'false' || !isDatabaseConfigured() || process.env.NEXT_PHASE === 'phase-production-build') return;
  controller = new AbortController();
  const tick = () => {
    if (running || controller?.signal.aborted) return;
    running = runKnowledgeExplanationWarmup(controller!.signal).catch(() => {
      console.error('[knowledge-explanation] warmup worker unavailable; durable jobs retained');
    }).finally(() => { running = undefined; });
  };
  timer = setInterval(tick, 5_000); timer.unref?.(); tick();
}
export async function stopKnowledgeExplanationWorker(): Promise<void> {
  if (timer) clearInterval(timer); timer = undefined;
  controller?.abort();
  // An in-flight shared generation retains its own bounded lease and can be recovered
  // by the next process. Do not hold process shutdown for a full model execution.
}
