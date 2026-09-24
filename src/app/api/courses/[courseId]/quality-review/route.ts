import { z } from 'zod';
import { authorizeTemplateRequest } from '@/lib/platform/template-access';
import { enqueueCourseQualityReview } from '@/lib/course-quality-review/job-runner';
import { confirmCourseTeacherReview, CourseReviewError, freshQualityReport, freshRenderReview, loadCourseReviewContext, requiresCourseTeacherReview, saveCourseRenderPage, startCourseRenderReview } from '@/lib/course-quality-review/review-service';
import { collectCourseStructureIssues } from '@/lib/course-quality-review/semantic-review';
import { unresolvedHardIssues } from '@/lib/course-quality-review/teacher-review';
import type { CourseQualityIssue } from '@/lib/course-quality-review/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const renderIssue = z.object({
  id: z.string().min(1).max(300), sceneId: z.string().min(1).max(200), elementId: z.string().max(200).optional(),
  title: z.string().min(1).max(300), evidence: z.string().max(3000), suggestion: z.string().max(3000),
});
const mutation = z.discriminatedUnion('action', [
  z.object({ action: z.literal('check') }),
  z.object({ action: z.literal('retry') }),
  z.object({ action: z.literal('render-start'), signature: z.string().regex(/^[a-f0-9]{64}$/), mode: z.enum(['all', 'retry']) }),
  z.object({ action: z.literal('render-page'), signature: z.string().regex(/^[a-f0-9]{64}$/), runId: z.string().uuid(), page: z.object({
    sceneId: z.string().min(1).max(200), status: z.enum(['completed', 'failed']), issues: z.array(renderIssue).max(300),
  }) }),
  z.object({ action: z.literal('confirm'), signature: z.string().regex(/^[a-f0-9]{64}$/), acceptedIssueIds: z.array(z.string().max(300)).max(10000), acknowledgeFailedCheck: z.boolean().optional(), publish: z.boolean().optional() }),
]);

function errorResponse(error: unknown): Response {
  if (error instanceof CourseReviewError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
  console.error('[course-review] Request failed', error instanceof Error ? error.message : 'Unknown error');
  return Response.json({ error: '课程检查暂时不可用，请稍后重试。' }, { status: 500 });
}

export async function GET(request: Request, context: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await context.params;
  const teacher = await authorizeTemplateRequest(request, courseId);
  if (teacher instanceof Response) return teacher;
  try {
    const { course, classroom, signature } = await loadCourseReviewContext(courseId);
    const required = requiresCourseTeacherReview(course);
    const blockingIssues = unresolvedHardIssues(collectCourseStructureIssues(course, classroom.scenes, { includePresentation: false }));
    const quality = freshQualityReport(course, signature);
    const generationRun = course.content.classroomGenerationRun;
    const checkedOutlineIds = generationRun?.testLesson?.sceneOutlineIds ?? generationRun?.generatedOutlineIds ?? [];
    const reviewScope = generationRun?.scope === 'test-lesson'
      ? { kind: 'test-lesson' as const, checkedSectionId: generationRun.testLesson?.sectionId,
        checkedSectionTitle: generationRun.testLesson?.sectionTitle,
        checkedOutlineIds,
        uncheckedOutlineCount: Math.max(0, generationRun.fullOutlineCount - checkedOutlineIds.length),
        ...(course.content.teachingBlueprint?.sections?.length ? { unreviewedSectionCount: Math.max(0, course.content.teachingBlueprint.sections.length - 1) } : {}) }
      : { kind: 'full-course' as const, checkedOutlineIds: [], uncheckedOutlineCount: 0 };
    const liveBlockingIds = new Set(blockingIssues.map((issue) => issue.id));
    // A saved report can provide teaching suggestions, but current server rules
    // alone decide what blocks publication. Do not let an old saved issue win
    // over a current issue with the same identifier in the client.
    const asAdvisory = (issue: CourseQualityIssue): CourseQualityIssue =>
      issue.blocking ? { ...issue, blocking: false, severity: 'suggestion' } : issue;
    const advisoryQuality = quality ? { ...quality, issues: quality.issues
      .filter((issue) => !liveBlockingIds.has(issue.id))
      .map(asAdvisory), sections: quality.sections?.map((section) => ({ ...section, issues: section.issues.map(asAdvisory) })) } : null;
    const render = freshRenderReview(course, signature);
    const advisoryRender = render ? { ...render, pages: render.pages.map((page) => ({ ...page,
      issues: page.issues.map((issue) => ({ ...issue, blocking: false, severity: 'suggestion' as const })) })) } : null;
    return Response.json({ required, signature, reviewScope, quality: advisoryQuality,
      blockingIssues,
      renderReview: advisoryRender,
      teacherReview: course.content.teacherReview?.signature === signature ? course.content.teacherReview : null,
      teacherReviewItems: course.content.teacherReviewItems ?? [],
      teacherReviewSummary: course.content.teacherReviewSummary ?? null,
      teacherReviewVersion: course.content.teacherReviewVersion ?? null,
      classroom });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request, context: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await context.params;
  const teacher = await authorizeTemplateRequest(request, courseId);
  if (teacher instanceof Response) return teacher;
  const raw = await request.text();
  if (raw.length > 1_000_000) return Response.json({ error: '检查结果过大。' }, { status: 413 });
  let parsed;
  try { parsed = mutation.safeParse(JSON.parse(raw)); } catch { return Response.json({ error: '请求不是有效 JSON。' }, { status: 400 }); }
  if (!parsed.success) return Response.json({ error: '检查请求格式无效。' }, { status: 400 });
  try {
    const body = parsed.data;
    if (body.action === 'check' || body.action === 'retry') {
      const quality = await enqueueCourseQualityReview(courseId, { mode: body.action });
      return Response.json({ success: true, quality });
    }
    if (body.action === 'render-start') {
      const renderReview = await startCourseRenderReview(courseId, body.signature, body.mode === 'all' ? 'check' : 'retry');
      return Response.json({ success: true, renderReview });
    }
    if (body.action === 'render-page') {
      if (body.page.issues.some((issue) => issue.sceneId !== body.page.sceneId)) return Response.json({ error: '检查问题与页面不一致。' }, { status: 400 });
      await saveCourseRenderPage(courseId, body.signature, body.runId, { ...body.page, checkedAt: new Date().toISOString(),
        issues: body.page.issues.map((issue) => ({ ...issue, origin: 'render', severity: 'suggestion', blocking: false, status: 'open' })) });
      return Response.json({ success: true });
    }
    const teacherReview = await confirmCourseTeacherReview(courseId, teacher, body.signature, body.acceptedIssueIds, body.acknowledgeFailedCheck, body.publish);
    return Response.json({ success: true, teacherReview });
  } catch (error) { return errorResponse(error); }
}
