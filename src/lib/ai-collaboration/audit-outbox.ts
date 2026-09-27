import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { appendAiInteractionEvents, type AiInteractionEventInput } from './audit-store';

export function auditOutboxDirectory(): string {
  return process.env.AI_AUDIT_OUTBOX_DIR || path.resolve(process.env.UPLOAD_DIR || '.openpbl-data/uploads', '../ai-audit-outbox');
}

const batchFilename = /^[0-9a-f-]+\.json$/;
const identifier = z.string().refine(value => value.trim().length > 0);
const eventSchema = z.object({
  id: identifier.optional(), requestId: identifier.optional(),
  courseId: identifier, studentId: identifier, stageKey: identifier,
  participationId: identifier.optional(), conversationId: identifier.optional(),
  source: z.enum(['sidebar', 'selection', 'proactive-comment', 'submission', 'system']),
  eventType: z.enum(['request', 'response', 'policy', 'proposal', 'decision', 'undo', 'comment', 'submit', 'error']),
  actorRole: z.enum(['student', 'ai', 'system', 'teacher']),
  actorId: z.string().optional(), content: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(), createdAt: z.string().optional(),
}).passthrough().refine(event => Boolean(event.id || event.requestId));
const batchSchema = z.array(eventSchema).min(1);

export async function readAiAuditOutboxCounts(): Promise<{ pending: number; quarantined: number }> {
  const count = async (directory: string) => {
    try { return (await readdir(directory)).filter(name => batchFilename.test(name)).length; }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return 0;
      throw error;
    }
  };
  const directory = auditOutboxDirectory();
  const [pending, quarantined] = await Promise.all([count(directory), count(path.join(directory, 'quarantine'))]);
  return { pending, quarantined };
}

async function quarantineBatch(directory: string, name: string, reason: string): Promise<void> {
  const quarantine = path.join(directory, 'quarantine');
  await mkdir(quarantine, { recursive: true, mode: 0o700 });
  await rename(path.join(directory, name), path.join(quarantine, name));
  for (const location of [quarantine, directory]) {
    const handle = await open(location, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  // Keep the exact original bytes for repair; never log student content.
  console.error('[ai-audit] batch retained in quarantine', { filename: name, reason });
}

/** Database failures may defer the audit write, but never discard the event. */
export async function appendDurableAiInteractionEvents(input: AiInteractionEventInput[]): Promise<void> {
  const events = input.map(event => event.id || event.requestId ? event : { ...event, id: randomUUID() });
  try { await appendAiInteractionEvents(events); return; }
  catch {
    const directory = auditOutboxDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, `${randomUUID()}.json`);
    const temporary = `${filename}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(events)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, filename);
    const directoryHandle = await open(directory, 'r');
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    console.warn('[ai-audit] events retained in durable outbox', { count: events.length });
  }
}

let draining: Promise<void> | undefined;
export function drainAiAuditOutbox(): Promise<void> {
  if (draining) return draining;
  draining = (async () => {
    const directory = auditOutboxDirectory();
    const names = await readdir(directory).catch(() => []);
    for (const name of names.filter(name => batchFilename.test(name)).slice(0, 100)) {
      const filename = path.join(directory, name);
      try {
        const contents = await readFile(filename, 'utf8');
        let parsed: unknown;
        try { parsed = JSON.parse(contents); }
        catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          await quarantineBatch(directory, name, 'INVALID_JSON');
          continue;
        }
        const batch = batchSchema.safeParse(parsed);
        if (!batch.success) {
          await quarantineBatch(directory, name, 'INVALID_EVENTS');
          continue;
        }
        try { await appendAiInteractionEvents(batch.data); }
        catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'EVENT_SCOPE_MISMATCH') {
            await quarantineBatch(directory, name, 'EVENT_SCOPE_MISMATCH');
            continue;
          }
          throw error;
        }
        await unlink(filename);
      } catch { break; /* Preserve the batch and retry after dependencies recover. */ }
    }
  })().finally(() => { draining = undefined; });
  return draining;
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startAiAuditOutbox(): void {
  if (timer) return;
  void drainAiAuditOutbox();
  timer = setInterval(() => { void drainAiAuditOutbox(); }, 15_000);
  timer.unref();
}
