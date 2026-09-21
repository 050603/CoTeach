import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Course } from '@/lib/session/types';
import { getCourse, updateCourse } from '@/lib/session/server-store';
import { isValidClassroomId, readClassroom, type PersistedClassroomData } from '@/lib/openmaic/server/classroom-storage';
import { getNewSystemCourseReadiness } from '@/lib/classroom/new-system-course';
import { auditCourseGeneratedResources } from '@/lib/course-generation/resource-audit-server';
import { computeCourseQualitySignature } from './signature';
import { collectCourseStructureIssues } from './semantic-review';
import { COURSE_QUALITY_REVIEW_POLICY_VERSION, type CourseQualityReport } from './types';
import { unresolvedHardIssues, type CourseRenderPageReview, type CourseTeacherReview } from './teacher-review';

export class CourseReviewError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) { super(message); }
}

export function requiresCourseTeacherReview(course: Pick<Course, 'content'>): boolean {
  return course.content.qualityReviewRequired === true
    || Number(course.content.resourcePackage?.schemaVersion ?? 0) >= 2
    || Number(course.content.stagePlan?.schemaVersion ?? 0) >= 2;
}

function confirmationSeal(review: Omit<CourseTeacherReview, 'seal'>): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new CourseReviewError('REVIEW_SIGNING_UNAVAILABLE', '教师确认暂时无法保存，请检查服务认证配置。', 503);
  return createHmac('sha256', secret).update(JSON.stringify(['course-teacher-review-v1', review.courseId, review.classroomId, review.signature, review.teacherId, review.confirmedAt, [...review.acceptedIssueIds].sort(), Boolean(review.manualContentReview)])).digest('hex');
}

export function isAuthenticTeacherReview(review: CourseTeacherReview): boolean {
  if (typeof review.seal !== 'string' || !/^[a-f0-9]{64}$/.test(review.seal) || !Array.isArray(review.acceptedIssueIds)) return false;
  try { return timingSafeEqual(Buffer.from(review.seal, 'hex'), Buffer.from(confirmationSeal(review), 'hex')); }
  catch { return false; }
}

export async function loadCourseReviewContext(courseId: string) {
  const course = await getCourse(courseId);
  if (!course) throw new CourseReviewError('NOT_FOUND', '课程不存在。', 404);
  const classroomId = course.aiLearningClassroomId || course.content._openmaicClassroomId;
  if (!classroomId || !isValidClassroomId(classroomId)) throw new CourseReviewError('CLASSROOM_NOT_READY', '课堂草稿尚未生成。');
  const classroom = await readClassroom(classroomId);
  if (!classroom) throw new CourseReviewError('CLASSROOM_NOT_READY', '课堂草稿不存在。');
  return { course, classroom, signature: computeCourseQualitySignature(course, classroom) };
}

export function renderableSceneIds(classroom: PersistedClassroomData): string[] {
  return classroom.scenes.filter((scene) => scene.type === 'slide' && scene.content.type === 'slide').map((scene) => scene.id);
}

export function freshQualityReport(course: Course, signature: string): CourseQualityReport | undefined {
  return course.content.qualityReview?.signature === signature
    && course.content.qualityReview.reviewPolicyVersion === COURSE_QUALITY_REVIEW_POLICY_VERSION
    ? course.content.qualityReview
    : undefined;
}

export async function saveCourseRenderPage(courseId: string, signature: string, page: CourseRenderPageReview) {
  const context = await loadCourseReviewContext(courseId);
  if (context.signature !== signature) throw new CourseReviewError('REVIEW_STALE', '课程已经修改，请按最新版本重新检查。');
  const ids = renderableSceneIds(context.classroom);
  if (!ids.includes(page.sceneId)) throw new CourseReviewError('INVALID_SCENE', '页面不属于当前课堂。', 400);
  await updateCourse(courseId, (current) => {
    if (computeCourseQualitySignature(current, context.classroom) !== signature) throw new CourseReviewError('REVIEW_STALE', '课程已经修改，请重新检查。');
    const previous = current.content.renderReview?.signature === signature ? current.content.renderReview.pages : [];
    const pages = [...previous.filter((item) => item.sceneId !== page.sceneId && ids.includes(item.sceneId)), page];
    return { ...current, content: { ...current.content,
      renderReview: { schemaVersion: 1, signature, classroomId: context.classroom.id,
        status: ids.every((id) => pages.some((item) => item.sceneId === id && item.status === 'completed')) ? 'completed' : 'running',
        pages, updatedAt: new Date().toISOString() } } };
  });
}

