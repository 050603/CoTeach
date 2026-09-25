import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import type { PlatformDb } from "@/lib/platform/access";
import { PlatformError } from "@/lib/platform/repository";
import type { CompanionMessage, CompanionThread, CompanionTriggerKind, Course, CompanionTask, CompanionConfirmation, CompanionProcessRecord } from "@/lib/session/types";

export type CompanionState = Pick<Course, "companionThreads" | "companionTasks" | "companionConfirmations" | "companionProcessRecords">;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const threadId = (instanceId: string, userId: string, stageKey: string) => `companion:${createHash("sha256").update(JSON.stringify([instanceId, userId, stageKey])).digest("hex")}`;

async function participationFor(db: PlatformDb, instanceId: string, userId: string) {
  const row = await db.classroomParticipation.findFirst({ where: { instanceId, enrollment: { userId } }, include: { enrollment: true, instance: { include: { activity: { include: { chapter: true } } } } } });
  if (!row || row.enrollment.offeringId !== row.instance.activity.chapter.offeringId) throw new PlatformError("STUDENT_SCOPE_MISMATCH", "协作记录不属于该课堂", 403);
  return row;
}

export async function ensureCompanionThreadWithinTransaction(db: Prisma.TransactionClient, instanceId: string, studentId: string, stageKey: string, openingSentAt?: string) {
  const participation = await participationFor(db, instanceId, studentId);
  const id = threadId(instanceId, studentId, stageKey);
  const previous = await db.aiConversation.findUnique({ where: { id } });
  const metadata = object(previous?.metadata);
  const row = await db.aiConversation.upsert({ where: { id }, create: { id, userId: studentId, offeringId: participation.enrollment.offeringId, participationId: participation.id, title: stageKey, metadata: json({ legacyStageKey: stageKey, openingSentAt }) }, update: { metadata: json({ ...metadata, legacyStageKey: stageKey, ...(openingSentAt && !metadata.openingSentAt ? { openingSentAt } : {}) }) } });
  return { row, participation };
}
const ensureThread = ensureCompanionThreadWithinTransaction;

function projectMessage(row: { id: string; role: string; content: string; createdAt: Date; metadata: unknown }): CompanionMessage {
  const meta = object(row.metadata);
  return { ...meta, id: row.id, role: (meta.legacyRole ?? (row.role === "assistant" ? "agent" : row.role === "user" ? "student" : "system-trigger")) as CompanionMessage["role"], visibility: (meta.visibility ?? "student-and-teacher") as CompanionMessage["visibility"], content: row.content, createdAt: row.createdAt.toISOString() };
}

export async function loadCompanionState(instanceId: string, db: PlatformDb = prisma): Promise<CompanionState> {
  const [conversations, tasks, confirmations, records] = await Promise.all([
    db.aiConversation.findMany({ where: { participation: { instanceId } }, include: { messages: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } } }),
    db.aiTask.findMany({ where: { conversation: { participation: { instanceId } } }, include: { conversation: true } }),
    db.aiActionConfirmation.findMany({ where: { payload: { path: ["legacy", "instanceId"], equals: instanceId } } }),
    db.aiSupportRecord.findMany({ where: { participation: { instanceId }, type: "COMPANION_PROCESS" } }),
  ]);
  const companionThreads = conversations.flatMap((row): CompanionThread[] => {
    const metadata = object(row.metadata);
    if (typeof metadata.legacyStageKey !== "string") return [];
    return [{ id: row.id, courseId: instanceId, studentId: row.userId, stageKey: metadata.legacyStageKey, messages: row.messages.map(projectMessage), openingSentAt: typeof metadata.openingSentAt === "string" ? metadata.openingSentAt : undefined, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }];
  });
  const companionTasks = tasks.flatMap((row): CompanionTask[] => {
    const legacy = object(object(row.input).legacy);
    if (typeof legacy.stageKey !== "string") return [];
    return [{ ...legacy, id: row.id, courseId: instanceId, studentId: row.createdById, stageKey: legacy.stageKey, kind: row.taskType as CompanionTask["kind"], status: row.status.toLowerCase() as CompanionTask["status"], title: String(legacy.title ?? ""), request: String(object(row.input).request ?? ""), result: typeof object(row.output).result === "string" ? object(row.output).result as string : undefined, error: row.error ?? undefined, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }];
  });
  const companionConfirmations = confirmations.map((row): CompanionConfirmation => {
    const legacy = object(object(row.payload).legacy);
    return { id: row.id, courseId: instanceId, studentId: row.requestedById, stageKey: String(legacy.stageKey ?? ""), action: row.actionType as CompanionConfirmation["action"], title: String(legacy.title ?? ""), summary: String(legacy.summary ?? ""), taskId: row.taskId ?? undefined, payload: object(object(row.payload).detail), status: row.status === "APPROVED" ? "confirmed" : row.status === "REJECTED" ? "rejected" : "pending", createdAt: row.createdAt.toISOString(), resolvedAt: row.decidedAt?.toISOString() };
  });
  const companionProcessRecords = records.map((row): CompanionProcessRecord => {
    const data = object(row.structuredPayload);
    return { ...data, id: row.id, courseId: instanceId, studentId: row.createdById, stageKey: String(data.stageKey ?? ""), title: String(data.title ?? ""), summary: row.summary ?? "", source: (data.source ?? "system") as CompanionProcessRecord["source"], createdAt: row.createdAt.toISOString() };
  });
  return { companionThreads, companionTasks, companionConfirmations, companionProcessRecords };
}

