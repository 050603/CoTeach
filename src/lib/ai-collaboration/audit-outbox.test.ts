import { mkdtemp, readdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendAiInteractionEvents } from './audit-store';
import { appendDurableAiInteractionEvents, drainAiAuditOutbox, auditOutboxDirectory, readAiAuditOutboxCounts } from './audit-outbox';
vi.mock('./audit-store', () => ({ appendAiInteractionEvents: vi.fn() }));
let directory: string;
const event = { id: 'retained-id', courseId: 'course', studentId: 'student', stageKey: 'make', source: 'system', eventType: 'response', actorRole: 'ai', content: 'complete answer' };
async function batch(name: string, contents: string) {
  await writeFile(path.join(directory, `${name}.json`), contents, { mode: 0o600 });
}
describe('durable AI audit outbox', () => {
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'openpbl-audit-test-'));
    vi.stubEnv('AI_AUDIT_OUTBOX_DIR', directory);
    vi.mocked(appendAiInteractionEvents).mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
  it('keeps pending audit data beside absolute uploads across standalone releases', () => {
    vi.stubEnv('AI_AUDIT_OUTBOX_DIR', '');
    vi.stubEnv('UPLOAD_DIR', path.join(directory, 'uploads'));
    expect(auditOutboxDirectory()).toBe(path.join(directory, 'ai-audit-outbox'));
  });
  it('retains failed batches and replays stable IDs after database recovery', async () => {
    vi.mocked(appendAiInteractionEvents).mockRejectedValue(new Error('database unavailable'));
    await appendDurableAiInteractionEvents([{ courseId: 'course', studentId: 'student', stageKey: 'make', source: 'system', eventType: 'response', actorRole: 'ai', content: 'complete answer' }]);
    const names = await readdir(directory);
    expect(names).toHaveLength(1);
    const events = JSON.parse(await readFile(path.join(directory, names[0]), 'utf8'));
    expect(events[0].id).toBeTruthy();
    await drainAiAuditOutbox();
    expect(await readdir(directory)).toEqual(names);
    vi.mocked(appendAiInteractionEvents).mockResolvedValue([]);
    await drainAiAuditOutbox();
    expect(appendAiInteractionEvents).toHaveBeenLastCalledWith(events);
    expect(await readdir(directory)).toEqual([]);
  });
  it('preserves invalid JSON in quarantine and continues valid batches in the same drain', async () => {
    const broken = '[{"content":"retained incomplete';
    await batch('0000', broken);
    await batch('0001', JSON.stringify([event]));
    vi.mocked(appendAiInteractionEvents).mockResolvedValue([]);
    await drainAiAuditOutbox();
    expect(appendAiInteractionEvents).toHaveBeenCalledTimes(1);
    expect(appendAiInteractionEvents).toHaveBeenCalledWith([event]);
    expect(await readFile(path.join(directory, 'quarantine/0000.json'), 'utf8')).toBe(broken);
    expect((await stat(path.join(directory, 'quarantine'))).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(directory, 'quarantine/0000.json'))).mode & 0o777).toBe(0o600);
    expect(await readAiAuditOutboxCounts()).toEqual({ pending: 0, quarantined: 1 });
    await drainAiAuditOutbox();
    expect(appendAiInteractionEvents).toHaveBeenCalledTimes(1);
    expect(await readAiAuditOutboxCounts()).toEqual({ pending: 0, quarantined: 1 });
    expect(console.error).toHaveBeenCalledWith('[ai-audit] batch retained in quarantine', { filename: '0000.json', reason: 'INVALID_JSON' });
  });
  it.each([null, {}, [], [{}], [{ ...event, studentId: '' }], [{ ...event, id: undefined }], [{ ...event, actorRole: 'invalid' }]])(
    'quarantines invalid event structures without a database write: %j', async value => {
      const raw = JSON.stringify(value);
      await batch('0000', raw);
      await drainAiAuditOutbox();
      expect(appendAiInteractionEvents).not.toHaveBeenCalled();
      expect(await readFile(path.join(directory, 'quarantine/0000.json'), 'utf8')).toBe(raw);
      expect(await readAiAuditOutboxCounts()).toEqual({ pending: 0, quarantined: 1 });
    });
  it('quarantines a permanently invalid ownership batch and continues other students', async () => {
    const invalid = { ...event, courseId: 'unknown-course' };
    await batch('0000', JSON.stringify([invalid]));
    await batch('0001', JSON.stringify([event]));
    vi.mocked(appendAiInteractionEvents).mockImplementation(async events => {
      if (events[0].courseId === 'unknown-course') throw Object.assign(new Error('invalid ownership'), { code: 'EVENT_SCOPE_MISMATCH' });
      return [];
    });
    await drainAiAuditOutbox();
    expect(appendAiInteractionEvents).toHaveBeenCalledTimes(2);
    expect(await readFile(path.join(directory, 'quarantine/0000.json'), 'utf8')).toBe(JSON.stringify([invalid]));
    expect(await readAiAuditOutboxCounts()).toEqual({ pending: 0, quarantined: 1 });
  });
  it('stops at the first database failure and leaves all pending batches for recovery', async () => {
    await batch('0000', JSON.stringify([event]));
    await batch('0001', JSON.stringify([{ ...event, id: 'second-id' }]));
    vi.mocked(appendAiInteractionEvents).mockRejectedValue(Object.assign(new Error('database unavailable'), { code: 'P1001' }));
    await drainAiAuditOutbox();
    expect(appendAiInteractionEvents).toHaveBeenCalledTimes(1);
    expect(await readAiAuditOutboxCounts()).toEqual({ pending: 2, quarantined: 0 });
    vi.mocked(appendAiInteractionEvents).mockResolvedValue([]);
    await drainAiAuditOutbox();
    expect(await readAiAuditOutboxCounts()).toEqual({ pending: 0, quarantined: 0 });
  });
  it('uses request-based idempotency and preserves identifiers verbatim during replay', async () => {
    const requestEvent = { ...event, id: undefined, requestId: 'request-1', conversationId: ' logical-id ' };
    await batch('0000', JSON.stringify([requestEvent]));
    vi.mocked(appendAiInteractionEvents).mockResolvedValue([]);
    await drainAiAuditOutbox();
    expect(appendAiInteractionEvents).toHaveBeenCalledWith([requestEvent]);
  });
});
