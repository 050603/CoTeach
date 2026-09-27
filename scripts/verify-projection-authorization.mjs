// Standalone disposable PostgreSQL validation; never reads deployment credentials.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
const root = process.cwd();
const marker = `openpbl-research-check-${randomUUID()}`;
const temporary = await mkdtemp(path.join(tmpdir(), 'openpbl-projection-auth-'));
function command(bin, args, options = {}) { const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 180000, ...options }); assert.equal(r.status, 0, `${r.error ?? ''}\n${r.stderr}\n${r.stdout}`); return r.stdout.trim(); }
let db;
try {
  command('docker', ['run', '--detach', '--rm', '--name', marker, '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data:rw', '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', 'pgvector/pgvector:0.8.6-pg16']);
  for (let i = 0; i < 60; i++) { if (spawnSync('docker', ['exec', marker, 'pg_isready', '-U', 'postgres']).status === 0) break; await new Promise(resolve => setTimeout(resolve, 500)); }
  const binding = command('docker', ['port', marker, '5432/tcp']); assert.match(binding, /^127\.0\.0\.1:\d+$/);
  const url = `postgresql://postgres@${binding}/postgres?schema=public&connection_limit=12&pool_timeout=30`;
  const env = { ...process.env, DATABASE_URL: url, OPENPBL_VERIFICATION_MARKER: marker, NODE_OPTIONS: '--conditions=import' };
  command('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { env });
  db = new PrismaClient({ datasourceUrl: url });
  await db.$executeRaw`CREATE TABLE "_OpenpblVerification" (marker text PRIMARY KEY)`;
  await db.$executeRaw`INSERT INTO "_OpenpblVerification" VALUES (${marker})`;
  const options = JSON.parse(await readFile('tsconfig.json', 'utf8')).compilerOptions;
  const config = path.join(temporary, 'tsconfig.json');
  await writeFile(config, JSON.stringify({ extends: path.join(root, 'tsconfig.json'), compilerOptions: { paths: { ...Object.fromEntries(Object.entries(options.paths).map(([key, values]) => [key, values.map(value => path.resolve(root, value))])), 'server-only': [path.join(root, 'node_modules/next/dist/compiled/server-only/empty.js')] } } }));
  console.log(command('pnpm', ['exec', 'tsx', '--tsconfig', config, 'scripts/verify-projection-authorization-worker.ts'], { env, timeout: 240000 }));
} finally { await db?.$disconnect(); spawnSync('docker', ['stop', marker], { stdio: 'ignore', timeout: 30000 }); await rm(temporary, { recursive: true, force: true }); }
