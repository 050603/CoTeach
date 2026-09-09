import { createHash, randomUUID } from "node:crypto";
import type { AiInteractionEvent as EventRow, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { runMutationTransaction } from "@/lib/db/transaction-retry";
import { publishCourseEvent } from "@/lib/realtime/event-bus";
import type { AiInteractionEvent } from "@/lib/session/types";
import { PlatformError } from "@/lib/platform/repository";

export type AiInteractionEventInput = Omit<AiInteractionEvent, "id" | "createdAt"> & { id?: string; createdAt?: string; participationId?: string };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function projectEvent(row: EventRow, courseId: string): AiInteractionEvent {
  const envelope = object(row.payload); const legacy = object(envelope.legacy);
  return { id: row.id, courseId, studentId: row.userId, stageKey: String(legacy.stageKey ?? "make"), conversationId: typeof legacy.conversationId === "string" ? legacy.conversationId : row.conversationId ?? undefined, source: (legacy.source ?? "system") as AiInteractionEvent["source"], eventType: row.eventType as AiInteractionEvent["eventType"], actorRole: (row.actor === "assistant" ? "ai" : row.actor) as AiInteractionEvent["actorRole"], actorId: typeof legacy.actorId === "string" ? legacy.actorId : undefined, content: row.content ?? undefined, payload: object(envelope.detail), requestId: row.requestId ?? undefined, createdAt: row.createdAt.toISOString() };
}

/** Persist legacy producer events as V2 facts. All IDs are resolved through participation. */
export async function appendAiInteractionEvents(events: AiInteractionEventInput[]): Promise<AiInteractionEvent[]> {
  if (!events.length) return [];
  const created = await runMutationTransaction(async tx => {
    const rows: AiInteractionEvent[] = [];
    for (const event of events) {
      const participation = await tx.classroomParticipation.findFirst({ where: { ...(event.participationId ? { id: event.participationId } : {}), instanceId: event.courseId, enrollment: { userId: event.studentId } }, include: { enrollment: true, instance: { include: { activity: { include: { chapter: true } } } } } });
      if (!participation || participation.enrollment.offeringId !== participation.instance.activity.chapter.offeringId) throw new PlatformError("EVENT_SCOPE_MISMATCH", "AI 事件归属无效", 403);
      await tx.$queryRaw`SELECT id FROM "ClassroomParticipation" WHERE id = ${participation.id} FOR UPDATE`;
      const eventKey = event.id ?? (event.requestId ? hash([event.requestId, event.stageKey, event.source, event.eventType, event.actorRole, event.content, event.payload]) : randomUUID());
      const idempotencyKey = `legacy-ai:${hash([participation.id, event.studentId, eventKey])}`;
      const previous = await tx.aiInteractionEvent.findUnique({ where: { idempotencyKey } });
      if (previous) { rows.push(projectEvent(previous, event.courseId)); continue; }
      let conversationId: string | undefined;
      if (event.conversationId) {
        // Logical editor conversation IDs are not database foreign keys.
        const actual = await tx.aiConversation.findFirst({ where: { id: event.conversationId, participationId: participation.id, userId: event.studentId } });
        const id = actual?.id ?? `legacy-ai-conversation:${hash([participation.id, event.stageKey, event.conversationId])}`;
        const conversation = await tx.aiConversation.upsert({ where: { id }, create: { id, userId: event.studentId, offeringId: participation.enrollment.offeringId, participationId: participation.id, title: event.stageKey, metadata: { legacyAuditConversation: event.conversationId, stageKey: event.stageKey } }, update: {} });
        conversationId = conversation.id;
      }
      const row = await tx.aiInteractionEvent.create({ data: {
        idempotencyKey, userId: event.studentId, offeringId: participation.enrollment.offeringId, participationId: participation.id, researchKey: participation.enrollment.researchKey,
        conversationId, eventType: event.eventType, actor: event.actorRole === "ai" ? "assistant" : event.actorRole, content: event.content,
        requestId: event.requestId, payload: { schemaVersion: 1, legacy: { stageKey: event.stageKey, source: event.source, actorId: event.actorId ?? null, conversationId: event.conversationId ?? null, occurredAt: event.createdAt ?? null }, detail: event.payload ?? {} } as Prisma.InputJsonValue,
      } });
      rows.push(projectEvent(row, event.courseId));
    }
    return rows;
  });
  for (const courseId of new Set(created.map(event => event.courseId))) {
    const courseEvents = created.filter(event => event.courseId === courseId);
    try { await publishCourseEvent(courseId, { type: "companion-message", courseId, at: new Date().toISOString(), payload: { source: "ai-interaction-event", scope: "student", studentId: courseEvents[0].studentId, stageKey: courseEvents[0].stageKey, eventIds: courseEvents.map(event => event.id) } }); }
    catch (error) { console.error("[ai-audit] realtime publish failed after event save", error); }
  }
  return created;
}

function decodeCursor(cursor: string | null): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { createdAt?: unknown; id?: unknown };
    if (typeof raw.createdAt !== "string" || typeof raw.id !== "string") throw new Error("invalid");
    const createdAt = new Date(raw.createdAt);
    if (Number.isNaN(createdAt.getTime()) || !raw.id) throw new Error("invalid");
    return { createdAt, id: raw.id };
  } catch { throw new PlatformError("INVALID_CURSOR", "分页游标无效", 400); }
}
export function encodeAiInteractionCursor(event: Pick<AiInteractionEvent, "id" | "createdAt">): string {
  return Buffer.from(JSON.stringify({ createdAt: event.createdAt, id: event.id }), "utf8").toString("base64url");
}
export async function listAiInteractionEvents(input: { courseId: string; studentId?: string; stageKey?: string; limit?: number; cursor?: string | null }): Promise<{ events: AiInteractionEvent[]; nextCursor?: string }> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const cursor = decodeCursor(input.cursor ?? null);
  const rows = await prisma.aiInteractionEvent.findMany({ where: {
    participation: { instanceId: input.courseId }, ...(input.studentId ? { userId: input.studentId } : {}),
    ...(input.stageKey ? { payload: { path: ["legacy", "stageKey"], equals: input.stageKey } } : {}),
    ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}),
  }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1 });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const events = page.map(row => projectEvent(row, input.courseId));
  return { events, ...(hasMore && events.length ? { nextCursor: encodeAiInteractionCursor(events[events.length - 1]) } : {}) };
}

export function aiInteractionEventsToCsv(events: AiInteractionEvent[]): string {
  const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const header = ["createdAt", "studentId", "stageKey", "source", "eventType", "actorRole", "content", "payload"];
  return [
    header.join(","),
    ...events.map((event) => [
      event.createdAt,
      event.studentId,
      event.stageKey,
      event.source,
      event.eventType,
      event.actorRole,
      event.content,
      JSON.stringify(event.payload ?? {}),
    ].map(escape).join(",")),
  ].join("\n");
}
