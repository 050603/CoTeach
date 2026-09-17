import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Course } from '@/lib/session/types';
import type { PersistedClassroomData } from '@/lib/openmaic/server/classroom-storage';
const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), read: vi.fn(), audit: vi.fn() }));
vi.mock('@/lib/session/server-store', () => ({ getCourse: mocks.get, updateCourse: mocks.save }));
vi.mock('@/lib/openmaic/server/classroom-storage', () => ({ readClassroom: mocks.read, isValidClassroomId: (id: string) => /^[\w-]+$/.test(id) }));
vi.mock('@/lib/classroom/new-system-course', () => ({ getNewSystemCourseReadiness: () => [] }));
vi.mock('@/lib/course-generation/resource-audit-server', () => ({ auditCourseGeneratedResources: mocks.audit }));
import { assertCourseTeacherReview, confirmCourseTeacherReview, saveCourseRenderPage } from './review-service';
import { computeCourseQualitySignature } from './signature';

afterEach(() => vi.unstubAllEnvs());

let course: Course;
let classroom: PersistedClassroomData;
beforeEach(() => {
  mocks.audit.mockResolvedValue({ issues: [] });
  vi.stubEnv('JWT_SECRET', 'test-course-review-secret-more-than-thirty-two-characters');
  classroom = { id: 'classroom', revision: 1, stage: { id: 'stage' }, scenes: [], createdAt: '2026-09-12' } as unknown as PersistedClassroomData;
  course = { id: 'course', name: '课程', grade: '本科一年级', hours: 2.25, aiLearningClassroomId: 'classroom', content: { qualityReviewRequired: true, knowledgePoints: [], _openmaicSceneOutlines: [] } } as unknown as Course;
  const signature = computeCourseQualitySignature(course, classroom);
  course.content.qualityReview = { schemaVersion: 1, signature, courseId: 'course', classroomId: 'classroom', classroomRevision: 1, status: 'completed', issues: [] };
  mocks.get.mockImplementation(async () => course);
  mocks.read.mockImplementation(async () => classroom);
  mocks.save.mockImplementation(async (_id: string, updater: (current: Course) => Course) => { course = updater(course); return course; });
});
describe('teacher confirmation of an exact teaching draft', () => {
  it('requires review for new courses and retains old-course compatibility', async () => {
    await expect(assertCourseTeacherReview(course, 'teacher')).rejects.toThrow('教师终审');
    await expect(assertCourseTeacherReview({ ...course, content: { ...course.content, qualityReviewRequired: false } })).resolves.toBeUndefined();
  });
  it('rejects teacher confirmation and publication for a bounded test lesson', async () => {
    course.content.classroomGenerationRun = {
      scope: 'test-lesson', status: 'completed', generatedOutlineIds: [], fullOutlineCount: 8,
    };
    const signature = computeCourseQualitySignature(course, classroom);
    await expect(confirmCourseTeacherReview('course', 'teacher', signature, [], false, true)).rejects.toThrow('单节测试样本');
    await expect(assertCourseTeacherReview(course, 'teacher')).rejects.toThrow('单节测试样本');
    expect(course.status).not.toBe('ready');
  });
  it('accepts a server confirmation but rejects changed content, changed classroom and forged stamps', async () => {
    const signature = computeCourseQualitySignature(course, classroom);
    await confirmCourseTeacherReview('course', 'teacher', signature, []);
    await expect(assertCourseTeacherReview(course, 'teacher')).resolves.toBeUndefined();
    await expect(assertCourseTeacherReview({ ...course, grade: '小学' }, 'teacher')).rejects.toThrow('内容已变更');
    classroom = { ...classroom, revision: 2 };
    await expect(assertCourseTeacherReview(course, 'teacher')).rejects.toThrow('内容已变更');
    classroom = { ...classroom, revision: 1 };
    course.content.teacherReview!.teacherId = 'another-teacher';
    await expect(assertCourseTeacherReview(course, 'another-teacher')).rejects.toThrow('教师终审');
  });
  it('does not invalidate a teaching confirmation when students download resources', async () => {
    course.resources = [{ id: 'launch', title: '启动课件', type: 'PPTX', size: '1MB', downloadedBy: [] }];
    const signature = computeCourseQualitySignature(course, classroom);
    course.content.qualityReview!.signature = signature;
    await confirmCourseTeacherReview('course', 'teacher', signature, []);
    course.resources[0].downloadedBy = ['student-1'];
    await expect(assertCourseTeacherReview(course, 'teacher')).resolves.toBeUndefined();
  });
  it('records explicit teacher review when automated content checking failed', async () => {
    course.content.qualityReview!.status = 'failed';
    const review = await confirmCourseTeacherReview('course', 'teacher', computeCourseQualitySignature(course, classroom), [], true);
    expect(review.manualContentReview).toBe(true);
    await expect(assertCourseTeacherReview(course, 'teacher')).resolves.toBeUndefined();
  });
  it('retains actual required-content errors independently of optional reports', async () => {
    course.content.knowledgePoints = [{ id: 'required', name: '必需知识' }] as Course['content']['knowledgePoints'];
    await expect(confirmCourseTeacherReview('course', 'teacher', computeCourseQualitySignature(course, classroom), [])).rejects.toThrow('必需知识缺少讲授页面');
  });
  it.each([undefined, 'pending', 'running', 'failed', 'completed'] as const)('allows teacher publication with optional report status %s and no layout report', async (status) => {
    if (status) {
      course.content.qualityReview!.status = status;
      course.content.qualityReview!.issues = [{ id: 'suggestion', origin: 'semantic', severity: 'suggestion', title: '核对概念', evidence: '定义', suggestion: '核对' }];
    } else course.content.qualityReview = undefined;
    classroom.scenes = [{ id: 'slide', type: 'slide', content: { type: 'slide', canvas: { elements: [] } } }] as unknown as PersistedClassroomData['scenes'];
    const signature = computeCourseQualitySignature(course, classroom);
    if (course.content.qualityReview) course.content.qualityReview.signature = signature;
    await expect(confirmCourseTeacherReview('course', 'teacher', signature, [], false, true)).resolves.toBeTruthy();
    expect(course.status).toBe('ready');
    expect(mocks.audit).toHaveBeenCalledWith('course');
    await expect(assertCourseTeacherReview(course, 'teacher')).resolves.toBeUndefined();
  });
  it('retains resource-integrity and asset-generation gates', async () => {
    const signature = computeCourseQualitySignature(course, classroom);
    mocks.audit.mockResolvedValue({ issues: [{ id: 'missing-audio' }] });
    await expect(confirmCourseTeacherReview('course', 'teacher', signature, [], false, true)).rejects.toThrow('资源尚未就绪');
    classroom.assetGeneration = { status: 'running' } as PersistedClassroomData['assetGeneration'];
    await expect(confirmCourseTeacherReview('course', 'teacher', computeCourseQualitySignature(course, classroom), [])).rejects.toThrow('仍在生成');
  });
  it('optional browser checks preserve an existing teacher confirmation', async () => {
    classroom.scenes = [{ id: 'slide', type: 'slide', content: { type: 'slide', canvas: { elements: [] } } }] as unknown as PersistedClassroomData['scenes'];
    const signature = computeCourseQualitySignature(course, classroom);
    const review = await confirmCourseTeacherReview('course', 'teacher', signature, []);
    await saveCourseRenderPage('course', signature, { sceneId: 'slide', status: 'completed', checkedAt: '', issues: [] });
    expect(course.content.teacherReview).toEqual(review);
    await expect(assertCourseTeacherReview(course, 'teacher')).resolves.toBeUndefined();
  });
  it('rejects stale or foreign-page browser reports', async () => {
    await expect(saveCourseRenderPage('course', 'outdated', { sceneId: 'foreign', status: 'completed', checkedAt: '', issues: [] })).rejects.toThrow('最新版本');
    await expect(saveCourseRenderPage('course', computeCourseQualitySignature(course, classroom), { sceneId: 'foreign', status: 'completed', checkedAt: '', issues: [] })).rejects.toThrow('不属于');
  });
});