export async function getCompanionThread(courseId: string, studentId: string, stageKey: string): Promise<CompanionThread | undefined> {
  await participationFor(prisma, courseId, studentId);
  const row = await prisma.aiConversation.findUnique({ where: { id: threadId(courseId, studentId, stageKey) }, include: { messages: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } } });
  if (!row) return undefined;
  const metadata = object(row.metadata);
  return { id: row.id, courseId, studentId, stageKey, messages: row.messages.map(projectMessage), openingSentAt: typeof metadata.openingSentAt === "string" ? metadata.openingSentAt : undefined, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

async function putMessages(db: Prisma.TransactionClient, conversationId: string, studentId: string, messages: CompanionMessage[]) {
  const conversation = await db.aiConversation.findUniqueOrThrow({ where: { id: conversationId }, include: { participation: { include: { enrollment: true } } } });
  if (!conversation.participation || conversation.userId !== studentId) throw new PlatformError("MESSAGE_SCOPE_MISMATCH", "消息归属不一致", 409);
  for (const message of messages) {
    const previous = await db.aiMessage.findUnique({ where: { id: message.id } });
    if (previous && previous.conversationId !== conversationId) throw new PlatformError("MESSAGE_SCOPE_MISMATCH", "消息归属不一致", 409);
    const { id, role, content, createdAt, ...extension } = message;
    const metadata = json({ ...object(previous?.metadata), ...extension, legacyRole: role });
    if (previous) {
      // Soft-delete flags change visibility; the original evidence remains immutable.
      await db.aiMessage.update({ where: { id }, data: { metadata } });
    } else {
      await db.aiMessage.create({ data: { id, conversationId, userId: role === "student" ? studentId : null, role: role === "student" ? "user" : role === "agent" ? "assistant" : "system", content, createdAt: new Date(createdAt), metadata } });
      await db.aiInteractionEvent.create({ data: { idempotencyKey: `companion-message:${id}`, userId: studentId, offeringId: conversation.offeringId, participationId: conversation.participation.id, conversationId, researchKey: conversation.participation.enrollment.researchKey, eventType: role === "student" ? "request" : role === "agent" ? "response" : "comment", actor: role === "student" ? "student" : role === "agent" ? "assistant" : "system", content, payload: json({ schemaVersion: 1, legacy: { stageKey: object(conversation.metadata).legacyStageKey, source: "sidebar", actorId: message.authorId, conversationId: message.conversationId }, detail: { messageId: id, visibility: message.visibility, triggerKind: message.triggerKind } }) } });
    }
  }
}

export async function appendCompanionMessages(input: { courseId: string; studentId: string; stageKey: string; messages: CompanionMessage[]; openingTrigger?: CompanionTriggerKind }): Promise<void> {
  await runMutationTransaction(async tx => {
    await appendCompanionMessagesWithinTransaction(tx, input);
  });
}

/** Use with the caller's transaction when a task receipt and its messages must commit together. */
export async function appendCompanionMessagesWithinTransaction(
  tx: Prisma.TransactionClient,
  input: { courseId: string; studentId: string; stageKey: string; messages: CompanionMessage[]; openingTrigger?: CompanionTriggerKind },
): Promise<void> {
  const participation = await participationFor(tx, input.courseId, input.studentId);
  await tx.$queryRaw`SELECT id FROM "ClassroomParticipation" WHERE id = ${participation.id} FOR UPDATE`;
  const { row } = await ensureThread(tx, input.courseId, input.studentId, input.stageKey, input.openingTrigger === "stage-opening" ? new Date().toISOString() : undefined);
  await putMessages(tx, row.id, input.studentId, input.messages);
}

export async function softDeleteCompanionMessage(input: { courseId: string; studentId: string; stageKey: string; messageId: string; conversationId: string }): Promise<boolean> {
  return runMutationTransaction(async tx => {
    const participation = await participationFor(tx, input.courseId, input.studentId);
    await tx.$queryRaw`SELECT id FROM "ClassroomParticipation" WHERE id = ${participation.id} FOR UPDATE`;
    const row = await tx.aiMessage.findFirst({ where: { id: input.messageId, conversationId: threadId(input.courseId, input.studentId, input.stageKey) } });
    if (!row) return false;
    const message = projectMessage(row);
    if (message.role === "system-trigger" || (message.conversationId ?? "legacy") !== input.conversationId) return false;
    const now = new Date().toISOString();
    await tx.aiMessage.update({ where: { id: row.id }, data: { metadata: json({ ...object(row.metadata), hiddenFromStudentAt: message.hiddenFromStudentAt ?? now, excludedFromAiAt: message.excludedFromAiAt ?? now }) } });
    return true;
  });
}

/** The session reducer dispatches changed entities here inside its existing transaction. */
export async function persistCompanionState(tx: Prisma.TransactionClient, instanceId: string, before: CompanionState, after: CompanionState, targetStudentId?: string) {
  function changed<T extends { id: string; studentId: string }>(previous: T[] | undefined, next: T[] | undefined): T[] {
    const old = new Map((previous ?? []).map(row => [row.id, JSON.stringify(row)]));
    return (next ?? []).filter(row => (!targetStudentId || row.studentId === targetStudentId) && old.get(row.id) !== JSON.stringify(row));
  }
  for (const thread of changed(before.companionThreads, after.companionThreads)) {
    const { row } = await ensureThread(tx, instanceId, thread.studentId, thread.stageKey, thread.openingSentAt);
    const oldThread = before.companionThreads?.find(old => old.studentId === thread.studentId && old.stageKey === thread.stageKey);
    const oldMessages = new Map(oldThread?.messages.map(m => [m.id, JSON.stringify(m)]) ?? []);
    await putMessages(tx, row.id, thread.studentId, thread.messages.filter(m => oldMessages.get(m.id) !== JSON.stringify(m)));
  }
  for (const task of changed(before.companionTasks, after.companionTasks)) {
    const { row, participation } = await ensureThread(tx, instanceId, task.studentId, task.stageKey);
    const old = await tx.aiTask.findUnique({ where: { id: task.id } });
    if (old && (old.createdById !== task.studentId || old.conversationId !== row.id)) throw new PlatformError("TASK_SCOPE_MISMATCH", "任务归属不一致", 409);
    const data = { conversationId: row.id, offeringId: participation.enrollment.offeringId, createdById: task.studentId, taskType: task.kind, status: task.status.toUpperCase(), input: json({ request: task.request, legacy: { stageKey: task.stageKey, title: task.title, companionId: task.companionId, confirmationId: task.confirmationId } }), output: task.result ? json({ result: task.result }) : Prisma.JsonNull, error: task.error ?? null, completedAt: ["saved", "failed", "result"].includes(task.status) ? new Date(task.updatedAt) : null };
    await tx.aiTask.upsert({ where: { id: task.id }, create: { id: task.id, ...data, createdAt: new Date(task.createdAt) }, update: data });
  }
  for (const confirmation of changed(before.companionConfirmations, after.companionConfirmations)) {
    const participation = await participationFor(tx, instanceId, confirmation.studentId);
    const old = await tx.aiActionConfirmation.findUnique({ where: { id: confirmation.id } });
    if (old && (old.requestedById !== confirmation.studentId || object(object(old.payload).legacy).instanceId !== instanceId)) throw new PlatformError("CONFIRMATION_SCOPE_MISMATCH", "确认归属不一致", 409);
    if (old && old.status !== "PENDING") continue;
    if (confirmation.taskId) {
      const task = await tx.aiTask.findFirst({ where: { id: confirmation.taskId, createdById: confirmation.studentId, conversation: { participationId: participation.id } } });
      if (!task) throw new PlatformError("TASK_SCOPE_MISMATCH", "确认任务归属不一致", 409);
    }
    const data = { taskId: confirmation.taskId ?? null, offeringId: participation.enrollment.offeringId, requestedById: confirmation.studentId, actionType: confirmation.action, payload: json({ legacy: { instanceId, stageKey: confirmation.stageKey, title: confirmation.title, summary: confirmation.summary }, detail: confirmation.payload ?? {} }), status: confirmation.status === "confirmed" ? "APPROVED" : confirmation.status.toUpperCase(), decidedById: confirmation.status !== "pending" ? confirmation.studentId : null, decidedAt: confirmation.resolvedAt ? new Date(confirmation.resolvedAt) : null };
    await tx.aiActionConfirmation.upsert({ where: { id: confirmation.id }, create: { id: confirmation.id, ...data, createdAt: new Date(confirmation.createdAt) }, update: data });
  }
  for (const record of changed(before.companionProcessRecords, after.companionProcessRecords)) {
    const participation = await participationFor(tx, instanceId, record.studentId);
    const old = await tx.aiSupportRecord.findUnique({ where: { id: record.id } });
    if (old) { if (old.participationId !== participation.id) throw new PlatformError("RECORD_SCOPE_MISMATCH", "过程记录归属不一致", 409); continue; }
    await tx.aiSupportRecord.create({ data: { id: record.id, participationId: participation.id, offeringId: participation.enrollment.offeringId, createdById: record.studentId, type: "COMPANION_PROCESS", summary: record.summary, structuredPayload: json({ stageKey: record.stageKey, title: record.title, source: record.source, companionId: record.companionId, taskId: record.taskId, evidenceIds: record.evidenceIds }), createdAt: new Date(record.createdAt) } });
  }
  const facts = [
    ...changed(before.companionTasks, after.companionTasks).map(row => ({ row, eventType: "companion_task_changed", revision: row.updatedAt, status: row.status })),
    ...changed(before.companionConfirmations, after.companionConfirmations).map(row => ({ row, eventType: "companion_confirmation_changed", revision: row.resolvedAt ?? row.createdAt, status: row.status })),
    ...changed(before.companionProcessRecords, after.companionProcessRecords).map(row => ({ row, eventType: "companion_process_recorded", revision: row.createdAt, status: "RECORDED" })),
  ];
  for (const { row, eventType, revision, status } of facts) {
    const participation = await participationFor(tx, instanceId, row.studentId);
    const idempotencyKey = `companion-fact:${createHash("sha256").update(JSON.stringify([eventType, row.id, revision, status])).digest("hex")}`;
    await tx.domainEvent.upsert({ where: { idempotencyKey }, create: { idempotencyKey, offeringId: participation.enrollment.offeringId, classroomInstanceId: instanceId, participationId: participation.id, researchKey: participation.enrollment.researchKey, eventType, payload: { entityId: row.id, stageKey: row.stageKey, status, source: "session_dispatch", schemaVersion: 1 } }, update: {} });
  }
}

export function companionMessage(message: Omit<CompanionMessage, "id" | "createdAt"> & { createdAt?: string }): CompanionMessage {
  return { ...message, id: `companion-message-${randomUUID()}`, createdAt: message.createdAt ?? new Date().toISOString() };
}
