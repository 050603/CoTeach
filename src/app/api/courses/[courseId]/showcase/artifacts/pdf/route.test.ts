// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
const mocks = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), file: vi.fn(), allowed: vi.fn() }));
vi.mock('@/lib/auth/request-guards', () => ({ requireSameOrigin: () => null, authenticateRequest: async () => ({ claims: { role: 'student', sub: 'student', sv: 7 } }) }));
vi.mock('@/lib/auth/distributed-rate-limit', () => ({ checkDistributedRateLimit: async () => ({ allowed: true }) }));
vi.mock('@/lib/db/client', () => ({ isDatabaseConfigured: () => true, prisma: { fileAsset: { findUnique: mocks.file } } }));
vi.mock('@/lib/realtime/event-bus', () => ({ publishCourseEvent: async () => undefined }));
vi.mock('@/lib/showcase/artifact-upload', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/showcase/artifact-upload')>()), readArtifactUploadReceipt: mocks.read, persistArtifactUpload: mocks.save, canReadArtifactCourse: mocks.allowed,
}));
import { POST } from './route';
import { ArtifactUploadError } from '@/lib/showcase/artifact-upload';
const key = 'ab6f6561-c2fc-4639-a617-84958deaf4c1';
const response = { ok: true, versionId: 'version', sequence: 1, submittedAt: '2026-09-26T00:00:00Z', uploadId: 'upload', kind: 'file', mimeType: 'text/plain', requestId: key };
const context = { params: Promise.resolve({ courseId: 'course' }) };
function request(name = 'work.txt') {
  const body = new FormData(); body.set('file', new File(['retained work'], name)); body.set('requestId', key);
  return new Request('http://localhost/api/courses/course/showcase/artifacts/pdf', { method: 'POST', body });
}
function timedPhases(result: Response) {
  return result.headers.get('server-timing')!.split(', ').map(part => {
    const match = /^([a-z_]+);dur=(\d+\.\d+)$/.exec(part);
    expect(match, part).not.toBeNull();
    expect(Number(match![2])).toBeGreaterThanOrEqual(0);
    return match![1];
  });
}
describe('local artifact upload route', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.read.mockResolvedValue(null); mocks.file.mockResolvedValue(null); mocks.allowed.mockResolvedValue(true);
    mocks.save.mockResolvedValue({ response, duplicate: false, courseVersion: 2, eventCursor: 'cursor' });
  });
  afterEach(async () => {
    for (const [input] of mocks.save.mock.calls) await unlink(path.resolve(process.env.UPLOAD_DIR || '.openpbl-data/uploads', input.storageKey)).catch(() => undefined);
    vi.restoreAllMocks();
  });
  it('keeps 201 for a new upload and 200 for an owned replay, with the complete original receipt', async () => {
    const first = await POST(request(), context);
    expect(first.status).toBe(201); expect(await first.json()).toEqual(response);
    expect(timedPhases(first)).toEqual(['authentication', 'authorization', 'form', 'validation', 'receipt', 'rate_limit', 'file', 'commit', 'notification']);
    mocks.read.mockResolvedValue(response);
    const replay = await POST(request(), context);
    expect(replay.status).toBe(200); expect(await replay.json()).toEqual(response);
    expect(timedPhases(replay)).toEqual(['authentication', 'authorization', 'form', 'validation', 'receipt']);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save.mock.calls[0][0]).toMatchObject({ sessionVersion: 7 });
    expect(mocks.read.mock.calls[0][0]).toMatchObject({ sessionVersion: 7 });
  });
  it('returns a conflict before staging a different file under a committed key', async () => {
    mocks.read.mockRejectedValue(new ArtifactUploadError('ARTIFACT_REQUEST_CONFLICT', 'conflict', 409));
    const result = await POST(request(), context);
    expect(result.status).toBe(409); expect(await result.json()).toMatchObject({ code: 'ARTIFACT_REQUEST_CONFLICT' });
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('checks current read authorization before replaying a committed receipt', async () => {
    mocks.allowed.mockResolvedValue(false); mocks.read.mockResolvedValue(response);
    expect((await POST(request(), context)).status).toBe(403);
    expect(mocks.allowed).toHaveBeenCalledWith('student', 'course');
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it('returns retryable course contention without acknowledging an uncommitted upload', async () => {
    mocks.save.mockRejectedValue(new ArtifactUploadError('COURSE_BUSY', 'busy', 503));
    const result = await POST(request(), context);
    expect(result.status).toBe(503); expect(await result.json()).toMatchObject({ code: 'COURSE_BUSY' });
    const location = path.resolve(process.env.UPLOAD_DIR || '.openpbl-data/uploads', mocks.save.mock.calls[0][0].storageKey);
    await expect(readFile(location)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects a session revoked during parsing before returning an old receipt', async () => {
    mocks.read.mockRejectedValue(new ArtifactUploadError('FORBIDDEN', 'session revoked', 403));
    expect((await POST(request(), context)).status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('removes only the new staged file when locked authorization observes a revoked session', async () => {
    mocks.save.mockRejectedValue(new ArtifactUploadError('FORBIDDEN', 'session revoked', 403));
    expect((await POST(request(), context)).status).toBe(403);
    const location = path.resolve(process.env.UPLOAD_DIR || '.openpbl-data/uploads', mocks.save.mock.calls[0][0].storageKey);
    await expect(readFile(location)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('preserves committed bytes when the database acknowledgement is lost', async () => {
    mocks.save.mockRejectedValue(new Error('lost commit acknowledgement')); mocks.file.mockResolvedValue({ id: 'committed' });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await POST(request(), context)).status).toBe(500);
    const location = path.resolve(process.env.UPLOAD_DIR || '.openpbl-data/uploads', mocks.save.mock.calls[0][0].storageKey);
    expect(await readFile(location, 'utf8')).toBe('retained work');
  });
  it('cleans only its own staged file when a concurrent request already committed', async () => {
    mocks.save.mockResolvedValue({ response, duplicate: true });
    const replay = await POST(request(), context);
    expect(replay.status).toBe(200); expect(await replay.json()).toEqual(response);
    expect(timedPhases(replay)).toEqual(['authentication', 'authorization', 'form', 'validation', 'receipt', 'rate_limit', 'file', 'commit', 'file_cleanup']);
    const location = path.resolve(process.env.UPLOAD_DIR || '.openpbl-data/uploads', mocks.save.mock.calls[0][0].storageKey);
    await expect(readFile(location)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('retains the file whitelist and 100 MiB limit', async () => {
    expect((await POST(request('program.exe'), context)).status).toBe(415);
    const body = new FormData(); const oversized = new File(['small actual fixture'], 'work.txt');
    Object.defineProperty(oversized, 'size', { value: 100 * 1024 * 1024 + 1 });
    body.set('file', oversized);
    const large = request(); vi.spyOn(large, 'formData').mockResolvedValue(body);
    expect((await POST(large, context)).status).toBe(413);
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
