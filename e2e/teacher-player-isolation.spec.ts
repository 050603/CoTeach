import { expect, test, type Locator, type Page } from '@playwright/test';
import { SignJWT } from 'jose';
import { readFileSync } from 'node:fs';
import { DEFAULT_STAGES, type Course } from '../src/lib/session/types';

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || 'http://localhost:3000';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname)) {
  throw new Error('Player isolation fixtures require a local acceptance service');
}
test.use({ baseURL, serviceWorkers: 'block', reducedMotion: 'reduce' });
const courseId = 'teacher-player-isolation-course';
const classroomId = 'teacher-player-isolation-classroom';
const at = '2026-10-13T00:00:00.000Z';
const titles = ['观察与记录', '比较与分析', '验证与改进'];

async function fixture(page: Page) {
  const secret = readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE || 'deploy/secrets/jwt_secret.txt', 'utf8').trim();
  const token = await new SignJWT({ role: 'teacher', sv: 1, username: 'isolation-teacher', displayName: '播放器验收教师' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject('isolation-teacher').setIssuer('openpbl')
    .setAudience('openpbl-app').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: 'openpbl_teacher', value: token, url: baseURL }]);
  const scenes = titles.map((title, index) => ({
    id: `native-scene-${index + 1}`, outlineId: `outline-${index + 1}`, stageId: classroomId,
    title, type: 'slide', order: index, actions: [],
    content: { type: 'slide', canvas: {
      id: `canvas-${index + 1}`, viewportSize: 1000, viewportRatio: 0.5625,
      theme: { backgroundColor: '#ffffff', themeColors: ['#344A6A'], fontColor: '#1F2933', fontName: 'Noto Sans SC' },
      background: { type: 'solid', color: '#ffffff' }, elements: [{
        id: `text-${index + 1}`, type: 'text', left: 48, top: 80, width: 880, height: 220, rotate: 0,
        defaultFontName: 'Noto Sans SC', defaultColor: '#1F2933',
        content: `<p style="font-size:36px">原生第 ${index + 1} 页：${title}</p>`,
      }],
    } },
  }));
  const outlines = scenes.map((scene, index) => ({ id: scene.outlineId, title: scene.title, type: 'slide',
    order: index, stageKey: 'ai-learning', audience: 'student', description: scene.title, keyPoints: [], estimatedDuration: 60 }));
  let course = {
    id: courseId, version: 1, name: '三页原生课堂播放器隔离验收', status: 'teaching',
    subject: '科学', grade: '七年级', hours: 1, summary: '', drivingQuestion: '如何使用证据验证方案？',
    stages: DEFAULT_STAGES.map(stage => ({ ...stage })), currentStageIndex: 1,
    aiLearningClassroomId: classroomId, students: [], resources: [], groups: [], activityLog: [],
    content: { pblOutline: '', knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: '' },
      _openmaicSceneOutlines: outlines, sceneOutlines: outlines },
    uiState: { classroomTiming: {
      schemaVersion: 1, status: 'paused', sessionStartedAt: at, pausedAt: at, activeStageKey: 'ai-learning', updatedAt: at,
      stages: DEFAULT_STAGES.map((stage, index) => ({ stageKey: stage.key, label: stage.label,
        basePlannedSec: 600, adjustmentSec: 0, elapsedSec: 0, status: index === 1 ? 'active' : 'pending' })),
    } }, createdAt: at, updatedAt: at,
  } as Course;
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const unexpected: string[] = [];
  const writes: string[] = [];
  let frameHeaders: Record<string, string> | undefined;
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/internal/resource-player') frameHeaders = response.headers();
  });
  await page.context().routeWebSocket(/.*/, socket => socket.onMessage(message => {
    const body = JSON.parse(String(message));
    if (body.type === 'subscribe') socket.send(JSON.stringify({ type: 'subscribed', courseId }));
  }));
  await page.context().route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin !== new URL(baseURL).origin) { unexpected.push(request.url()); return route.abort(); }
    // The iframe document keeps the actual production CSP and framing headers.
    if (!path.startsWith('/api/') && ['GET', 'HEAD'].includes(method)) return route.continue();
    if (path.startsWith('/api/openmaic/interactive-runtime/') && method === 'GET') return route.continue();
    if (!['GET', 'HEAD'].includes(method)) writes.push(`${method} ${path}`);
    if (path === '/api/auth/me') return json({ user: { id: 'isolation-teacher', role: 'teacher', name: '播放器验收教师', displayName: '播放器验收教师' } });
    if (path === '/api/courses') return json({ courses: [course], user: { role: 'teacher', name: '播放器验收教师' }, hydrated: true, updatedAt: at });
    if (path === `/api/courses/${courseId}/state`) return json({ course, eventCursor: '0' });
    if (path === `/api/courses/${courseId}/events`) return json({ events: [], nextCursor: '0', hasMore: false, courseVersion: course.version });
    if (path === `/api/courses/${courseId}/presence`) return json({ members: [], degraded: false });
    if (path === `/api/courses/${courseId}/projection`) return json({ courseId, courseVersion: course.version, projectionVersion: 0, projectionUpdatedAt: at, serverTime: at, resourceProjection: null, teacherResourceProjection: null });
    if (path === `/api/courses/${courseId}/public-discussion` || path === `/api/courses/${courseId}/public-discussion/settings`) return json({ enabled: false, session: null });
    if (path === `/api/courses/${courseId}/actions`) {
      const body = request.postDataJSON();
      if (body.action?.type === 'UPDATE_COURSE') course = { ...course, ...body.action.payload.patch, version: (course.version ?? 0) + 1 };
      return json({ ok: true, requestId: body.requestId, courseVersion: course.version, updatedAt: at });
    }
    if (path === '/api/openmaic/classroom') return json({ success: true, classroom: { stage: { id: classroomId, name: course.name, createdAt: 1, updatedAt: 1 }, scenes } });
    if (path === '/api/openmaic/progress') return json({ data: { progress: {} } });
    if (['/api/openmaic/provider-config', '/api/openmaic/server-providers', '/api/server-providers'].includes(path)) return json({ success: true, providers: [], models: [] });
    if (path === '/api/learning-events') return json({ success: true });
    unexpected.push(`${method} ${path}`);
    return json({ error: 'Unconfigured isolated fixture request' }, 404);
  });
  return { pageErrors, consoleErrors, unexpected, writes, frameHeaders: () => frameHeaders };
}

