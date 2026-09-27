import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { SignJWT } from 'jose';

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || 'http://127.0.0.1:3000';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) {
  throw new Error('Desktop fixture flows must run against a local acceptance service.');
}
test.use({ baseURL, serviceWorkers: 'block', reducedMotion: 'reduce' });

const courseId = 'desktop-flow-course';
const surveyId = 'desktop-flow-survey';
const courseName = '社区生态与证据探究课程';
const retryMessage = '模拟服务暂时繁忙，请重试';
const questions = [
  { id: 'pace', title: '课堂节奏如何？', type: 'single-choice', required: true, options: [{ id: 'good', label: '合适' }, { id: 'other', label: '其他', allowTextInput: true }] },
  { id: 'skills', title: '练习了哪些能力？', type: 'multiple-choice', required: true, maxSelections: 2, options: [{ id: 'research', label: '调研' }, { id: 'teamwork', label: '协作' }, { id: 'present', label: '表达' }] },
  { id: 'idea', title: '最有启发的内容？', type: 'short-text', required: true, options: [] },
];
const initialCourse = {
  id: courseId, name: courseName, term: '2026 秋季', status: 'open', version: 1,
  description: '通过观察与协作建立自己的解释。', outline: '先收集证据，再比较方案。',
  startsAt: '2026-09-01', endsAt: '2027-01-01', coverImageUrl: null,
  teacher: { displayName: '流程验收教师' }, invitation: { code: 'A7B9C2' },
  chapters: [{ id: 'chapter-1', title: '观察与反思', isOpen: true, activities: [
    { id: surveyId, title: '课堂反馈问卷', type: 'Form', isOpen: true, progress: { status: 'not_started' }, config: { questions } },
  ] }],
};

type Audit = { unexpected: string[]; pageErrors: string[]; writes: Array<{ path: string; method: string; body: Record<string, unknown> }> };
const audits = new WeakMap<Page, Audit>();

async function installApp(page: Page, role: 'student' | 'teacher', authenticated = true) {
  const secret = readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE || process.env.LAYOUT_JWT_SECRET_FILE || 'deploy/secrets/jwt_secret.txt', 'utf8').trim();
  const subject = `desktop-flow-${role}`;
  const token = await new SignJWT({ role, sv: 1, username: subject, displayName: '流程验收', userId: subject, studentName: '流程验收' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(subject).setIssuer('openpbl').setAudience('openpbl-app')
    .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  const signIn = () => page.context().addCookies([{ name: `openpbl_${role}`, value: token, url: baseURL }]);
  if (authenticated) await signIn();
  const course = structuredClone(initialCourse);
  let submittedAnswers: Record<string, unknown> = {};
  let submitted = false;
  const audit: Audit = { unexpected: [], pageErrors: [], writes: [] };
  audits.set(page, audit);
  page.on('pageerror', (error) => audit.pageErrors.push(error.message));
  await page.routeWebSocket('**/*', (socket) => socket.close());
  const failNext = new Set<string>();
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();
    const json = (payload: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.origin !== new URL(baseURL).origin) {
      audit.unexpected.push(`External request: ${request.url()}`);
      return route.abort('blockedbyclient');
    }
    if (!pathname.startsWith('/api/')) {
      if (['GET', 'HEAD'].includes(method)) return route.continue();
      audit.unexpected.push(`${method} ${pathname}`);
      return json({ message: 'Non-API writes are blocked by the fixture' }, 405);
    }
    // Every API call is fulfilled locally. No route fallback can reach business data.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const body = request.postDataJSON() ?? {};
      audit.writes.push({ path: pathname, method, body });
      if (failNext.delete(pathname)) return json({ message: retryMessage }, 503);
      if (method === 'POST' && ['/api/platform/auth/login', '/api/platform/auth/teacher-login'].includes(pathname)) {
        await signIn();
        return json({ ok: true, enrollments: [{ offeringId: courseId }] });
      }
      if (method === 'POST' && pathname === `/api/platform/activities/${surveyId}/submit`) {
        submittedAnswers = body.answers;
        submitted = true;
        course.chapters[0].activities[0].progress.status = 'completed';
        return json({ progress: { status: 'completed', progressData: { answer: body.answer, answers: submittedAnswers } } });
      }
      if (method === 'PATCH' && pathname === `/api/platform/offerings/${courseId}`) {
        Object.assign(course, body, { version: course.version + 1 });
        return json({ offering: course });
      }
      audit.unexpected.push(`${method} ${pathname}`);
      return json({ message: 'Unconfigured fixture mutation' }, 405);
    }
    const fixtures: Record<string, unknown> = {
      '/api/auth/me': { user: { id: subject, role, username: subject, displayName: '流程验收' } },
      '/api/platform/auth/teacher-register': { available: false, mode: 'authenticated' },
      '/api/platform/auth/student-profile': { user: { id: subject, role, username: subject, displayName: '流程验收' } },
      '/api/platform/courses': { courses: [course], viewer: { id: subject, displayName: '流程验收' } },
      '/api/platform/offerings': { offerings: [course] },
      '/api/platform/templates': { templates: [] },
      [`/api/platform/activities/${surveyId}`]: { activity: {
        id: surveyId, title: '课堂反馈问卷', type: 'Form', isOpen: true, description: null,
        offering: { id: courseId, name: course.name, status: course.status }, chapter: { title: '观察与反思' },
        config: { content: '请根据真实体验作答。', questions }, instance: null,
        progress: { status: submitted ? 'completed' : 'not_started', progressData: { answers: submittedAnswers } },
      } },
    };
    if (pathname in fixtures) return json(fixtures[pathname]);
    audit.unexpected.push(`${method} ${pathname}`);
    return json({ message: 'Unconfigured fixture read' }, 404);
  });
  return { audit, course, failNext };
}

