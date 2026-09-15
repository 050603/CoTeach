import { test, expect } from '@playwright/test';
import { SignJWT } from 'jose';
import { readFileSync } from 'node:fs';
import { createPblTemplateCourse } from '../src/lib/platform/pbl-template';
import { buildNewSystemTimingPlan } from '../src/lib/classroom/new-system-course';

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || 'http://localhost:3000';
test.use({ baseURL });
for (const manualCheck of [false, true]) test(`teacher publishes ${manualCheck ? 'after a manual page check' : 'without auxiliary reports'}`, async ({ page }, info) => {
  test.setTimeout(150_000);
  const courseId = 'e2e-quality-review', classroomId = 'e2e-quality-classroom', signature = 'a'.repeat(64);
  const course = createPblTemplateCourse(courseId, { name: '课程终审验收', subject: '教育学', grade: '本科一年级', hours: 1.5, drivingQuestion: '怎样用证据解释学习？' });
  course.content.qualityReviewRequired = true;
  course.aiLearningClassroomId = classroomId;
  course.content.moduleTimingPlan = buildNewSystemTimingPlan(27);
  course.content.knowledgePoints = [{ id: 'knowledge', name: '学习证据', description: '依据可观察结果解释学习', level: 'core' }];
  course.content._openmaicSceneOutlines = [{ id: 'outline', title: '学习证据', type: 'slide', stageKey: 'ai-learning', audience: 'student', targetDurationSec: 1620, knowledgePointIds: ['knowledge'] }];
  const scene = { id: 'slide', outlineId: 'outline', type: 'slide', title: '学习证据', order: 0, actions: [], content: { type: 'slide', canvas: { id: 'canvas', viewportSize: 1000, viewportRatio: 0.5625, theme: { fontName: 'Noto Sans SC', fontColor: '#163B3C', themeColor: '#163B3C', backgroundColor: '#ffffff' }, background: { type: 'solid', color: '#ffffff' }, elements: [
    { id: 'title', type: 'text', left: 80, top: 40, width: 840, height: 55, rotate: 0, content: '<p style="font-size:32px">学习证据</p>', defaultFontName: 'Noto Sans SC', defaultColor: '#163B3C' },
    { id: 'body', type: 'text', left: 100, top: 150, width: 800, height: 350, rotate: 0, content: '<p style="font-size:28px">用学生实际表现支持你的教学判断。</p>', defaultFontName: 'Noto Sans SC', defaultColor: '#163B3C' },
  ] } } };
  const classroom = { id: classroomId, revision: 1, stage: { id: 'stage', name: '学习证据' }, scenes: [scene], createdAt: new Date().toISOString() };
  const quality = null;
  let renderReview: unknown = null;
  const writes: Array<Record<string, unknown>> = [], errors: string[] = [], unexpected: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, 'utf8').trim() : process.env.JWT_SECRET;
  if (secret) {
    const token = await new SignJWT({ role: 'teacher', sv: 1, username: 'e2e-quality', displayName: '终审验收' }).setProtectedHeader({ alg: 'HS256' }).setSubject('e2e-teacher').setIssuer('openpbl').setAudience('openpbl-app').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
    await page.context().addCookies([{ name: 'openpbl_teacher', value: token, domain: new URL(baseURL).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
  }
  await page.routeWebSocket((url) => !url.pathname.includes('_next'), (socket) => socket.onMessage(() => undefined));
  await page.route('**/api/**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = (value: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/auth/me') return json({ user: { id: 'e2e-teacher', role: 'teacher', name: '终审验收', displayName: '终审验收' } });
    if (path === '/api/courses') return json({ courses: [course], user: { role: 'teacher', name: '终审验收' }, hydrated: true, updatedAt: course.updatedAt });
    if (path.endsWith('/state')) return json({ course, eventCursor: '0' });
    if (path.endsWith('/events')) return json({ events: [], nextCursor: '0', hasMore: false, courseVersion: 1 });
    if (path.endsWith('/presence')) return json({ members: [], degraded: false });
    if (path.endsWith('/resource-repair')) return json({ issues: [] });
    if (path.endsWith('/quality-review')) {
      if (request.method() === 'POST') {
        const body = request.postDataJSON(); writes.push(body);
        if (body.action === 'render-page') renderReview = { schemaVersion: 1, signature, classroomId, status: 'completed', pages: [body.page], updatedAt: new Date().toISOString() };
        return json({ ok: true });
      }
      return json({ required: true, signature, classroom, quality, renderReview, teacherReview: null });
    }
    if (path.includes(classroomId) || path === '/api/openmaic/classroom') return json(classroom);
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.goto(`/teacher/prepare/${courseId}/preview`, { waitUntil: 'domcontentloaded' });
  const review = page.getByRole('region', { name: '课程质量与教师终审' });
  await expect(review).toBeVisible({ timeout: 60_000 });
  await expect(review.getByText('内容检查：未检查')).toBeVisible();
  await expect(review.getByText('页面呈现：未检查')).toBeVisible();
  await expect(page.getByRole('button', { name: '确认并发布', exact: true })).toBeEnabled();
  expect(writes).toHaveLength(0);
  if (manualCheck) {
    await review.getByRole('button', { name: '检查页面', exact: true }).click();
    await expect(review.getByText('页面呈现：1 / 1 页，已检查')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => writes.filter((write) => write.action === 'render-page').length).toBe(1);
    const result = writes.find((write) => write.action === 'render-page') as { page: { issues: Array<{ id: string }> } };
    expect(result.page.issues.some((issue) => issue.id.includes('top-heavy'))).toBe(true);
    await page.reload();
    await expect(review.getByText('页面呈现：1 / 1 页，已检查')).toBeVisible({ timeout: 30_000 });
    expect(writes.filter((write) => write.action === 'render-page')).toHaveLength(1);
    await expect(page.getByRole('button', { name: '确认并发布', exact: true })).toBeEnabled();
  }
  await page.screenshot({ path: info.outputPath('teacher-quality-review.png'), fullPage: true });
  await page.getByRole('button', { name: '确认并发布', exact: true }).click();
  await expect.poll(() => writes.some((write) => write.action === 'confirm' && write.signature === signature && write.publish === true)).toBe(true);
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
});
