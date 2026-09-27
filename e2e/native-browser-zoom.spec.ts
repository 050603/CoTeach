import { chromium, expect, test, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SignJWT } from 'jose';
import { textbookFixture, textbookId, firstChapter, firstSection } from './fixtures/textbook-library';

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || 'http://127.0.0.1:3000';
const factors = [0.8, 1, 1.25, 1.5];
const courseName = '原生缩放验收：城市生态与社区行动';
test.use({ viewport: null, deviceScaleFactor: undefined });

async function fixture(page: Page, role: 'teacher' | 'student') {
  const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE
    ? (await readFile(process.env.OPENPBL_E2E_JWT_SECRET_FILE, 'utf8')).trim() : process.env.JWT_SECRET;
  if (!secret) throw new Error('Provide the acceptance server JWT secret.');
  const user = { id: `native-zoom-${role}`, role, sv: 1, username: 'native-zoom', displayName: '原生缩放验收' };
  const token = await new SignJWT(user).setProtectedHeader({ alg: 'HS256' }).setSubject(user.id)
    .setIssuer('openpbl').setAudience('openpbl-app').setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: `openpbl_${role}`, value: token, url: baseURL }]);
  const course = { id: 'native-zoom-course', name: courseName, status: 'open', term: '2026 秋季',
    description: '观察真实社区，分析证据并形成可以付诸实践的方案。', outline: '',
    startsAt: '2026-09-01', endsAt: '2027-01-10', coverImageUrl: '/brand/coteach/horizontal-color.png',
    teacher: { displayName: '验收教师' }, chapters: [], invitation: { code: 'A7B9C2' } };
  const textbook = textbookFixture(30);
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    let value: unknown;
    if (url.pathname === '/api/auth/me') value = { user, configured: true };
    else if (url.pathname === '/api/platform/courses') value = { courses: [course], viewer: user };
    else if (url.pathname === '/api/platform/offerings') value = { offerings: [course] };
    else if (url.pathname === `/api/textbooks/${textbookId}`) value = textbook;
    else if (url.pathname.endsWith('/search')) value = { query: url.searchParams.get('q'), degraded: false, hits: [] };
    else return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'No browser fixture for this API' }) });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
  });
}

