// Disposable containers only. No .env/secrets loading, migrations or production ports.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';

const learningMode = process.env.OPENPBL_VERIFY_LEARNING_EVENTS_ONLY === '1';
const draftMode = process.env.OPENPBL_VERIFY_GROUP_DRAFTS_ONLY === '1';
const capacityMode = learningMode || draftMode;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marker = `openpbl-fault-check-${randomUUID()}`;
const temporary = mkdtempSync(path.join(tmpdir(), 'openpbl-fault-check-'));
const postgres = `${marker}-postgres`;
const redis = `${marker}-redis`;
const created = [];
let db;
function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 60_000, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${executable}: ${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
async function ready(container, args) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (spawnSync('docker', ['exec', container, ...args], { stdio: 'ignore', timeout: 2000 }).status === 0) return;
    await delay(250);
  }
  throw new Error(`Isolated container failed to become ready: ${container}`);
}
async function unusedLocalPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
try {
  // An explicit ephemeral port stays stable across docker stop/start; Docker's
  // empty host-port syntax allocates a different port after each start.
  const postgresPort = await unusedLocalPort();
  const redisPort = await unusedLocalPort();
  command('docker', ['run', '-d', '--name', postgres, '--label', `openpbl.verification=${marker}`,
    '-p', `127.0.0.1:${postgresPort}:5432`, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'pgvector/pgvector:0.8.6-pg16']);
  created.push(postgres);
  command('docker', ['run', '-d', '--name', redis, '--label', `openpbl.verification=${marker}`,
    '-p', `127.0.0.1:${redisPort}:6379`, 'redis:7.4.5-alpine']);
  created.push(redis);
  await ready(postgres, ['pg_isready', '-U', 'postgres']);
  await ready(redis, ['redis-cli', 'ping']);
  const binding = (container, port) => {
    const value = command('docker', ['port', container, `${port}/tcp`]);
    assert.match(value, /^127\.0\.0\.1:\d+$/);
    return value;
  };
  const uploadMode = capacityMode || process.env.OPENPBL_VERIFY_UPLOADS_ONLY === '1' || process.env.OPENPBL_VERIFY_LOCAL_ARTIFACTS_ONLY === '1' || process.env.OPENPBL_VERIFY_WHITEBOARD_ONLY === '1';
  const databaseUrl = `postgresql://postgres@${binding(postgres, 5432)}/postgres?schema=public&connect_timeout=2&connection_limit=${capacityMode ? 30 : uploadMode ? 12 : 4}&pool_timeout=${capacityMode ? 10 : uploadMode ? 20 : 2}`;
  const environment = { ...process.env, DATABASE_URL: databaseUrl, PROVIDER_CONFIG_DATABASE_URL: databaseUrl,
    REDIS_URL: `redis://${binding(redis, 6379)}`, AI_AUDIT_OUTBOX_DIR: path.join(temporary, 'audit-outbox'),
    OPENPBL_VERIFICATION_MARKER: marker, OPENPBL_FAULT_REDIS: redis, OPENPBL_FAULT_POSTGRES: postgres,
    NODE_OPTIONS: '--conditions=import', NODE_ENV: 'test' };
  delete environment.PRISMA_GENERATE_NO_ENGINE;
  // Generate current DDL locally, then apply only the audit ownership graph. No migration chain.
  const ddl = command(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'diff',
    '--from-empty', '--to-schema-datamodel', path.join(root, 'prisma/schema.prisma'), '--script'], { env: environment });
  const models = new Set(['User', 'CourseOffering', 'Chapter', 'Activity', 'ClassroomInstance',
    'Enrollment', 'ClassroomParticipation', 'AiConversation', 'AiInteractionEvent']);
  if (capacityMode || process.env.OPENPBL_VERIFY_UPLOADS_ONLY === '1' || process.env.OPENPBL_VERIFY_LOCAL_ARTIFACTS_ONLY === '1' || process.env.OPENPBL_VERIFY_WHITEBOARD_ONLY === '1') {
    for (const model of ['ClassroomTemplate', 'CourseTeacher', 'FileAsset', 'Resource', 'DomainEvent']) models.add(model);
  }
  if (capacityMode || process.env.OPENPBL_VERIFY_LOCAL_ARTIFACTS_ONLY === '1' || process.env.OPENPBL_VERIFY_WHITEBOARD_ONLY === '1') {
    for (const model of ['ClassroomTemplateVersion', 'ProjectGroup', 'GroupMember', 'Artifact', 'ArtifactVersion']) models.add(model);
  }
  if (learningMode) for (const model of ['LearningEvent', 'LearningSignal']) models.add(model);
  if (draftMode) models.add('ClassroomSubmission');
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  for (const statement of ddl.split(';').map(value => value.replace(/^--.*$/gm, '').trim()).filter(Boolean)) {
    const table = statement.match(/^CREATE TABLE "([^"]+)"/)?.[1];
    const indexTable = statement.match(/^CREATE (?:UNIQUE )?INDEX .* ON "([^"]+)"/)?.[1];
    const foreignKey = statement.match(/^ALTER TABLE "([^"]+)".*REFERENCES "([^"]+)"/s);
    if ((table && models.has(table)) || (indexTable && models.has(indexTable))
      || (foreignKey && models.has(foreignKey[1]) && models.has(foreignKey[2]))) await db.$executeRawUnsafe(statement);
  }
  await db.$executeRawUnsafe('CREATE TABLE "_OpenpblVerification" (marker TEXT PRIMARY KEY)');
  await db.$executeRaw`INSERT INTO "_OpenpblVerification" (marker) VALUES (${marker})`;
  const offering = await db.courseOffering.create({ data: { id: 'fault-offering', name: marker } });
  const chapter = await db.chapter.create({ data: { offeringId: offering.id, title: marker, position: 0 } });
  const activity = await db.activity.create({ data: { chapterId: chapter.id, title: marker, type: 'CLASSROOM', position: 0 } });
  let templateVersionId = 'unused-in-audit-path';
  if (capacityMode || process.env.OPENPBL_VERIFY_LOCAL_ARTIFACTS_ONLY === '1' || process.env.OPENPBL_VERIFY_WHITEBOARD_ONLY === '1') {
    const owner = await db.user.create({ data: { username: marker, usernameKey: marker, displayName: 'Fixture owner', passwordHash: 'unusable', role: 'TEACHER' } });
    const template = await db.classroomTemplate.create({ data: { title: marker, ownerId: owner.id } });
    const version = await db.classroomTemplateVersion.create({ data: { templateId: template.id, version: 1, status: 'PUBLISHED', snapshot: {} } });
    templateVersionId = version.id;
  }
  await db.classroomInstance.create({ data: { id: 'fault-course', activityId: activity.id, templateVersionId } });
  for (let i = 0; i < 40; i += 1) {
    const id = `fault-student-${i}`;
    await db.user.create({ data: { id, username: id, usernameKey: id, displayName: id, passwordHash: 'unusable-fixture' } });
    const enrollment = await db.enrollment.create({ data: { userId: id, offeringId: offering.id } });
    await db.classroomParticipation.create({ data: { instanceId: 'fault-course', enrollmentId: enrollment.id } });
  }
  await db.$disconnect();
  const compilerOptions = JSON.parse(readFileSync(path.join(root, 'tsconfig.json'), 'utf8')).compilerOptions;
  const config = path.join(temporary, 'tsconfig.json');
  writeFileSync(config, JSON.stringify({ extends: path.join(root, 'tsconfig.json'), compilerOptions: { paths: {
    ...Object.fromEntries(Object.entries(compilerOptions.paths).map(([key, values]) => [key, values.map(value => path.resolve(root, value))])),
    'server-only': [path.join(root, 'node_modules/next/dist/compiled/server-only/empty.js')],
  } } }));
  if (capacityMode || process.env.OPENPBL_VERIFY_UPLOADS_ONLY === '1' || process.env.OPENPBL_VERIFY_LOCAL_ARTIFACTS_ONLY === '1' || process.env.OPENPBL_VERIFY_WHITEBOARD_ONLY === '1') {
    const worker = draftMode ? 'scripts/verify-capacity-group-drafts-worker.ts' : learningMode ? 'scripts/verify-capacity-learning-events-worker.ts' : process.env.OPENPBL_VERIFY_WHITEBOARD_ONLY === '1' ? 'scripts/verify-capacity-whiteboard-worker.ts' : process.env.OPENPBL_VERIFY_LOCAL_ARTIFACTS_ONLY === '1' ? 'scripts/verify-capacity-local-artifact-worker.ts' : 'scripts/verify-capacity-upload-worker.ts';
    console.log(command('pnpm', ['exec', 'tsx', '--tsconfig', config, worker], {
      cwd: root, env: { ...environment, UPLOAD_DIR: path.join(temporary, 'uploads'), WHITEBOARD_DATA_DIR: path.join(temporary, 'whiteboards') }, timeout: 120_000,
    }));
  } else {
    const run = phase => console.log(command('pnpm', ['exec', 'tsx', '--tsconfig', config,
      'scripts/verify-capacity-fault-worker.ts', phase], { cwd: root, env: environment, timeout: 90_000 }));
    command('docker', ['stop', '-t', '1', postgres]);
    run('offline');
    await ready(postgres, ['pg_isready', '-U', 'postgres']);
    run('recovery');
    console.log('PASS isolated PostgreSQL/Redis fault recovery; temporary containers and queue will be removed');
  }
} finally {
  await db?.$disconnect();
  for (const container of created.reverse()) command('docker', ['rm', '-f', '-v', container]);
  rmSync(temporary, { recursive: true, force: true });
}
