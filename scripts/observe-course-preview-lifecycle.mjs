/** Keep real canonical + generation preview players mounted across promotion/recovery. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';

const arg = (name) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const courseId = arg('--course-id');
assert.ok(courseId, 'Pass --course-id');
const baseUrl = arg('--base-url') ?? 'http://127.0.0.1:3000';
const output = path.resolve(arg('--output') ?? `.openpbl-runtime/preview-lifecycle/${courseId}`);
const stopFile = path.join(output, 'stop');
const baselinePath = arg('--accepted-baseline');
const expectedSceneCount = arg('--expected-scene-count') ? Number(arg('--expected-scene-count')) : null;
assert.ok(expectedSceneCount === null || (Number.isInteger(expectedSceneCount) && expectedSceneCount > 0));
const acceptedBaseline = baselinePath ? JSON.parse(await readFile(baselinePath, 'utf8')) : undefined;
await mkdir(output, { recursive: true });
const report = { courseId, startedAt: new Date().toISOString(), pages: [], lifecycle: [], errors: [], transportInterruptions: [] };
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
try {
  const secret = process.env.JWT_SECRET ?? (await readFile('deploy/secrets/jwt_secret.txt', 'utf8')).trim();
  const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL ?? (await readFile('deploy/secrets/database_url.txt', 'utf8')).trim() } } });
  try {
    const { owner } = await db.classroomTemplate.findUniqueOrThrow({ where: { id: courseId }, select: { owner: true } });
    const token = await new SignJWT({ role: 'teacher', sv: owner.sessionVersion, username: owner.username, displayName: owner.displayName })
      .setSubject(owner.id).setProtectedHeader({ alg: 'HS256' }).setIssuer('openpbl').setAudience('openpbl-app')
      .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
    await context.addCookies([{ name: 'openpbl_teacher', value: token, url: baseUrl, httpOnly: true, sameSite: 'Lax' }]);
  } finally { await db.$disconnect(); }
  await context.storageState({ path: path.join(output, 'storage-state.json') });
  const jobResponse = await context.request.get(`${baseUrl}/api/courses/${courseId}/generation`);
  assert.ok(jobResponse.ok(), `Generation access failed ${jobResponse.status()}`);
  const initialJob = (await jobResponse.json()).job;
  assert.ok(initialJob?.id, 'No generation job');
  report.jobId = initialJob.id;
  if (acceptedBaseline) report.acceptedBaseline = { path: path.resolve(baselinePath), classroomId: acceptedBaseline.id, sceneIds: acceptedBaseline.scenes.map((scene) => scene.id) };
  const observers = [];
  for (const kind of ['canonical', 'generation-preview']) {
    const page = await context.newPage();
    const record = { kind, responses: [], cursors: [], stoppedPollingChecks: [] };
    report.pages.push(record);
    page.on('pageerror', (error) => report.errors.push({ kind, error: error.message }));
    await page.route('**/api/openmaic/classroom?*', async (route) => {
      const url = kind === 'generation-preview'
        ? `${baseUrl}/api/openmaic/classroom?id=course-generation-preview-${initialJob.id}`
        : route.request().url();
      let response;
      try { response = await context.request.get(url); } catch (error) {
        report.transportInterruptions.push({ at: new Date().toISOString(), kind, endpoint: 'classroom', message: String(error).split('\n')[0] });
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Service temporarily restarting' }) });
        return;
      }
      if (!response.ok()) {
        report.transportInterruptions.push({ at: new Date().toISOString(), kind, endpoint: 'classroom', status: response.status() });
        await route.fulfill({ response });
        return;
      }
      const payload = await response.json();
      const classroom = payload.classroom;
      if (classroom) record.responses.push({
        at: new Date().toISOString(), requestedId: new URL(route.request().url()).searchParams.get('id'),
        classroomId: classroom.id, revision: classroom.generationPreview?.contentVersion,
        active: classroom.generationPreview?.active, sceneIds: classroom.scenes.map((scene) => scene.id),
        media: classroom.generationPreview?.scenes,
      });
      await route.fulfill({ response });
    });
    await page.goto(`${baseUrl}/teacher/prepare/${courseId}/preview?view=student`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    const host = page.locator('[data-stage-host-mode="teacher-preview"]');
    await host.getByTestId('scene-item').nth(1).waitFor({ timeout: 90_000 });
    await host.getByTestId('scene-item').nth(1).click();
    const desiredSceneId = record.responses.at(-1).sceneIds[1];
    await expect(host).toHaveAttribute('data-active-scene-id', desiredSceneId);
    if (acceptedBaseline) assert.equal(desiredSceneId, acceptedBaseline.scenes[1].id, 'Accepted second-page ID changed before observation');
    record.initialSceneId = desiredSceneId;
    observers.push({ page, host, record, desiredSceneId, terminalSince: Date.now(), terminalResponseCount: record.responses.length });
  }
  let previousState = `${initialJob.id}:${initialJob.status}`;
  report.lifecycle.push({ at: new Date().toISOString(), state: previousState });
  console.log(JSON.stringify({ phase: 'observing', courseId, jobId: initialJob.id, stopFile }));
  const deadline = Date.now() + Number(arg('--duration-seconds') ?? 2700) * 1000;
  while (Date.now() < deadline) {
    if (await access(stopFile).then(() => true, () => false)) break;
    let job;
    try {
      const response = await context.request.get(`${baseUrl}/api/courses/${courseId}/generation`);
      if (!response.ok()) throw new Error(`Generation HTTP ${response.status()}`);
      job = (await response.json()).job;
    } catch (error) {
      report.transportInterruptions.push({ at: new Date().toISOString(), endpoint: 'generation', message: String(error).split('\n')[0] });
      await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    const lifecycle = `${job?.id}:${job?.status}`;
    if (lifecycle !== previousState) {
      report.lifecycle.push({ at: new Date().toISOString(), state: lifecycle, refresh: process.argv.includes('--no-focus-wake') ? 'none' : 'window-focus' });
      console.log(JSON.stringify({ phase: 'lifecycle', state: lifecycle }));
      previousState = lifecycle;
      // Emulate returning from the generation-progress task to each open player.
      if (!process.argv.includes('--no-focus-wake')) {
        for (const observer of observers) await observer.page.evaluate(() => window.dispatchEvent(new Event('focus')));
      }
    }
    for (const observer of observers) {
      const latest = observer.record.responses.at(-1);
      const selected = await observer.host.getAttribute('data-active-scene-id');
      const includesCursor = latest.sceneIds.includes(observer.desiredSceneId);
      if (includesCursor && selected && selected !== observer.desiredSceneId) {
        report.errors.push({ kind: observer.record.kind, error: 'Stable teacher cursor moved', expected: observer.desiredSceneId, actual: selected, at: new Date().toISOString() });
      }
      const previous = observer.record.cursors.at(-1);
      if (!previous || previous.sceneId !== selected || previous.revision !== latest.revision) {
        observer.record.cursors.push({ at: new Date().toISOString(), sceneId: selected, revision: latest.revision, sceneCount: latest.sceneIds.length });
      }
      if (latest.active) {
        observer.terminalSince = Date.now();
        observer.terminalResponseCount = observer.record.responses.length;
      } else if (Date.now() - observer.terminalSince >= 8_000) {
        observer.record.stoppedPollingChecks.push({ at: new Date().toISOString(), stableRequests: observer.record.responses.length === observer.terminalResponseCount, count: observer.record.responses.length });
        observer.terminalSince = Date.now();
        observer.terminalResponseCount = observer.record.responses.length;
      }
    }
    await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  assert.ok(report.lifecycle.some((item) => item.state.endsWith(':running') || item.state.endsWith(':queued')), 'No observed resume/promotion lifecycle');
  assert.equal(report.errors.length, 0, 'Browser errors or teacher cursor movement');
  for (const observer of observers) {
    assert.ok(observer.record.responses.length > 1, `${observer.record.kind} did not refresh`);
    const initial = observer.record.responses[0];
    const final = observer.record.responses.at(-1);
    if (expectedSceneCount !== null) assert.ok(final.sceneIds.length >= expectedSceneCount, `${observer.record.kind} lost expected pages`);
    else assert.ok(final.sceneIds.length > (acceptedBaseline?.scenes.length ?? initial.sceneIds.length), `${observer.record.kind} did not receive continued pages`);
    if (acceptedBaseline) {
      for (const scene of acceptedBaseline.scenes) assert.ok(final.sceneIds.includes(scene.id), `${observer.record.kind} lost accepted scene ${scene.id}`);
    }
    assert.notEqual(final.revision, initial.revision, `${observer.record.kind} retained the original content version`);
    assert.equal(final.active, false, `${observer.record.kind} still reports active generation`);
    assert.ok(Object.values(final.media ?? {}).every((scene) => scene.status === 'ready'), `${observer.record.kind} retains unready media`);
    assert.ok(observer.record.stoppedPollingChecks.some((check) => check.stableRequests), `${observer.record.kind} never stopped terminal polling`);
    await observer.page.screenshot({ path: path.join(output, `${observer.record.kind}-final.png`), fullPage: true });
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = (error instanceof Error ? error.message : String(error)).split('\n')[0];
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  console.log(JSON.stringify({ passed: report.passed, report: path.join(output, 'report.json'), failure: report.failure }));
}
