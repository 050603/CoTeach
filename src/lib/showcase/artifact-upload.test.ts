import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  admitted: true, receipt: vi.fn(), event: vi.fn(), version: vi.fn(), scope: vi.fn(), row: vi.fn(), query: vi.fn(), execute: vi.fn(),
}));
vi.mock('@/lib/db/client', () => {
  const db = { domainEvent: { findUnique: mocks.receipt }, artifactVersion: { findUnique: mocks.version },
    $queryRaw: mocks.query, $executeRaw: mocks.execute };
  return { prisma: { ...db, $transaction: async (callback: (tx: unknown) => unknown) => callback(db) } };
});
vi.mock('@/lib/db/transaction-retry', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/db/transaction-retry')>();
  return { ...actual, hasCourseMutationAdmission: (...args: Parameters<typeof actual.hasCourseMutationAdmission>) => mocks.admitted && actual.hasCourseMutationAdmission(...args) };
});
import { persistArtifactUpload, readArtifactUploadReceipt } from './artifact-upload';

const input = { courseId: 'course', studentId: 'student', sessionVersion: 1, requestId: 'request', title: 'Project', originalName: 'project.txt', mimeType: 'text/plain', size: 3, sha256: 'abc', kind: 'file' as const,
  uploadId: 'file', versionId: 'version', storageKey: 'file.txt' };
const at = new Date('2026-09-26T00:00:00Z');
function historicalVersion() { return { id: 'version', sequence: 1, submittedAt: at, createdAt: at, sha256: 'abc', size: BigInt(3),
  uploadId: 'file', fileSha256: 'abc', fileSize: BigInt(3), originalName: 'project.txt', mimeType: 'text/plain',
  title: 'Project', type: 'FILE_ARCHIVE', instanceId: 'course', userId: 'student', userStatus: 'ACTIVE', userRole: 'STUDENT', sessionVersion: 1, readAllowed: true }; }
const stages = ['launch', 'ai-learning', 'make', 'showcase', 'reflection'].map(key => ({ key }));
function activeScope() { return { status: 'TEACHING', runtimeVersion: 7, currentStageIndex: 2, runtimeStages: stages, templateStages: null,
  userStatus: 'ACTIVE', userRole: 'STUDENT', sessionVersion: 1, readAllowed: true, enrollmentStatus: 'ACTIVE',
  offeringId: 'offering', offeringStatus: 'OPEN', archivedAt: null, participationId: 'participation', researchKey: 'research', groupId: 'group', sequence: 1, hasReceipt: false }; }
