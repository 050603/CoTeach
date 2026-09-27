import { chromium, expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SignJWT } from 'jose';

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || 'http://127.0.0.1:3000';
const executablePath = process.env.PRELAUNCH_E2E_EXECUTABLE_PATH;
const brand = process.env.PRELAUNCH_E2E_BROWSER_LABEL || 'branded-browser';
const factors = [0.8, 1, 1.25, 1.5];
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) {
  throw new Error('Native zoom fixture flows require a local acceptance service.');
}

async function signIn(page: Page, role: 'teacher' | 'student') {
  const secret = (await readFile(process.env.OPENPBL_E2E_JWT_SECRET_FILE || process.env.LAYOUT_JWT_SECRET_FILE || 'deploy/secrets/jwt_secret.txt', 'utf8')).trim();
  const id = `native-brand-${role}`;
  const token = await new SignJWT({ role, sv: 1, username: id, userId: id, studentName: '原生缩放验收', displayName: '原生缩放验收' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(id).setIssuer('openpbl').setAudience('openpbl-app')
    .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: `openpbl_${role}`, value: token, url: baseURL }]);
}

async function measureAndCapture(page: Page, info: TestInfo, scenario: string, factor: number, physical: { width: number; height: number }) {
  const dimensions = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio,
    visualViewportScale: visualViewport?.scale,
    bodyCssZoom: getComputedStyle(document.body).zoom,
    rootCssZoom: getComputedStyle(document.documentElement).zoom,
    overflow: document.documentElement.scrollWidth - innerWidth,
  }));
  expect(dimensions.outerWidth).toBe(physical.width);
  expect(dimensions.outerHeight).toBe(physical.height);
  // Edge reserves a small native window border. The same fixed outer window
  // must shrink its CSS content width inversely to the native page zoom.
  expect(Math.abs(dimensions.innerWidth * factor - physical.width)).toBeLessThanOrEqual(16);
  expect(dimensions.devicePixelRatio).toBeCloseTo(factor, 3);
  expect(dimensions.visualViewportScale).toBe(1);
  expect(dimensions.bodyCssZoom).toBe('1');
  expect(dimensions.rootCssZoom).toBe('1');
  expect(dimensions.overflow).toBeLessThanOrEqual(2);
  await page.screenshot(); // Settle the renderer before capturing its physical surface.
  const cdp = await page.context().newCDPSession(page);
  try {
    const capture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
    const file = info.outputPath(`${scenario}.png`);
    await writeFile(file, Buffer.from(capture.data, 'base64'));
    await info.attach(scenario, { path: file, contentType: 'image/png' });
  } finally { await cdp.detach(); }
  return { scenario, factor, ...dimensions };
}

