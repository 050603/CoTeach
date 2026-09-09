// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ offering: vi.fn(), instance: vi.fn(), template: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ prisma: { courseOffering: { findUnique: mocks.offering }, classroomInstance: { findUnique: mocks.instance }, classroomTemplate: { findUnique: mocks.template } } }));
import { resolveUploadScope } from './scope';
beforeEach(() => { vi.clearAllMocks(); mocks.offering.mockResolvedValue(null); mocks.instance.mockResolvedValue(null); mocks.template.mockResolvedValue(null); });
it('resolves offering, classroom instance and private template IDs explicitly', async () => {
  mocks.offering.mockResolvedValueOnce({ id: 'offering' });
  expect(await resolveUploadScope('offering')).toMatchObject({ offeringId: 'offering' });
  mocks.instance.mockResolvedValueOnce({ activity: { chapter: { offeringId: 'offering' } } });
  expect(await resolveUploadScope('instance')).toMatchObject({ offeringId: 'offering' });
  mocks.template.mockResolvedValueOnce({ id: 'template', ownerId: 'teacher' });
  expect(await resolveUploadScope('template')).toEqual({ offeringId: null, templateOwnerId: 'teacher', templateId: 'template' });
  expect(await resolveUploadScope('missing')).toBeNull();
});
