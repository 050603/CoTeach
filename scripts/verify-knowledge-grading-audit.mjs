// Minimal disposable PostgreSQL graph. Never reads deployment credentials or contacts a model.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
const root = path.resolve(import.meta.dirname, '..');
const marker = `openpbl-grade-check-${randomUUID()}`;
const temporary = mkdtempSync(path.join(tmpdir(), 'openpbl-grade-check-'));
let started = false, db;
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 90000, ...options });
  assert.equal(result.status, 0, `${command}: ${result.stdout}\n${result.stderr}`); return result.stdout.trim();
}
try {
  run('docker', ['run', '-d', '--rm', '--name', marker, '--label', `openpbl.verification=${marker}`, '--tmpfs', '/var/lib/postgresql/data:rw', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'pgvector/pgvector:0.8.6-pg16']); started = true;
  let ready = false;
  for (let i = 0; i < 40; i++) { if (spawnSync('docker', ['exec', marker, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' }).status === 0) { ready = true; break; } await delay(250); }
  assert.ok(ready);
  const address = run('docker', ['port', marker, '5432/tcp']); assert.match(address, /^127\.0\.0\.1:\d+$/);
  const url = `postgresql://postgres@${address}/postgres?connection_limit=30&pool_timeout=10`;
  const env = { ...process.env, DATABASE_URL: url, PROVIDER_CONFIG_DATABASE_URL: url, REDIS_URL: '', AI_AUDIT_OUTBOX_DIR: path.join(temporary, 'outbox'), OPENPBL_VERIFICATION_MARKER: marker, NODE_OPTIONS: '--conditions=import', NODE_ENV: 'test' };
  const ddl = run(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', path.join(root, 'prisma/schema.prisma'), '--script'], { env });
  const models = new Set(['User', 'CourseOffering', 'Chapter', 'Activity', 'ClassroomInstance', 'ClassroomTemplate', 'ClassroomTemplateVersion', 'Enrollment', 'ClassroomParticipation', 'StudentProjectWorkspace', 'DomainEvent', 'AiConversation', 'AiInteractionEvent']);
  db = new PrismaClient({ datasources: { db: { url } } });
  for (const sql of ddl.split(';').map(value => value.replace(/^--.*$/gm, '').trim()).filter(Boolean)) {
    const table = sql.match(/^CREATE TABLE "([^"]+)"/)?.[1];
    const index = sql.match(/^CREATE (?:UNIQUE )?INDEX .* ON "([^"]+)"/)?.[1];
    const fk = sql.match(/^ALTER TABLE "([^"]+)".*REFERENCES "([^"]+)"/s);
    if (models.has(table) || models.has(index) || fk && models.has(fk[1]) && models.has(fk[2])) await db.$executeRawUnsafe(sql);
  }
  await db.$executeRawUnsafe('CREATE TABLE "_OpenpblVerification" (marker TEXT PRIMARY KEY)');
  await db.$executeRaw`INSERT INTO "_OpenpblVerification" VALUES (${marker})`;
  await db.$disconnect();
  const config = path.join(temporary, 'tsconfig.json');
  const paths = JSON.parse(readFileSync(path.join(root, 'tsconfig.json'), 'utf8')).compilerOptions.paths;
  writeFileSync(config, JSON.stringify({ extends: path.join(root, 'tsconfig.json'), compilerOptions: { paths: { ...Object.fromEntries(Object.entries(paths).map(([key, values]) => [key, values.map(value => path.resolve(root, value))])), 'server-only': [path.join(root, 'node_modules/next/dist/compiled/server-only/empty.js')] } } }));
  console.log(run('pnpm', ['exec', 'tsx', '--tsconfig', config, 'scripts/verify-knowledge-grading-audit-worker.ts'], { cwd: root, env }));
} finally {
  await db?.$disconnect();
  if (started) run('docker', ['rm', '-f', marker]);
  rmSync(temporary, { recursive: true, force: true });
}
