import { expect, test } from '@playwright/test';
import { SignJWT } from 'jose';
import { readFileSync } from 'node:fs';
import { DEFAULT_STAGES, type Course } from '../src/lib/session/types';

test.use({ serviceWorkers: 'block' });

test('student can switch to text after microphone permission is denied', async ({ page }) => {
  const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || 'http://localhost:3000';
  const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE
    ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, 'utf8').trim()
    : process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error('Set a test JWT secret for this isolated browser fixture');
  const courseId = 'prelaunch-microphone-permission-course';
  const studentId = 'prelaunch-microphone-permission-student';
  const now = '2026-09-25T00:00:00.000Z';
  const course: Course = {
    id: courseId, version: 1, name: '麦克风权限验收课堂', subject: '科学', grade: '七年级', hours: 1,
    summary: '', drivingQuestion: '如何记录观察证据？', status: 'teaching',
    stages: DEFAULT_STAGES.map(stage => ({ ...stage })), currentStageIndex: 0,
    students: [{ id: studentId, name: '测试学生', joinedAt: now, stageProgress: {} }],
    resources: [], groups: [], content: { pblOutline: '', knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: '' } },
    createdAt: now, updatedAt: now,
  } as Course;
  const token = await new SignJWT({ role: 'student', sv: 1, userId: studentId, studentName: '测试学生' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(studentId).setIssuer('openpbl')
    .setAudience('openpbl-app').setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{
    name: 'openpbl_student', value: token, domain: new URL(baseURL).hostname,
    path: '/', httpOnly: true, sameSite: 'Lax',
  }]);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => Promise.reject(new DOMException('麦克风权限已拒绝', 'NotAllowedError')) },
    });
  });
  const pageErrors: string[] = [];
  const submitted: string[] = [];
  const unexpected: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.routeWebSocket(/.*/, socket => socket.onMessage(message => {
    const payload = JSON.parse(String(message)) as { type?: string; courseId?: string };
    if (payload.type === 'subscribe') socket.send(JSON.stringify({ type: 'subscribed', courseId: payload.courseId }));
  }));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const json = (value: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (method === 'GET' && path === '/api/auth/me') return json({ user: { id: studentId, role: 'student', name: '测试学生', displayName: '测试学生' } });
    if (method === 'GET' && path === '/api/courses') return json({ courses: [course], user: { role: 'student', name: '测试学生' }, studentId, studentName: '测试学生', joinedCourseId: courseId, hydrated: true, updatedAt: now });
    if (method === 'GET' && path === `/api/courses/${courseId}/state`) return json({ course, eventCursor: '0' });
    if (method === 'GET' && path === `/api/courses/${courseId}/events`) return json({ events: [], nextCursor: '0', hasMore: false, courseVersion: 1 });
    if (method === 'GET' && path === `/api/courses/${courseId}/projection`) return json({ courseVersion: 1, resourceProjection: null, teacherResourceProjection: null });
    if (path === `/api/courses/${courseId}/presence` && ['GET', 'PUT'].includes(method)) return json({ members: [] });
    if (path === `/api/courses/${courseId}/public-discussion`) {
      const body = method === 'POST' ? request.postDataJSON() as { action: string; content?: string } : undefined;
      if (body) submitted.push(`${body.action}:${body.content ?? ''}`);
      return json({ enabled: true, session: {
        id: 'permission-session', courseId, knowledgePointId: 'observation', topic: '观察证据', mode: 'inquiry',
        openingPrompt: '说出一条观察证据。', status: body?.action === 'submit-answer' ? 'ai-ready' : body?.action === 'accept' ? 'awaiting-student' : 'inviting',
        version: body?.action === 'submit-answer' ? 3 : body?.action === 'accept' ? 2 : 1,
        roundCount: 0, currentStudent: { id: studentId, name: '测试学生' }, isCurrentStudent: true,
        turns: [], createdAt: now, updatedAt: now, shouldSuggestSummary: false,
      } });
    }
    unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture endpoint missing' }) });
  });

  await page.goto(`${baseURL}/student/classroom/${courseId}`);
  const dialog = page.getByRole('dialog', { name: '回答课堂提问' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '接受并打开麦克风' }).click();
  await expect(dialog.getByRole('alert')).toContainText('麦克风权限已拒绝');
  await expect(dialog.getByRole('button', { name: '使用文字回答' })).toBeEnabled();
  await page.screenshot({ path: 'docs/audits/2026-09-25-prelaunch/evidence/microphone-denied.png' });
  await dialog.getByRole('button', { name: '使用文字回答' }).click();
  await dialog.getByRole('textbox', { name: '文字回答' }).fill('我观察到鸟类数量增加。');
  await dialog.getByRole('button', { name: '提交回答' }).click();
  await expect(dialog.getByText('请听教师大屏上的 AI 回应。')).toBeVisible();
  await page.screenshot({ path: 'docs/audits/2026-09-25-prelaunch/evidence/microphone-text-fallback.png' });
  expect(submitted).toEqual(['accept:', 'submit-answer:我观察到鸟类数量增加。']);
  expect(pageErrors).toEqual([]);
  expect(unexpected).toEqual([]);
});
