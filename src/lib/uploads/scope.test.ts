// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ offering: vi.fn(), instance: vi.fn(), template: vi.fn(), participations: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ prisma: { courseOffering: { findUnique: mocks.offering }, classroomInstance: { findUnique: mocks.instance }, classroomTemplate: { findUnique: mocks.template }, classroomParticipation: { findMany: mocks.participations } } }));
import { canReadTemplateAsset, resolveUploadScope } from './scope';
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
it('grants student access to the launch resource while excluding raw package metadata references', async () => {
  mocks.participations.mockResolvedValue([{ instance: { templateVersion: { snapshot: {
    schemaVersion: 2, kind: 'pbl-course', design: {
      resources: [{ id: 'launch', url: '/api/uploads/launch', previewUrl: '/api/uploads/launch?variant=classroom' }],
      content: { resourcePackage: { source: { id: 'zip', url: '/api/uploads/zip' }, documents: { knowledge: { id: 'knowledge', url: '/api/uploads/knowledge' }, lessonPlan: { id: 'lesson', url: '/api/uploads/lesson' } } } },
    },
  } } } }]);
  expect(await canReadTemplateAsset('student', 'launch')).toBe(true);
  expect(await canReadTemplateAsset('student', 'zip')).toBe(false);
  expect(await canReadTemplateAsset('student', 'knowledge')).toBe(false);
  expect(await canReadTemplateAsset('student', 'lesson')).toBe(false);
  expect(mocks.participations).toHaveBeenCalledWith(expect.objectContaining({ where: { enrollment: { userId: 'student', status: { in: ['ACTIVE', 'COMPLETED'] } } } }));
});