for (const physical of [{ width: 1024, height: 768 }, { width: 1280, height: 720 }, { width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
  for (const factor of factors) {
    test(`${brand} native ${Math.round(factor * 100)}% at ${physical.width}x${physical.height}: login, settings and survey`, async ({ browserName }, info) => {
      test.skip(browserName !== 'chromium' || !executablePath, 'Supply an actual Chrome/Edge executable for this native preference audit.');
      test.setTimeout(90_000);
      const profile = await mkdtemp(path.join(tmpdir(), 'openpbl-brand-native-zoom-'));
      await mkdir(path.join(profile, 'Default'));
      // Chromium's actual profile setting uses a dictionary keyed by the
      // default storage partition "x". No extension, emulated viewport, DPR
      // override, CSS zoom or CDP page-scale emulation is involved.
      await writeFile(path.join(profile, 'Default/Preferences'), JSON.stringify({
        partition: { default_zoom_level: { x: Math.log(factor) / Math.log(1.2) } },
      }));
      const context = await chromium.launchPersistentContext(profile, {
        executablePath, headless: true, viewport: null, deviceScaleFactor: undefined,
        reducedMotion: 'reduce', serviceWorkers: 'block', args: [`--window-size=${physical.width},${physical.height}`],
      });
      context.setDefaultTimeout(10_000);
      context.setDefaultNavigationTimeout(20_000);
      await context.tracing.start({ screenshots: true, snapshots: true });
      const errors: string[] = [];
      const writes: Array<{ path: string; method: string; body: unknown }> = [];
      const measurements: unknown[] = [];
      let currentRole: 'teacher' | 'student' = 'teacher';
      const course = { id: 'native-brand-course', name: '浏览器原生缩放课程', term: '2026 秋季', status: 'open', version: 1, description: '原生缩放表单验收', outline: '', startsAt: null, endsAt: null, coverImageUrl: null, chapters: [], invitation: { code: 'A7B9C2' } };
      try {
        const page = context.pages()[0] ?? await context.newPage();
        page.on('pageerror', (error) => errors.push(error.message));
        await page.routeWebSocket('**/*', (socket) => socket.close());
        await page.route('**/*', async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          const method = request.method();
          const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
          if (url.origin !== new URL(baseURL).origin) {
            errors.push(`Unexpected external request: ${url}`);
            return route.abort('blockedbyclient');
          }
          if (!url.pathname.startsWith('/api/')) {
            if (method === 'GET' || method === 'HEAD') return route.continue();
            errors.push(`Blocked non-API write: ${method} ${url.pathname}`);
            return json({}, 405);
          }
          if (!['GET', 'HEAD'].includes(method)) {
            const body = request.postDataJSON();
            writes.push({ path: url.pathname, method, body });
            if (method === 'POST' && ['/api/platform/auth/login', '/api/platform/auth/teacher-login'].includes(url.pathname)) {
              return json({ message: '原生缩放验收：请求已拦截，请重试' }, 401);
            }
            if (method === 'PATCH' && url.pathname === '/api/platform/offerings/native-brand-course') {
              Object.assign(course, body);
              return json({ offering: course });
            }
            if (method === 'POST' && url.pathname === '/api/platform/activities/native-brand-survey/submit') {
              return json({ progress: { status: 'completed', progressData: body } });
            }
          } else {
            const fixtures: Record<string, unknown> = {
              '/api/auth/me': { user: { id: `native-brand-${currentRole}`, role: currentRole, displayName: '原生缩放验收', username: 'native-brand' } },
              '/api/platform/auth/teacher-register': { available: false },
              '/api/platform/auth/student-profile': { user: { id: 'native-brand-student', role: 'student', username: 'native-brand-student', displayName: '原生缩放验收' } },
              '/api/platform/offerings': { offerings: [course] },
              '/api/platform/templates': { templates: [] },
              '/api/platform/activities/native-brand-survey': { activity: {
                id: 'native-brand-survey', type: 'Form', title: '原生缩放学习问卷', isOpen: true,
                offering: { id: course.id, name: course.name, status: 'open' }, chapter: { title: '课堂反思' },
                progress: { status: 'not_started' }, instance: null,
                config: { questions: [{ id: 'idea', title: '本次学习最重要的收获？', type: 'short-text', required: true, options: [] }] },
              } },
            };
            if (url.pathname in fixtures) return json(fixtures[url.pathname]);
          }
          errors.push(`Unconfigured API: ${method} ${url.pathname}`);
          return json({ message: 'Fixture missing' }, 404);
        });

        for (const role of ['student', 'teacher']) {
          await page.goto(`${baseURL}/${role}/login`);
          await page.getByPlaceholder(role === 'student' ? '输入你的学号' : '教师账号', { exact: true }).fill('native-zoom-fixture');
          await page.getByPlaceholder(role === 'student' ? '输入密码' : '密码', { exact: true }).fill('fixture-password');
          await page.getByRole('button', { name: '登录', exact: true }).click();
          await expect(page.locator('form').getByRole('alert')).toContainText('原生缩放验收：请求已拦截');
          expect(writes.at(-1)).toMatchObject({ method: 'POST', body: { username: 'native-zoom-fixture', password: 'fixture-password' } });
          measurements.push(await measureAndCapture(page, info, `${role}-login`, factor, physical));
        }

        await signIn(page, 'teacher');
        await page.goto(`${baseURL}/teacher/classes/${course.id}`);
        await page.getByRole('button', { name: /课程设置/ }).click();
        const dialog = page.getByRole('dialog', { name: '课程设置', exact: true });
        await dialog.getByRole('textbox', { name: /课程名称/ }).fill('原生缩放后保存成功');
        await dialog.getByRole('button', { name: '保存课程设置', exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(page.getByRole('heading', { name: '原生缩放后保存成功', exact: true })).toBeVisible();
        expect(writes.at(-1)).toMatchObject({ method: 'PATCH', body: { name: '原生缩放后保存成功' } });
        await page.getByRole('button', { name: /课程设置/ }).click();
        await expect(dialog.getByRole('textbox', { name: /课程名称/ })).toHaveValue('原生缩放后保存成功');
        const headerGap = await dialog.locator('.pbl-dialog-header-icon').evaluate((icon) => {
          const title = icon.nextElementSibling;
          if (!title) throw new Error('Course settings title is missing');
          return title.getBoundingClientRect().left - icon.getBoundingClientRect().right;
        });
        expect(headerGap, 'Course settings icon must leave space before its title').toBeGreaterThanOrEqual(8);
        measurements.push(await measureAndCapture(page, info, 'teacher-settings', factor, physical));
        await dialog.getByRole('button', { name: '取消', exact: true }).click();

        currentRole = 'student';
        await signIn(page, 'student');
        await page.goto(`${baseURL}/student/activities/native-brand-survey`);
        await page.getByRole('textbox', { name: '本次学习最重要的收获？' }).fill('使用证据解释实际问题。');
        await page.getByRole('button', { name: '提交问卷', exact: true }).click();
        await expect(page.locator('form').getByRole('status')).toContainText('回答已经保存');
        expect(writes.at(-1)).toMatchObject({ method: 'POST', body: { answers: { idea: '使用证据解释实际问题。' } } });
        await page.getByRole('textbox', { name: '本次学习最重要的收获？' }).fill('补充证据并更新回答。');
        await page.getByRole('button', { name: '更新回答', exact: true }).click();
        await expect(page.locator('form').getByRole('status')).toContainText('回答已经保存');
        expect(writes.at(-1)).toMatchObject({ method: 'POST', body: { answers: { idea: '补充证据并更新回答。' } } });
        measurements.push(await measureAndCapture(page, info, 'student-survey', factor, physical));
        expect(writes).toHaveLength(5);
        expect(errors).toEqual([]);
      } finally {
        await info.attach('native-zoom-evidence', { body: JSON.stringify({ brand, version: context.browser()?.version(), physical, factor, measurements, writes, errors }, null, 2), contentType: 'application/json' });
        await context.tracing.stop({ path: info.outputPath('native-zoom-trace.zip') });
        await context.close();
        await rm(profile, { recursive: true, force: true });
      }
    });
  }
}
