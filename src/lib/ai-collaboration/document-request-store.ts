import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { publishCourseEvent } from "@/lib/realtime/event-bus";
import {
  appendCompanionMessagesWithinTransaction,
  ensureCompanionThreadWithinTransaction,
} from "@/lib/companion/server-store";
import type { CompanionMessage } from "@/lib/session/types";

const TASK_TYPE = "DOCUMENT_COLLABORATION";
const LEASE_MS = 125_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function taskId(participationId: string, requestId: string): string {
  return `document-ai-${createHash("sha256").update(JSON.stringify([participationId, requestId])).digest("hex")}`;
}

export type DocumentRequestIdentity = {
  requestId: string;
  participationId: string;
  courseId: string;
  studentId: string;
  stageKey: string;
  workspaceKind: string;
  conversationId: string;
};

export type DocumentRequestInput = DocumentRequestIdentity & {
  threadStageKey: string;
  fingerprint: string;
  documentVersion: string;
  message: string;
  intent: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
};

export type DocumentRequestState = {
  requestId: string;
  status: "processing" | "completed" | "failed" | "cancelled";
  message: string;
  intent: string;
  conversationId: string;
  documentVersion: string;
  createdAt: string;
  error?: string;
  response?: Record<string, unknown>;
};

function projectTask(task: {
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
}): DocumentRequestState {
  const input = record(task.input);
  const output = record(task.output);
  const leaseExpired = task.status === "RUNNING"
    && (!task.startedAt || task.startedAt.getTime() < Date.now() - LEASE_MS);
  return {
    requestId: String(input.requestId ?? ""),
    status: task.status === "COMPLETED" ? "completed"
      : task.status === "CANCELLED" ? "cancelled"
      : task.status === "FAILED" || leaseExpired ? "failed" : "processing",
    message: String(input.message ?? ""),
    intent: String(input.intent ?? "discuss"),
    conversationId: String(input.conversationId ?? ""),
    documentVersion: String(input.documentVersion ?? ""),
    createdAt: task.createdAt.toISOString(),
    ...(task.error || leaseExpired ? { error: task.error ?? "REQUEST_INTERRUPTED" } : {}),
    ...(output.response && typeof output.response === "object" && !Array.isArray(output.response)
      ? { response: output.response as Record<string, unknown> }
      : {}),
  };
}

export async function getDocumentRequest(input: DocumentRequestIdentity): Promise<DocumentRequestState | null> {
  const task = await prisma.aiTask.findFirst({
    where: {
      id: taskId(input.participationId, input.requestId),
      taskType: TASK_TYPE,
      createdById: input.studentId,
      conversation: { participationId: input.participationId },
    },
  });
  if (!task) return null;
  const saved = record(task.input);
  if (saved.stageKey !== input.stageKey || saved.workspaceKind !== input.workspaceKind) return null;
  if (input.conversationId && saved.conversationId !== input.conversationId) return null;
  return projectTask(task);
}

/** A rejected worker lease is not evidence that the durable task was cancelled. */
export async function readDocumentRequestReceipt(input: DocumentRequestIdentity): Promise<{
  status: number; body: Record<string, unknown>;
}> {
  const state = await getDocumentRequest(input);
  if (!state) return { status: 503, body: { requestId: input.requestId, status: "failed", error: "REQUEST_STATE_UNAVAILABLE", retryable: true } };
  if (state.status === "completed") {
    return state.response ? { status: 200, body: state.response }
      : { status: 503, body: { requestId: input.requestId, status: "failed", error: "REQUEST_RECEIPT_MISSING", retryable: true } };
  }
  const body = { requestId: input.requestId, status: state.status, documentVersion: state.documentVersion };
  if (state.status === "cancelled") return { status: 409, body };
  if (state.status === "processing") return { status: 202, body: { ...body, retryAfterMs: 1_000 } };
  return { status: 503, body: { ...body, error: state.error ?? "AI_COLLABORATION_FAILED", retryable: true } };
}

