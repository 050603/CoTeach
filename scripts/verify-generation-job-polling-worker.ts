import assert from "node:assert/strict";
import type { GenerationJob } from "@prisma/client";
import type { CourseGenerationJob, JobWhere } from "../src/lib/course-generation/job-storage";
// Independent legacy predicate retained as the before/after equivalence oracle.
function legacyMatches(row: CourseGenerationJob, where: JobWhere): boolean {
  return Object.entries(where).every(([key, filter]) => {
    if (key === "OR") return (filter as JobWhere[]).some(part => legacyMatches(row, part));
    if (key === "AND") return (filter as JobWhere[]).every(part => legacyMatches(row, part));
    const value = row[key as keyof CourseGenerationJob];
    if (filter === null || typeof filter !== "object" || filter instanceof Date) return value instanceof Date && filter instanceof Date ? value.getTime() === filter.getTime() : value === filter;
    if (filter.in && !filter.in.includes(String(value))) return false;
    if (filter.not !== undefined && value === filter.not) return false;
    if (filter.lt && !(value instanceof Date && value < filter.lt)) return false;
    if (filter.lte && !(value instanceof Date && value <= filter.lte)) return false;
    if (filter.gt && !(value instanceof Date && value > filter.gt)) return false;
    return true;
  });
}
async function main() {
  const marker = process.env.OPENPBL_VERIFICATION_MARKER;
  assert.match(marker ?? "", /^openpbl-research-check-[0-9a-f-]{36}$/);
  const target = new URL(process.env.DATABASE_URL!);
  assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.username, "postgres"); assert.equal(target.password, ""); assert.equal(target.pathname, "/postgres");
  const { prisma: db } = await import("../src/lib/db/client");
  try {
    assert.equal((await db.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification" WHERE marker = ${marker}`).length, 1);
    const { contentGenerationJobs: jobs, projectGenerationJob } = await import("../src/lib/course-generation/job-storage");
    const now = new Date("2026-09-27T00:00:00.000Z");
    const past = new Date(now.getTime() - 10000), future = new Date(now.getTime() + 10000);
    const terminal = Array.from({ length: 62 }, (_, i) => ({ id: `history-${i}`, targetType: "CLASSROOM_TEMPLATE", targetId: `template-${i}`, jobType: "COURSE_CONTENT", status: i % 2 ? "COMPLETED" : "FAILED", result: { payload: "historical evidence ".repeat(39000) }, createdAt: new Date(now.getTime() - 100000 - i) }));
    await db.generationJob.createMany({ data: terminal });
    for (const [index, status] of ["QUEUED", "RUNNING", "PENDING", "CANCELLING", "REVIEW_AVAILABLE"].entries()) {
      for (let variation = 0; variation < 3; variation++) {
        await db.generationJob.create({ data: { id: `${status}-${variation}`, targetType: "CLASSROOM_TEMPLATE", targetId: `active-template-${index}-${variation}`, jobType: "COURSE_CONTENT", status,
          retryAt: variation === 0 ? null : variation === 1 ? past : future, heartbeatAt: variation ? past : null,
          error: variation === 0 ? null : variation === 1 ? "failed" : "other", attempt: variation,
          trace: { state: { leaseExpiresAt: variation === 0 ? null : variation === 1 ? past.toISOString() : future.toISOString(), version: variation + 1, message: "preserve" } },
          createdAt: new Date(now.getTime() + index * 100 + variation) } });
      }
    }
    await db.generationJob.create({ data: { id: "foreign-type", targetType: "CLASSROOM_TEMPLATE", targetId: "foreign", jobType: "COURSE_DESIGN", status: "QUEUED" } });
    const nativeFind = db.generationJob.findMany.bind(db.generationJob);
    const all = await nativeFind({ where: { targetType: "CLASSROOM_TEMPLATE", jobType: "COURSE_CONTENT" }, orderBy: { createdAt: "asc" } });
    const projected = all.map(projectGenerationJob);
    const workerWhere: JobWhere = { OR: [{ status: "queued" }, { status: "running", OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] }] };
    const cases: JobWhere[] = [workerWhere,
      { OR: [{ status: "queued", OR: [{ retryAt: null }, { retryAt: { lte: now } }] }, { status: "running", OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] }, { status: "review_available", step: { not: "capacityReview" }, leaseExpiresAt: null }] },
      { AND: [{ status: { in: ["queued", "pending", "running"] } }, { retryAt: { lte: now } }] },
      { status: "running", OR: [{ retryAt: null }, { leaseExpiresAt: null }] },
      { status: { in: ["pending", "running"] }, error: { not: "failed" } },
      { status: { not: "RUNNING" } }, { status: { not: "running" } },
      { OR: [] }, { AND: [] }, { OR: [{}, { status: "queued" }] },
      { status: "running", leaseExpiresAt: null }, { status: "queued", version: 2 },
      { retryAt: { gt: now } }, { retryAt: { lt: now } }, { retryAt: now },
      { lastHeartbeatAt: null }, { lastHeartbeatAt: { lte: now } },
      { status: { in: [] } }, { createdAt: null }, { attempt: 2 }, { error: null },
      { AND: [{ status: "queued" }, { OR: [{ version: 2 }, { error: null }] }] },
    ];
    for (const where of cases) for (const order of ["asc", "desc"] as const) {
      const ordered = order === "asc" ? projected : projected.toReversed();
      const expected = ordered.find(row => legacyMatches(row, where)) ?? null;
      const actual = await jobs.findFirst({ where, orderBy: { createdAt: order } });
      assert.deepEqual(actual, expected, JSON.stringify({ where, order }));
    }
    console.log(`PASS ${cases.length * 2} PostgreSQL before/after equivalent first-result queries: OR/AND, pending/running, null/dates/not, residual JSON, both orders; no premature take before residual`);
    // Observe actual rows returned by the driver, not merely a generated SQL string.
    const captures: Array<{ rows: number; bytes: number }> = [];
    db.generationJob.findMany = (async (...args: Parameters<typeof nativeFind>) => {
      const rows = await nativeFind(...args);
      captures.push({ rows: rows.length, bytes: Buffer.byteLength(JSON.stringify(rows)) });
      return rows;
    }) as typeof db.generationJob.findMany;
    const samples: Record<string, number[]> = { before: [], after: [] };
    for (let i = 0; i < 6; i++) {
      let start = performance.now();
      const before = (await nativeFind({ where: { targetType: "CLASSROOM_TEMPLATE", jobType: "COURSE_CONTENT" }, orderBy: { createdAt: "asc" } })).map(projectGenerationJob).find(row => legacyMatches(row, workerWhere));
      samples.before.push(performance.now() - start);
      start = performance.now(); const after = await jobs.findFirst({ where: workerWhere, orderBy: { createdAt: "asc" } }); samples.after.push(performance.now() - start);
      assert.deepEqual(after, before);
    }
    db.generationJob.findMany = nativeFind;
    assert.ok(captures.every(c => c.rows === 6 && c.bytes < 10000));
    const summary = Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, { samples: values.length, p95Ms: Math.max(...values) }]));
    console.log(JSON.stringify({ pollingComparison: summary, previousRows: all.length, previousBytes: Buffer.byteLength(JSON.stringify(all)), optimized: captures[0] }));
    // Same advisory-locked read/CAS/update semantics still claim at most one worker.
    const claims = await Promise.all([0, 1].map(() => jobs.updateMany({ where: { id: "QUEUED-0", status: "queued" }, data: { status: "running", attempt: { increment: 1 } } })));
    assert.deepEqual(claims.map(c => c.count).sort(), [0, 1]);
    const claimed = await jobs.findUnique({ where: { id: "QUEUED-0" } });
    assert.equal(claimed?.attempt, 1); assert.equal(claimed?.message, "preserve");
    const stateBefore = await nativeFind({ where: { status: "PENDING" }, orderBy: { id: "asc" } });
    await db.$executeRawUnsafe(`CREATE FUNCTION reject_pending_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id = 'PENDING-1' THEN RAISE EXCEPTION 'polling-update-fault'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER reject_pending_update BEFORE UPDATE ON "GenerationJob" FOR EACH ROW EXECUTE FUNCTION reject_pending_update()`);
    await assert.rejects(jobs.updateMany({ where: { status: { in: ["pending"] } }, data: { status: "running" } }), /polling-update-fault/);
    assert.deepEqual(await nativeFind({ where: { id: { in: stateBefore.map(r => r.id) } }, orderBy: { id: "asc" } }), stateBefore);
    console.log("PASS concurrent claim is single-owner; predicate-selected updateMany fault rolls back every row and preserves JSON state");
    await db.$executeRawUnsafe(`DROP TRIGGER reject_pending_update ON "GenerationJob"`);
    await db.generationJob.updateMany({ where: { targetType: "CLASSROOM_TEMPLATE", jobType: "COURSE_CONTENT" }, data: { status: "COMPLETED" } });
    let emptyRows: GenerationJob[] = [];
    db.generationJob.findMany = (async (...args: Parameters<typeof nativeFind>) => { emptyRows = await nativeFind(...args); return emptyRows; }) as typeof db.generationJob.findMany;
    assert.equal(await jobs.findFirst({ where: workerWhere }), null); assert.equal(emptyRows.length, 0);
    db.generationJob.findMany = nativeFind;
    console.log("PASS idle worker with all terminal history transfers zero job/payload rows; workers remain enabled");
  } finally { await db.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
