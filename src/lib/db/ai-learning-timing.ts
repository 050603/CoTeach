import type { Prisma } from "@prisma/client";
import type { Course } from "@/lib/session/types";
import { calculateToleratedDurationSec } from "@/lib/learning-analytics/analyzer";

type Timing = NonNullable<Course["aiLearningTimingByStudent"]>[string];
type DurationRow = { studentId: string; effectiveDurationMs: bigint; eventCount: bigint };
type SceneRow = {
  studentId: string;
  expectedDurationSec: string;
  ttsDurationSec: string | null;
  plannedStudentActivitySec: string | null;
};

function safeSeconds(value: string | null): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 86_400 ? seconds : 0;
}

/**
 * Aggregate the complete event stream in PostgreSQL. `Course.learningEvents`
 * deliberately contains only the latest 10,000 events for trajectory display.
 * A heartbeat is sent every ten seconds; a gap over five minutes cannot be
 * treated as observed foreground study time.
 */
export async function loadAiLearningTiming(
  instanceId: string,
  studentIds: string[],
  db: Prisma.TransactionClient,
): Promise<NonNullable<Course["aiLearningTimingByStudent"]>> {
  const timing: Record<string, Timing> = Object.fromEntries(studentIds.map((id) => [id, {
    effectiveDurationMs: 0,
    expectedDurationMs: 0,
    hasEvidence: false,
  }]));
  if (!studentIds.length) return timing;

  const [durationRows, sceneRows] = await Promise.all([
    db.$queryRaw<DurationRow[]>`
      WITH scoped AS (
        SELECT e."id", e."userId", e."idempotencyKey", e."eventType", e."durationMs", e."receivedAt",
          COALESCE(e."metadata"->'legacy', e."metadata"->'view') AS payload,
          COALESCE(NULLIF(e."metadata"#>>'{legacy,idempotencyKey}', ''),
            NULLIF(e."metadata"#>>'{view,idempotencyKey}', ''), e."idempotencyKey") AS "logicalKey"
        FROM "LearningEvent" e
        WHERE e."classroomInstanceId" = ${instanceId}
      ), unique_events AS (
        SELECT DISTINCT ON ("userId", "logicalKey") "userId", "eventType", "durationMs", payload
        FROM scoped
        WHERE payload->>'stageKey' = 'ai-learning'
        ORDER BY "userId", "logicalKey", "receivedAt", "id"
      )
      SELECT "userId" AS "studentId", COUNT(*)::bigint AS "eventCount",
        COALESCE(SUM("durationMs") FILTER (
          WHERE "eventType" = 'heartbeat'
            AND "durationMs" BETWEEN 1 AND 300000
            AND payload->>'visible' IS DISTINCT FROM 'false'
        ), 0)::bigint AS "effectiveDurationMs"
      FROM unique_events
      GROUP BY "userId"
    `,
    db.$queryRaw<SceneRow[]>`
      WITH scoped AS (
        SELECT e."id", e."userId", e."occurredAt", e."receivedAt",
          COALESCE(e."metadata"->'legacy', e."metadata"->'view') AS payload
        FROM "LearningEvent" e
        WHERE e."classroomInstanceId" = ${instanceId}
      )
      SELECT DISTINCT ON ("userId", payload->>'sceneId')
        "userId" AS "studentId",
        payload->>'expectedDurationSec' AS "expectedDurationSec",
        payload->>'ttsDurationSec' AS "ttsDurationSec",
        payload->>'plannedStudentActivitySec' AS "plannedStudentActivitySec"
      FROM scoped
      WHERE payload->>'stageKey' = 'ai-learning'
        AND NULLIF(payload->>'sceneId', '') IS NOT NULL
        AND jsonb_typeof(payload->'expectedDurationSec') = 'number'
      ORDER BY "userId", payload->>'sceneId', "occurredAt" DESC, "receivedAt" DESC, "id" DESC
    `,
  ]);

  for (const row of durationRows) {
    const target = timing[row.studentId];
    if (!target) continue;
    const duration = Number(row.effectiveDurationMs);
    if (!Number.isSafeInteger(duration) || duration < 0) throw new RangeError("Invalid aggregate learning duration");
    target.effectiveDurationMs = duration;
    target.hasEvidence = Number(row.eventCount) > 0;
  }
  for (const row of sceneRows) {
    const target = timing[row.studentId];
    if (!target) continue;
    const expected = safeSeconds(row.expectedDurationSec);
    if (!expected) continue;
    target.expectedDurationMs += calculateToleratedDurationSec({
      expectedDurationSec: expected,
      ttsDurationSec: safeSeconds(row.ttsDurationSec),
      plannedStudentActivitySec: safeSeconds(row.plannedStudentActivitySec),
    }) * 1_000;
  }
  return timing;
}
