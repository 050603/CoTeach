import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { SignJWT } from 'jose';

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || 'http://localhost:3000';
test.use({ baseURL, serviceWorkers: 'block' });

async function signIn(page: Page, role: 'teacher' | 'student') {
  const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE
    ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, 'utf8').trim()
    : process.env.JWT_SECRET;
  test.skip(!secret, 'Provide the acceptance server JWT secret.');
  const subject = `prelaunch-fault-${role}`;
  const token = await new SignJWT({ role, sv: 1, username: subject, displayName: '故障恢复验收' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(subject)
    .setIssuer('openpbl')
    .setAudience('openpbl-app')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret!));
  await page.context().addCookies([{ name: `openpbl_${role}`, value: token, url: baseURL }]);
  await page.route('**/api/auth/me', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ user: { id: subject, role, displayName: '故障恢复验收' } }),
  }));
}

test('student course list recovers after a disconnected request', async ({ page }) => {
  await signIn(page, 'student');
  let disconnected = true;
  await page.route('**/api/platform/courses', route => {
    if (disconnected) return route.abort('internetdisconnected');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ courses: [] }) });
  });
  await page.goto('/student?all=1');
  const alert = page.locator('.pbl-student-dashboard [role="alert"]');
  await expect(alert).toContainText('暂时无法加载课程，请重试');
  disconnected = false;
  await page.getByRole('button', { name: '重新加载' }).click();
  await expect(page.getByRole('heading', { name: '尚未加入课程' })).toBeVisible();
  await expect(alert).toHaveCount(0);
});

test('teacher course list recovers after a timed-out request and displays a missing cover fallback', async ({ page }) => {
  await signIn(page, 'teacher');
  let timedOut = true;
  await page.route('**/api/platform/offerings', route => {
    if (timedOut) return route.abort('timedout');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ offerings: [{
      id: 'prelaunch-fault-course', name: '故障恢复课程', description: null, term: null,
      startsAt: null, coverImageUrl: '/missing-prelaunch-cover.png', status: 'OPEN', chapters: [],
    }] }) });
  });
  await page.route('**/missing-prelaunch-cover.png', route => route.fulfill({ status: 404, body: '' }));
  await page.goto('/teacher/classes');
  const alert = page.locator('.pbl-teacher-classes-page [role="alert"]');
  await expect(alert).toBeVisible();
  timedOut = false;
  await page.getByRole('button', { name: '重新加载' }).click();
  await expect(page.getByRole('heading', { name: '故障恢复课程' })).toBeVisible();
  await expect(page.getByRole('img', { name: '故障恢复课程教学班封面（图片暂不可用）' })).toBeVisible();
  await expect(alert).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(2);
});
