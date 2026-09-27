import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuthClaims } from "@/lib/auth/session";
import { runMutationTransaction, tryCourseMutationAdmission, tryPersonalMutationAdmission } from "@/lib/db/transaction-retry";
import { prisma } from "@/lib/db/client";
import { lockProjectedCourse } from "@/lib/db/session-repository";
import { PlatformError } from "@/lib/platform/repository";
import { publishCourseEvent } from "@/lib/realtime/event-bus";
import { encodeEventCursor } from "@/lib/realtime/event-cursor";
import type { CourseContent, LearningEvent, LearningSignal } from "@/lib/session/types";
import { aggregateCommonIssues, analyzeStudentLearning } from "./analyzer";

const text = z.string().min(1).max(500);
const seconds = z.number().finite().nonnegative().optional();
const eventSchema = z.object({
  id: text, idempotencyKey: text, courseId: text, studentId: text, stageKey: text,
  sceneId: text.optional(), type: z.enum(["scene-enter", "scene-leave", "scene-complete", "heartbeat", "scene-replay", "interaction-result", "artifact-change", "stage-enter", "stage-goal-complete", "resource-open", "resource-progress", "resource-complete"]),
  occurredAt: z.string().datetime(), durationMs: z.number().int().min(0).max(2_147_483_647).optional(),
  expectedDurationSec: seconds, ttsDurationSec: seconds, plannedStudentActivitySec: seconds,
  visible: z.boolean().optional(), progressMarker: z.string().optional(),
  content: z.object({ stageLabel: z.string().optional(), sceneTitle: z.string().optional(), sceneIndex: z.number().optional(), sceneType: z.string().optional(), activityId: z.string().optional(), activityTitle: z.string().optional(), knowledgePointIds: z.array(z.string()).optional(), knowledgePointLabels: z.array(z.string()).optional() }).optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
}).refine(event => JSON.stringify(event).length <= 32_000);
const batchSchema = z.object({ courseId: text, studentId: text, events: z.array(eventSchema).min(1).max(100) });
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function key(courseId: string, event: LearningEvent) { return `legacy:${createHash("sha256").update(JSON.stringify([courseId, event.idempotencyKey])).digest("hex")}`; }
function fingerprint(event: LearningEvent): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => [name, canonical(child)]));
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonical({ ...event, occurredAt: new Date(event.occurredAt).toISOString() }))).digest("hex");
}
function scope(item: Pick<LearningEvent, "stageKey" | "sceneId">) { return JSON.stringify([item.stageKey, item.sceneId ?? ""]); }
function enrich(event: LearningEvent, content: Partial<CourseContent>): LearningEvent {
  if (!event.content) return event;
  const activity = content.teachingOutline?.find(item => item.id === event.content?.activityId) ?? content.lessonOutline?.find(item => item.id === event.content?.activityId);
  const labels = (event.content.knowledgePointIds ?? []).flatMap(id => content.knowledgePoints?.find(item => item.id === id)?.name ?? []);
  return { ...event, content: { ...event.content, ...(activity?.title ? { activityTitle: activity.title } : {}), ...(labels.length ? { knowledgePointLabels: labels } : {}) } };
}

