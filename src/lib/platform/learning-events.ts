import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { AuthClaims } from "@/lib/auth/session";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { requireStudentUser } from "./access";
import { PlatformError } from "./repository";

const contextId = z.string().trim().min(1).max(200).optional();
export const learningEventSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(200),
  type: z.string().trim().min(1).max(120),
  occurredAt: z.string().datetime().optional(),
  offeringId: contextId,
  enrollmentId: contextId,
  chapterId: contextId,
  activityId: contextId,
  classroomInstanceId: contextId,
  participationId: contextId,
  metadata: z.json().refine((value) => JSON.stringify(value).length <= 32_768, "事件内容过大").optional(),
  source: z.string().max(80).optional(),
  durationMs: z.number().int().min(0).max(2_147_483_647).optional(),
}).refine((event) => Boolean(event.offeringId || event.enrollmentId || event.chapterId || event.activityId || event.classroomInstanceId || event.participationId), "缺少学习事件归属");
export const learningEventsSchema = z.object({ events: z.array(learningEventSchema).min(1).max(100) });
export type LearningEventInput = z.input<typeof learningEventSchema>;

type Context = Partial<Record<"offeringId" | "enrollmentId" | "chapterId" | "activityId" | "classroomInstanceId" | "participationId", string>>;
function invalidContext(): never {
  throw new PlatformError("EVENT_SCOPE_MISMATCH", "学习事件不属于当前学生或课程上下文不一致", 403);
}
function mergeContext(context: Context, fields: Context) {
  for (const [key, value] of Object.entries(fields)) {
    const field = key as keyof Context;
    if (context[field] && context[field] !== value) invalidContext();
    context[field] = value;
  }
}

/** Resolve every supplied reference, never trust client-provided ownership. */
async function resolveContext(tx: Prisma.TransactionClient, userId: string, event: LearningEventInput) {
  const context: Context = { offeringId: event.offeringId, enrollmentId: event.enrollmentId, chapterId: event.chapterId, activityId: event.activityId, classroomInstanceId: event.classroomInstanceId, participationId: event.participationId };
  if (context.participationId) {
    const row = await tx.classroomParticipation.findUnique({ where: { id: context.participationId } });
    if (!row) invalidContext();
    mergeContext(context, { enrollmentId: row.enrollmentId, classroomInstanceId: row.instanceId });
  }
  if (context.classroomInstanceId) {
    const row = await tx.classroomInstance.findUnique({ where: { id: context.classroomInstanceId } });
    if (!row) invalidContext();
    mergeContext(context, { activityId: row.activityId });
  }
  if (context.activityId) {
    const row = await tx.activity.findUnique({ where: { id: context.activityId } });
    if (!row) invalidContext();
    mergeContext(context, { chapterId: row.chapterId });
  }
  if (context.chapterId) {
    const row = await tx.chapter.findUnique({ where: { id: context.chapterId } });
    if (!row) invalidContext();
    mergeContext(context, { offeringId: row.offeringId });
  }
  const enrollment = context.enrollmentId
    ? await tx.enrollment.findUnique({ where: { id: context.enrollmentId } })
    : context.offeringId
      ? await tx.enrollment.findUnique({ where: { userId_offeringId: { userId, offeringId: context.offeringId } } })
      : null;
  if (!enrollment || enrollment.userId !== userId || !["active", "completed"].includes(enrollment.status.toLowerCase())) invalidContext();
  mergeContext(context, { enrollmentId: enrollment.id, offeringId: enrollment.offeringId });
  if (context.classroomInstanceId && !context.participationId) {
    const participation = await tx.classroomParticipation.findUnique({ where: { instanceId_enrollmentId: { instanceId: context.classroomInstanceId, enrollmentId: enrollment.id } } });
    if (!participation) invalidContext();
    context.participationId = participation.id;
  }
  return { ...context, researchKey: enrollment.researchKey };
}

export async function appendValidatedLearningEvents(claims: AuthClaims, input: unknown) {
  const parsed = learningEventsSchema.safeParse({ events: input });
  if (!parsed.success) throw new PlatformError("INVALID_INPUT", "学习事件格式无效", 400);
  const events = parsed.data.events;
  const now = new Date();
  if (events.some((event) => event.occurredAt && Date.parse(event.occurredAt) > now.getTime() + 300_000)) {
    throw new PlatformError("INVALID_INPUT", "事件发生时间超出允许的时钟偏差", 400);
  }
  return runMutationTransaction(async (tx) => {
    const user = await requireStudentUser(claims, tx);
    const rows: Prisma.LearningEventCreateManyInput[] = [];
    // Complete validation before inserting any part of the batch.
    for (const event of events) {
      const context = await resolveContext(tx, user.id, event);
      rows.push({ ...context, id: randomUUID(), userId: user.id, idempotencyKey: event.idempotencyKey, eventType: event.type, occurredAt: event.occurredAt ? new Date(event.occurredAt) : now, source: event.source, durationMs: event.durationMs, metadata: event.metadata == null ? undefined : event.metadata as Prisma.InputJsonValue, eventVersion: 1 });
    }
    await tx.learningEvent.createMany({ data: rows, skipDuplicates: true });
    // A retry acknowledges durable duplicate keys as well as newly inserted keys.
    return events.map((event) => event.idempotencyKey);
  });
}
