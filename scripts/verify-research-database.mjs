// Runs against a disposable PostgreSQL container only; never reads DATABASE_URL or .env files.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetMigration = "20260908120000_research_integrity";
const container = `openpbl-research-check-${randomUUID()}`;
const temporary = mkdtempSync(path.join(tmpdir(), "openpbl-research-check-"));
let db;
let started = false;

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 60_000, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} failed: ${result.stdout || ""}\n${result.stderr || ""}`);
  return result.stdout?.trim() ?? "";
}

async function rejectsConstraint(operation, expectedCode) {
  await assert.rejects(operation, (error) => error.code === expectedCode,
    `Expected database constraint ${expectedCode}`);
}

async function rejectsCheck(operation, constraint) {
  await assert.rejects(operation, (error) =>
    String(error.message).includes(constraint)
      && (error.code === "P2004" || String(error.message).includes('code: "23514"')),
  `Expected PostgreSQL CHECK constraint ${constraint}`);
}

try {
  command("docker", ["run", "--detach", "--rm", "--name", container,
    "--publish", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql/data:rw",
    "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:16.9-alpine"]);
  started = true;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres"], { stdio: "ignore", timeout: 5000 });
    if (probe.status === 0) { ready = true; break; }
    await delay(500);
  }
  assert.ok(ready, "Disposable PostgreSQL did not become ready");
  const binding = command("docker", ["port", container, "5432/tcp"]);
  assert.match(binding, /^127\.0\.0\.1:\d+$/);
  const databaseUrl = `postgresql://postgres@${binding}/postgres?schema=public`;
  const environment = { ...process.env, DATABASE_URL: databaseUrl, PRISMA_CLIENT_ENGINE_TYPE: "library" };
  delete environment.PRISMA_GENERATE_NO_ENGINE;
  const migrationRoot = path.join(temporary, "prisma");
  cpSync(path.join(root, "prisma"), migrationRoot, { recursive: true });
  // Deploy the complete historical chain, seed historical facts, then apply the new migration.
  for (const migration of readdirSync(path.join(migrationRoot, "migrations"))) {
    if (migration >= targetMigration && migration !== "migration_lock.toml") {
      rmSync(path.join(migrationRoot, "migrations", migration), { recursive: true, force: true });
    }
  }
  const deploy = () => command(process.execPath, [path.join(root, "node_modules/prisma/build/index.js"),
    "migrate", "deploy", "--schema", path.join(migrationRoot, "schema.prisma")], { cwd: temporary, env: environment });
  deploy();
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const userData = (key) => ({ username: key, usernameKey: key, displayName: key, passwordHash: "test-only-unusable-hash" });
  const first = await db.user.create({ data: userData("first") });
  const second = await db.user.create({ data: userData("second") });
  const offering = await db.courseOffering.create({ data: { name: "Research verification" } });
  const enrollment = await db.enrollment.create({ data: { userId: first.id, offeringId: offering.id } });
  const chapter = await db.chapter.create({ data: { offeringId: offering.id, title: "Chapter", position: 0 } });
  const activity = await db.activity.create({ data: { chapterId: chapter.id, title: "Assignment", type: "ASSIGNMENT", position: 0 } });
  // The current client includes researchKey, so seed the pre-migration table through explicit SQL.
  await db.$executeRaw`INSERT INTO "LearningEvent" (id, "idempotencyKey", "userId", "offeringId", "enrollmentId", "eventType", "occurredAt")
    VALUES ('historical-valid', 'historical-valid', ${first.id}, ${offering.id}, ${enrollment.id}, 'activity.entered', CURRENT_TIMESTAMP),
           ('historical-mismatched', 'historical-mismatched', ${second.id}, ${offering.id}, ${enrollment.id}, 'activity.entered', CURRENT_TIMESTAMP)`;
  for (const migration of readdirSync(path.join(root, "prisma/migrations"))) {
    if (migration >= targetMigration && migration !== "migration_lock.toml") {
      cpSync(path.join(root, "prisma/migrations", migration), path.join(migrationRoot, "migrations", migration), { recursive: true });
    }
  }
  deploy();
  assert.equal((await db.learningEvent.findUnique({ where: { id: "historical-valid" } })).researchKey, enrollment.researchKey);
  assert.equal((await db.learningEvent.findUnique({ where: { id: "historical-mismatched" } })).researchKey, null);
  console.log("PASS full migration chain and ownership-safe research-key backfill");

  const event = { idempotencyKey: "same-client-key", eventType: "activity.entered", occurredAt: new Date() };
  assert.equal((await db.learningEvent.createMany({ data: [{ ...event, userId: first.id }, { ...event, userId: second.id }], skipDuplicates: true })).count, 2);
  assert.equal((await db.learningEvent.createMany({ data: [{ ...event, userId: first.id }], skipDuplicates: true })).count, 0);
  await rejectsConstraint(() => db.learningEvent.create({ data: { ...event, userId: first.id } }), "P2002");
  console.log("PASS per-user event idempotency and duplicate retry handling");

  const submission = { enrollmentId: enrollment.id, activityId: activity.id, researchKey: enrollment.researchKey,
    activityVersion: activity.version, activitySnapshot: { title: activity.title, config: { prompt: "Original" } }, payload: { answer: "First" } };
  await db.activitySubmission.create({ data: submission });
  await db.activitySubmission.create({ data: { ...submission, payload: { answer: "Revised" } } });
  await db.activity.update({ where: { id: activity.id }, data: { title: "Edited", version: { increment: 1 } } });
  const history = await db.activitySubmission.findMany({ where: { activityId: activity.id } });
  assert.equal(history.length, 2);
  assert.ok(history.every((row) => row.activitySnapshot.title === "Assignment" && row.activityVersion === 1));
  assert.deepEqual(new Set(history.map((row) => row.payload.answer)), new Set(["First", "Revised"]));
  for (const operation of [
    () => db.user.delete({ where: { id: first.id } }),
    () => db.enrollment.delete({ where: { id: enrollment.id } }),
    () => db.courseOffering.delete({ where: { id: offering.id } }),
    () => db.activity.delete({ where: { id: activity.id } }),
  ]) await rejectsConstraint(operation, "P2003");
  assert.equal(await db.activitySubmission.count(), 2);
  assert.equal(await db.learningEvent.count(), 4);
  console.log("PASS append-only submission snapshots and deletion restrictions preserving history");

  // Prisma 6 can surface CHECK violations as an unknown request error containing SQLSTATE 23514.
  await rejectsCheck(() => db.learningEvent.create({ data: { ...event, idempotencyKey: "negative-duration", userId: first.id, durationMs: -1 } }), "LearningEvent_durationMs_check");
  await rejectsCheck(() => db.learningEvent.create({ data: { ...event, idempotencyKey: "zero-version", userId: first.id, eventVersion: 0 } }), "LearningEvent_eventVersion_check");
  await rejectsCheck(() => db.activitySubmission.create({ data: { ...submission, activityVersion: 0 } }), "ActivitySubmission_activityVersion_check");
  for (const counters of [{ useCount: -1 }, { maxUses: -1 }, { maxUses: 1, useCount: 2 }]) {
    await rejectsCheck(() => db.courseInvitation.create({ data: { offeringId: offering.id, code: randomUUID(), ...counters } }), "CourseInvitation_usage_check");
  }
  await db.courseInvitation.create({ data: { offeringId: offering.id, code: "capacity-zero", maxUses: 0, useCount: 0 } });
  await db.learningEvent.create({ data: { ...event, idempotencyKey: "zero-duration", userId: first.id, durationMs: 0 } });
  console.log("PASS duration, version and invitation CHECK constraints including valid boundaries");

  await assert.rejects(() => db.$transaction(async (tx) => {
    await tx.activitySubmission.create({ data: { ...submission, payload: { answer: "Must roll back" } } });
    await tx.activityProgress.create({ data: { enrollmentId: enrollment.id, activityId: activity.id, status: "COMPLETED" } });
    await tx.learningEvent.create({ data: { ...event, userId: first.id } });
  }), (error) => error.code === "P2002");
  assert.equal(await db.activitySubmission.count(), 2);
  assert.equal(await db.activityProgress.count(), 0);
  console.log("PASS submission, progress and event transaction rollback");
  deploy();
  assert.equal(await db.activitySubmission.count(), 2);
  console.log("PASS repeated migrate deploy preserves existing data");
  await db.$executeRaw`CREATE TABLE "_OpenpblVerification" ("marker" TEXT PRIMARY KEY)`;
  await db.$executeRaw`INSERT INTO "_OpenpblVerification" ("marker") VALUES (${container})`;
  // Next resolves server-only itself; the CLI verification supplies the same empty server module.
  const compilerOptions = JSON.parse(readFileSync(path.join(root, 'tsconfig.json'), 'utf8')).compilerOptions;
  const verificationConfig = path.join(temporary, 'tsconfig.verification.json');
  writeFileSync(verificationConfig, JSON.stringify({ extends: path.join(root, 'tsconfig.json'), compilerOptions: { paths: {
    ...Object.fromEntries(Object.entries(compilerOptions.paths).map(([key, values]) => [key, values.map((value) => path.resolve(root, value))])),
    'server-only': [path.join(root, 'node_modules/next/dist/compiled/server-only/empty.js')],
  } } }));
  const persistenceOutput = command("pnpm", ["exec", "tsx", "--tsconfig", verificationConfig, "scripts/verify-platform-persistence.ts"], {
    cwd: root, env: { ...environment, OPENPBL_VERIFICATION_MARKER: container },
  });
  console.log(persistenceOutput);
  if (process.env.OPENPBL_VERIFY_BROWSER === '1') {
    console.log(command(process.execPath, [path.join(root, 'scripts/verify-v2-pages.mjs')], {
      cwd: root, timeout: 900_000, stdio: 'inherit', env: { ...environment, OPENPBL_VERIFICATION_MARKER: container },
    }));
  }
  console.log(command("pnpm", ["exec", "tsx", "--tsconfig", verificationConfig, "scripts/verify-v2-teaching.ts"], { cwd: root, env: { ...environment, OPENPBL_VERIFICATION_MARKER: container }, timeout: 120_000 }));
  console.log(command("pnpm", ["exec", "tsx", "--tsconfig", verificationConfig, "scripts/verify-v2-collaboration.ts"], { cwd: root, env: { ...environment, OPENPBL_VERIFICATION_MARKER: container }, timeout: 120_000 }));
} finally {
  try { await db?.$disconnect(); } finally {
    try {
      if (started) command("docker", ["rm", "--force", container]);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
}
