/** Authenticated, synthetic loopback runner checks; tokens never enter output. */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const token = (await readFile(path.join(root, 'deploy/secrets/monitor_token.txt'), 'utf8')).trim();
const destination = path.join(root, 'docs/audits/2026-09-26-classroom-capacity/operations-results.json');
const checks = [];
const startedAt = new Date().toISOString();
const artifact = (language, content) => ({ language, activeFileId: 'main', files: [{ id: 'main', path: `main.${language === 'python' ? 'py' : 'c'}`, content }] });

async function check(name, call, verify) {
  const started = performance.now();
  try {
    const result = await call();
    verify(result);
    checks.push({ name, passed: true, elapsedMs: Math.round(performance.now() - started), result });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, passed: false, elapsedMs: Math.round(performance.now() - started), error: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

async function request(port, endpoint, body, authenticate = true) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json', ...(authenticate ? { Authorization: `Bearer ${token}` } : {}) } : {},
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(16000),
  });
  const value = await response.json();
  // Keep output-limit probes compact while retaining the exact byte count.
  if (typeof value.stdout === 'string') {
    value.stdoutBytes = Buffer.byteLength(value.stdout);
    if (value.stdout.length > 300) value.stdout = value.stdout.slice(0, 300) + ' [truncated in report]';
  }
  return { status: response.status, body: value };
}

await Promise.all([
  ['runner-health', 3002, '/health'], ['survey-nlp-health', 3003, '/health/live'],
  ['speech-alignment-health', 3004, '/health/live'], ['outbound-proxy-health', 19999, '/health/live'],
  ['outbound-proxy-upstream-ready', 19999, '/health/ready'],
].map(([name, port, endpoint]) => check(name, () => request(port, endpoint), (result) => assert.equal(result.status, 200))));

await check('runner-rejects-missing-auth', () => request(3002, '/execute', { artifact: artifact('python', 'print(1)') }, false), (result) => assert.equal(result.status, 401));
await check('python-stdin-and-local-module', () => request(3002, '/execute', {
  artifact: { language: 'python', activeFileId: 'main', files: [
    { id: 'main', path: 'main.py', content: 'from helper import answer\nprint(answer(int(input())))\n' },
    { id: 'helper', path: 'helper.py', content: 'def answer(value):\n    return value + 2\n' },
  ] }, stdin: '40\n',
}), ({ status, body }) => { assert.equal(status, 200); assert.equal(body.status, 'success'); assert.equal(body.stdout.trim(), '42'); });
await check('c-compile-stdin-and-run', () => request(3002, '/execute', {
  artifact: artifact('c', '#include <stdio.h>\nint main(void) { int n=0; if(scanf("%d", &n)!=1) return 1; printf("%d\\n", n+2); return 0; }'), stdin: '40\n',
}), ({ status, body }) => { assert.equal(status, 200); assert.equal(body.status, 'success'); assert.equal(body.stdout.trim(), '42'); });

await check('sandbox-resource-limits', () => request(3002, '/execute', { artifact: artifact('python', `import resource,json,os
print(json.dumps({key:list(resource.getrlimit(getattr(resource,key))) for key in ['RLIMIT_CPU','RLIMIT_AS','RLIMIT_NPROC','RLIMIT_NOFILE','RLIMIT_FSIZE']}))
assert 'CODE_RUNNER_TOKEN' not in os.environ
assert not os.path.exists('/home/lkj/OpenPBL/openPBL/deploy/secrets')
`) }), ({ body }) => {
  assert.equal(body.status, 'success');
  const limits = JSON.parse(body.stdout);
  assert.equal(limits.RLIMIT_CPU[0], 4); assert.equal(limits.RLIMIT_AS[0], 1073741824);
  assert.equal(limits.RLIMIT_NPROC[0], 64); assert.equal(limits.RLIMIT_NOFILE[0], 64);
  assert.equal(limits.RLIMIT_FSIZE[0], 10485760);
});
await check('sandbox-network-isolation', () => request(3002, '/execute', { artifact: artifact('python', `import socket
try:
    connection=socket.create_connection(('127.0.0.1',15432),timeout=1)
except OSError:
    print('NETWORK_ISOLATED')
else:
    connection.close()
    raise RuntimeError('Production database must not be reachable')
`) }), ({ body }) => { assert.equal(body.status, 'success'); assert.equal(body.stdout.trim(), 'NETWORK_ISOLATED'); });
await check('sandbox-memory-limit', () => request(3002, '/execute', { artifact: artifact('python', `try:
    data=bytearray(2*1024*1024*1024)
except MemoryError:
    print('MEMORY_LIMIT_OK')
else:
    raise RuntimeError('Expected memory cap')
`) }), ({ body }) => { assert.equal(body.status, 'success'); assert.equal(body.stdout.trim(), 'MEMORY_LIMIT_OK'); });
await check('sandbox-output-limit', () => request(3002, '/execute', { artifact: artifact('python', 'print("x" * 1000000)') }), ({ body }) => {
  assert.equal(body.status, 'failed'); assert.equal(body.stdoutBytes, 64000); assert.match(body.stderr, /64 KB/);
});
for (const [name, value] of [
  ['rejects-traversal', { language: 'python', files: [{ path: '../main.py', content: 'print(1)' }] }],
  ['rejects-over-16-files', { language: 'python', files: Array.from({ length: 17 }, (_, i) => ({ path: `file${i}.py`, content: 'print(1)' })) }],
  ['rejects-over-160k-code', artifact('python', '#' + 'x'.repeat(160001))],
]) await check(name, () => request(3002, '/execute', { artifact: value }), ({ status }) => assert.equal(status, 400));

await Promise.all([
  ['python-wall-timeout', artifact('python', 'import time\ntime.sleep(60)')],
  ['c-wall-timeout', artifact('c', '#include <unistd.h>\nint main(void) { sleep(60); return 0; }')],
].map(([name, value]) => check(name, () => request(3002, '/execute', { artifact: value }), ({ status, body }) => {
  assert.equal(status, 200); assert.equal(body.status, 'timeout'); assert.ok(body.durationMs >= 5900 && body.durationMs < 14000);
})));
await check('runner-recovers-after-limits', () => request(3002, '/execute', { artifact: artifact('python', 'print("STILL_HEALTHY")') }), ({ body }) => {
  assert.equal(body.status, 'success'); assert.equal(body.stdout.trim(), 'STILL_HEALTHY');
});

await mkdir(path.dirname(destination), { recursive: true });
await writeFile(destination, JSON.stringify({ startedAt, completedAt: new Date().toISOString(), checks, passed: checks.every((item) => item.passed) }, null, 2) + '\n');
console.log(`Report: ${destination}`);
if (checks.some((item) => !item.passed)) process.exitCode = 1;
