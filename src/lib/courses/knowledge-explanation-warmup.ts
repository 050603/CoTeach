import { knowledgeTutorEvidence } from "./knowledge-tutor-evidence";
import { randomUUID } from 'node:crypto';
import { isDatabaseConfigured, prisma } from '@/lib/db/client';
import type { CourseContent } from '@/lib/session/types';
import { readClassroom } from '@openmaic/lib/server/classroom-storage';
import { withBackgroundAiPriority } from '@/lib/llm/classroom-capacity';
import { getSharedExplanation, resolveKnowledgeTutorModel } from './knowledge-explanations';
import { TUTOR_LEASE_MS } from './knowledge-tutor-payload';

type WarmupInput = { classroomId: string; sections: Array<{ id?: string; quizOutlineId: string; knowledgePointIds: string[] }>; knowledgePoints: CourseContent["knowledgePoints"]; courseEvidence?: CourseContent["courseEvidence"]; teachingBlueprint?: CourseContent["teachingBlueprint"] };
type WarmupJob = { id: string; input: WarmupInput; attempts: number };

export { enqueueKnowledgeExplanationWarmup } from "./knowledge-explanation-enqueue";

export async function runKnowledgeExplanationWarmup(signal: AbortSignal): Promise<boolean> {
  const token = randomUUID(); const now = new Date();
  const [job] = await prisma.$queryRaw<WarmupJob[]>`WITH candidate AS (
    SELECT id FROM "KnowledgeExplanationWarmup" WHERE
      ((status = 'PENDING' AND ("retryAt" IS NULL OR "retryAt" <= ${now})) OR (status = 'FAILED' AND attempts < 3 AND "retryAt" <= ${now}) OR (status = 'RUNNING' AND "leaseUntil" < ${now}))
      ORDER BY "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE "KnowledgeExplanationWarmup" j SET status = 'RUNNING', token = ${token}, attempts = attempts + 1,
      "leaseUntil" = ${new Date(Date.now() + TUTOR_LEASE_MS)}, "updatedAt" = NOW()
      FROM candidate WHERE j.id = candidate.id RETURNING j.id, j.input, j.attempts`;
  if (!job) return false;
  try {
    const classroom = await readClassroom(job.input.classroomId);
    if (!classroom) throw new Error('WARMUP_CLASSROOM_MISSING');
    const model = await resolveKnowledgeTutorModel();
    for (const scene of classroom.scenes) {
      const section = job.input.sections.find(section => section.quizOutlineId === (scene.outlineId || scene.id));
      if (!section || scene.content?.type !== 'quiz') continue;
      for (const question of scene.content.questions) {
        // Single includes true/false. Multiple caches independent option explanations;
        // matching and answer combinations stay demand-driven, avoiding combinatorial work.
        if (!['single', 'multiple'].includes(question.type) || !question.options?.length) continue;
        const adoptedIds = (question.knowledgePointIds ?? []).filter(id => section.knowledgePointIds.includes(id));
        const pointIds = adoptedIds.length ? adoptedIds : section.knowledgePointIds;
        const sectionUnits = job.input.teachingBlueprint?.sections.find(item => item.id === section.id)?.units.map(unit => unit.id) ?? [];
        const adoptedUnits = (question.teachingUnitIds ?? []).filter(id => sectionUnits.includes(id));
        const unitIds = adoptedUnits.length ? adoptedUnits : sectionUnits;
        const knowledgePointNames = pointIds
          .map(id => job.input.knowledgePoints.find(point => point.id === id)?.name ?? id);
        for (const option of question.options) {
          signal.throwIfAborted();
          const renewed = await prisma.$executeRaw`UPDATE "KnowledgeExplanationWarmup" SET "leaseUntil" = ${new Date(Date.now() + TUTOR_LEASE_MS)}, "updatedAt" = NOW() WHERE id = ${job.id} AND token = ${token}`;
          if (renewed !== 1) throw new Error('WARMUP_LEASE_EXPIRED');
          await withBackgroundAiPriority(() => getSharedExplanation({ classroomId: job.input.classroomId, sceneId: scene.id,
            question, knowledgePointNames, sourceEvidence: knowledgeTutorEvidence(job.input, pointIds, unitIds), answer: option.value, ...(question.type === 'multiple' ? { mode: 'option' as const } : {}) }, model,
          AbortSignal.any([signal, AbortSignal.timeout(TUTOR_LEASE_MS)])));
        }
      }
    }
    await prisma.$executeRaw`UPDATE "KnowledgeExplanationWarmup" SET status = 'COMPLETED', token = NULL, "leaseUntil" = NULL, error = NULL, "updatedAt" = NOW() WHERE id = ${job.id} AND token = ${token}`;
  } catch (error) {
    const busy = error instanceof Error && error.name === 'LlmRateLimitError';
    await prisma.$executeRaw`UPDATE "KnowledgeExplanationWarmup" SET status = ${signal.aborted || busy ? 'PENDING' : 'FAILED'}, attempts = attempts - ${busy ? 1 : 0}, token = NULL,
      "leaseUntil" = NULL, error = ${signal.aborted ? 'WORKER_STOPPED' : busy ? 'CLASSROOM_AI_BUSY' : 'WARMUP_GENERATION_FAILED'}, "retryAt" = ${new Date(Date.now() + 60_000)}, "updatedAt" = NOW() WHERE id = ${job.id} AND token = ${token}`;
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