function legacyReceipt() { mocks.receipt.mockResolvedValue({ actorId: 'student', classroomInstanceId: 'course', payload: { versionId: 'version' } }); mocks.version.mockResolvedValue([historicalVersion()]); }
describe('local artifact upload persistence', () => {
  beforeEach(() => {
    vi.resetAllMocks(); mocks.admitted = true;
    mocks.receipt.mockResolvedValue(null);
    mocks.scope.mockResolvedValue([activeScope()]);
    mocks.row.mockResolvedValue([{ id: 'course' }]);
    mocks.event.mockResolvedValue([{ id: 'event', createdAt: at }]);
    mocks.query.mockImplementation((parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join('?');
      if (sql.includes('pg_try_advisory_xact_lock')) return [{ acquired: true }];
      if (sql.includes('openpbl_external_artifact_scope_v1')) return mocks.scope(...values);
      if (sql.includes('FOR UPDATE')) return mocks.row(...values);
      if (sql.includes('AS "runtimeStages"')) return mocks.scope(...values);
      if (sql.includes('WITH asset')) return mocks.event(...values);
      if (sql.includes('FROM "ArtifactVersion" v')) return mocks.version(...values);
      throw new Error('Unexpected database query');
    });
  });
  it('keeps config, immutable file facts and audit ownership in the same commit after admission', async () => {
    const result = await persistArtifactUpload(input);
    expect(result.duplicate).toBe(false);
    expect(result.courseVersion).toBe(8);
    expect(result.response).toMatchObject({ requestId: 'request', versionId: 'version', uploadId: 'file', sequence: 1 });
    expect(mocks.event).toHaveBeenCalledTimes(1);
    const parameters = mocks.event.mock.calls[0];
    expect(parameters).toEqual(expect.arrayContaining(['research', 'participation', 'group', 'offering', 'student', BigInt(3), 'abc']));
    expect(parameters.map(value => typeof value === 'string' && value.startsWith('{') ? JSON.parse(value) : null)).toEqual(expect.arrayContaining([
      expect.objectContaining({ fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), courseVersion: 8, requestId: 'request', versionId: 'version' }),
    ]));
    expect(parameters).toContain('8');
    expect(mocks.query).toHaveBeenCalledTimes(3);
    expect(mocks.query.mock.calls[1][0].join('?')).toContain('openpbl_external_artifact_scope_v1');
    expect(mocks.row).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls[2][0].join('?')).toContain('jsonb_set(');
    expect(mocks.receipt).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled(); // Admission already owns this exact transaction's advisory lock.
  });
  it('replays verified historical receipts even after classroom and membership closure', async () => {
    legacyReceipt();
    mocks.scope.mockResolvedValue([{ ...activeScope(), hasReceipt: true, status: 'FINISHED', enrollmentStatus: 'COMPLETED', groupId: null }]);
    const result = await persistArtifactUpload(input);
    expect(result.duplicate).toBe(true);
    expect(result.response).toMatchObject({ versionId: 'version', uploadId: 'file', kind: 'file', mimeType: 'text/plain' });
    expect(mocks.event).not.toHaveBeenCalled();
  });
  it.each([{ sha256: 'changed' }, { title: 'Changed title' }, { originalName: 'other.txt' }, { size: 4 }])('rejects changed inputs against a historical receipt: %j', async changed => {
    legacyReceipt();
    await expect(readArtifactUploadReceipt({ ...input, ...changed })).rejects.toMatchObject({ code: 'ARTIFACT_REQUEST_CONFLICT', status: 409 });
  });
  it('rejects unprovable or wrong-owner historical receipts', async () => {
    legacyReceipt();
    mocks.version.mockResolvedValueOnce([{ ...historicalVersion(), sha256: null, fileSha256: null }]);
    await expect(readArtifactUploadReceipt(input)).rejects.toMatchObject({ code: 'ARTIFACT_REQUEST_CONFLICT' });
    mocks.receipt.mockResolvedValueOnce({ actorId: 'other-student', classroomInstanceId: 'course', payload: { versionId: 'version' } });
    await expect(readArtifactUploadReceipt(input)).rejects.toMatchObject({ code: 'ARTIFACT_REQUEST_CONFLICT' });
  });
  it('checks the new fingerprint before loading a version', async () => {
    mocks.receipt.mockResolvedValue({ actorId: 'student', classroomInstanceId: 'course', payload: { versionId: 'version', fingerprint: 'different' } });
    await expect(readArtifactUploadReceipt(input)).rejects.toMatchObject({ code: 'ARTIFACT_REQUEST_CONFLICT' });
    expect(mocks.version).not.toHaveBeenCalled();
  });
  it('keeps historical null fallbacks and original dates without loading a document body', async () => {
    legacyReceipt(); mocks.version.mockResolvedValue([{ ...historicalVersion(), sha256: null, size: null, submittedAt: null }]);
    expect(await readArtifactUploadReceipt(input)).toEqual({ ok: true, versionId: 'version', uploadId: 'file', sequence: 1,
      submittedAt: at.toISOString(), requestId: 'request', kind: 'file', mimeType: 'text/plain' });
    expect(mocks.receipt).toHaveBeenCalledTimes(1); expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][0].join('?')).not.toContain('sourceHtml');
  });
  it.each([{ rows: [] }, { rows: [{ ...historicalVersion(), userId: 'other' }] }, { rows: [{ ...historicalVersion(), instanceId: 'other' }] }])('rejects missing or unowned immutable versions', async ({ rows }) => {
    legacyReceipt(); mocks.version.mockResolvedValue(rows);
    await expect(readArtifactUploadReceipt(input)).rejects.toMatchObject({ code: 'ARTIFACT_REQUEST_CONFLICT', status: 409 });
  });
  it('returns a missing receipt without a version query', async () => {
    expect(await readArtifactUploadReceipt(input)).toBeNull(); expect(mocks.query).not.toHaveBeenCalled();
  });
  it.each([
    [{ status: 'FINISHED' }, 'ARTIFACT_SUBMISSION_INACTIVE'],
    [{ offeringStatus: 'CLOSED' }, 'ARTIFACT_SUBMISSION_INACTIVE'],
    [{ archivedAt: at }, 'ARTIFACT_SUBMISSION_INACTIVE'],
    [{ participationId: null }, 'STUDENT_NOT_FOUND'],
    [{ groupId: null }, 'GROUP_NOT_FOUND'],
    [{ enrollmentStatus: 'COMPLETED' }, 'STUDENT_NOT_FOUND'],
    [{ currentStageIndex: 4 }, 'ARTIFACT_SUBMISSION_INACTIVE'],
    [{ currentStageIndex: 2, runtimeStages: [], templateStages: stages }, 'ARTIFACT_SUBMISSION_INACTIVE'],
  ])('rejects ineligible scope without writing: %j', async (changed, code) => {
    mocks.scope.mockResolvedValue([{ ...activeScope(), ...changed }]);
    await expect(persistArtifactUpload(input)).rejects.toMatchObject({ code });
    expect(mocks.event).not.toHaveBeenCalled();
  });
  it.each([stages, null])('uses template or default stage fallback without replacing other runtime keys', async templateStages => {
    mocks.scope.mockResolvedValue([{ ...activeScope(), currentStageIndex: 3, runtimeVersion: null, runtimeStages: null, templateStages, sequence: 9 }]);
    const result = await persistArtifactUpload(input);
    expect(result.response.sequence).toBe(9);
    expect(result.courseVersion).toBe(2);
    expect(mocks.event.mock.calls[0]).toContain('2');
    const sql = mocks.query.mock.calls[2][0].join('?');
    expect(sql).toContain('THEN "runtimeConfig" ELSE');
    expect(sql).toContain("'{version}'");
  });
  it('does not acknowledge a missing scope or missing commit receipt', async () => {
    mocks.scope.mockResolvedValueOnce([]);
    await expect(persistArtifactUpload(input)).rejects.toMatchObject({ code: 'COURSE_NOT_FOUND' });
    mocks.event.mockResolvedValueOnce([]);
    await expect(persistArtifactUpload(input)).rejects.toThrow('durable receipt');
  });
  it.each([{ userStatus: 'DISABLED' }, { userRole: 'TEACHER' }, { sessionVersion: 2 }, { readAllowed: false }])('rejects revoked identity/read scope before writes and existing receipt replay: %j', async changed => {
    for (const hasReceipt of [false, true]) {
      legacyReceipt();
      mocks.scope.mockResolvedValue([{ ...activeScope(), ...changed, hasReceipt }]);
      await expect(persistArtifactUpload(input)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    }
    expect(mocks.receipt).not.toHaveBeenCalled(); expect(mocks.event).not.toHaveBeenCalled();
  });
  it.each([{ userStatus: 'DISABLED' }, { userRole: 'TEACHER' }, { sessionVersion: 2 }, { readAllowed: false }])('reauthorizes fast receipt replay after file parsing: %j', async changed => {
    legacyReceipt(); mocks.version.mockResolvedValue([{ ...historicalVersion(), ...changed }]);
    await expect(readArtifactUploadReceipt(input)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(mocks.event).not.toHaveBeenCalled();
  });
  it('fallback does not read the scope until the independent course row lock finishes', async () => {
    mocks.admitted = false;
    let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    mocks.row.mockImplementation(() => { entered(); return new Promise<void>(resolve => { release = resolve; }); });
    const result = persistArtifactUpload(input);
    const rejected = expect(result).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await waiting;
    expect(mocks.scope).not.toHaveBeenCalled();
    mocks.scope.mockResolvedValue([{ ...activeScope(), sessionVersion: 2, hasReceipt: true }]);
    release(); await rejected;
    expect(mocks.scope).toHaveBeenCalledTimes(1);
    expect(mocks.receipt).not.toHaveBeenCalled(); expect(mocks.event).not.toHaveBeenCalled();
  });
  it.each(['2147483648', '', false, null])('retains JavaScript Number semantics for runtime version %j', async runtimeVersion => {
    mocks.scope.mockResolvedValue([{ ...activeScope(), runtimeVersion }]);
    const result = await persistArtifactUpload(input);
    expect(result.courseVersion).toBe(Number(runtimeVersion ?? 1) + 1);
  });
  it('fallback retains independent advisory lock, row lock and complete scope query', async () => {
    mocks.admitted = false;
    await persistArtifactUpload(input);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledTimes(4);
    expect(mocks.query.mock.calls[1][0].join('?')).toMatch(/^SELECT id .* FOR UPDATE$/);
    expect(mocks.query.mock.calls[2][0].join('?')).toContain('AS "runtimeStages"');
    expect(mocks.query.mock.calls.flat().join(' ')).not.toContain('openpbl_external_artifact_scope_v1');
  });
  it('permits renewed-session replay without changing the committed business fingerprint', async () => {
    legacyReceipt(); mocks.version.mockResolvedValue([{ ...historicalVersion(), sessionVersion: 2 }]);
    const replay = await readArtifactUploadReceipt({ ...input, sessionVersion: 2 });
    expect(replay?.requestId).toBe(input.requestId);
  });
});