/** Append-only evidence and derived signals commit together, without a full Course projection. */
export async function ingestClassroomLearningEvents(claims: AuthClaims, input: unknown) {
  const parsed = batchSchema.safeParse(input);
  if (!parsed.success) throw new PlatformError("INVALID_EVENTS", "学习事件格式无效", 400);
  const { courseId, studentId, events } = parsed.data;
  if (claims.role !== "student" || studentId !== claims.sub) throw new PlatformError("STUDENT_SCOPE_MISMATCH", "无权写入其他学生的记录", 403);
  if (events.some(event => event.courseId !== courseId || event.studentId !== studentId || Date.parse(event.occurredAt) > Date.now() + 300_000)) throw new PlatformError("INVALID_EVENTS", "学习事件归属或时间无效", 400);
  const result = await runMutationTransaction(async tx => {
    // Keep the established personal -> course order for all deployed writers.
    await tryPersonalMutationAdmission(tx, `learning-events:${courseId}:${studentId}`);
    await tryCourseMutationAdmission(tx, courseId);
    await lockProjectedCourse(tx, courseId);
    // A separate statement after BOTH locks obtains fresh state, including
    // changes from row-only close/archive writers. Scope all large reads to
    // this participant; none of this preparation performs external I/O.
    const [context] = await tx.$queryRaw<Array<{
      id: string | null; status: string; runtimeConfig: unknown; templateVersionId: string;
      activityId: string; chapterId: string; offeringId: string; offeringStatus: string; archivedAt: Date | null;
      participationId: string | null; enrollmentId: string | null; enrollmentStatus: string | null; researchKey: string;
      actorRole: string; actorStatus: string; actorSessionVersion: number;
      existing: Array<{ idempotencyKey: string; metadata: unknown }>;
      history: Array<{ metadata: unknown }>; ownSignalRows: Array<{ id: string; payload: unknown }>;
      content: Partial<CourseContent> | null;
    }>>`SELECT ci.id, ci.status, ci."runtimeConfig", ci."templateVersionId", ci."activityId", a."chapterId",
        c."offeringId", o.status AS "offeringStatus", a."archivedAt", p.id AS "participationId",
        e.id AS "enrollmentId", e.status AS "enrollmentStatus", e."researchKey",
        u.role AS "actorRole", u.status AS "actorStatus", u."sessionVersion" AS "actorSessionVersion",
        COALESCE((SELECT jsonb_agg(jsonb_build_object('idempotencyKey', le."idempotencyKey", 'metadata', le.metadata))
          FROM "LearningEvent" le WHERE le."userId" = u.id AND le."idempotencyKey" = ANY(${events.map(event => key(courseId, event))}::text[])), '[]'::jsonb) AS existing,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('metadata', le.metadata) ORDER BY le."receivedAt")
          FROM "LearningEvent" le WHERE le."userId" = u.id AND le."classroomInstanceId" = ci.id AND le."participationId" = p.id), '[]'::jsonb) AS history,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id', ls.id, 'payload', ls.payload))
          FROM "LearningSignal" ls WHERE ls."participationId" = p.id), '[]'::jsonb) AS "ownSignalRows",
        CASE WHEN ${events.some(event => event.content)} THEN
          (SELECT jsonb_build_object('knowledgePoints', snapshot #> '{design,content,knowledgePoints}', 'teachingOutline', snapshot #> '{design,content,teachingOutline}', 'lessonOutline', snapshot #> '{design,content,lessonOutline}')
           FROM "ClassroomTemplateVersion" WHERE id = ci."templateVersionId") ELSE NULL END AS content
      FROM "User" u LEFT JOIN "ClassroomInstance" ci ON ci.id = ${courseId}
      LEFT JOIN "Activity" a ON a.id = ci."activityId"
      LEFT JOIN "Chapter" c ON c.id = a."chapterId" LEFT JOIN "CourseOffering" o ON o.id = c."offeringId"
      LEFT JOIN "Enrollment" e ON e."offeringId" = o.id AND e."userId" = u.id
      LEFT JOIN "ClassroomParticipation" p ON p."instanceId" = ci.id AND p."enrollmentId" = e.id
      WHERE u.id = ${studentId}`;
    if (!context || context.actorStatus.toUpperCase() !== "ACTIVE" || context.actorRole.toLowerCase() !== claims.role || context.actorSessionVersion !== claims.sv) throw new PlatformError("UNAUTHENTICATED", "请重新登录", 401);
    if (!context.id) throw new PlatformError("COURSE_NOT_FOUND", "课堂不存在", 404);
    if (!context.participationId || !context.enrollmentId || !["ACTIVE", "COMPLETED"].includes(context.enrollmentStatus?.toUpperCase() ?? "")) throw new PlatformError("STUDENT_SCOPE_MISMATCH", "未加入该课堂", 403);
    const participation = { id: context.participationId, enrollmentId: context.enrollmentId, enrollment: { status: context.enrollmentStatus!, researchKey: context.researchKey } };
    const { existing, history, ownSignalRows } = context;
    const design = { content: context.content };
    const seen = new Map(existing.map(event => [event.idempotencyKey, object(event.metadata)]));
    const accepted: LearningEvent[] = [];
    for (const event of events) {
      const eventKey = key(courseId, event);
      const previous = seen.get(eventKey);
      if (previous) {
        // Historical rows predate the explicit fingerprint; compare their full
        // enriched legacy event. Never accept a changed event ID or body.
        const matches = typeof previous.requestFingerprint === "string"
          ? previous.requestFingerprint === fingerprint(event)
          : previous.legacy && fingerprint(previous.legacy as LearningEvent) === fingerprint(enrich(event, design?.content ?? {}));
        if (!matches) throw new PlatformError("LEARNING_EVENT_CONFLICT", "事件标识已用于不同内容，请保留原始记录", 409);
      } else {
        accepted.push(event);
        seen.set(eventKey, { requestFingerprint: fingerprint(event) });
      }
    }
    const incoming = accepted.map(event => enrich(event, design?.content ?? {}));
    let ownSignals = ownSignalRows.map(row => object(row.payload).view as LearningSignal).filter(Boolean);
    let notification: { cursor: string; at: string; courseVersion: number } | undefined;
    // Durable retries can still be acknowledged after closure; no new fact can.
    if (accepted.length) {
      const learningEvents = [...history.map(row => object(row.metadata).legacy as LearningEvent).filter(Boolean), ...incoming];
      const affected = new Set(incoming.map(scope));
      for (const event of incoming) if (event.type === "stage-goal-complete") {
        for (const previous of [...learningEvents, ...ownSignals]) if (previous.stageKey === event.stageKey) affected.add(scope(previous));
      }
      const nextSignals = [...affected].flatMap(value => {
        const [stageKey, sceneId] = JSON.parse(value) as [string, string];
        const scoped = learningEvents.filter(event => event.stageKey === stageKey && ((event.sceneId ?? "") === sceneId || event.type === "stage-goal-complete"));
        const last = <K extends "expectedDurationSec" | "ttsDurationSec" | "plannedStudentActivitySec">(field: K) => [...scoped].reverse().find(event => typeof event[field] === "number")?.[field];
        const attempts = ownSignals.filter(signal => scope(signal) === value).reduce((max, signal) => Math.max(max, signal.aiInterventionAttempts), 0);
        return analyzeStudentLearning({ events: scoped, expectedDurationSec: last("expectedDurationSec") ?? 0, ttsDurationSec: last("ttsDurationSec"), plannedStudentActivitySec: last("plannedStudentActivitySec"), aiInterventionAttempts: attempts }).signals;
      });
      const obsolete = ownSignalRows.filter(row => { const signal = object(row.payload).view as LearningSignal | undefined; return signal && affected.has(scope(signal)) && !nextSignals.some(next => next.id === signal.id); }).map(row => row.id);
      if (context.status.toUpperCase() !== "TEACHING" || context.offeringStatus.toUpperCase() !== "OPEN" || context.archivedAt || context.enrollmentStatus?.toUpperCase() !== "ACTIVE") throw new PlatformError("COURSE_LOCKED", "课堂当前不可写入", 409);
      const newFacts = incoming.map(event => ({
        id: randomUUID(), idempotencyKey: key(courseId, event), eventType: event.type,
        occurredAt: event.occurredAt, durationMs: event.durationMs ?? null,
        metadata: { legacy: event, requestFingerprint: fingerprint(accepted.find(original => original.idempotencyKey === event.idempotencyKey)!) },
      }));
      const newSignals = nextSignals.map(signal => ({
        id: `${participation.id}:${signal.id}`, type: signal.kind, severity: signal.severity, status: signal.status,
        payload: { instanceId: courseId, collection: "learningSignals", provenance: { actorId: studentId, actorRole: "student" }, view: signal },
      }));
      ownSignals = [...ownSignals.filter(signal => !affected.has(scope(signal))), ...nextSignals];
      const runtime = object(context.runtimeConfig);
      const courseVersion = Number(runtime.version ?? 1) + 1;
      const now = new Date();
      // One atomic statement records all evidence and derived facts. The
      // notice depends on the course update; any constraint/trigger failure
      // rolls back every CTE and the surrounding transaction together.
      const [event] = await tx.$queryRaw<Array<{ id: string; createdAt: Date }>>`WITH facts AS (
        INSERT INTO "LearningEvent" (id, "userId", "idempotencyKey", "researchKey", "offeringId", "enrollmentId", "chapterId", "activityId", "classroomInstanceId", "participationId", "eventType", "occurredAt", "durationMs", source, metadata)
        SELECT f.id, ${studentId}, f."idempotencyKey", ${participation.enrollment.researchKey}, ${context.offeringId}, ${participation.enrollmentId}, ${context.chapterId}, ${context.activityId}, ${courseId}, ${participation.id}, f."eventType", f."occurredAt", f."durationMs", 'legacy-classroom', f.metadata
        FROM jsonb_to_recordset(${JSON.stringify(newFacts)}::jsonb) AS f(id text, "idempotencyKey" text, "eventType" text, "occurredAt" timestamptz, "durationMs" integer, metadata jsonb) RETURNING id
      ), removed AS (
        DELETE FROM "LearningSignal" WHERE "participationId" = ${participation.id} AND id = ANY(${obsolete}::text[]) RETURNING id
      ), signals AS (
        INSERT INTO "LearningSignal" (id, "userId", "offeringId", "enrollmentId", "participationId", type, severity, status, payload, "updatedAt")
        SELECT s.id, ${studentId}, ${context.offeringId}, ${participation.enrollmentId}, ${participation.id}, s.type, s.severity, s.status, s.payload, ${now}
        FROM jsonb_to_recordset(${JSON.stringify(newSignals)}::jsonb) AS s(id text, type text, severity text, status text, payload jsonb)
        ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type, severity = EXCLUDED.severity, status = EXCLUDED.status, payload = EXCLUDED.payload, "updatedAt" = EXCLUDED."updatedAt" RETURNING id
      ), course AS (
        UPDATE "ClassroomInstance" SET "runtimeConfig" = ${JSON.stringify({ ...runtime, version: courseVersion })}::jsonb,
          "updatedAt" = ${now} WHERE id = ${courseId} AND (SELECT count(*) FROM facts) = ${incoming.length} RETURNING id
      ) INSERT INTO "DomainEvent" (id, "createdAt", "idempotencyKey", "actorId", "offeringId", "classroomInstanceId", "participationId", "researchKey", "eventType", payload)
        SELECT ${randomUUID()}, ${now}, ${randomUUID()}, ${studentId}, ${context.offeringId}, course.id,
          ${participation.id}, ${participation.enrollment.researchKey}, 'UPDATE_COURSE',
          ${JSON.stringify({ source: "learning-events", scope: "student", studentId, courseVersion })}::jsonb FROM course
        RETURNING id, "createdAt"`;
      if (!event) throw new Error("LEARNING_EVENT_COMMIT_INCOMPLETE");
      notification = { cursor: encodeEventCursor(event), at: event.createdAt.toISOString(), courseVersion };
    }
    return { response: { acceptedIds: [...new Set(events.map(event => event.id))], duplicateCount: events.length - accepted.length, signals: ownSignals }, notification };
  }, { lowPriorityCourseId: courseId, deferCourseAdmission: true,
    admissionTimeoutError: () => new PlatformError("COURSE_BUSY", "课堂记录保存繁忙，请保留原事件稍后重试", 503) });
  if (result.notification) {
    try { await publishCourseEvent(courseId, { type: "course-updated", courseId, at: result.notification.at, payload: { actionType: "UPDATE_COURSE", scope: "student", studentId, courseVersion: result.notification.courseVersion, eventCursor: result.notification.cursor } }); }
    catch { console.error("[learning-events] live invalidation failed; durable course cursor retained", { courseId }); }
  }
  // Class-wide grouping is a response view, not an atomic learning fact. Read
  // after commit to release the course lock first; it may include later commits.
  const [allSignals, studentCount] = await Promise.all([
    prisma.$queryRaw<Array<{ view: LearningSignal }>>`
      SELECT (s.payload -> 'view') - 'evidenceEventIds' AS view FROM "LearningSignal" s
      JOIN "ClassroomParticipation" p ON p.id = s."participationId" WHERE p."instanceId" = ${courseId}`,
    prisma.classroomParticipation.count({ where: { instanceId: courseId } }),
  ]);
  return { ...result.response, commonIssues: aggregateCommonIssues(allSignals.map(row => row.view).filter(Boolean), studentCount) };
}
