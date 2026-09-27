/** Bounded, isolated kernel ENOSPC/EROFS checks. No production volumes or network. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(path.join(tmpdir(), 'openpbl-disk-check-'));
const marker = `openpbl-disk-check-${randomUUID()}`;
const uid = process.getuid(); const gid = process.getgid();
const databaseUrl = 'postgresql://isolated@127.0.0.1:65432/absent?connect_timeout=1&connection_limit=1';
const invoke = (args, timeout = 15_000) => spawnSync('docker', args, { encoding: 'utf8', timeout });
let createdSuccessfully = false;
try {
  mkdirSync(path.join(temporary, 'readonly-outbox'));
  const compilerOptions = JSON.parse(readFileSync(path.join(root, 'tsconfig.json'), 'utf8')).compilerOptions;
  writeFileSync(path.join(temporary, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    ...compilerOptions, baseUrl: '/workspace', paths: {
      ...Object.fromEntries(Object.entries(compilerOptions.paths).map(([key, values]) => [key, values.map(value => path.posix.resolve('/workspace', value))])),
      'server-only': ['/workspace/node_modules/next/dist/compiled/server-only/empty.js'],
    },
  } }));
  // The image must already exist locally. --pull=never prevents network use.
  const args = ['create', '--pull=never', '--name', marker, '--label', `openpbl.verification=${marker}`,
    '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--memory=512m', '--cpus=1', '--pids-limit=64', '--user', `${uid}:${gid}`, '--workdir=/workspace',
    '--tmpfs', `/failure:rw,size=4m,uid=${uid},gid=${gid},mode=0700`,
    '--tmpfs', `/tmp:rw,size=16m,uid=${uid},gid=${gid},mode=0700`,
    '-v', `${temporary}:/config:ro`, '-v', `${temporary}/readonly-outbox:/readonly-outbox:ro`,
    ...['src', 'scripts', 'node_modules', 'packages'].flatMap(name => ['-v', `${root}/${name}:/workspace/${name}:ro`]),
    '-e', `DATABASE_URL=${databaseUrl}`, '-e', `PROVIDER_CONFIG_DATABASE_URL=${databaseUrl}`,
    '-e', `OPENPBL_DISK_VERIFICATION=${marker}`, '-e', 'AI_AUDIT_OUTBOX_DIR=/failure/outbox',
    '-e', 'NODE_ENV=test', '-e', 'NODE_OPTIONS=--conditions=import',
    'mcr.microsoft.com/playwright:v1.61.1-noble', 'node', '/workspace/node_modules/tsx/dist/cli.mjs',
    '--tsconfig', '/config/tsconfig.json', '/workspace/scripts/verify-capacity-disk-worker.ts'];
  const created = invoke(args, 45_000);
  assert.equal(created.status, 0, created.stderr);
  createdSuccessfully = true;
  const inspected = invoke(['inspect', marker]);
  assert.equal(inspected.status, 0);
  const container = JSON.parse(inspected.stdout)[0];
  assert.equal(container.Config.Labels['openpbl.verification'], marker);
  assert.equal(container.HostConfig.NetworkMode, 'none');
  assert.equal(container.HostConfig.ReadonlyRootfs, true);
  assert.ok(container.Mounts.filter(mount => mount.Type === 'bind').every(mount => mount.RW === false));
  assert.ok(!container.Mounts.some(mount => /(?:deploy\/secrets|\.openpbl-data)/.test(mount.Source)));
  const result = invoke(['start', '--attach', marker], 60_000);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.status, 0, 'Isolated disk worker failed');
  const state = invoke(['inspect', '--format', '{{.State.ExitCode}}', marker]);
  assert.equal(state.stdout.trim(), '0');
  console.log('PASS isolated disk exercise: network disabled, production data/secrets absent, read-only source mounts, bounded 4 MiB tmpfs');
} finally {
  const removed = invoke(['rm', '-f', '-v', marker]);
  rmSync(temporary, { recursive: true, force: true });
  if (createdSuccessfully) {
    assert.equal(removed.status, 0, 'Disposable disk container cleanup failed');
    console.log('PASS disposable disk container and temporary configuration removed');
  }
}
