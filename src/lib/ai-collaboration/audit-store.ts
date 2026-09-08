import { randomUUID } from "node:crypto";
import { prisma, isDatabaseConfigured } from "@/lib/db/client";
import { publishCourseEvent } from "@/lib/realtime/event-bus";
import type { AiInteractionEvent } from "@/lib/session/types";
import { findLegacyParticipation } from "@/lib/platform/access";

export type AiInteractionEventInput = Omit<AiInteractionEvent, "id" | "createdAt"> & {
  id?: string;
  createdAt?: string;
  participationId?: string;
};

function toJson(value: Record<string, unknown> | undefined): object {
  return value ?? {};
}

/**
 * Persist an append-only collaboration event. Existing JSON session mode may
 * not have a database; in that mode the caller still writes the legacy thread
 * and this helper becomes a safe no-op.
 */
export async function appendAiInteractionEvents(
  events: AiInteractionEventInput[],
): Promise<AiInteractionEvent[]> {
  if (!events.length || !isDatabaseConfigured()) return [];
  const created = await prisma.$transaction(async (tx) => {
    const rows: AiInteractionEvent[] = [];
    for (const event of events) {
      const participationId = event.participationId
        ?? (await findLegacyParticipation(tx, event.courseId, event.studentId))?.id;
      const row = await tx.aiInteractionEvent.create({
        data: {
          id: event.id ?? randomUUID(),
          courseId: event.courseId,
          studentId: event.studentId,
          stageKey: event.stageKey,
          conversationId: event.conversationId ?? null,
          source: event.source,
          eventType: event.eventType,
          actorRole: event.actorRole,
          actorId: event.actorId ?? null,
          content: event.content ?? null,
          payload: toJson(event.payload),
          requestId: event.requestId ?? null,
          participationId: participationId ?? null,
          createdAt: event.createdAt ? new Date(event.createdAt) : undefined,
        },
      });
      rows.push({
        id: row.id,
        courseId: row.courseId,
        studentId: row.studentId,
        stageKey: row.stageKey,
        conversationId: row.conversationId ?? undefined,
        source: row.source as AiInteractionEvent["source"],
        eventType: row.eventType as AiInteractionEvent["eventType"],
        actorRole: row.actorRole as AiInteractionEvent["actorRole"],
        actorId: row.actorId ?? undefined,
        content: row.content ?? undefined,
        payload: (row.payload as Record<string, unknown>) ?? undefined,
        requestId: row.requestId ?? undefined,
        createdAt: row.createdAt.toISOString(),
      });
    }
    return rows;
  });
  if (created.length) {
    try {
      await publishCourseEvent(created[0].courseId, {
        type: "companion-message",
        courseId: created[0].courseId,
        at: new Date().toISOString(),
        payload: {
          source: "ai-interaction-event",
          scope: "student",
          studentId: created[0].studentId,
          stageKey: created[0].stageKey,
          eventIds: created.map((event) => event.id),
        },
      });
    } catch (error) {
      console.error("[ai-audit] realtime publish failed after event save", error);
    }
  }
  return created;
}


function decodeCursor(cursor: string | null): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (typeof raw.createdAt !== "string" || typeof raw.id !== "string") return null;
    const createdAt = new Date(raw.createdAt);
    return Number.isNaN(createdAt.getTime()) || !raw.id ? null : { createdAt, id: raw.id };
  } catch {
    return null;
  }
}

export function encodeAiInteractionCursor(event: Pick<AiInteractionEvent, "id" | "createdAt">): string {
  return Buffer.from(JSON.stringify({ createdAt: event.createdAt, id: event.id }), "utf8").toString("base64url");
}

export async function listAiInteractionEvents(input: {
  courseId: string;
  studentId?: string;
  stageKey?: string;
  limit?: number;
  cursor?: string | null;
}): Promise<{ events: AiInteractionEvent[]; nextCursor?: string }> {
  if (!isDatabaseConfigured()) return { events: [] };
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const cursor = decodeCursor(input.cursor ?? null);
  const rows = await prisma.aiInteractionEvent.findMany({
    where: {
      courseId: input.courseId,
      ...(input.studentId ? { studentId: input.studentId } : {}),
      ...(input.stageKey ? { stageKey: input.stageKey } : {}),
      ...(cursor ? {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const events = page.map((row): AiInteractionEvent => ({
    id: row.id,
    courseId: row.courseId,
    studentId: row.studentId,
    stageKey: row.stageKey,
    conversationId: row.conversationId ?? undefined,
    source: row.source as AiInteractionEvent["source"],
    eventType: row.eventType as AiInteractionEvent["eventType"],
    actorRole: row.actorRole as AiInteractionEvent["actorRole"],
    actorId: row.actorId ?? undefined,
    content: row.content ?? undefined,
    payload: (row.payload as Record<string, unknown>) ?? undefined,
    requestId: row.requestId ?? undefined,
    createdAt: row.createdAt.toISOString(),
  }));
  return {
    events,
    ...(hasMore && events.length ? { nextCursor: encodeAiInteractionCursor(events[events.length - 1]) } : {}),
  };
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
