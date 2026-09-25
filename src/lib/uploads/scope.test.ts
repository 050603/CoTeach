// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ offering: vi.fn(), instance: vi.fn(), template: vi.fn(), participations: vi.fn(), classroom: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ prisma: { courseOffering: { findUnique: mocks.offering }, classroomInstance: { findUnique: mocks.instance }, classroomTemplate: { findUnique: mocks.template }, classroomParticipation: { findMany: mocks.participations } } }));
vi.mock('@openmaic/lib/server/classroom-storage', () => ({
  isValidClassroomId: (id: string) => /^[a-zA-Z0-9_-]+$/.test(id),
  readClassroom: mocks.classroom,
}));
import { canReadTemplateAsset, resolveUploadScope } from './scope';
beforeEach(() => { vi.clearAllMocks(); mocks.offering.mockResolvedValue(null); mocks.instance.mockResolvedValue(null); mocks.template.mockResolvedValue(null); });
const asset = (id: string, uploadedById = 'teacher', assetRole = 'SOURCE', mimeType = 'application/pdf') => ({ id, uploadedById, assetRole, mimeType });
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
  mocks.participations.mockResolvedValue([{ instance: { templateVersion: { template: { ownerId: 'teacher' }, snapshot: {
    schemaVersion: 2, kind: 'pbl-course', design: {
      resources: [{ id: 'launch', url: '/api/uploads/launch', previewUrl: '/api/uploads/launch?variant=classroom' }],
      content: { resourcePackage: { source: { id: 'zip', url: '/api/uploads/zip' }, documents: { knowledge: { id: 'knowledge', url: '/api/uploads/knowledge' }, lessonPlan: { id: 'lesson', url: '/api/uploads/lesson' } } } },
    },
  } } } }]);
  expect(await canReadTemplateAsset('student', asset('launch'))).toBe(true);
  expect(await canReadTemplateAsset('student', asset('launch', 'shared-resource-owner'))).toBe(true);
  expect(await canReadTemplateAsset('student', asset('zip'))).toBe(false);
  expect(await canReadTemplateAsset('student', asset('knowledge'))).toBe(false);
  expect(await canReadTemplateAsset('student', asset('lesson'))).toBe(false);
  expect(mocks.participations).toHaveBeenCalledWith(expect.objectContaining({ where: { enrollment: { userId: 'student', status: { in: ['ACTIVE', 'COMPLETED'] } } } }));
});
it('serves only teacher-owned figures embedded in the enrolled student classroom', async () => {
  mocks.participations.mockResolvedValue([{ instance: { templateVersion: {
    template: { ownerId: 'teacher' }, mediaRefs: null,
    snapshot: { design: { aiLearningClassroomId: 'classroom-1' } },
  } } }]);
  mocks.classroom.mockResolvedValue({ scenes: [
    { type: 'slide', audience: 'student', content: { canvas: { elements: [{ src: '/api/uploads/figure' }] } } },
    { type: 'slide', audience: 'teacher', content: { canvas: { elements: [{ src: '/api/uploads/teacher-only' }] } } },
  ] });
  expect(await canReadTemplateAsset('student', asset('figure', 'teacher', 'TEXTBOOK_FIGURE', 'image/jpeg'))).toBe(true);
  expect(await canReadTemplateAsset('student', asset('figure', 'other-teacher', 'TEXTBOOK_FIGURE', 'image/jpeg'))).toBe(false);
  expect(await canReadTemplateAsset('student', asset('teacher-only', 'teacher', 'TEXTBOOK_FIGURE', 'image/jpeg'))).toBe(false);
  expect(await canReadTemplateAsset('student', asset('unreferenced', 'teacher', 'TEXTBOOK_FIGURE', 'image/jpeg'))).toBe(false);
  expect(await canReadTemplateAsset('student', asset('figure', 'teacher', 'SOURCE', 'image/jpeg'))).toBe(false);
});