async function assertUsablePage(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(2);
  // Flow actions use ordinary clicks/fills, so covered buttons must be hit-testable,
  // including those revealed by scrolling at the smaller effective CSS viewports.
  await expect(page.locator('body')).not.toContainText('Application error');
}

test.afterEach(async ({ page, browser }, info) => {
  if (!page.isClosed()) {
    const runtime = await page.evaluate(() => ({
      userAgent: navigator.userAgent, innerWidth, innerHeight, devicePixelRatio,
      visualViewportScale: visualViewport?.scale,
    }));
    const browserVersion = browser.version();
    await info.attach('browser-runtime', { body: JSON.stringify({ browserVersion, ...runtime }, null, 2), contentType: 'application/json' });
    if (process.env.PRELAUNCH_E2E_EXECUTABLE_PATH) {
      const brand = process.env.PRELAUNCH_E2E_BROWSER_LABEL;
      if (brand === 'microsoft-edge') expect(runtime.userAgent).toContain(`Edg/${browserVersion.split('.')[0]}.`);
      if (brand === 'google-chrome') expect(runtime.userAgent).toMatch(new RegExp(`(?:Headless)?Chrome/${browserVersion.split('.')[0]}\\.`));
    }
  }
  const audit = audits.get(page);
  if (audit) {
    await info.attach('intercepted-api-writes', { body: JSON.stringify(audit.writes, null, 2), contentType: 'application/json' });
    expect(audit.unexpected, 'All requests must use an explicit local fixture or static page asset').toEqual([]);
    expect(audit.pageErrors, 'No uncaught component errors').toEqual([]);
  }
  if (!page.isClosed()) await info.attach('final-flow-state', { body: await page.screenshot({ fullPage: false }), contentType: 'image/png' });
});