async function retainedMainLesson(preview: Locator) {
  await expect(preview).toHaveAttribute('data-active-scene-id', 'native-scene-2');
  await expect(preview.getByTestId('scene-item')).toHaveCount(3);
  await expect(preview.getByTestId('scene-title')).toHaveText(titles);
}

async function pressSpaceOutsidePlayer(page: Page) {
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.keyboard.press('Space');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

for (const viewport of [{ width: 1024, height: 576 }, { width: 1366, height: 768 }]) {
  test(`supplementary slide cannot replace the three-page teacher preview at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    test.setTimeout(60_000);
    await page.setViewportSize(viewport);
    const audit = await fixture(page);
    await page.goto(`/teacher/teach/${courseId}/classroom`);
    const toggle = page.getByRole('button', { name: /学生知识讲授课程预览/ });
    await toggle.click();
    const preview = page.locator('[data-stage-host-mode="teacher-preview"]');
    await expect(preview).toHaveCount(1);
    await expect(preview.getByTestId('scene-item')).toHaveCount(3);
    const openDirectory = preview.getByRole('button', { name: '打开页面目录', exact: true });
    if (await openDirectory.isVisible()) await openDirectory.click();
    await preview.getByTestId('scene-item').filter({ hasText: titles[1] }).click();
    await retainedMainLesson(preview);
    const playerIdentity = await preview.elementHandle();

    await page.getByRole('combobox', { name: '自主选择知识讲授PPT页面' }).selectOption('outline-3');
    const supplement = page.frameLocator('iframe[title="授课资源播放器"]');
    await expect(supplement.getByText('原生第 3 页：验证与改进', { exact: true })).toBeVisible();
    await expect.poll(() => audit.frameHeaders()?.['x-frame-options']).toBe('SAMEORIGIN');
    expect(audit.frameHeaders()?.['content-security-policy']).toContain("frame-ancestors 'self'");
    await retainedMainLesson(preview);
    const screenshot = info.outputPath('supplementary-native-slide.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    await info.attach('supplementary-native-slide', { path: screenshot, contentType: 'image/png' });

    await toggle.click();
    await expect(preview).toBeHidden();
    await pressSpaceOutsidePlayer(page);
    await retainedMainLesson(preview);
    await expect(preview.locator('button[aria-label="暂停讲解"]')).toHaveCount(0);
    await toggle.click();
    await expect(preview).toBeVisible();
    await retainedMainLesson(preview);

    await page.getByRole('button', { name: '全屏授课', exact: true }).filter({ visible: true }).click();
    await expect(page.getByRole('button', { name: '退出全屏', exact: true })).toBeVisible();
    await expect(preview).toBeVisible();
    await retainedMainLesson(preview);
    await page.getByRole('button', { name: '课程目录', exact: true }).filter({ visible: true }).first().click();
    await expect(preview.getByTestId('scene-list')).toBeVisible();
    await retainedMainLesson(preview);

    await page.getByRole('button', { name: '班级学情', exact: true }).click();
    await expect(preview).toBeHidden();
    await pressSpaceOutsidePlayer(page);
    await retainedMainLesson(preview);
    await expect(preview.locator('button[aria-label="暂停讲解"]')).toHaveCount(0);
    await page.getByRole('button', { name: '授课展示', exact: true }).click();
    await expect(preview).toBeVisible();
    await retainedMainLesson(preview);
    await page.getByRole('button', { name: 'AI 公开讨论', exact: true }).click();
    await expect(page.getByRole('region', { name: 'AI 公开讨论工作台', exact: true })).toBeVisible();
    await expect(preview).toBeHidden();
    await pressSpaceOutsidePlayer(page);
    await retainedMainLesson(preview);
    await expect(preview.locator('button[aria-label="暂停讲解"]')).toHaveCount(0);
    await page.getByRole('button', { name: '授课展示', exact: true }).click();
    await expect(preview).toBeVisible();
    await retainedMainLesson(preview);
    await page.getByRole('button', { name: '退出全屏', exact: true }).click();
    await expect(toggle).toBeVisible();
    await retainedMainLesson(preview);
    for (const size of [{ width: 1366, height: 768 }, { width: 768, height: 576 }, { width: 1024, height: 576 }, { width: 1920, height: 1080 }, viewport]) {
      await page.setViewportSize(size);
      await retainedMainLesson(preview);
      expect(await preview.evaluate((element, original) => element === original, playerIdentity)).toBe(true);
      for (const name of ['继续讲解', '下一页']) {
        const control = preview.getByRole('button', { name, exact: true });
        await control.scrollIntoViewIfNeeded();
        await expect(control).toBeInViewport({ ratio: 1 });
        await control.click({ trial: true });
        const bounds = await control.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size.width + 1);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(size.height + 1);
      }
      await page.screenshot({ path: info.outputPath(`teacher-preview-resize-${size.width}x${size.height}.png`) });
    }
    expect(await preview.evaluate((element, original) => element === original, playerIdentity)).toBe(true);
    await playerIdentity?.dispose();

    expect(audit.unexpected).toEqual([]);
    expect(audit.pageErrors).toEqual([]);
    expect(audit.consoleErrors).toEqual([]);
    expect(audit.writes.some(write => write.includes('/api/openmaic/progress') || write.includes('/api/learning-events'))).toBe(false);
  });
}
