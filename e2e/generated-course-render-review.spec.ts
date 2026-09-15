import { test, expect } from '@playwright/test';
import { SignJWT } from 'jose';
import { readFileSync, writeFileSync } from 'node:fs';

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || 'http://localhost:3000';
test.use({ baseURL });
test('renders every generated teaching slide with loaded fonts and records page-level measurements', async ({ page }, info) => {
  test.skip(!process.env.OPENPBL_ACCEPTANCE_COURSE || !process.env.OPENPBL_ACCEPTANCE_CLASSROOM, 'Provide actual privately generated acceptance artifacts.');
  test.setTimeout(180_000);
  const course = JSON.parse(readFileSync(process.env.OPENPBL_ACCEPTANCE_COURSE!, 'utf8'));
  const classroom = JSON.parse(readFileSync(process.env.OPENPBL_ACCEPTANCE_CLASSROOM!, 'utf8'));
  const signature = 'b'.repeat(64), errors: string[] = [], reports: Array<{ sceneId: string; status: string; issues: unknown[] }> = [];
  course.content.qualityReviewRequired = true;
  const expected = classroom.scenes.filter((scene: { type: string }) => scene.type === 'slide');
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1600, height: 1000 });
  const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, 'utf8').trim() : process.env.JWT_SECRET;
  if (secret) {
    const token = await new SignJWT({ role: 'teacher', sv: 1, username: 'e2e-generated', displayName: '逐页验收' }).setProtectedHeader({ alg: 'HS256' }).setSubject('e2e-teacher').setIssuer('openpbl').setAudience('openpbl-app').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
    await page.context().addCookies([{ name: 'openpbl_teacher', value: token, domain: new URL(baseURL).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
  }
  await page.addInitScript(() => {
    const originalFetch = window.fetch;
    window.fetch = function (input, init) {
      if (String(input).includes('/quality-review') && typeof init?.body === 'string') {
        const body = JSON.parse(init.body);
        if (body.action === 'render-page') {
          const source = document.querySelector(`[data-review-canvas="${body.page.sceneId}"]`);
          if (source) {
            const clone = source.cloneNode(true) as HTMLElement;
            clone.dataset.acceptanceSnapshot = body.page.sceneId;
            Object.assign(clone.style, { position: 'fixed', left: '0', top: '0', zIndex: '99999' });
            const originals = source.querySelectorAll('canvas');
            clone.querySelectorAll('canvas').forEach((canvas, index) => canvas.getContext('2d')?.drawImage(originals[index], 0, 0));
            document.body.appendChild(clone);
          }
        }
      }
      return originalFetch.call(this, input, init);
    };
  });
  await page.routeWebSocket((url) => !url.pathname.includes('_next'), (socket) => socket.onMessage(() => undefined));
  await page.route('**/api/**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = (value: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/auth/me') return json({ user: { id: 'e2e-teacher', role: 'teacher', name: '逐页验收', displayName: '逐页验收' } });
    if (path === '/api/courses') return json({ courses: [course], user: { role: 'teacher', name: '逐页验收' }, hydrated: true, updatedAt: course.updatedAt });
    if (path.endsWith('/state')) return json({ course, eventCursor: '0' });
    if (path.endsWith('/events')) return json({ events: [], nextCursor: '0', hasMore: false, courseVersion: 1 });
    if (path.endsWith('/presence')) return json({ members: [], degraded: false });
    if (path.endsWith('/resource-repair')) return json({ issues: [] });
    if (path.endsWith('/quality-review')) {
      if (request.method() === 'POST') {
        const body = request.postDataJSON();
        expect(body.action).toBe('render-page');
        reports.push(body.page);
        const node = page.locator(`[data-acceptance-snapshot="${body.page.sceneId}"]`);
        if (body.page.status === 'completed') {
          const file = info.outputPath(`page-${String(reports.length).padStart(2, '0')}.png`);
          await node.screenshot({ path: file });
          await info.attach(`page-${reports.length}`, { path: file, contentType: 'image/png' });
          await node.evaluate((canvas) => canvas.remove());
        }
        return json({ success: true });
      }
      return json({ required: true, signature, classroom, quality: { schemaVersion: 1, signature, status: 'pending', issues: [] }, renderReview: reports.length ? { signature, status: reports.length === expected.length ? 'completed' : 'running', pages: reports } : null, teacherReview: null });
    }
    if (path === '/api/openmaic/classroom') return json(classroom);
    return json({});
  });
  await page.goto(`/teacher/prepare/${course.id}/preview`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '检查页面', exact: true }).click();
  await expect.poll(() => reports.length, { timeout: 120_000 }).toBe(expected.length);
  expect(expected.length).toBeGreaterThan(0);
  expect(reports.every((report) => report.status === 'completed')).toBe(true);
  expect(new Set(reports.map((report) => report.sceneId)).size).toBe(expected.length);
  expect(errors).toEqual([]);
  const file = info.outputPath('render-report.json'); writeFileSync(file, JSON.stringify(reports, null, 2));
  await info.attach('render-report', { path: file, contentType: 'application/json' });
});
