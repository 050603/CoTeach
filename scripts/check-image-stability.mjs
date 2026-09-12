// Browser-only cover fault/slow-load fixtures; no business requests reach the server.
// Run after deploying the build: node scripts/check-image-stability.mjs
// Uses the same LAYOUT_BASE_URL / LAYOUT_JWT_SECRET(_FILE) as check-desktop-layout.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium, webkit, devices } from '@playwright/test';
import { SignJWT } from 'jose';

const baseURL = process.env.LAYOUT_BASE_URL || 'http://127.0.0.1:3000';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) throw new Error('Only local instances are supported');
const browserName = process.env.LAYOUT_BROWSER || 'chromium';
if (!['chromium', 'webkit'].includes(browserName)) throw new Error('LAYOUT_BROWSER must be chromium or webkit');
const secret = process.env.LAYOUT_JWT_SECRET || fs.readFileSync(process.env.LAYOUT_JWT_SECRET_FILE || 'deploy/secrets/jwt_secret.txt', 'utf8').trim();
const token = await new SignJWT({ role: 'teacher', sv: 1, username: 'layout', displayName: '素材测试教师' })
  .setProtectedHeader({ alg: 'HS256' }).setSubject('layout-teacher').setIssuer('openpbl').setAudience('openpbl-app').setExpirationTime('1h').sign(new TextEncoder().encode(secret));
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'openpbl-image-stability-'));
const browser = await ({ chromium, webkit })[browserName].launch();
const reports = [];
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#dce6df"/><path d="M200 120h100l20 15 20-15h100v140H340l-20 15-20-15H200z" fill="#fff" stroke="#658578" stroke-width="5"/></svg>';
const profiles = [
  { id: 'desktop', viewport: { width: 1440, height: 900 } },
  { ...devices['iPhone 13'], id: 'phone', defaultBrowserType: undefined },
];

try {
  for (const { id, ...profile } of profiles) {
    delete profile.defaultBrowserType;
    const context = await browser.newContext({ ...profile, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addCookies([{ name: 'openpbl_teacher', value: token, url: baseURL }]);
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    let phase = 'missing';
    let releaseImage;
    const imageGate = new Promise(resolve => { releaseImage = resolve; });
    let sawSlowRequest;
    const slowRequested = new Promise(resolve => { sawSlowRequest = resolve; });
    const report = { device: id, errors: [], unexpectedRequests: [], expected404s: 0, checks: [] };
    page.on('pageerror', error => report.errors.push(error.message));
    await page.route('**/api/**', route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      const course = { id: 'asset-course', name: '社区生态调查课程', coverImageUrl: `/__asset-check__/${phase}.svg`, status: 'open', term: '2026 秋季', description: '素材加载稳定性检查', chapters: [] };
      const fixtures = {
        '/api/auth/me': { user: { id: 'layout-teacher', username: 'layout', displayName: '素材测试教师', role: 'teacher' } },
        '/api/platform/offerings': { offerings: [course] },
      };
      const allowed = ['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && pathname in fixtures;
      if (!allowed) report.unexpectedRequests.push({ pathname, method: request.method() });
      return route.fulfill({ status: allowed ? 200 : 405, contentType: 'application/json', body: JSON.stringify(allowed ? fixtures[pathname] : { message: 'No audit fixture' }) });
    });
    await page.route('**/__asset-check__/*', async route => {
      if (route.request().url().endsWith('/missing.svg')) {
        report.expected404s++;
        return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Deliberate image audit 404' });
      }
      if (route.request().url().endsWith('/slow.svg')) { sawSlowRequest(); await imageGate; }
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg });
    });
    const rects = () => page.evaluate(() => Object.fromEntries(['.pbl-teacher-class-card', '.pbl-teacher-class-cover', '.pbl-teacher-class-body'].map(selector => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return [selector, { x: r.x, y: r.y, width: r.width, height: r.height }];
    })));
    try {
      await page.goto(`${baseURL}/teacher/classes`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('img', { name: '社区生态调查课程教学班封面（图片暂不可用）' }).waitFor();
      assert.equal(await page.locator('.pbl-teacher-class-cover img').count(), 0);
      assert.equal(await page.locator('.pbl-teacher-class-cover .pbl-learning-art').count(), 1);
      report.checks.push('404 switches to network-independent teaching illustration');
      await page.screenshot({ path: path.join(output, `${id}-404.png`) });

      phase = 'slow';
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('.pbl-teacher-class-card').waitFor();
      let requestTimeout;
      try {
        await Promise.race([slowRequested, new Promise((_, reject) => { requestTimeout = setTimeout(() => reject(new Error('Slow image was never requested')), 15000); })]);
      } finally {
        clearTimeout(requestTimeout);
      }
      await page.evaluate(() => document.fonts.ready);
      const before = await rects();
      assert.equal(await page.locator('.pbl-teacher-class-cover img').evaluate(img => img.complete), false);
      await page.waitForTimeout(1200);
      const delayed = await rects();
      releaseImage();
      await page.locator('.pbl-teacher-class-cover img').evaluate(img => img.decode());
      await page.waitForTimeout(100);
      const loaded = await rects();
      const deltas = [delayed, loaded].flatMap(sample => Object.keys(before).flatMap(selector => Object.keys(before[selector]).map(key => Math.abs(sample[selector][key] - before[selector][key]))));
      report.maxLayoutDeltaPx = Math.max(...deltas);
      report.geometry = { before, delayed, loaded };
      assert.ok(report.maxLayoutDeltaPx <= 1, `Cover load shifted layout ${report.maxLayoutDeltaPx}px`);
      report.checks.push('Delayed image preserves card, cover, and body positions/dimensions');

      phase = 'recovered';
      await page.reload({ waitUntil: 'domcontentloaded' });
      const recovered = page.getByRole('img', { name: '社区生态调查课程教学班封面', exact: true });
      await recovered.waitFor();
      await recovered.evaluate(img => img.decode());
      assert.ok(await recovered.evaluate(img => img.complete && img.naturalWidth > 0 && img.src.endsWith('/recovered.svg')));
      assert.equal(await page.getByRole('img', { name: /图片暂不可用/ }).count(), 0);
      report.checks.push('Fresh read of a recovered URL displays the actual image');
      report.brokenImages = await page.evaluate(() => [...document.images].filter(img => img.getClientRects().length && img.complete && !img.naturalWidth).map(img => img.src));
      assert.deepEqual(report.brokenImages, []);
      assert.deepEqual(report.errors, []);
      assert.deepEqual(report.unexpectedRequests, []);
      await page.screenshot({ path: path.join(output, `${id}-recovered.png`) });
    } catch (error) {
      report.failure = error.message;
      await page.screenshot({ path: path.join(output, `${id}-failed.png`) }).catch(() => {});
    } finally {
      releaseImage();
      reports.push(report);
      await context.close();
    }
  }
} finally {
  await browser.close();
}
const summary = { browser: browserName, output, checks: reports.length, failures: reports.filter(report => report.failure).length, reports };
fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (summary.failures) process.exitCode = 1;
