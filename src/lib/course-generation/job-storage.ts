import { Prisma, type GenerationJob } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";

type JobKind = "COURSE_DESIGN" | "COURSE_CONTENT" | "COURSE_RESOURCE_PACKAGE" | "COURSE_QUALITY_REVIEW";
type Json = Prisma.JsonValue;
export type CourseGenerationJob = {
  id: string; courseId: string; requestedBy: string | null; status: string; step: string; progress: number;
  message: string; scenesGenerated: number; totalScenes: number; estimatedRemainingSeconds: number | null;
  tokenUsage: number; tokenUsageCalls: number;
  activePages: Json; currentStage: string | null; currentCall: Json;
  events: Json; trace: Json; request: Json; result: Json; qualityReport: Json; preparedOutlines: Json;
  reviewStatus: string; reviewAvailableUntil: Date | null; stepIndex: number; version: number; attempt: number;
  executionId: string | null; executionOwner: string | null; leaseExpiresAt: Date | null;
  error: string | null; startedAt: Date | null; completedAt: Date | null; lastHeartbeatAt: Date | null; retryAt: Date | null;
  createdAt: Date; updatedAt: Date;
};
export type CourseDesignGenerationJob = CourseGenerationJob;
type Filter = string | number | Date | null | { in?: string[]; not?: string; lt?: Date; lte?: Date; gt?: Date };
export type JobWhere = { [K in keyof CourseGenerationJob]?: Filter } & { OR?: JobWhere[]; AND?: JobWhere[] };
type Patch = Partial<{ [K in keyof CourseGenerationJob]: CourseGenerationJob[K] | null | { increment: number } | Prisma.InputJsonValue | typeof Prisma.JsonNull }>;
type Find = { where: JobWhere; select?: Record<string, boolean>; orderBy?: { createdAt?: "asc" | "desc" } };
export type GenerationCheckpointPolicy =
  | "all"
  | "prepared-outlines"
  | { steps?: readonly string[]; prefixes?: readonly string[] };
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value === Prisma.JsonNull ? null : value)); }
function date(value: unknown): Date | null { return typeof value === "string" ? new Date(value) : null; }
export function projectGenerationJob(row: GenerationJob): CourseGenerationJob {
  const envelope = object(row.trace); const state = object(envelope.state);
  return {
    id: row.id, courseId: row.targetId, requestedBy: typeof state.requestedBy === "string" ? state.requestedBy : null,
    status: row.status.toLowerCase(), step: row.step ?? "queued", progress: row.progress, message: String(state.message ?? "等待生成"),
    scenesGenerated: Number(state.scenesGenerated ?? 0), totalScenes: Number(state.totalScenes ?? 0),
    estimatedRemainingSeconds: state.estimatedRemainingSeconds == null ? null : Number(state.estimatedRemainingSeconds),
    tokenUsage: Number(state.tokenUsage ?? 0), tokenUsageCalls: Number(state.tokenUsageCalls ?? 0),
    activePages: (state.activePages ?? []) as Json, currentStage: typeof state.currentStage === "string" ? state.currentStage : null,
    currentCall: (state.currentCall ?? null) as Json,
    events: (state.events ?? []) as Json, trace: (envelope.entries ?? []) as Json, request: row.request, result: row.result, qualityReport: row.qualityReport,
    preparedOutlines: (state.preparedOutlines ?? null) as Json,
    reviewStatus: String(state.reviewStatus ?? "unavailable"), reviewAvailableUntil: date(state.reviewAvailableUntil), stepIndex: Number(state.stepIndex ?? 0), version: Number(state.version ?? 1),
    executionId: typeof state.executionId === "string" ? state.executionId : null,
    executionOwner: typeof state.executionOwner === "string" ? state.executionOwner : null,
    leaseExpiresAt: date(state.leaseExpiresAt),
    attempt: row.attempt, error: row.error, startedAt: row.startedAt, completedAt: row.completedAt, lastHeartbeatAt: row.heartbeatAt, retryAt: row.retryAt, createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}
function matches(row: CourseGenerationJob, where: JobWhere): boolean {
  return Object.entries(where).every(([key, filter]) => {
    if (key === "OR") return (filter as JobWhere[]).some((part) => matches(row, part));
    if (key === "AND") return (filter as JobWhere[]).every((part) => matches(row, part));
    const value = row[key as keyof CourseGenerationJob];
    if (filter === null || typeof filter !== "object" || filter instanceof Date) return value instanceof Date && filter instanceof Date ? value.getTime() === filter.getTime() : value === filter;
    const condition = filter as Exclude<Filter, string | number | Date | null>;
    if (condition.in && !condition.in.includes(String(value))) return false;
    if (condition.not !== undefined && value === condition.not) return false;
    if (condition.lt && !(value instanceof Date && value < condition.lt)) return false;
    if (condition.lte && !(value instanceof Date && value <= condition.lte)) return false;
    if (condition.gt && !(value instanceof Date && value > condition.gt)) return false;
    return true;
  });
}
function sqlWhere(kind: JobKind, where: JobWhere): Prisma.GenerationJobWhereInput {
  return { targetType: "CLASSROOM_TEMPLATE", jobType: kind,
    ...(typeof where.id === "string" ? { id: where.id } : {}),
    ...(typeof where.courseId === "string" ? { targetId: where.courseId } : {}),
    ...(typeof where.status === "string" ? { status: where.status.toUpperCase() } : {}),
  };
}
function updateData(row: CourseGenerationJob, patch: Patch): Prisma.GenerationJobUpdateInput {
  const values = { ...row } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    values[key] = value && typeof value === "object" && "increment" in value ? Number(values[key] ?? 0) + Number(value.increment) : value === Prisma.JsonNull ? null : value;
  }
  const next = values as CourseGenerationJob;
  return {
    status: next.status.toUpperCase(), step: next.step, progress: next.progress, request: json(next.request), result: next.result === null ? Prisma.JsonNull : json(next.result),
    qualityReport: next.qualityReport === null ? Prisma.JsonNull : json(next.qualityReport), error: next.error,
    attempt: next.attempt, startedAt: next.startedAt, completedAt: next.completedAt, heartbeatAt: next.lastHeartbeatAt, retryAt: next.retryAt,
    trace: json({ schemaVersion: 1, entries: next.trace, state: {
      requestedBy: next.requestedBy, message: next.message, scenesGenerated: next.scenesGenerated, totalScenes: next.totalScenes,
      estimatedRemainingSeconds: next.estimatedRemainingSeconds, tokenUsage: next.tokenUsage, tokenUsageCalls: next.tokenUsageCalls,
      events: next.events, reviewStatus: next.reviewStatus,
      activePages: next.activePages, currentStage: next.currentStage,
      currentCall: next.currentCall,
      reviewAvailableUntil: next.reviewAvailableUntil, stepIndex: next.stepIndex, version: next.version, preparedOutlines: next.preparedOutlines,
      executionId: next.executionId, executionOwner: next.executionOwner, leaseExpiresAt: next.leaseExpiresAt,
    } }),
  };
}
async function deleteCheckpoints(
  tx: Prisma.TransactionClient,
  jobId: string,
  policy: GenerationCheckpointPolicy,
): Promise<void> {
  if (policy === "all") {
    await tx.generationCheckpoint.deleteMany({ where: { jobId } });
    return;
  }
  if (policy === "prepared-outlines") {
    await tx.generationCheckpoint.deleteMany({ where: { jobId, step: "prepared-outlines" } });
    return;
  }
  const steps = [...new Set(policy.steps ?? [])];
  const prefixes = [...new Set(policy.prefixes ?? [])];
  if (steps.length === 0 && prefixes.length === 0) return;
  await tx.generationCheckpoint.deleteMany({
    where: {
      jobId,
      OR: [
        ...(steps.length ? [{ step: { in: steps } }] : []),
        ...prefixes.map((prefix) => ({ step: { startsWith: prefix } })),
      ],
    },
  });
}
function storage(kind: JobKind) {
  async function findIn(db: Prisma.TransactionClient, input: Find) {
    const records = await db.generationJob.findMany({ where: sqlWhere(kind, input.where), orderBy: { createdAt: input.orderBy?.createdAt ?? "desc" } });
    return records.map(projectGenerationJob).filter((row) => matches(row, input.where));
  }
  async function lock(tx: Prisma.TransactionClient) { await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`generation-jobs:${kind}`}, 0))`; }
  async function createIn(tx: Prisma.TransactionClient, data: Patch) {
    if (typeof data.courseId !== "string") throw new Error("GENERATION_TEMPLATE_REQUIRED");
    if (!await tx.classroomTemplate.findUnique({ where: { id: data.courseId }, select: { id: true } })) throw new Error("GENERATION_TEMPLATE_NOT_FOUND");
    const existing = await findIn(tx, { where: { courseId: data.courseId } });
    if (existing[0]) return existing[0];
    const row = await tx.generationJob.create({ data: { targetType: "CLASSROOM_TEMPLATE", targetId: data.courseId, jobType: kind, status: "QUEUED", request: json(data.request ?? {}) } });
    return projectGenerationJob(await tx.generationJob.update({ where: { id: row.id }, data: updateData(projectGenerationJob(row), data) }));
  }
  return {
    async findUnique(input: Find): Promise<CourseGenerationJob | null> { return (await findIn(prisma, input))[0] ?? null; },
    async findFirst(input: Find): Promise<CourseGenerationJob | null> { return (await findIn(prisma, input))[0] ?? null; },
    async create(input: { data: Patch }) { return runMutationTransaction(async (tx) => { await lock(tx); return createIn(tx, input.data); }); },
    async update(input: { where: JobWhere; data: Patch }) {
      return runMutationTransaction(async (tx) => {
        await lock(tx); const row = (await findIn(tx, { where: input.where }))[0];
        if (!row) throw new Error("GENERATION_JOB_NOT_FOUND");
        return projectGenerationJob(await tx.generationJob.update({ where: { id: row.id }, data: updateData(row, input.data) }));
      });
    },
    async updateMany(input: { where: JobWhere; data: Patch }) {
      return runMutationTransaction(async (tx) => {
        await lock(tx); const rows = await findIn(tx, { where: input.where });
        for (const row of rows) await tx.generationJob.update({ where: { id: row.id }, data: updateData(row, input.data) });
        return { count: rows.length };
      });
    },
    async replace(input: {
      where: JobWhere;
      data: Patch;
      checkpointPolicy: GenerationCheckpointPolicy;
    }) {
      return runMutationTransaction(async (tx) => {
        await lock(tx);
        const row = (await findIn(tx, { where: input.where }))[0];
        if (!row) throw new Error("GENERATION_JOB_NOT_FOUND");
        await deleteCheckpoints(tx, row.id, input.checkpointPolicy);
        return projectGenerationJob(await tx.generationJob.update({
          where: { id: row.id },
          data: updateData(row, input.data),
        }));
      });
    },
    async upsert(input: { where: JobWhere; create: Patch; update: Patch; rejectStatuses?: readonly string[] }) {
      return runMutationTransaction(async (tx) => {
        await lock(tx); const row = (await findIn(tx, { where: input.where }))[0];
        if (row && input.rejectStatuses?.includes(row.status)) throw new Error("GENERATION_JOB_BUSY");
        if (!row) return createIn(tx, input.create);
        return projectGenerationJob(await tx.generationJob.update({ where: { id: row.id }, data: updateData(row, input.update) }));
      });
    },
  };
}
export const contentGenerationJobs = storage("COURSE_CONTENT");
export const designGenerationJobs = storage("COURSE_DESIGN");
export const resourcePackageJobs = storage("COURSE_RESOURCE_PACKAGE");
export const qualityReviewJobs = storage("COURSE_QUALITY_REVIEW");
