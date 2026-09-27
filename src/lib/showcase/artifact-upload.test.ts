import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  receipt: vi.fn(), event: vi.fn(), version: vi.fn(), latest: vi.fn(), saveVersion: vi.fn(),
  instance: vi.fn(), updateInstance: vi.fn(), participation: vi.fn(), member: vi.fn(), file: vi.fn(), artifact: vi.fn(), query: vi.fn(), execute: vi.fn(),
}));
vi.mock('@/lib/db/client', () => {
  const db = { domainEvent: { findUnique: mocks.receipt, create: mocks.event }, artifactVersion: { findUnique: mocks.version, aggregate: mocks.latest, create: mocks.saveVersion },
    classroomInstance: { findUnique: mocks.instance, update: mocks.updateInstance }, classroomParticipation: { findFirst: mocks.participation }, groupMember: { findFirst: mocks.member },
    fileAsset: { create: mocks.file }, artifact: { create: mocks.artifact }, $queryRaw: mocks.query, $executeRaw: mocks.execute };
  return { prisma: { ...db, $transaction: async (callback: (tx: unknown) => unknown) => callback(db) } };
});
import { persistArtifactUpload, readArtifactUploadReceipt } from './artifact-upload';

const input = { courseId: 'course', studentId: 'student', requestId: 'request', title: 'Project', originalName: 'project.txt', mimeType: 'text/plain', size: 3, sha256: 'abc', kind: 'file' as const,
  uploadId: 'file', versionId: 'version', storageKey: 'file.txt' };
const at = new Date('2026-09-26T00:00:00Z');
function historicalVersion() { return { id: 'version', sequence: 1, submittedAt: at, createdAt: at, sha256: 'abc', size: BigInt(3),
  fileAsset: { id: 'file', sha256: 'abc', size: BigInt(3), originalName: 'project.txt', mimeType: 'text/plain' },
  artifact: { title: 'Project', type: 'FILE_ARCHIVE', participation: { instanceId: 'course', enrollment: { userId: 'student' } } } }; }
function legacyReceipt() { mocks.receipt.mockResolvedValue({ actorId: 'student', classroomInstanceId: 'course', payload: { versionId: 'version' } }); mocks.version.mockResolvedValue(historicalVersion()); }
describe('local artifact upload persistence', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.receipt.mockResolvedValue(null);
    mocks.instance.mockResolvedValue({ status: 'TEACHING', runtimeConfig: { version: 7, currentStageIndex: 2,
      stages: ['launch', 'ai-learning', 'make', 'showcase', 'reflection'].map(key => ({ key })) }, templateVersionId: 'template-version',
      activity: { archivedAt: null, chapter: { offeringId: 'offering', offering: { status: 'OPEN' } } } });
    mocks.participation.mockResolvedValue({ id: 'participation', enrollment: { offeringId: 'offering', researchKey: 'research' } });
    mocks.member.mockResolvedValue({ groupId: 'group' });
    mocks.latest.mockResolvedValue({ _max: { sequence: null } });
    mocks.artifact.mockResolvedValue({ id: 'artifact' });
    mocks.saveVersion.mockResolvedValue({ id: 'version', sequence: 1 });
    mocks.event.mockResolvedValue({ id: 'event', createdAt: at });
  });
  it('queries only classroom state and the current student, records fingerprint and increments version once', async () => {
    const result = await persistArtifactUpload(input);
    expect(result.duplicate).toBe(false);
    expect(result.courseVersion).toBe(8);
    expect(mocks.instance).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ runtimeConfig: true }) }));
    expect(mocks.participation).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ instanceId: 'course', enrollment: { userId: 'student', offeringId: 'offering', status: 'ACTIVE' } }) }));
    expect(mocks.member).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: 'student', leftAt: null, group: { offeringId: 'offering', status: 'ACTIVE' } }) }));
    expect(mocks.updateInstance).toHaveBeenCalledTimes(1);
    expect(mocks.event).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ researchKey: 'research', payload: expect.objectContaining({ fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), courseVersion: 8 }) }) }));
    expect(mocks.execute.mock.invocationCallOrder[0]).toBeLessThan(mocks.query.mock.invocationCallOrder[0]);
  });
  it('replays verified historical receipts and skips course state reads after classroom closure', async () => {
    legacyReceipt();
    const result = await persistArtifactUpload(input);
    expect(result.duplicate).toBe(true);
    expect(result.response).toMatchObject({ versionId: 'version', uploadId: 'file', kind: 'file', mimeType: 'text/plain' });
    expect(mocks.instance).not.toHaveBeenCalled();
    expect(mocks.file).not.toHaveBeenCalled();
  });
  it.each([{ sha256: 'changed' }, { title: 'Changed title' }, { originalName: 'other.txt' }, { size: 4 }])('rejects changed inputs against a historical receipt: %j', async changed => {
    legacyReceipt();
    await expect(readArtifactUploadReceipt({ ...input, ...changed })).rejects.toMatchObject({ code: 'ARTIFACT_REQUEST_CONFLICT', status: 409 });
  });
  it('rejects unprovable or wrong-owner historical receipts', async () => {
    legacyReceipt();
    mocks.version.mockResolvedValueOnce({ ...historicalVersion(), sha256: null, fileAsset: { ...historicalVersion().fileAsset, sha256: null } });
    await expect(readArtifactUploadReceipt(input)).rejects.toMatchObject({ code: 'ARTIFACT_REQUEST_CONFLICT' });
    mocks.receipt.mockResolvedValueOnce({ actorId: 'other-student', classroomInstanceId: 'course', payload: { versionId: 'version' } });
    await expect(readArtifactUploadReceipt(input)).rejects.toMatchObject({ code: 'ARTIFACT_REQUEST_CONFLICT' });
  });
  it('checks the new fingerprint before loading a version', async () => {
    mocks.receipt.mockResolvedValue({ actorId: 'student', classroomInstanceId: 'course', payload: { versionId: 'version', fingerprint: 'different' } });
    await expect(readArtifactUploadReceipt(input)).rejects.toMatchObject({ code: 'ARTIFACT_REQUEST_CONFLICT' });
    expect(mocks.version).not.toHaveBeenCalled();
  });
  it('rejects a new upload after a locked classroom closes', async () => {
    mocks.instance.mockResolvedValue({ status: 'FINISHED', runtimeConfig: { stages: [] }, activity: { archivedAt: null, chapter: { offering: { status: 'OPEN' } } } });
    await expect(persistArtifactUpload(input)).rejects.toMatchObject({ code: 'ARTIFACT_SUBMISSION_INACTIVE' });
    expect(mocks.file).not.toHaveBeenCalled();
  });
});
