import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, statfs, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appendDurableAiInteractionEvents, drainAiAuditOutbox, readAiAuditOutboxCounts } from '../src/lib/ai-collaboration/audit-outbox';
import { prisma } from '../src/lib/db/client';

const fingerprint = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const root = '/failure';
assert.match(process.env.OPENPBL_DISK_VERIFICATION ?? '', /^openpbl-disk-check-[0-9a-f-]{36}$/);
assert.equal(process.env.DATABASE_URL, 'postgresql://isolated@127.0.0.1:65432/absent?connect_timeout=1&connection_limit=1');
assert.equal(process.env.AI_AUDIT_OUTBOX_DIR, `${root}/outbox`);
assert.equal(process.env.PROVIDER_CONFIG_DATABASE_URL, process.env.DATABASE_URL);
assert.ok(!process.env.REDIS_URL && !process.env.JWT_SECRET && !process.env.PROVIDER_ENCRYPTION_KEY);

async function main() {
  assert.match(await readFile('/proc/mounts', 'utf8'), /tmpfs \/failure tmpfs/);
  await mkdir(`${root}/outbox`, { recursive: true });
  // Network isolation and the unopened loopback port force the real database
  // adapter to fail. The fallback below is the unchanged application module.
  await assert.rejects(prisma.$queryRaw`SELECT 1`);
  const event = (id: string) => ({ id, requestId: id, courseId: 'isolated-course', studentId: 'isolated-student', stageKey: 'make',
    source: 'system' as const, eventType: 'response' as const, actorRole: 'ai' as const, content: `Complete synthetic answer for ${id}` });
  const first = event('before-full');
  await appendDurableAiInteractionEvents([first]);
  const originalName = (await readdir(`${root}/outbox`)).find(name => name.endsWith('.json'))!;
  const originalFile = `${root}/outbox/${originalName}`;
  const originalDigest = fingerprint(await readFile(originalFile));
  const filler = await open(`${root}/bounded-filler`, 'wx', 0o600);
  let failure: unknown;
  try {
    for (let i = 0; i < 80; i++) await filler.write(Buffer.alloc(65536));
  } catch (error) { failure = error; }
  finally { await filler.close(); }
  assert.equal((failure as NodeJS.ErrnoException)?.code, 'ENOSPC', 'The kernel must report real tmpfs exhaustion');
  assert.equal((await statfs(root)).bavail, 0);
  const second = event('retry-after-full');
  await assert.rejects(appendDurableAiInteractionEvents([second]), { code: 'ENOSPC' });
  assert.equal(fingerprint(await readFile(originalFile)), originalDigest, 'A failed append cannot alter an acknowledged batch');
  assert.equal((await readAiAuditOutboxCounts()).pending, 1, 'A failed write must not publish an incomplete committed batch');
  await unlink(`${root}/bounded-filler`);
  await appendDurableAiInteractionEvents([second]);
  const batches = await Promise.all((await readdir(`${root}/outbox`)).filter(name => name.endsWith('.json'))
    .map(async name => JSON.parse(await readFile(path.join(root, 'outbox', name), 'utf8'))));
  assert.deepEqual(batches.flat().sort((a, b) => a.id.localeCompare(b.id)), [first, second].sort((a, b) => a.id.localeCompare(b.id)));
  assert.equal(fingerprint(await readFile(originalFile)), originalDigest);
  console.log('PASS kernel ENOSPC: append rejects; acknowledged batch preserved; no incomplete committed JSON; retry after freeing 4 MiB tmpfs preserves both complete stable-ID events');

  process.env.AI_AUDIT_OUTBOX_DIR = '/readonly-outbox';
  await assert.rejects(appendDurableAiInteractionEvents([event('read-only')]), { code: 'EROFS' });
  assert.deepEqual(await readdir('/readonly-outbox'), []);
  assert.equal(fingerprint(await readFile(originalFile)), originalDigest);
  console.log('PASS kernel EROFS: read-only bind rejects append, no false save acknowledgement, existing committed batch remains unchanged');

  process.env.AI_AUDIT_OUTBOX_DIR = `${root}/bad-batches`;
  await mkdir(process.env.AI_AUDIT_OUTBOX_DIR);
  const malformed = Buffer.from('{invalid json');
  const invalidStructure = Buffer.from('[{"studentId":"synthetic"}]');
  const badFiles = [['00000000-0000-0000-0000-000000000001.json', malformed],
    ['00000000-0000-0000-0000-000000000002.json', invalidStructure]] as const;
  for (const [name, bytes] of badFiles) await writeFile(path.join(process.env.AI_AUDIT_OUTBOX_DIR, name), bytes, { mode: 0o600 });
  await drainAiAuditOutbox();
  assert.deepEqual(await readAiAuditOutboxCounts(), { pending: 0, quarantined: 2 });
  for (const [name, bytes] of badFiles) assert.deepEqual(await readFile(path.join(process.env.AI_AUDIT_OUTBOX_DIR, 'quarantine', name)), bytes);
  console.log('PASS real filesystem quarantine: malformed JSON and invalid event structure retain exact bytes, pending=0 and quarantined=2');
}

main().finally(() => prisma.$disconnect()).catch(error => {
  console.error(error instanceof assert.AssertionError ? error.message.split('\n')[0] : (error as NodeJS.ErrnoException)?.code ?? 'DiskVerificationError');
  process.exitCode = 1;
});