export async function confirmCourseTeacherReview(courseId: string, teacherId: string, signature: string, acceptedIssueIds: string[], acknowledgeFailedCheck = false, publish = false) {
  const { course, classroom, signature: actual } = await loadCourseReviewContext(courseId);
  if (actual !== signature) throw new CourseReviewError('REVIEW_STALE', '课程已经修改，请重新核对后确认。');
  if (course.content.classroomGenerationRun?.scope === 'test-lesson') {
    throw new CourseReviewError('TEST_LESSON_NOT_PUBLISHABLE', '当前是正式链路生成的单节测试样本，请生成完整课程后再终审发布。');
  }
  if (classroom.assetGeneration?.status === 'running') throw new CourseReviewError('ASSETS_RUNNING', '课堂资源仍在生成，请完成后再确认。');
  const readiness = getNewSystemCourseReadiness(course).filter((check) => check.id !== 'teacher-review' && !check.ok);
  if (readiness.length) throw new CourseReviewError('COURSE_NOT_READY', readiness.map((check) => check.message).join('\n'));
  if (publish) {
    const resources = await auditCourseGeneratedResources(courseId);
    if (resources.issues.length) throw new CourseReviewError('RESOURCES_NOT_READY', '部分教学资源尚未就绪，请在预览页补齐后发布。');
  }
  const quality = freshQualityReport(course, signature);
  // Auxiliary reports never gate a teacher's confirmation. Validate only the
  // current required teaching structure, independently of optional reports.
  const hard = unresolvedHardIssues(collectCourseStructureIssues(course, classroom.scenes, { includePresentation: false }));
  if (hard.length) throw new CourseReviewError('COURSE_HARD_ERRORS', hard.map((issue) => issue.title).join('；'));
  const render = course.content.renderReview?.signature === signature ? course.content.renderReview : undefined;
  const issues = [...(quality?.issues ?? []), ...(render?.pages.flatMap((page) => page.issues) ?? [])];
  const accepted = new Set(acceptedIssueIds);
  const unsigned: Omit<CourseTeacherReview, 'seal'> = { schemaVersion: 1, courseId, classroomId: classroom.id,
    signature, teacherId, manualContentReview: quality?.status !== 'completed' || acknowledgeFailedCheck, confirmedAt: new Date().toISOString(), acceptedIssueIds: [...accepted].filter((id) => issues.some((issue) => issue.id === id)).sort() };
  const teacherReview = { ...unsigned, seal: confirmationSeal(unsigned) };
  await updateCourse(courseId, (current) => {
    if (computeCourseQualitySignature(current, classroom) !== signature) throw new CourseReviewError('REVIEW_STALE', '课程已经修改，请重新核对后确认。');
    return { ...current, ...(publish ? { status: 'ready' as const } : {}), content: { ...current.content, teacherReview } };
  });
  return teacherReview;
}

/** Used by publication AND new session creation; old courses do not acquire a new gate. */
export async function assertCourseTeacherReview(course: Course, teacherId?: string): Promise<void> {
  if (!requiresCourseTeacherReview(course)) return;
  if (course.content.classroomGenerationRun?.scope === 'test-lesson') {
    throw new CourseReviewError('TEST_LESSON_NOT_PUBLISHABLE', '单节测试样本不能用于正式授课，请先生成完整课程。');
  }
  const review = course.content.teacherReview;
  if (!review || !isAuthenticTeacherReview(review) || (teacherId && review.teacherId !== teacherId)) throw new CourseReviewError('TEACHER_REVIEW_REQUIRED', '请先在预览发布页面完成教师终审。');
  const classroomId = course.aiLearningClassroomId || course.content._openmaicClassroomId;
  if (!classroomId || classroomId !== review.classroomId || !isValidClassroomId(classroomId)) throw new CourseReviewError('REVIEW_STALE', '课堂资源已变更，请重新进行教师终审。');
  const classroom = await readClassroom(classroomId);
  // A copied template may retain a valid review of exactly the same teaching
  // content. Its stamp keeps the original authoring course id in the hash.
  if (!classroom || computeCourseQualitySignature({ ...course, id: review.courseId }, classroom) !== review.signature) throw new CourseReviewError('REVIEW_STALE', '课程内容已变更，请重新进行教师终审。');
  const hard = unresolvedHardIssues(collectCourseStructureIssues(course, classroom.scenes, { includePresentation: false }));
  if (hard.length) throw new CourseReviewError('COURSE_HARD_ERRORS', hard.map((issue) => issue.title).join('；'));
}
