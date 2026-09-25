// Read-only by default. Set TRIAL_ENTER_CLASSROOM=1 only for a dedicated trial student.
// Credentials are supplied through the environment and are never written to the report.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = process.env.TRIAL_BASE_URL || 'https://coteach.cn';
const username = process.env.TRIAL_STUDENT_USERNAME;
const password = process.env.TRIAL_STUDENT_PASSWORD;
const offeringId = process.env.TRIAL_OFFERING_ID;
const activityId = process.env.TRIAL_ACTIVITY_ID;
const archivedActivityId = process.env.TRIAL_ARCHIVED_ACTIVITY_ID;
const mediaPath = process.env.TRIAL_MEDIA_PATH;
const launchResourceId = process.env.TRIAL_LAUNCH_RESOURCE_ID;
const imageIds = (process.env.TRIAL_IMAGE_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
const output = path.resolve(process.env.TRIAL_OUTPUT_DIR || 'test-results/teacher-trial/live-student');
const enter = process.env.TRIAL_ENTER_CLASSROOM === '1';
const checkDeepLink = process.env.TRIAL_CHECK_DEEP_LINK === '1';
if (!username || !password || !offeringId || !activityId) {
  throw new Error('Set TRIAL_STUDENT_USERNAME, TRIAL_STUDENT_PASSWORD, TRIAL_OFFERING_ID and TRIAL_ACTIVITY_ID.');
}
mkdirSync(output, { recursive: true });
const results = [];
const record = (name, status, detail = '') => {
  results.push({ name, status, detail });
  console.log(`${status} ${name}${detail ? `: ${detail}` : ''}`);
};
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await context.newPage();
const pageErrors = [];
const brokenResources = [];
const failedRequests = [];
const failedApis = [];
const failedApiDetails = [];
const progressUrls = [];
page.on('pageerror', error => pageErrors.push(error.message));
page.on('requestfailed', request => failedRequests.push(`${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`));
page.on('response', response => {
  if (response.status() === 200 && response.request().method() === 'GET'
    && new URL(response.url()).pathname === '/api/openmaic/progress') progressUrls.push(response.url());
  if (response.status() >= 400 && new URL(response.url()).pathname.startsWith('/api/')) {
    failedApis.push(`${response.status()} ${new URL(response.url()).pathname}`);
    response.text().then(body => failedApiDetails.push({
      status: response.status(), path: new URL(response.url()).pathname, body: body.slice(0, 250),
    })).catch(() => undefined);
  }
  if (response.status() >= 400 && /\.(?:js|css|woff2?|png|jpe?g|webp)(?:\?|$)/.test(response.url())) {
    brokenResources.push(`${response.status()} ${new URL(response.url()).pathname}`);
  }
});
await page.addInitScript(() => {
  const evidence = { started: 0, playing: 0, errors: 0, maxTime: 0 };
  window.__teacherTrialMedia = evidence;
  const original = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    evidence.started += 1;
    this.addEventListener('playing', () => { evidence.playing += 1; });
    this.addEventListener('error', () => { evidence.errors += 1; });
    this.addEventListener('timeupdate', () => { evidence.maxTime = Math.max(evidence.maxTime, this.currentTime); });
    return original.apply(this, args);
  };
});
try {
  await page.goto(`${origin}/student/login`, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  await page.getByLabel('学号').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  assert.equal(await page.getByLabel('学号').inputValue(), username);
  assert.equal(await page.locator('input[autocomplete="current-password"]').inputValue(), password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(`**/student/courses/${offeringId}`, { timeout: 30_000 });
  await page.getByRole('heading', { name: '测试课程' }).first().waitFor();
  record('real-student-browser-login-and-course', '通过');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '测试课程' }).first().waitFor();
  record('real-student-session-reload', '通过');

  const activityLink = page.locator(`a[href="/student/activities/${activityId}"]`);
  const targetRow = page.locator('.pbl-student-task-row').filter({ hasText: '中小学人工智能教育的教学理论与方法' });
  if (!await targetRow.count()) {
    for (const chapter of await page.locator('.pbl-student-chapter-heading').all()) {
      if (await chapter.getAttribute('aria-expanded') !== 'true') await chapter.click();
      if (await targetRow.count()) break;
    }
  }
  assert.ok(await targetRow.count(), 'Target classroom activity is absent from the student course list');
  if (await targetRow.getByText('未解锁', { exact: true }).count()) {
    throw new Error('Target classroom activity is locked for this student');
  }
  await activityLink.first().waitFor({ timeout: 15_000 });
  await activityLink.first().click();
  await page.waitForURL(`**/student/activities/${activityId}`);
  await page.getByRole('button', { name: '进入课堂' }).waitFor({ timeout: 20_000 });
  record('real-student-course-to-open-classroom', '通过');

  const roleDenied = await context.request.get(`${origin}/api/platform/offerings`);
  assert.equal(roleDenied.status(), 401);
  record('real-student-teacher-api-denied', '通过');

  if (enter) {
    await page.getByRole('button', { name: '进入课堂' }).click();
    await page.waitForURL(/\/student\/(?:classroom|participations)\//, { timeout: 30_000, waitUntil: 'domcontentloaded' });
    await page.getByText('中小学人工智能教育的教学理论与方法').first().waitFor({ timeout: 30_000 });
    record('real-student-enter-classroom', '通过', new URL(page.url()).pathname);

    if (mediaPath) {
      const media = await context.request.get(new URL(mediaPath, origin).toString());
      assert.equal(media.status(), 200, 'Enrolled student cannot load classroom media');
      assert.match(media.headers()['content-type'] || '', /^audio\//);
      assert.ok((await media.body()).length > 44);
      const anonymous = await browser.newContext();
      const blocked = await anonymous.request.get(new URL(mediaPath, origin).toString());
      assert.ok([401, 403, 404].includes(blocked.status()), `Anonymous media request returned ${blocked.status()}`);
      await anonymous.close();
      record('real-student-media-access-and-anonymous-denial', '通过');
    }

    if (imageIds.length) {
      const anonymous = await browser.newContext();
      try {
        for (const id of imageIds) {
          assert.match(id, /^[0-9a-f-]{36}$/i, 'Invalid image ID');
          const imageUrl = `${origin}/api/uploads/${id}`;
          const image = await context.request.get(imageUrl);
          assert.equal(image.status(), 200, `Enrolled student cannot load classroom image ${id}`);
          assert.match(image.headers()['content-type'] || '', /^image\//);
          assert.ok((await image.body()).length > 0);
          const blocked = await anonymous.request.get(imageUrl);
          assert.ok([401, 403, 404].includes(blocked.status()), `Anonymous image request returned ${blocked.status()}`);
        }
      } finally {
        await anonymous.close();
      }
      record('real-student-embedded-images-and-anonymous-denial', '通过', `${imageIds.length} images`);
    }

    if (launchResourceId) {
      assert.match(launchResourceId, /^[0-9a-f-]{36}$/i, 'Invalid launch resource ID');
      const resourceUrl = `${origin}/api/uploads/${launchResourceId}?variant=classroom`;
      const preview = await context.request.get(resourceUrl, { headers: { Range: 'bytes=0-7' } });
      assert.equal(preview.status(), 206, 'Enrolled student cannot load the launch PDF preview');
      assert.match(preview.headers()['content-type'] || '', /^application\/pdf/);
      assert.ok((await preview.body()).toString('ascii').startsWith('%PDF-'));
      const anonymous = await browser.newContext();
      try {
        const blocked = await anonymous.request.get(resourceUrl, { headers: { Range: 'bytes=0-7' } });
        assert.ok([401, 403, 404].includes(blocked.status()), `Anonymous launch resource returned ${blocked.status()}`);
      } finally {
        await anonymous.close();
      }
      record('real-student-launch-pdf-and-anonymous-denial', '通过');
    }

    const resume = page.getByRole('button', { name: '继续讲解', exact: true });
    await resume.waitFor({ state: 'visible', timeout: 20_000 });
    await resume.click();
    await page.waitForFunction(() => window.__teacherTrialMedia?.maxTime > 0.5, null, { timeout: 30_000 });
    const media = await page.evaluate(() => window.__teacherTrialMedia);
    assert.equal(media.errors, 0);
    record('real-student-browser-audio-progress', '通过', `playing=${media.playing}, maxTime=${media.maxTime.toFixed(1)}s`);
    const pause = page.getByRole('button', { name: '暂停讲解', exact: true });
    await pause.waitFor({ state: 'visible', timeout: 10_000 });
    await pause.click();
    await resume.waitFor({ state: 'visible', timeout: 10_000 });
    const otherTab = await context.newPage();
    await otherTab.bringToFront();
    await page.bringToFront();
    await otherTab.close();
    const priorPlaying = await page.evaluate(() => window.__teacherTrialMedia.playing);
    await resume.click();
    await page.waitForFunction(prior => window.__teacherTrialMedia?.playing > prior, priorPlaying, { timeout: 15_000 });
    record('real-student-pause-tab-switch-and-resume', '通过');
    await page.screenshot({ path: path.join(output, 'student-classroom.png') });

    const progressUrl = progressUrls.at(-1);
    assert.ok(progressUrl, 'Classroom did not request persisted learning progress');
    const readProgress = async () => {
      const response = await context.request.get(progressUrl);
      assert.equal(response.status(), 200);
      const payload = await response.json();
      const entries = Object.values(payload.data?.progress || {});
      assert.ok(entries.length <= 1, 'Unexpected progress entries for other students');
      return entries[0] || { completedScenes: [] };
    };
    const beforeProgress = await readProgress();
    const completedBefore = beforeProgress.completedScenes || [];
    if (!completedBefore.length) record('real-student-opening-does-not-complete-lecture', '通过');
    await page.getByRole('button', { name: '暂停讲解', exact: true }).click();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('中小学人工智能教育的教学理论与方法').first().waitFor({ timeout: 30_000 });
    const afterProgress = await readProgress();
    const completedAfter = new Set(afterProgress.completedScenes || []);
    assert.ok(completedBefore.every(id => completedAfter.has(id)), 'Saved completed scenes disappeared after reload');
    record('real-student-saved-progress-survives-classroom-reload',
      completedBefore.length ? '通过' : '未验证', `${completedBefore.length} saved scenes`);

    const freshContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    try {
      const freshPage = await freshContext.newPage();
      await freshPage.goto(`${origin}/student/login`, { waitUntil: 'load' });
      await freshPage.getByLabel('学号').fill(username);
      await freshPage.locator('input[autocomplete="current-password"]').fill(password);
      await freshPage.getByRole('button', { name: '登录', exact: true }).click();
      await freshPage.waitForURL(`**/student/courses/${offeringId}`, { timeout: 30_000 });
      await freshPage.goto(page.url(), { waitUntil: 'domcontentloaded' });
      await freshPage.getByText('中小学人工智能教育的教学理论与方法').first().waitFor({ timeout: 30_000 });
      const freshResponse = await freshContext.request.get(progressUrl);
      assert.equal(freshResponse.status(), 200);
      const freshPayload = await freshResponse.json();
      const freshEntries = Object.values(freshPayload.data?.progress || {});
      assert.ok(freshEntries.length <= 1, 'Fresh session received another student progress entry');
      const freshProgress = freshEntries[0] || { completedScenes: [] };
      const freshCompleted = new Set(freshProgress.completedScenes || []);
      assert.ok(completedBefore.every(id => freshCompleted.has(id)), 'Saved completed scenes disappeared after fresh login');
      record('real-student-saved-progress-survives-fresh-login',
        completedBefore.length ? '通过' : '未验证', `${completedBefore.length} saved scenes`);
    } finally {
      await freshContext.close();
    }

  }

  if (checkDeepLink) {
    const deepContext = await browser.newContext();
    try {
      const deepPage = await deepContext.newPage();
      const deepNavigations = [];
      const deepResponses = [];
      deepPage.on('framenavigated', frame => {
        if (frame === deepPage.mainFrame() && /^https?:/.test(frame.url())) {
          const navigated = new URL(frame.url());
          deepNavigations.push(navigated.pathname + navigated.search);
        }
      });
      deepPage.on('response', response => {
        const pathname = new URL(response.url()).pathname;
        if (pathname === '/api/platform/auth/login' || pathname.startsWith('/student/')) {
          deepResponses.push({ pathname, status: response.status(), location: response.headers().location || null,
            issuedSessionCookie: pathname === '/api/platform/auth/login' && Boolean(response.headers()['set-cookie']) });
        }
      });
      await deepPage.goto(`${origin}/student/activities/${activityId}`, { waitUntil: 'domcontentloaded' });
      await deepPage.waitForURL('**/student/login?redirect=*', { timeout: 20_000 });
      assert.equal(new URL(deepPage.url()).searchParams.get('redirect'), `/student/activities/${activityId}`);
      await deepPage.getByLabel('学号').fill(username);
      await deepPage.locator('input[autocomplete="current-password"]').fill(password);
      await deepPage.getByRole('button', { name: '登录', exact: true }).click();
      try {
        await deepPage.waitForURL(`**/student/activities/${activityId}`, { timeout: 30_000 });
      } catch (error) {
        const cookieNames = (await deepContext.cookies()).map(cookie => cookie.name);
        await deepPage.screenshot({ path: path.join(output, 'deep-link-failure.png'), fullPage: true }).catch(() => undefined);
        throw new Error(`Deep link did not restore at ${deepPage.url()}: ${String(error)}; navigations=${JSON.stringify(deepNavigations)}; responses=${JSON.stringify(deepResponses)}; cookieNames=${JSON.stringify(cookieNames)}`);
      }
      await deepPage.getByRole('button', { name: '进入课堂' }).waitFor({ timeout: 20_000 });
      record('real-student-unauthenticated-deep-link-restored-after-login', '通过');
      if (archivedActivityId) {
        await deepPage.goto(`${origin}/student/activities/${archivedActivityId}`, { waitUntil: 'domcontentloaded' });
        await deepPage.getByRole('heading', { name: '暂时无法打开活动' }).waitFor({ timeout: 20_000 });
        assert.match(await deepPage.getByRole('alert').filter({ hasText: '活动不存在' }).first().textContent() || '', /活动不存在/);
        await deepPage.getByRole('link', { name: '返回我的课程' }).waitFor({ timeout: 10_000 });
        record('real-student-archived-link-shows-recovery', '通过');
      }
    } finally {
      await deepContext.close();
    }
  }

  assert.deepEqual(pageErrors, [], 'Uncaught browser errors');
  assert.deepEqual(brokenResources, [], 'Broken static resources');
  const unexpectedApis = failedApis.filter(item => !item.includes('/api/platform/offerings'));
  assert.deepEqual(unexpectedApis, [], 'Failed application resources');
  record('real-student-page-and-assets', '通过');
} catch (error) {
  record('fatal', '失败', JSON.stringify({
    error: String(error?.message || error).slice(0, 300),
    alerts: await page.getByRole('alert').allTextContents().catch(() => []),
    failedRequests: failedRequests.slice(-8), failedApis: failedApis.slice(-8), failedApiDetails: failedApiDetails.slice(-8),
    media: await page.evaluate(() => window.__teacherTrialMedia).catch(() => null),
    fullscreen: await page.evaluate(() => Boolean(document.fullscreenElement)).catch(() => null),
    visibleButtons: await page.locator('button:visible').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label') || button.textContent?.trim()).filter(Boolean).slice(-20)).catch(() => []),
    playbackButtons: await page.locator('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label') || button.textContent?.trim()).filter(label => /讲解|播放|暂停|自动/.test(label || '')).slice(0, 12)).catch(() => []),
  }).slice(0, 1800));
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  writeFileSync(path.join(output, 'report.json'), JSON.stringify({
    checkedAt: new Date().toISOString(), origin, offeringId, activityId, enter, checkDeepLink,
    browser: browser.version(), results,
  }, null, 2));
  await browser.close();
}
