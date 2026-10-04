import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { CLASSROOM_MEDIA_ORIGIN_PREFIX, saveFinalizationMediaOrigins } from './classroom-media-origin';
import { SECTION_CAPACITY_CHECKPOINT_PREFIX } from './section-capacity-checkpoints';
import { SOURCE_CONTENT_CHECKPOINT_PREFIX, SOURCE_NARRATION_BASELINE_STEP } from './source-content-acceptance';

export const PREPARED_OUTLINES_STEP = "prepared-outlines";
export const TEACHING_BLUEPRINT_STEP = "teaching-blueprint";
export const TEACHING_BLUEPRINT_ATTEMPT_STEP = "course-design-attempt:teaching-blueprint";
export const KNOWLEDGE_STRUCTURE_STEP = "course-design:knowledge-structure";
export const KNOWLEDGE_STRUCTURE_ATTEMPT_STEP = "course-design-attempt:knowledge-structure";
export const AI_DURATION_STEP = "course-design:ai-duration";
export const AI_DURATION_ATTEMPT_STEP = "course-design-attempt:ai-duration";
export const COURSE_FINALIZATION_STEP = "course-finalization";
export async function loadGenerationCheckpoints(jobId: string) {
  const rows = await prisma.generationCheckpoint.findMany({ where: { jobId } });
  return {
    preparedOutlines: rows.find((row) => row.step === PREPARED_OUTLINES_STEP)?.state ?? [],
    teachingBlueprint: rows.find((row) => row.step === TEACHING_BLUEPRINT_STEP)?.state ?? null,
    teachingBlueprintAttempt: rows.find((row) => row.step === TEACHING_BLUEPRINT_ATTEMPT_STEP)?.state ?? null,
    knowledgeStructure: rows.find((row) => row.step === KNOWLEDGE_STRUCTURE_STEP)?.state ?? null,
    knowledgeStructureAttempt: rows.find((row) => row.step === KNOWLEDGE_STRUCTURE_ATTEMPT_STEP)?.state ?? null,
    aiDuration: rows.find((row) => row.step === AI_DURATION_STEP)?.state ?? null,
    aiDurationAttempt: rows.find((row) => row.step === AI_DURATION_ATTEMPT_STEP)?.state ?? null,
    courseSeed: rows.find((row) => row.step === 'design-authoring:courseSeed')?.state ?? null,
    courseSeedAttempt: rows.find((row) => row.step === 'course-design-attempt:course-seed')?.state ?? null,
    classicOutline: rows.find((row) => row.step === 'design-authoring:classicOutline')?.state ?? null,
    classicOutlineAttempt: rows.find((row) => row.step === 'course-design-attempt:classic-outline')?.state ?? null,
    spokenSections: rows.filter((row) => /^(?:design-authoring|course-design-attempt|course-design):spoken-section:\d+$/u.test(row.step))
      .map((row) => ({ step: row.step, state: row.state })),
    courseFinalization: rows.find((row) => row.step === COURSE_FINALIZATION_STEP)?.state ?? null,
    sourceNarrationBaseline: rows.find((row) => row.step === SOURCE_NARRATION_BASELINE_STEP)?.state ?? null,
    authoringHistory: rows.filter((row) => /^authoring-history:v\d+:usage-summary$/u.test(row.step)).map((row) => {
      const prefix = row.step.slice(0, -'usage-summary'.length);
      return { request: row.state && typeof row.state === 'object' && !Array.isArray(row.state)
        ? row.state.request : undefined,
      stages: rows.filter((stage) => stage.step.startsWith(`${prefix}stage:`)).map((stage) => stage.state) };
    }),
    pages: rows.filter((row) => row.step.startsWith("page:")).map((row) => row.state),
    stages: rows.filter((row) => row.step.startsWith("stage:")).map((row) => row.state),
    stageAttempts: rows.filter((row) => row.step.startsWith("stage-attempt:")).map((row) => row.state),
    authoringResponses: rows.filter((row) => row.step.startsWith("authoring-response:")).map((row) => row.state),
    authoringAcceptances: rows.filter((row) => row.step.startsWith("authoring-acceptance:")).map((row) => row.state),
    auxiliaryAuthoringStates: rows.filter((row) => row.step.startsWith('aux-authoring:')).map((row) => row.state),
    teachingSections: rows.filter((row) => row.step.startsWith("teaching-section:")).map((row) => row.state),
    sectionCapacities: rows.filter((row) => row.step.startsWith(SECTION_CAPACITY_CHECKPOINT_PREFIX)).map((row) => row.state),
    sourceContents: rows.filter((row) => row.step.startsWith(SOURCE_CONTENT_CHECKPOINT_PREFIX)).map((row) => row.state),
  };
}
export async function saveGenerationCheckpoint(
  jobId: string,
  step: string,
  state: unknown,
  options: { executionId?: string } = {},
) {
  if (step === SOURCE_NARRATION_BASELINE_STEP) {
    await saveSourceNarrationBaselineCheckpoint(jobId, state, options);
    return;
  }
  const value = JSON.parse(JSON.stringify(state)) as Prisma.InputJsonValue;
  if (!options.executionId && step !== COURSE_FINALIZATION_STEP) {
    await prisma.generationCheckpoint.upsert({ where: { jobId_step: { jobId, step } }, create: { jobId, step, state: value }, update: { state: value } });
    return;
  }
  await runMutationTransaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "GenerationJob" WHERE id = ${jobId} FOR UPDATE`;
    if (options.executionId) {
      const row = await tx.generationJob.findUnique({ where: { id: jobId }, select: { status: true, trace: true } });
      const trace = row?.trace && typeof row.trace === "object" && !Array.isArray(row.trace)
        ? row.trace as Record<string, unknown>
        : {};
      const stateEnvelope = trace.state && typeof trace.state === "object" && !Array.isArray(trace.state)
        ? trace.state as Record<string, unknown>
        : {};
      if (row?.status !== "RUNNING" || stateEnvelope.executionId !== options.executionId) {
        throw new Error("GENERATION_JOB_EXECUTION_LOST");
      }
    }
    if (step === COURSE_FINALIZATION_STEP) {
      await saveFinalizationMediaOrigins(tx, jobId, value);
    }
    await tx.generationCheckpoint.upsert({
      where: { jobId_step: { jobId, step } },
      create: { jobId, step, state: value },
      update: { state: value },
    });
  });
}

/** Preserve the first identity-checked failed finalization and its original
 * stages. A later attempt cannot overwrite this evidence, including through
 * the generic checkpoint writer. Return the actual stored value on races. */
export async function saveSourceNarrationBaselineCheckpoint(
  jobId: string,
  state: unknown,
  options: { executionId?: string } = {},
): Promise<Prisma.JsonValue> {
  const value = JSON.parse(JSON.stringify(state)) as Prisma.InputJsonValue;
  const args = {
    where: { jobId_step: { jobId, step: SOURCE_NARRATION_BASELINE_STEP } },
    create: { jobId, step: SOURCE_NARRATION_BASELINE_STEP, state: value },
    update: {},
  };
  if (!options.executionId) {
    return (await prisma.generationCheckpoint.upsert(args)).state;
  }
  return runMutationTransaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "GenerationJob" WHERE id = ${jobId} FOR UPDATE`;
    const row = await tx.generationJob.findUnique({ where: { id: jobId }, select: { status: true, trace: true } });
    const trace = row?.trace && typeof row.trace === 'object' && !Array.isArray(row.trace)
      ? row.trace as Record<string, unknown> : {};
    const envelope = trace.state && typeof trace.state === 'object' && !Array.isArray(trace.state)
      ? trace.state as Record<string, unknown> : {};
    if (row?.status !== 'RUNNING' || envelope.executionId !== options.executionId) {
      throw new Error('GENERATION_JOB_EXECUTION_LOST');
    }
    return (await tx.generationCheckpoint.upsert(args)).state;
  });
}
export async function resetGenerationCheckpoints(jobId: string) {
  // A projection reset cannot erase a paid request or its draft. Explicit
  // authoring replacement uses job-storage's transactional history archive.
  await prisma.generationCheckpoint.deleteMany({ where: { jobId, NOT: [
    CLASSROOM_MEDIA_ORIGIN_PREFIX, 'model-usage:', 'authoring-history:',
    'authoring-response:', 'aux-authoring:', 'stage-attempt:', 'native-render-repair:', 'course-design:', 'course-design-attempt:', 'design-authoring:',
  ].map((prefix) => ({ step: { startsWith: prefix } })).concat([{ step: { startsWith: TEACHING_BLUEPRINT_STEP } }]) } });
}
/**
 * A test lesson and its later full-course promotion share page checkpoints.
 * Only discard the prepared outline envelope so the next request adopts the
 * newly confirmed full outline; every retained page is still guarded by its
 * exact outline, model, and production-input fingerprints.
 */
export async function resetPreparedOutlinesCheckpoint(jobId: string) {
  await prisma.generationCheckpoint.deleteMany({ where: { jobId, step: PREPARED_OUTLINES_STEP } });
}
export async function countGenerationPageCheckpoints(jobId: string) {
  return prisma.generationCheckpoint.count({ where: { jobId, step: { startsWith: "page:" } } });
}
