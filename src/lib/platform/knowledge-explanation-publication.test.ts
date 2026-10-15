import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthClaims } from '@/lib/auth/session';
const mocks = vi.hoisted(() => {
  const tx = { $queryRaw: vi.fn(), $executeRaw: vi.fn(),
    classroomTemplate: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    classroomTemplateVersion: { create: vi.fn(), findUniqueOrThrow: vi.fn(), findUnique: vi.fn() },
    classroomInstance: { findUnique: vi.fn(), update: vi.fn(), findFirst: vi.fn(), aggregate: vi.fn(), create: vi.fn() },
    activity: { findUnique: vi.fn() },
    classroomParticipation: { updateMany: vi.fn() }, courseTeacher: { findFirst: vi.fn() }, domainEvent: { create: vi.fn() } };
  return { tx, transaction: vi.fn(), teacher: vi.fn(), review: vi.fn() };
});
vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/lib/db/transaction-retry', () => ({ runMutationTransaction: mocks.transaction }));
vi.mock('./access', () => ({ requireTeacherUser: mocks.teacher, normalizeUsername: (value: string) => value }));
vi.mock('@/lib/course-quality-review/review-service', () => ({ assertCourseTeacherReview: mocks.review, CourseReviewError: class extends Error {} }));
import { createPrivateTemplate, createTemplateVersion, createClassroomInstance, startClassroomInstance, finishClassroomInstance } from './repository';
const claims = { sub: 'teacher', role: 'teacher' } as AuthClaims;
const snapshot = { schemaVersion: 2, kind: 'pbl-course', design: { name: 'Course', stages: [], aiLearningClassroomId: 'classroom-content', content: {
  knowledgePoints: [{ id: 'kp', name: 'Concept' }], knowledgeLectureSections: [{ id: 'section', quizOutlineId: 'quiz', knowledgePointIds: ['kp'] }],
} } };
let queued: Map<string, { courseId: string; input: unknown }>;
let instance: { id: string; status: string; templateVersionId: string; activity: { chapter: { offeringId: string } } };
beforeEach(() => {
  vi.resetAllMocks(); queued = new Map();
  instance = { id: 'instance', status: 'SCHEDULED', templateVersionId: 'version-1', activity: { chapter: { offeringId: 'offering' } } };
  mocks.transaction.mockImplementation(operation => operation(mocks.tx));
  mocks.teacher.mockResolvedValue({ id: 'teacher' }); mocks.review.mockResolvedValue(undefined);
  mocks.tx.$executeRaw.mockImplementation(async (_sql: TemplateStringsArray, id: string, courseId: string, input: string) => {
    if (!queued.has(id)) queued.set(id, { courseId, input: JSON.parse(input) }); return 1;
  });
  mocks.tx.classroomTemplate.create.mockImplementation(async ({ data }) => ({ id: 'template', versions: [{ id: 'version-1', ...data.versions.create }] }));
  mocks.tx.classroomTemplate.findFirst.mockResolvedValue({ id: 'template', versions: [{ version: 1 }] });
  mocks.tx.classroomTemplateVersion.create.mockImplementation(async ({ data }) => ({ id: 'version-2', ...data }));
  mocks.tx.classroomTemplateVersion.findUniqueOrThrow.mockResolvedValue({ id: 'version-1', snapshot });
  mocks.tx.classroomInstance.findUnique.mockImplementation(async () => ({ ...instance }));
  mocks.tx.classroomInstance.update.mockImplementation(async ({ data }) => { Object.assign(instance, data); return { ...instance }; });
  mocks.tx.courseTeacher.findFirst.mockResolvedValue({ userId: 'teacher' });
});
describe('V2 publication and classroom start enqueue explanations atomically', () => {
  it('publishes the first private template with its immutable-version warmup receipt in one transaction', async () => {
    const result = await createPrivateTemplate(claims, { title: 'Course', snapshot });
    expect(result.id).toBe('template'); expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.teacher).toHaveBeenCalledWith(claims, mocks.tx);
    expect(mocks.review).toHaveBeenCalledOnce(); expect(queued.size).toBe(1);
    expect([...queued.values()][0]).toMatchObject({ courseId: 'template', input: { classroomId: 'classroom-content', sections: [{ quizOutlineId: 'quiz' }] } });
    expect(mocks.tx.classroomTemplate.create.mock.invocationCallOrder[0]).toBeLessThan(mocks.tx.$executeRaw.mock.invocationCallOrder[0]);
  });
  it('deduplicates identical published resources across immutable versions and retains the version lock', async () => {
    await createPrivateTemplate(claims, { title: 'Course', snapshot });
    const created = await createTemplateVersion(claims, 'template', { snapshot });
    expect(created.version).toBe(2); expect(queued.size).toBe(1);
    expect([...queued.values()].every(row => row.courseId === 'template')).toBe(true);
    expect(mocks.tx.$queryRaw.mock.calls[0][0].join('')).toContain('FOR UPDATE');
  });
  it('enqueues a fresh resource receipt when the authored classroom revision changes', async () => {
    await createPrivateTemplate(claims, { title: 'Course', snapshot });
    await createTemplateVersion(claims, 'template', { snapshot: { ...snapshot, design: { ...snapshot.design,
      content: { ...snapshot.design.content, teacherReviewVersion: { classroomRevision: 2 } },
    } } });
    expect(queued.size).toBe(2);
  });
  it('passes a copied template identity to review authorization while retaining the original confirmation identity', async () => {
    const copied = { ...snapshot, design: { ...snapshot.design, content: { ...snapshot.design.content,
      teacherReview: { courseId: 'source-course', signature: 'source-signature' },
    } } };
    await createTemplateVersion(claims, 'copied-template', { snapshot: copied });
    expect(mocks.review).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'copied-template',
      content: expect.objectContaining({ teacherReview: { courseId: 'source-course', signature: 'source-signature' } }),
    }), 'teacher');
    mocks.tx.activity.findUnique.mockResolvedValue({ id: 'activity', chapter: { offeringId: 'offering' } });
    mocks.tx.classroomTemplateVersion.findUnique.mockResolvedValue({ templateId: 'copied-template', status: 'PUBLISHED',
      snapshot: copied, template: { ownerId: 'teacher', status: 'ACTIVE' } });
    mocks.tx.classroomInstance.findFirst.mockResolvedValue(null);
    mocks.tx.classroomInstance.aggregate.mockResolvedValue({ _max: { runNo: 0 } });
    await createClassroomInstance(claims, 'activity', 'audio-version');
    expect(mocks.review).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'copied-template',
      content: expect.objectContaining({ teacherReview: { courseId: 'source-course', signature: 'source-signature' } }),
    }), 'teacher');
  });
  it('queues the bound snapshot when starting, deduplicates repeated start, and never enqueues on finish', async () => {
    const result = await startClassroomInstance(claims, 'instance');
    expect(result.status).toBe('TEACHING'); expect(queued.size).toBe(1);
    expect([...queued.values()][0].courseId).toBe('instance');
    expect(mocks.tx.classroomTemplateVersion.findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: 'version-1' }, select: { id: true, snapshot: true } });
    await startClassroomInstance(claims, 'instance');
    expect(queued.size).toBe(1); expect(mocks.tx.domainEvent.create).toHaveBeenCalledOnce();
    const writes = mocks.tx.$executeRaw.mock.calls.length;
    await finishClassroomInstance(claims, 'instance');
    expect(mocks.tx.$executeRaw).toHaveBeenCalledTimes(writes);
  });
  it('shares a publication receipt when a classroom starts with the same bound resources', async () => {
    await createPrivateTemplate(claims, { title: 'Course', snapshot });
    await startClassroomInstance(claims, 'instance');
    expect(queued.size).toBe(1);
  });
  it('does not enqueue unrelated snapshots or templates without lecture sections', async () => {
    await createPrivateTemplate(claims, { title: 'Other', snapshot: {} });
    await createTemplateVersion(claims, 'template', { snapshot: { ...snapshot, design: { ...snapshot.design, content: { knowledgePoints: [] } } } });
    mocks.tx.classroomTemplateVersion.findUniqueOrThrow.mockResolvedValue({ id: 'version-1', snapshot: {} });
    await startClassroomInstance(claims, 'instance');
    expect(queued.size).toBe(0); expect(mocks.tx.$executeRaw).not.toHaveBeenCalled();
  });
  it('keeps authorization ahead of start receipts and propagates enqueue failures to the same transaction', async () => {
    mocks.tx.courseTeacher.findFirst.mockResolvedValueOnce(null);
    await expect(startClassroomInstance(claims, 'instance')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.tx.$executeRaw).not.toHaveBeenCalled();
    mocks.tx.$executeRaw.mockRejectedValueOnce(new Error('queue storage failed'));
    await expect(createPrivateTemplate(claims, { title: 'Course', snapshot })).rejects.toThrow('queue storage failed');
  });
});
