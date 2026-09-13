import { z } from 'zod';
import { authorizeTemplateRequest } from '@/lib/platform/template-access';
import { enqueueCourseQualityReview } from '@/lib/course-quality-review/job-runner';
import { confirmCourseTeacherReview, CourseReviewError, freshQualityReport, loadCourseReviewContext, requiresCourseTeacherReview, saveCourseRenderPage } from '@/lib/course-quality-review/review-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const renderIssue = z.object({
  id: z.string().min(1).max(300), sceneId: z.string().min(1).max(200), elementId: z.string().max(200).optional(),
  title: z.string().min(1).max(300), evidence: z.string().max(3000), suggestion: z.string().max(3000),
});
const mutation = z.discriminatedUnion('action', [
  z.object({ action: z.literal('retry') }),
  z.object({ action: z.literal('render-page'), signature: z.string().regex(/^[a-f0-9]{64}$/), page: z.object({
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
    const initial = await loadCourseReviewContext(courseId);
    const required = requiresCourseTeacherReview(initial.course);
    if (required && !freshQualityReport(initial.course, initial.signature)) await enqueueCourseQualityReview(courseId);
    const { course, classroom, signature } = await loadCourseReviewContext(courseId);
    return Response.json({ required, signature, quality: freshQualityReport(course, signature) ?? null,
      renderReview: course.content.renderReview?.signature === signature ? course.content.renderReview : null,
      teacherReview: course.content.teacherReview?.signature === signature ? course.content.teacherReview : null,
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
    if (body.action === 'retry') {
      await enqueueCourseQualityReview(courseId, { force: true });
      return Response.json({ success: true });
    }
    if (body.action === 'render-page') {
      if (body.page.issues.some((issue) => issue.sceneId !== body.page.sceneId)) return Response.json({ error: '检查问题与页面不一致。' }, { status: 400 });
      await saveCourseRenderPage(courseId, body.signature, { ...body.page, checkedAt: new Date().toISOString(),
        issues: body.page.issues.map((issue) => ({ ...issue, origin: 'render', severity: 'suggestion', status: 'open' })) });
      return Response.json({ success: true });
    }
    const teacherReview = await confirmCourseTeacherReview(courseId, teacher, body.signature, body.acceptedIssueIds, body.acknowledgeFailedCheck, body.publish);
    return Response.json({ success: true, teacherReview });
  } catch (error) { return errorResponse(error); }
}