export async function listDocumentRequests(input: Omit<DocumentRequestIdentity, "requestId">): Promise<DocumentRequestState[]> {
  const tasks = await prisma.aiTask.findMany({
    where: {
      taskType: TASK_TYPE,
      createdById: input.studentId,
      conversation: { participationId: input.participationId },
      status: { in: ["RUNNING", "FAILED", "CANCELLED"] },
    },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  return tasks.filter((task) => {
    const saved = record(task.input);
    return saved.stageKey === input.stageKey
      && saved.workspaceKind === input.workspaceKind
      && saved.conversationId === input.conversationId;
  }).map(projectTask);
}

export type ClaimResult =
  | { kind: "run"; token: string; history: DocumentRequestInput["history"] }
  | { kind: "existing"; state: DocumentRequestState }
  | { kind: "conflict" };

export async function claimDocumentRequest(input: DocumentRequestInput): Promise<ClaimResult> {
  return runMutationTransaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ClassroomParticipation" WHERE id = ${input.participationId} FOR UPDATE`;
    const { row, participation } = await ensureCompanionThreadWithinTransaction(
      tx, input.courseId, input.studentId, input.threadStageKey,
    );
    const id = taskId(input.participationId, input.requestId);
    const existing = await tx.aiTask.findUnique({ where: { id } });
    let history = input.history;
    if (existing) {
      const saved = record(existing.input);
      if (
        existing.taskType !== TASK_TYPE
        || existing.createdById !== input.studentId
        || existing.conversationId !== row.id
        || saved.fingerprint !== input.fingerprint
      ) return { kind: "conflict" };
      const stale = existing.status === "RUNNING"
        && (!existing.startedAt || existing.startedAt.getTime() < Date.now() - LEASE_MS);
      if (!stale && existing.status !== "FAILED") {
        return { kind: "existing", state: projectTask(existing) };
      }
      if (Array.isArray(saved.history)) {
        history = saved.history.flatMap((turn) => {
          const item = record(turn);
          return (item.role === "user" || item.role === "assistant") && typeof item.content === "string"
            ? [{ role: item.role, content: item.content }]
            : [];
        });
      }
    }
    const token = randomUUID();
    const taskInput = {
      schemaVersion: 1,
      requestId: input.requestId,
      participationId: input.participationId,
      stageKey: input.stageKey,
      workspaceKind: input.workspaceKind,
      conversationId: input.conversationId,
      documentVersion: input.documentVersion,
      fingerprint: input.fingerprint,
      message: input.message,
      intent: input.intent,
      history,
      token,
    } satisfies Prisma.InputJsonObject;
    if (existing) {
      await tx.aiTask.update({
        where: { id },
        data: { status: "RUNNING", input: taskInput, output: Prisma.JsonNull, error: null, startedAt: new Date(), completedAt: null },
      });
    } else {
      await tx.aiTask.create({
        data: {
          id,
          conversationId: row.id,
          offeringId: participation.enrollment.offeringId,
          createdById: input.studentId,
          taskType: TASK_TYPE,
          status: "RUNNING",
          input: taskInput,
          startedAt: new Date(),
        },
      });
    }
    return { kind: "run", token, history };
  });
}

export async function completeDocumentRequest(input: DocumentRequestInput & {
  token: string;
  messages: CompanionMessage[];
  response: Record<string, unknown>;
  auditEvents?: Array<{ idempotencyKey: string; eventType: string; actor: "system" | "assistant";
    content: string; payload: Record<string, unknown> }>;
}): Promise<boolean> {
  const committed = await runMutationTransaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ClassroomParticipation" WHERE id = ${input.participationId} FOR UPDATE`;
    const id = taskId(input.participationId, input.requestId);
    const task = await tx.aiTask.findUnique({ where: { id } });
    if (!task || task.status !== "RUNNING" || record(task.input).token !== input.token) return false;
    await appendCompanionMessagesWithinTransaction(tx, {
      courseId: input.courseId,
      studentId: input.studentId,
      stageKey: input.threadStageKey,
      messages: input.messages,
    });
    if (input.auditEvents?.length) {
      const participation = await tx.classroomParticipation.findUniqueOrThrow({ where: { id: input.participationId },
        select: { instanceId: true, enrollment: { select: { userId: true, offeringId: true, researchKey: true } } } });
      if (participation.instanceId !== input.courseId || participation.enrollment.userId !== input.studentId) throw new Error("REVIEW_EVENT_SCOPE_MISMATCH");
      await tx.aiInteractionEvent.createMany({ data: input.auditEvents.map(event => ({
        ...event, payload: JSON.parse(JSON.stringify(event.payload)) as Prisma.InputJsonValue,
        userId: input.studentId, participationId: input.participationId, offeringId: participation.enrollment.offeringId,
        researchKey: participation.enrollment.researchKey, taskId: id, conversationId: task.conversationId,
        requestId: input.requestId,
      })) });
    }
    await tx.aiTask.update({
      where: { id },
      data: {
        status: "COMPLETED",
        output: { schemaVersion: 1, response: input.response } as Prisma.InputJsonObject,
        completedAt: new Date(),
      },
    });
    return true;
  });
  if (committed && input.auditEvents?.length) {
    try {
      await publishCourseEvent(input.courseId, { type: "companion-message", courseId: input.courseId,
        at: new Date().toISOString(), payload: { source: "ai-interaction-event", scope: "student",
          studentId: input.studentId, stageKey: input.stageKey, requestId: input.requestId } });
    } catch { console.error("[document-ai] review saved; realtime notification failed"); }
  }
  return committed;
}

export async function failDocumentRequest(input: DocumentRequestIdentity & { token: string; error: string }): Promise<boolean> {
  return runMutationTransaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ClassroomParticipation" WHERE id = ${input.participationId} FOR UPDATE`;
    const id = taskId(input.participationId, input.requestId);
    const task = await tx.aiTask.findUnique({ where: { id } });
    if (!task || task.status !== "RUNNING" || record(task.input).token !== input.token) return false;
    await tx.aiTask.update({ where: { id }, data: { status: "FAILED", error: input.error, completedAt: new Date() } });
    return true;
  });
}

export async function cancelDocumentRequest(input: DocumentRequestIdentity): Promise<DocumentRequestState | null> {
  return runMutationTransaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ClassroomParticipation" WHERE id = ${input.participationId} FOR UPDATE`;
    const id = taskId(input.participationId, input.requestId);
    const task = await tx.aiTask.findFirst({
      where: { id, taskType: TASK_TYPE, createdById: input.studentId, conversation: { participationId: input.participationId } },
    });
    if (!task) return null;
    const saved = record(task.input);
    if (saved.stageKey !== input.stageKey || saved.workspaceKind !== input.workspaceKind
      || saved.conversationId !== input.conversationId) return null;
    if (task.status !== "RUNNING") return projectTask(task);
    const updated = await tx.aiTask.update({ where: { id }, data: { status: "CANCELLED", completedAt: new Date() } });
    return projectTask(updated);
  });
}
