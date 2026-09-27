import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from 'redis';
import { prisma } from '../src/lib/db/client';
import { appendDurableAiInteractionEvents, drainAiAuditOutbox, auditOutboxDirectory } from '../src/lib/ai-collaboration/audit-outbox';
import { closeEventBus, initializeEventBus, publishCourseEvent, subscribeCourseEvents, type RealtimeEvent } from '../src/lib/realtime/event-bus';

const marker = process.env.OPENPBL_VERIFICATION_MARKER ?? '';
assert.match(marker, /^openpbl-fault-check-[0-9a-f-]{36}$/);
assert.equal(new URL(process.env.DATABASE_URL!).hostname, '127.0.0.1');
assert.equal(new URL(process.env.REDIS_URL!).hostname, '127.0.0.1');
assert.ok(auditOutboxDirectory().startsWith('/tmp/openpbl-fault-check-'));
const redisContainer = process.env.OPENPBL_FAULT_REDIS!;
assert.equal(redisContainer, `${marker}-redis`);
function containerCommand(container: string, ...args: string[]) {
  assert.ok(container === `${marker}-postgres` || container === `${marker}-redis`);
  const label = spawnSync('docker', ['inspect', '--format', '{{index .Config.Labels "openpbl.verification"}}', container], { encoding: 'utf8', timeout: 5000 });
  assert.equal(label.status, 0);
  assert.equal(label.stdout.trim(), marker);
  const result = spawnSync('docker', [...args, container], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
}
async function until(predicate: () => boolean, message: string) {
  for (let i = 0; i < 100; i += 1) { if (predicate()) return; await delay(50); }
  assert.ok(predicate(), message);
}
async function main() {
  if (process.argv[2] === 'offline') {
    await assert.rejects(() => prisma.$queryRaw`SELECT 1`);
    await appendDurableAiInteractionEvents(Array.from({ length: 40 }, (_, i) => ({
      courseId: 'fault-course', studentId: `fault-student-${i}`, stageKey: 'make', source: 'system' as const,
      eventType: 'response' as const, actorRole: 'ai' as const, content: `retained-answer-${i}`,
    })));
    const files = await readdir(auditOutboxDirectory());
    assert.equal(files.length, 1);
    const location = path.join(auditOutboxDirectory(), files[0]);
    const events = JSON.parse(await readFile(location, 'utf8'));
    assert.equal(events.length, 40);
    assert.equal(new Set(events.map((event: { id: string }) => event.id)).size, 40);
    assert.equal((await stat(location)).mode & 0o777, 0o600);
    await drainAiAuditOutbox();
    assert.deepEqual(await readdir(auditOutboxDirectory()), files);
    console.log('PASS PostgreSQL unavailable: real Prisma query fails, 40 complete audit events retained with stable IDs and mode 0600; failed drain retains file');
    containerCommand(process.env.OPENPBL_FAULT_POSTGRES!, 'start');
    let recovered = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { await prisma.$queryRaw`SELECT 1`; recovered = true; break; }
      catch { await delay(250); }
    }
    assert.ok(recovered, 'The existing Prisma client reconnects after PostgreSQL restarts');
    console.log('PASS existing Prisma client reconnects after PostgreSQL restart; disk batch is left for a fresh Node process');
    return;
  }
  assert.equal(process.argv[2], 'recovery');
  const markers = await prisma.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification"`;
  assert.equal(markers[0]?.marker, marker);
  const filename = (await readdir(auditOutboxDirectory()))[0];
  const location = path.join(auditOutboxDirectory(), filename);
  const original = await readFile(location, 'utf8');
  await drainAiAuditOutbox();
  assert.equal(await prisma.aiInteractionEvent.count(), 40);
  assert.equal((await readdir(auditOutboxDirectory())).length, 0);
  const facts = await prisma.aiInteractionEvent.findMany({ include: { participation: { include: { enrollment: true } } } });
  for (const fact of facts) {
    assert.equal(fact.userId, fact.participation!.enrollment.userId);
    assert.equal(fact.researchKey, fact.participation!.enrollment.researchKey);
    assert.equal(fact.offeringId, 'fault-offering');
    assert.equal(fact.content, `retained-answer-${fact.userId.split('-').at(-1)}`);
  }
  // Re-create a committed batch as if the process died between COMMIT and unlink.
  await writeFile(location, original, { mode: 0o600 });
  await Promise.all([drainAiAuditOutbox(), drainAiAuditOutbox()]);
  assert.equal(await prisma.aiInteractionEvent.count(), 40);
  assert.equal((await readdir(auditOutboxDirectory())).length, 0);
  console.log('PASS PostgreSQL restart + new Node process: 40/40 answers and ownership/research keys restored; commit-before-unlink replay and concurrent drains produce zero duplicate rows');

  const local: string[] = [];
  subscribeCourseEvents('fault-course', event => local.push(String(event.payload?.marker)));
  await initializeEventBus();
  let external = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false }, disableOfflineQueue: true });
  external.on('error', () => {});
  await external.connect();
  await external.publish('openpbl:realtime:v1', JSON.stringify({ origin: 'isolated-peer', event: { type: 'course-updated', courseId: 'fault-course', at: new Date().toISOString(), payload: { marker: 'before' } } }));
  await until(() => local.includes('before'), 'Cross-process Redis delivery before outage');
  await external.quit();
  containerCommand(redisContainer, 'stop', '-t', '1');
  await delay(200);
  const event = (value: string): RealtimeEvent => ({ type: 'course-updated', courseId: 'fault-course', at: new Date().toISOString(), payload: { marker: value } });
  const started = performance.now();
  await publishCourseEvent('fault-course', event('during'));
  assert.ok(local.includes('during'));
  await initializeEventBus();
  assert.ok(performance.now() - started < 4000, 'Redis failure must be bounded');
  containerCommand(redisContainer, 'start');
  await delay(5500); // Application retries initialization on publish after its 5-second throttle.
  await publishCourseEvent('fault-course', event('repair-trigger'));
  await initializeEventBus();
  external = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false }, disableOfflineQueue: true });
  external.on('error', () => {});
  await external.connect();
  const after = event('after');
  await external.publish('openpbl:realtime:v1', JSON.stringify({ origin: 'isolated-peer', event: after }));
  await until(() => local.includes('after'), 'Cross-process inbound delivery recovers');
  const remote: string[] = [];
  await external.subscribe('openpbl:realtime:v1', message => remote.push(JSON.parse(message).event.payload.marker));
  await publishCourseEvent('fault-course', event('outbound-after'));
  await until(() => remote.includes('outbound-after'), 'Cross-process outbound delivery recovers');
  assert.equal(local.filter(value => value === 'outbound-after').length, 1);
  await external.quit();
  console.log('PASS Redis stop/start: bounded failure, local delivery during outage, publish-triggered reconnect and bidirectional cross-process delivery after recovery without local echo duplication');
}
main().finally(async () => { await closeEventBus(); await prisma.$disconnect(); }).catch(error => { console.error(error); process.exitCode = 1; });
