import { Prisma, type ClassroomSubmission, type Reflection, type AiSupportRecord, type LearningSignal, type LearningEvent, type StudentProjectWorkspace } from "@prisma/client";

export type StudentPrivateReadScope = {
  courseId: string;
  offeringId: string;
  studentId: string;
  participationIds: string[];
  ownParticipationIds: string[];
  studentGroupIds: string[];
};
export type StudentPrivateRows = {
  submissions: Pick<ClassroomSubmission, "id" | "participationId" | "stageKey" | "status" | "payload" | "createdAt" | "updatedAt">[];
  reflections: Pick<Reflection, "id" | "participationId" | "content" | "metadata" | "createdAt" | "updatedAt">[];
  supports: Pick<AiSupportRecord, "structuredPayload">[];
  signals: Pick<LearningSignal, "payload">[];
  events: Pick<LearningEvent, "metadata">[];
  workspaces: Pick<StudentProjectWorkspace, "participationId" | "projectState">[];
};
type BundleRow = {
  kind: "submission" | "reflection" | "support" | "signal" | "event" | "workspace";
  id: string;
  participationId: string | null;
  stageKey: string | null;
  status: string | null;
  content: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  value: Prisma.JsonValue;
  ordinal: number | null;
};
const inIds = (column: Prisma.Sql, ids: string[]) => ids.length ? Prisma.sql`${column} IN (${Prisma.join(ids)})` : Prisma.sql`FALSE`;

/** Caller only opts in for authenticated student reads on the default client.
 * Timestamp columns remain native timestamps (Prisma returns Date), rather than
 * JSON dates. JSON payloads are never recursively converted or normalized here.
 * Teacher and transaction projections continue using their existing delegates.
 */
export async function loadStudentPrivateRows(db: Prisma.TransactionClient, scope: StudentPrivateReadScope): Promise<StudentPrivateRows> {
  const all = (column: Prisma.Sql) => inIds(column, scope.participationIds);
  const own = (column: Prisma.Sql) => inIds(column, scope.ownParticipationIds);
  const groupPredicate = scope.studentGroupIds.length
    ? Prisma.sql`(${Prisma.join(scope.studentGroupIds.map(id => Prisma.sql`s."payload" #> '{view,groupId}' = to_jsonb(${id}::text)`), " OR ")})`
    : Prisma.sql`FALSE`;
  // The sole production caller consumes only aiLearningProgress from workspaces;
  // keep unrelated saved workspace content in PostgreSQL, out of this read DTO.
  const rows = await db.$queryRaw<BundleRow[]>(Prisma.sql`
    WITH recent_events AS (
      SELECT e."id", e."metadata", e."receivedAt"
      FROM "LearningEvent" e
      WHERE e."classroomInstanceId" = ${scope.courseId} AND e."userId" = ${scope.studentId}
      ORDER BY e."receivedAt" DESC LIMIT 10000
    )
    SELECT 'submission'::text AS kind, s."id", s."participationId", s."stageKey", s."status",
      NULL::text AS content, s."createdAt", s."updatedAt", s."payload" AS value, NULL::integer AS ordinal
    FROM "ClassroomSubmission" s
    WHERE ${all(Prisma.sql`s."participationId"`)} AND (
      ${own(Prisma.sql`s."participationId"`)} OR s."payload" #> '{view,studentId}' = to_jsonb(${scope.studentId}::text)
      OR ${groupPredicate} OR s."payload"->'collection' IN ('"learningEvidence"'::jsonb, '"artifactSnapshots"'::jsonb)
    )
    UNION ALL
    SELECT 'reflection', r."id", r."participationId", NULL::text, NULL::text,
      r."content", r."createdAt", r."updatedAt", r."metadata", NULL::integer
    FROM "Reflection" r WHERE ${own(Prisma.sql`r."participationId"`)}
    UNION ALL
    SELECT 'support', a."id", NULL::text, NULL::text, NULL::text,
      NULL::text, NULL::timestamp, NULL::timestamp, a."structuredPayload", NULL::integer
    FROM "AiSupportRecord" a WHERE a."offeringId" = ${scope.offeringId}
      AND (${all(Prisma.sql`a."participationId"`)} OR a."structuredPayload"->'instanceId' = to_jsonb(${scope.courseId}::text))
      AND a."structuredPayload"->'collection' IN ('"aiAssessmentSuggestions"'::jsonb, '"aiSupports"'::jsonb, '"aiContributions"'::jsonb, '"studentAiDecisions"'::jsonb)
    UNION ALL
    SELECT 'signal', l."id", NULL::text, NULL::text, NULL::text,
      NULL::text, NULL::timestamp, NULL::timestamp, l."payload", NULL::integer
    FROM "LearningSignal" l WHERE ${own(Prisma.sql`l."participationId"`)}
    UNION ALL
    SELECT 'event', e."id", NULL::text, NULL::text, NULL::text,
      NULL::text, NULL::timestamp, NULL::timestamp, e."metadata",
      ROW_NUMBER() OVER (ORDER BY e."receivedAt" DESC)::integer FROM recent_events e
    UNION ALL
    SELECT 'workspace', w."id", w."participationId", NULL::text, NULL::text,
      NULL::text, NULL::timestamp, NULL::timestamp, jsonb_build_object('aiLearningProgress', w."projectState"->'aiLearningProgress'), NULL::integer
    FROM "StudentProjectWorkspace" w WHERE ${own(Prisma.sql`w."participationId"`)}
  `);
  const result: StudentPrivateRows = { submissions: [], reflections: [], supports: [], signals: [], events: [], workspaces: [] };
  const events: BundleRow[] = [];
  for (const row of rows) {
    switch (row.kind) {
      case "submission": result.submissions.push({ id: row.id, participationId: row.participationId!, stageKey: row.stageKey!, status: row.status!, createdAt: row.createdAt!, updatedAt: row.updatedAt!, payload: row.value }); break;
      case "reflection": result.reflections.push({ id: row.id, participationId: row.participationId!, content: row.content!, createdAt: row.createdAt!, updatedAt: row.updatedAt!, metadata: row.value }); break;
      case "support": result.supports.push({ structuredPayload: row.value }); break;
      case "signal": result.signals.push({ payload: row.value }); break;
      case "workspace": result.workspaces.push({ participationId: row.participationId!, projectState: row.value }); break;
      case "event": events.push(row); break;
    }
  }
  // UNION ALL may interleave branches. Preserve the existing newest-first input
  // to loadInstanceCourse, which reverses it once for the browser trajectory.
  result.events = events.sort((a, b) => a.ordinal! - b.ordinal!).map(row => ({ metadata: row.value }));
  return result;
}
