// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ list: vi.fn(), count: vi.fn(), read: vi.fn(), stat: vi.fn(), unlink: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ prisma: { fileAsset: { findMany: mocks.list, count: mocks.count } } }));
vi.mock('node:fs/promises', () => ({ readdir: mocks.read, lstat: mocks.stat, unlink: mocks.unlink }));
import { cleanupCourseFiles, cleanupExpiredFiles, cleanupOrphanFiles } from './cleanup';
beforeEach(() => { vi.clearAllMocks(); mocks.list.mockResolvedValue([]); mocks.count.mockResolvedValue(0); mocks.unlink.mockResolvedValue(undefined); });
it('retains registered assets, fresh files and symbolic links while removing old disk orphans', async () => {
  mocks.read.mockResolvedValue(['known.pdf', 'fresh.pdf', 'old.pdf', 'link']);
  mocks.list.mockResolvedValue([{ storageKey: 'known.pdf' }]);
  mocks.stat.mockImplementation(async (file: string) => ({ isFile: () => !file.endsWith('/link'), mtimeMs: file.endsWith('/fresh.pdf') ? Date.now() : 0 }));
  expect(await cleanupOrphanFiles()).toEqual({ deleted: ['old.pdf'], failed: [] });
  expect(mocks.unlink).toHaveBeenCalledTimes(1);
});
it('requires a tombstone and no relational reference for course and retention cleanup', async () => {
  await cleanupCourseFiles('offering');
  expect(mocks.list).toHaveBeenCalledWith({ where: { offeringId: 'offering', deletedAt: { not: null }, resource: null, artifactVersions: { none: {} } } });
  await cleanupExpiredFiles(30);
  expect(mocks.list).toHaveBeenLastCalledWith({ where: { offeringId: undefined, deletedAt: { lt: expect.any(Date) }, resource: null, artifactVersions: { none: {} } } });
});
it('never follows path traversal in a stored asset key', async () => {
  mocks.list.mockResolvedValue([{ id: 'unsafe', storageKey: '../outside', deletedAt: new Date() }]);
  expect(await cleanupCourseFiles('offering')).toEqual({ deleted: [], failed: ['unsafe'] });
  expect(mocks.unlink).not.toHaveBeenCalled();
});
