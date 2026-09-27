// Disposable PG runner for the actual runtime admission helper; no deployment credentials.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
const marker = `openpbl-admission-${randomUUID()}`;
const directory = await mkdtemp(path.join(tmpdir(), 'openpbl-admission-'));
let db;
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 180000, ...options });
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}
try {
  run('docker', ['run', '--detach', '--rm', '--name', marker, '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data:rw', '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', 'pgvector/pgvector:0.8.6-pg16']);
  for (let i = 0; i < 60; i++) {
    if (spawnSync('docker', ['exec', marker, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], { stdio: 'ignore' }).status === 0) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const binding = run('docker', ['port', marker, '5432/tcp']);
  assert.match(binding, /^127\.0\.0\.1:\d+$/);
  const url = `postgresql://postgres@${binding}/postgres?connection_limit=8&pool_timeout=10`;
  db = new PrismaClient({ datasourceUrl: url });
  await db.$executeRaw`CREATE TABLE "_OpenpblVerification" (marker text PRIMARY KEY)`;
  await db.$executeRaw`INSERT INTO "_OpenpblVerification" VALUES (${marker})`;
  await db.$executeRaw`CREATE TABLE "ClassroomInstance" (id text PRIMARY KEY, "runtimeConfig" jsonb NOT NULL, status text NOT NULL)`;
  await db.$executeRaw`CREATE TABLE receipt (id text PRIMARY KEY, version integer UNIQUE NOT NULL)`;
  const root = process.cwd();
  const paths = JSON.parse(await readFile('tsconfig.json', 'utf8')).compilerOptions.paths;
  const config = path.join(directory, 'tsconfig.json');
  await writeFile(config, JSON.stringify({ extends: path.join(root, 'tsconfig.json'), compilerOptions: { paths: {
    ...Object.fromEntries(Object.entries(paths).map(([key, values]) => [key, values.map(value => path.resolve(root, value))])),
    'server-only': [path.join(root, 'node_modules/next/dist/compiled/server-only/empty.js')],
  } } }));
  console.log(run(process.execPath, ['--import', 'tsx', 'scripts/verify-course-admission-worker.ts'], {
    env: { ...process.env, DATABASE_URL: url, OPENPBL_VERIFICATION_MARKER: marker, TSX_TSCONFIG_PATH: config, NODE_OPTIONS: '--conditions=import' },
  }));
} finally {
  await db?.$disconnect();
  spawnSync('docker', ['stop', marker], { stdio: 'ignore', timeout: 30000 });
  await rm(directory, { recursive: true, force: true });
}
