import { z } from "zod";
import { prisma } from "@/lib/db/client";
import type { AuthClaims } from "@/lib/auth/session";
import { requireTeacherUser } from "./access";
import { PlatformError } from "./repository";

const timestamp = z.string().datetime({ offset: true });
const exportType = z.enum(["events", "submissions", "outcomes", "ai", "domain"]);
const querySchema = z.object({
  type: exportType.default("events"),
  take: z.coerce.number().int().min(1).max(500).default(200),
  since: timestamp.optional(),
  until: timestamp.optional(),
  includeContent: z.enum(["true", "false"]).default("false"),
  cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();
const cursorSchema = z.object({
  version: z.literal(1),
  offeringId: z.string().min(1).max(200),
  type: exportType,
  includeContent: z.boolean().optional(),
  since: timestamp,
  until: timestamp,
  at: timestamp,
  id: z.string().min(1).max(200),
}).strict();

function invalidInput(): never {
  throw new PlatformError("INVALID_INPUT", "请检查导出类型、分页游标和时间范围", 400);
}

function decodeCursor(value: string) {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    return invalidInput();
  }
}

/** A cursor carries a fixed window; every page independently checks course authorization. */
export async function exportOfferingResearch(
  claims: AuthClaims,
  offeringId: string,
  query: Record<string, string>,
) {
  if (claims.role !== "teacher") throw new PlatformError("FORBIDDEN", "仅教学班教师可导出研究数据", 403);
  const teacher = await requireTeacherUser(claims);
  const link = await prisma.courseTeacher.findFirst({ where: { offeringId, userId: teacher.id }, select: { id: true } });
  if (!link) throw new PlatformError("FORBIDDEN", "无权导出该教学班", 403);
  const parsed = querySchema.safeParse(query);
  if (!parsed.success) return invalidInput();
  const options = parsed.data;
  const cursor = options.cursor ? decodeCursor(options.cursor) : null;
  const since = new Date(options.since ?? cursor?.since ?? 0);
  const until = new Date(options.until ?? cursor?.until ?? Date.now());
  if (since > until || (cursor && (
    cursor.offeringId !== offeringId || cursor.type !== options.type ||
    (cursor.includeContent !== undefined && cursor.includeContent !== (options.includeContent === "true")) ||
    new Date(cursor.since).getTime() !== since.getTime() ||
    new Date(cursor.until).getTime() !== until.getTime() ||
    new Date(cursor.at) < since || new Date(cursor.at) > until
  ))) return invalidInput();
  const window = { since: since.toISOString(), until: until.toISOString() };
  const includeContent = options.includeContent === "true";

  function page<T extends { id: string }>(records: T[], dateOf: (row: T) => Date) {
    const rows = records.slice(0, options.take);
    const last = rows.at(-1);
    return {
      exportVersion: 1,
      type: options.type,
      window,
      rows,
      nextCursor: records.length > options.take && last
        ? Buffer.from(JSON.stringify({ version: 1, offeringId, type: options.type, includeContent, ...window, at: dateOf(last).toISOString(), id: last.id })).toString("base64url")
        : null,
    };
  }

  if (options.type === "events") {
    const records = await prisma.learningEvent.findMany({
      where: {
        offeringId,
        receivedAt: { gte: since, lte: until },
        ...(cursor ? { OR: [
          { receivedAt: { gt: new Date(cursor.at) } },
          { receivedAt: new Date(cursor.at), id: { gt: cursor.id } },
        ] } : {}),
      },
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
      take: options.take + 1,
      select: {
        id: true, researchKey: true, chapterId: true, activityId: true,
        classroomInstanceId: true, eventType: true, eventVersion: true,
        occurredAt: true, receivedAt: true, source: true, durationMs: true,
        ...(includeContent ? { metadata: true } : {}),
      },
    });
    return page(records.map((row) => ({
      id: row.id, researchKey: row.researchKey,
      quality: row.researchKey ? "complete" : "missing_research_key",
      chapterId: row.chapterId, activityId: row.activityId,
      classroomInstanceId: row.classroomInstanceId,
      eventType: row.eventType, eventVersion: row.eventVersion,
      occurredAt: row.occurredAt, receivedAt: row.receivedAt,
      source: row.source, durationMs: row.durationMs,
      ...(includeContent ? { metadata: row.metadata } : {}),
    })), (row) => row.receivedAt);
  }

  if (options.type === "ai") {
    const records = await prisma.aiInteractionEvent.findMany({
      where: {
        offeringId,
        createdAt: { gte: since, lte: until },
        ...(cursor ? { OR: [
          { createdAt: { gt: new Date(cursor.at) } },
          { createdAt: new Date(cursor.at), id: { gt: cursor.id } },
        ] } : {}),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: options.take + 1,
      select: {
        id: true, researchKey: true, eventType: true, actor: true, createdAt: true,
        participation: { select: { instanceId: true } },
        ...(includeContent ? { content: true, payload: true } : {}),
      },
    });
    return page(records.map((row) => ({
      id: row.id, researchKey: row.researchKey,
      quality: row.researchKey ? "complete" : "missing_research_key",
      classroomInstanceId: row.participation?.instanceId ?? null,
      eventType: row.eventType, actor: row.actor, createdAt: row.createdAt,
      ...(includeContent ? { content: row.content, payload: row.payload } : {}),
    })), (row) => row.createdAt);
  }

  if (options.type === "outcomes" || options.type === "domain") {
    const records = await prisma.domainEvent.findMany({
      where: {
        offeringId,
        ...(options.type === "outcomes" ? { eventType: { startsWith: "CLASSROOM_" } } : {}),
        createdAt: { gte: since, lte: until },
        ...(cursor ? { OR: [
          { createdAt: { gt: new Date(cursor.at) } },
          { createdAt: new Date(cursor.at), id: { gt: cursor.id } },
        ] } : {}),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: options.take + 1,
      select: {
        id: true, researchKey: true, classroomInstanceId: true,
        eventType: true, createdAt: true,
        ...(includeContent ? { payload: true } : {}),
      },
    });
    return page(records.map((row) => ({
      id: row.id, researchKey: row.researchKey,
      quality: row.researchKey ? "complete" : "missing_research_key",
      classroomInstanceId: row.classroomInstanceId,
      eventType: row.eventType, createdAt: row.createdAt,
      ...(includeContent ? { payload: row.payload } : {}),
    })), (row) => row.createdAt);
  }

  const records = await prisma.activitySubmission.findMany({
    where: {
      // Require both sides to belong to this offering, including for historical rows.
      enrollment: { offeringId },
      activity: { chapter: { offeringId } },
      submittedAt: { gte: since, lte: until },
      ...(cursor ? { OR: [
        { submittedAt: { gt: new Date(cursor.at) } },
        { submittedAt: new Date(cursor.at), id: { gt: cursor.id } },
      ] } : {}),
    },
    orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
    take: options.take + 1,
    select: {
      id: true, researchKey: true, activityId: true, activityVersion: true, submittedAt: true,
      ...(includeContent ? { activitySnapshot: true, payload: true } : {}),
    },
  });
  return page(records.map((row) => ({
    id: row.id, researchKey: row.researchKey,
    quality: row.researchKey ? "complete" : "missing_research_key",
    activityId: row.activityId, activityVersion: row.activityVersion, submittedAt: row.submittedAt,
    ...(includeContent ? { activitySnapshot: row.activitySnapshot, payload: row.payload } : {}),
  })), (row) => row.submittedAt);
}
