// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ scope: vi.fn(), files: vi.fn(), read: vi.fn() }));
vi.mock('@/lib/uploads/scope', () => ({ resolveUploadScope: mocks.scope }));
vi.mock('@/lib/db/client', () => ({ prisma: { fileAsset: { findMany: mocks.files } } }));
vi.mock('node:fs/promises', () => ({ readFile: mocks.read }));
import { resolveGenerationReferenceMaterials } from './generation-references';
beforeEach(() => { vi.clearAllMocks(); mocks.scope.mockResolvedValue({ offeringId: null, templateOwnerId: 'teacher' }); mocks.files.mockResolvedValue([{ id: 'asset', originalName: 'reference.md', storageKey: 'reference.md', mimeType: 'text/markdown' }]); mocks.read.mockResolvedValue(Buffer.from('Evidence for the lesson')); });
it('reads owned private FileAssets for template preparation without legacy course markers', async () => {
  const materials = await resolveGenerationReferenceMaterials({ courseId: 'template', uploadedById: 'teacher', uploadIds: ['asset'] });
  expect(materials[0].content).toContain('Evidence');
  expect(mocks.files).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['asset'] }, offeringId: null, uploadedById: 'teacher', deletedAt: null } }));
});
it('denies other teachers and refuses unscoped background reads', async () => {
  await expect(resolveGenerationReferenceMaterials({ courseId: 'template', uploadedById: 'other', uploadIds: ['asset'] })).rejects.toMatchObject({ code: 'GENERATION_REFERENCE_NOT_FOUND' });
  await expect(resolveGenerationReferenceMaterials({ courseId: 'template', uploadIds: ['asset'] })).rejects.toMatchObject({ code: 'GENERATION_REFERENCE_NOT_FOUND' });
  expect(mocks.files).not.toHaveBeenCalled();
});
