/** Optional authorized diagnostic only: owned fixture, profiler overhead excluded from acceptance. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
const mainPid = Number(execFileSync('systemctl', ['--user', 'show', 'openpbl.service', '--property=MainPID', '--value'], { encoding: 'utf8' }).trim());
const children = (await readFile(`/proc/${mainPid}/task/${mainPid}/children`, 'utf8')).trim().split(/\s+/).map(Number);
let pid;
for (const child of children) if ((await readFile(`/proc/${child}/cmdline`, 'utf8')).startsWith('next-server')) pid = child;
assert.ok(pid, 'Current openpbl.service must have exactly targeted Next server child');
assert.match(await readFile(`/proc/${pid}/cgroup`, 'utf8'), /openpbl\.service/);
const listeners = execFileSync('ss', ['-H', '-ltn', 'sport = :9229'], { encoding: 'utf8' }).trim();
assert.equal(listeners, '', 'Do not interfere with an existing inspector');
const out = path.resolve('test-results/capacity', `cpu-diagnostic-${Date.now()}`);
await mkdir(out, { recursive: true, mode: 0o700 });
let ws, enabled = false, child, childExit, seq = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools timeout ${method}`)); }, 10000);
  pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
try {
  process.kill(pid, 'SIGUSR1'); enabled = true;
  let targets;
  for (let i = 0; i < 50; i++) {
    try { targets = await (await fetch('http://127.0.0.1:9229/json/list')).json(); break; } catch { await delay(100); }
  }
  assert.equal(targets?.length, 1);
  assert.match(targets[0].webSocketDebuggerUrl, /^ws:\/\/127\.0\.0\.1:9229\//);
  ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.on('message', bytes => {
    const data = JSON.parse(bytes.toString()); const receiver = pending.get(data.id);
    if (receiver) { pending.delete(data.id); if (data.error) receiver.reject(new Error(data.error.message)); else receiver.resolve(data.result); }
  });
  const identity = await send('Runtime.evaluate', { expression: '({pid:process.pid,cwd:process.cwd()})', returnByValue: true });
  assert.equal(identity.result.value.pid, pid);
  assert.ok(identity.result.value.cwd.includes('openPBL'));
  await send('Profiler.enable');
  await send('Profiler.setSamplingInterval', { interval: 1000 });
  await send('Profiler.start');
  await delay(10000);
  const idle = await send('Profiler.stop');
  await writeFile(path.join(out, 'next-server-idle.cpuprofile'), JSON.stringify(idle.profile));
  await send('Profiler.start');
  const log = [];
  child = spawn('pnpm', ['exec', 'tsx', 'scripts/verify-projection-http-contention.mjs'], {
    env: { ...process.env, CAPACITY_CONNECT_HOST: '172.16.185.157', PROJECTION_CONTENTION_ROUNDS: '12', PROJECTION_CONTENTION_MODES: 'draft', PROJECTION_CONTENTION_INCLUDE_STATE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => log.push(chunk.toString()));
  child.stderr.on('data', chunk => log.push(chunk.toString()));
  childExit = await new Promise(resolve => child.once('exit', resolve));
  await writeFile(path.join(out, 'diagnostic-load.log'), log.join(''));
  const { profile } = await send('Profiler.stop');
  await writeFile(path.join(out, 'next-server.cpuprofile'), JSON.stringify(profile));
  await writeFile(path.join(out, 'manifest.json'), JSON.stringify({ pid, deploymentId: process.env.PROJECTION_DEPLOYMENT_ID, childExit, diagnosticOnly: true, profilerOverhead: true, durationSeconds: (profile.endTime - profile.startTime) / 1e6, samples: profile.samples?.length, out }, null, 2));
  console.log(JSON.stringify({ out, childExit, samples: profile.samples?.length, durationSeconds: (profile.endTime - profile.startTime) / 1e6 }));
} finally {
  if (child && childExit === undefined) child.kill('SIGTERM');
  if (enabled && ws?.readyState === WebSocket.OPEN) {
    await send('Runtime.evaluate', { expression: 'setTimeout(()=>process.getBuiltinModule("node:inspector").close(),100); undefined' });
    ws.close();
    for (let i = 0; i < 50; i++) { if (!execFileSync('ss', ['-H', '-ltn', 'sport = :9229'], { encoding: 'utf8' }).trim()) break; await delay(100); }
    assert.equal(execFileSync('ss', ['-H', '-ltn', 'sport = :9229'], { encoding: 'utf8' }).trim(), '', 'Our inspector must close');
    console.log('Inspector closed; application process retained.');
  }
}