for (const physical of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
  for (const scenario of ['teacher-courses', 'student-courses', 'textbook-reader', 'teacher-login'] as const) {
    test(`native Chromium zoom 80–150% ${scenario} physical ${physical.width}x${physical.height}`, async ({ browserName }, info) => {
      test.skip(browserName !== 'chromium', 'Native extension page zoom is a Chromium-specific audit.');
      test.setTimeout(120_000);
      const extension = await mkdtemp(path.join(tmpdir(), 'openpbl-native-zoom-'));
      await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'CoTeach native zoom audit', version: '1.0.0', permissions: ['tabs'], background: { service_worker: 'background.js' } }));
      await writeFile(path.join(extension, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
      const context = await chromium.launchPersistentContext('', {
        channel: 'chromium', headless: true, viewport: null, deviceScaleFactor: undefined,
        args: [`--window-size=${physical.width},${physical.height}`, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      });
      const issues: string[] = [];
      const measurements: unknown[] = [];
      try {
        const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
        const page = context.pages()[0] ?? await context.newPage();
        page.on('pageerror', (error) => issues.push(`pageerror: ${error.message}`));
        if (scenario === 'teacher-login') {
          await page.route('**/api/**', (request) => request.fulfill({
            status: request.request().url().endsWith('/teacher-login') ? 401 : 200,
            contentType: 'application/json', body: JSON.stringify({ available: false, message: '原生缩放验收：登录请求已由测试拦截' }),
          }));
        } else await fixture(page, scenario === 'student-courses' ? 'student' : 'teacher');
        const route = scenario === 'teacher-courses' ? '/teacher/classes' : scenario === 'student-courses' ? '/student?all=1' : scenario === 'teacher-login' ? '/teacher/login' : `/teacher/textbooks/${textbookId}`;
        await page.goto(baseURL + route);
        for (const factor of factors) {
          // The extension API changes native browser page zoom. No viewport,
          // device-scale-factor emulation, CSS zoom, or pinch API is used.
          const actualZoom = await worker.evaluate(async ({ prefix, zoom }) => {
            const extensionApi = (globalThis as unknown as { chrome: { tabs: {
              query: (query: object) => Promise<Array<{ id: number; url?: string }>>;
              setZoom: (id: number, factor: number) => Promise<void>;
              getZoom: (id: number) => Promise<number>;
            } } }).chrome;
            const tab = (await extensionApi.tabs.query({})).find((candidate) => candidate.url?.startsWith(prefix));
            if (!tab) throw new Error('Native zoom tab not found');
            await extensionApi.tabs.setZoom(tab.id, zoom);
            return extensionApi.tabs.getZoom(tab.id);
          }, { prefix: baseURL, zoom: factor });
          await page.goto(baseURL + route);
          try {
            if (scenario === 'teacher-login') {
              await page.getByPlaceholder('教师账号').fill('native-zoom-fixture');
              await page.getByPlaceholder('密码', { exact: true }).fill('fixture-password-never-sent');
              await page.getByRole('button', { name: '登录', exact: true }).click();
              await expect(page.locator('.pbl-auth-error[role="alert"]')).toHaveText('原生缩放验收：登录请求已由测试拦截');
            } else if (scenario === 'textbook-reader') {
              await page.getByLabel('教材阅读区').getByRole('button', { name: new RegExp(firstChapter) }).first().click();
              await page.getByLabel('子章节').getByRole('button', { name: firstSection }).click();
              await expect(page.getByLabel('教材阅读区').getByRole('heading', { name: firstSection })).toBeVisible();
              const search = page.getByRole('combobox', { name: '搜索本书' });
              await search.fill('原生缩放');
              await expect(search).toHaveValue('原生缩放');
              await search.fill('');
            } else {
              const search = page.getByRole('textbox', { name: scenario === 'teacher-courses' ? '搜索教学班' : '搜索课程' });
              await expect(page.getByRole('heading', { name: courseName })).toBeVisible();
              await search.fill('没有匹配的教学班');
              await expect(page.getByRole('heading', { name: courseName })).toHaveCount(0);
              await search.fill('');
              await expect(page.getByRole('heading', { name: courseName })).toBeVisible();
              if (scenario === 'teacher-courses') {
                await page.getByRole('button', { name: '新建教学班', exact: true }).click();
                const dialog = page.getByRole('dialog');
                await dialog.getByPlaceholder('例如：设计思维与社区创新').fill('只验证输入，不提交');
                await dialog.getByRole('button', { name: '取消', exact: true }).click();
                await expect(dialog).toHaveCount(0);
              }
            }
            const dimensions = await page.evaluate(() => ({
              innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio,
              visualViewportScale: visualViewport?.scale,
              bodyCssZoom: getComputedStyle(document.body).zoom,
              overflow: document.documentElement.scrollWidth - innerWidth,
            }));
            measurements.push({ factor, actualZoom, ...dimensions });
            expect(actualZoom).toBeCloseTo(factor, 5);
            expect(dimensions.outerWidth).toBe(physical.width);
            expect(Math.abs(dimensions.innerWidth * factor - physical.width)).toBeLessThanOrEqual(2);
            expect(dimensions.devicePixelRatio).toBeCloseTo(factor, 3);
            expect(dimensions.visualViewportScale).toBe(1);
            expect(dimensions.bodyCssZoom).toBe('1');
            expect(dimensions.overflow).toBeLessThanOrEqual(2);
          } catch (error) { issues.push(`${Math.round(factor * 100)}%: ${String(error)}`); }
          // Playwright's normal screenshot path uses the CSS viewport when
          // viewport:null and clips native zoom captures. Capture the actual
          // browser surface at its unchanged physical pixel dimensions.
          await page.screenshot();
          const cdp = await context.newCDPSession(page);
          await cdp.send('Page.enable');
          const capture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
          const png = Buffer.from(capture.data, 'base64');
          expect(png.readUInt32BE(16)).toBe(physical.width);
          await writeFile(info.outputPath(`native-zoom-${Math.round(factor * 100)}.png`), png);
          await cdp.detach();
        }
        const measurementPath = info.outputPath('native-browser-zoom-measurements.json');
        await writeFile(measurementPath, JSON.stringify({ physical, scenario, measurements, issues }, null, 2));
        await info.attach('native-browser-zoom-measurements', { path: measurementPath, contentType: 'application/json' });
        expect(issues).toEqual([]);
      } finally {
        await context.close();
        await rm(extension, { recursive: true, force: true });
      }
    });
  }
}