for (const profile of [
  { name: 'desktop-100pct', width: 1366, height: 768 },
  { name: 'desktop-150pct-equivalent', width: 911, height: 512 },
  { name: 'desktop-125pct-equivalent', width: 1093, height: 614 },
]) {
  test.describe(profile.name, () => {
    // Reduced CSS viewport models reflow at browser zoom; this is not native OS zoom.
    test.use({ viewport: { width: profile.width, height: profile.height } });

    for (const role of ['student', 'teacher'] as const) {
      test(`${role} login validates required fields, recovers from failure and navigates`, async ({ page }) => {
        const app = await installApp(page, role, false);
        const endpoint = role === 'student' ? '/api/platform/auth/login' : '/api/platform/auth/teacher-login';
        const target = `/${role}/${role === 'student' ? 'courses' : 'classes'}/${courseId}`;
        await page.goto(`/${role}/login?redirect=${encodeURIComponent(target)}`);
        const login = page.getByRole('button', { name: '登录', exact: true });
        await login.click();
        expect(await page.locator('form').evaluate((form: HTMLFormElement) => form.checkValidity())).toBe(false);
        expect(app.audit.writes).toHaveLength(0);
        await page.getByPlaceholder(role === 'student' ? '输入你的学号' : '教师账号', { exact: true }).fill('acceptance-user');
        const password = page.getByPlaceholder(role === 'student' ? '输入密码' : '密码', { exact: true });
        await password.fill('Acceptance-Only-123!');
        if (role === 'student') {
          await page.getByRole('button', { name: '显示密码' }).click();
          await expect(password).toHaveAttribute('type', 'text');
          await page.getByRole('button', { name: '隐藏密码' }).click();
          await expect(password).toHaveAttribute('type', 'password');
        }
        app.failNext.add(endpoint);
        await login.click();
        await expect(page.locator('form').getByRole('alert')).toContainText(retryMessage);
        await expect(password).toHaveValue('Acceptance-Only-123!');
        await expect(login).toBeEnabled();
        await login.click();
        await expect(page).toHaveURL(new RegExp(`${target}$`));
        await expect(page.getByRole('heading', { name: courseName, exact: true })).toBeVisible();
        expect(app.audit.writes).toEqual([0, 1].map(() => ({ path: endpoint, method: 'POST', body: { username: 'acceptance-user', password: 'Acceptance-Only-123!' } })));
        await assertUsablePage(page);
      });
    }

    test('student searches a course, switches information and enters the learning activity', async ({ page }) => {
      const app = await installApp(page, 'student');
      await page.goto('/student?all=1');
      const search = page.getByRole('textbox', { name: '搜索课程' });
      await search.fill('没有这门课程');
      await expect(page.locator('.pbl-student-course-card')).toHaveCount(0);
      await search.fill('生态');
      await expect(page.locator('.pbl-student-course-card')).toHaveCount(1);
      await page.locator('.pbl-student-course-card').click();
      await expect(page).toHaveURL(new RegExp(`/student/courses/${courseId}$`));
      await page.getByRole('button', { name: '课程介绍', exact: true }).click();
      await expect(page.getByRole('region', { name: '课程内容', exact: true }).getByText(initialCourse.description, { exact: true })).toBeVisible();
      await page.getByRole('button', { name: '课程学习', exact: true }).click();
      await expect(page.getByRole('button', { name: '课程学习', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await page.getByRole('link', { name: /开始学习/ }).click();
      await expect(page).toHaveURL(new RegExp(`/student/activities/${surveyId}$`));
      await expect(page.getByRole('radio', { name: /合适/ })).toBeAttached();
      expect(app.audit.writes).toHaveLength(0);
      await assertUsablePage(page);
    });

    test('student submits mixed survey answers, retries without data loss and updates the saved response', async ({ page }) => {
      const app = await installApp(page, 'student');
      const endpoint = `/api/platform/activities/${surveyId}/submit`;
      await page.goto(`/student/activities/${surveyId}`);
      await page.getByRole('button', { name: '提交问卷', exact: true }).click();
      expect(app.audit.writes).toHaveLength(0);
      // Click the visible labels, not the visually hidden native radio/checkbox.
      await page.locator('label.survey-paper-option').filter({ hasText: '其他' }).click();
      await page.getByRole('textbox', { name: '请补充其他的具体内容' }).fill('讨论时间希望更充足');
      await page.locator('label.survey-paper-option').filter({ hasText: '调研' }).click();
      await page.locator('label.survey-paper-option').filter({ hasText: '协作' }).click();
      await expect(page.getByRole('checkbox', { name: /表达/ })).toBeDisabled();
      const idea = page.getByRole('textbox', { name: '最有启发的内容？' });
      await idea.fill('用观察记录来支持我们的解释');
      app.failNext.add(endpoint);
      await page.getByRole('button', { name: '提交问卷', exact: true }).click();
      await expect(page.locator('form').getByRole('alert')).toContainText(retryMessage);
      await expect(idea).toHaveValue('用观察记录来支持我们的解释');
      await expect(page.getByRole('checkbox', { name: /协作/ })).toBeChecked();
      await page.getByRole('button', { name: '提交问卷', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('回答已经保存');
      const expectedAnswers = { pace: { selected: 'other', optionText: { other: '讨论时间希望更充足' } }, skills: ['research', 'teamwork'], idea: '用观察记录来支持我们的解释' };
      expect(app.audit.writes.map((entry) => entry.body)).toEqual([0, 1].map(() => ({ answer: '', answers: expectedAnswers })));
      await idea.fill('补充：还要比较不同小组的证据');
      await page.getByRole('button', { name: '更新回答', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('回答已经保存');
      expect(app.audit.writes.at(-1)?.body).toEqual({ answer: '', answers: { ...expectedAnswers, idea: '补充：还要比较不同小组的证据' } });
      await page.reload();
      await expect(idea).toHaveValue('补充：还要比较不同小组的证据');
      await expect(page.getByRole('radio', { name: /其他/ })).toBeChecked();
      await page.getByRole('link', { name: '返回课程', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/student/courses/${courseId}$`));
      await assertUsablePage(page);
    });

    test('teacher edits course settings, sees save failure, retries and can discard later edits', async ({ page }) => {
      const app = await installApp(page, 'teacher');
      const endpoint = `/api/platform/offerings/${courseId}`;
      await page.goto(`/teacher/classes/${courseId}`);
      await page.getByRole('button', { name: /课程设置/ }).click();
      const dialog = page.getByRole('dialog', { name: '课程设置', exact: true });
      const name = dialog.getByRole('textbox', { name: /课程名称/ });
      const save = dialog.getByRole('button', { name: '保存课程设置', exact: true });
      await name.fill('');
      await save.click();
      expect(app.audit.writes).toHaveLength(0);
      await name.fill('已更新的社区生态探究课程');
      await dialog.getByRole('textbox', { name: '学期', exact: true }).fill('2026 秋季第二阶段');
      app.failNext.add(endpoint);
      await save.click();
      await expect(dialog.getByRole('alert')).toContainText(retryMessage);
      await expect(name).toHaveValue('已更新的社区生态探究课程');
      await expect(save).toBeEnabled();
      await save.click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('heading', { name: '已更新的社区生态探究课程', exact: true })).toBeVisible();
      expect(app.audit.writes).toHaveLength(2);
      for (const write of app.audit.writes) {
        expect(write).toMatchObject({ path: endpoint, method: 'PATCH', body: { name: '已更新的社区生态探究课程', term: '2026 秋季第二阶段', version: 1 } });
      }
      await page.getByRole('button', { name: /课程设置/ }).click();
      await name.fill('不应保存的草稿');
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      await expect(dialog).toBeHidden();
      await page.getByRole('button', { name: /课程设置/ }).click();
      await expect(name).toHaveValue('已更新的社区生态探究课程');
      expect(app.audit.writes).toHaveLength(2);
      await assertUsablePage(page);
    });
  });
}
