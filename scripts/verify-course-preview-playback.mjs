/** Read-only acceptance of real teacher preview, decoded audio and visible cues.
 * node scripts/verify-course-preview-playback.mjs --course-id <template> [--job-id <job>]
 * Use --storage-state <file> to reuse a session; otherwise sign a short-lived
 * owner session from deployment secrets. No account or course is changed.
 */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';

const arg = (name) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const courseId = arg('--course-id');
assert.ok(courseId, 'Pass --course-id <template ID>');
const baseUrl = arg('--base-url') ?? 'http://127.0.0.1:3000';
const whiteboardFixture = process.argv.includes('--whiteboard-fixture');
const reusedBaseline = arg('--reuse-audio-report') ? JSON.parse(await readFile(arg('--reuse-audio-report'), 'utf8')).audio ?? [] : [];
const reusedSpeechIds = new Set(reusedBaseline.map((speech) => speech.id));
const fixtureBoardId = 'acceptance-whiteboard-note';
function applyBrowserFixture(input) {
  if (!whiteboardFixture) return input;
  const copy = structuredClone(input);
  const scene = copy.scenes.find((item) => item.type === 'slide' && item.actions?.some((action) => action.type === 'speech' && action.audioUrl));
  const speech = scene.actions.find((action) => action.type === 'speech' && action.audioUrl);
  scene.actions = [
    { id: 'acceptance-wb-open', type: 'wb_open' },
    { id: 'acceptance-wb-note', type: 'wb_draw_text', elementId: fixtureBoardId, content: '<p>板书暂停与页面隔离验收</p>', x: 80, y: 100, width: 560, height: 110, fontSize: 30 },
    speech, { id: 'acceptance-wb-close', type: 'wb_close' },
  ];
  return copy;
}
const classroomOverride = arg('--job-id') ? `course-generation-preview-${arg('--job-id')}` : arg('--classroom-id');
const output = path.resolve(arg('--output') ?? `.openpbl-runtime/preview-playback/${courseId}-${Date.now()}`);
await mkdir(output, { recursive: true });
const report = { courseId, classroomOverride, startedAt: new Date().toISOString(), audio: [], scenes: [], errors: [] };
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...(arg('--storage-state') ? { storageState: arg('--storage-state') } : {}) });
let page;
try {
  if (!arg('--storage-state')) {
    const secret = process.env.JWT_SECRET ?? (await readFile(arg('--jwt-secret-file') ?? 'deploy/secrets/jwt_secret.txt', 'utf8')).trim();
    const databaseUrl = process.env.DATABASE_URL ?? (await readFile('deploy/secrets/database_url.txt', 'utf8')).trim();
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
      const template = await db.classroomTemplate.findUniqueOrThrow({ where: { id: courseId }, select: { owner: true } });
      const owner = template.owner;
      const token = await new SignJWT({ role: 'teacher', sv: owner.sessionVersion, username: owner.username, displayName: owner.displayName })
        .setSubject(owner.id).setProtectedHeader({ alg: 'HS256' }).setIssuer('openpbl').setAudience('openpbl-app')
        .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
      await context.addCookies([{ name: 'openpbl_teacher', value: token, url: baseUrl, httpOnly: true, sameSite: 'Lax' }]);
    } finally { await db.$disconnect(); }
  }
  const stateResponse = await context.request.get(`${baseUrl}/api/courses/${courseId}/state`);
  assert.ok(stateResponse.ok(), `Course access failed: ${stateResponse.status()}`);
  const course = (await stateResponse.json()).course;
  const classroomId = classroomOverride ?? course.aiLearningClassroomId ?? course.content?._openmaicClassroomId;
  assert.ok(classroomId, 'Course has no generated classroom');
  report.classroomId = classroomId;
  const classroomResponse = await context.request.get(`${baseUrl}/api/openmaic/classroom?id=${encodeURIComponent(classroomId)}`);
  assert.ok(classroomResponse.ok(), `Classroom access failed: ${classroomResponse.status()}`);
  const storedClassroom = (await classroomResponse.json()).classroom;
  const classroom = applyBrowserFixture(storedClassroom);
  report.authoredWhiteboardActions = storedClassroom.scenes.flatMap((scene) => scene.actions ?? []).filter((action) => action.type.startsWith('wb_')).length;
  if (whiteboardFixture) report.fixture = { kind: 'browser-only whiteboard playback fixture', productionContentChanged: false, note: 'Narration is a real course audio asset; only this browser receives injected whiteboard actions. This does not establish that the generated course authored whiteboard actions.' };
  assert.ok(classroom?.scenes?.length, 'Classroom is empty');
  console.log(JSON.stringify({ phase: 'classroom-loaded', scenes: classroom.scenes.length }));
  report.contentVersion = classroom.generationPreview?.contentVersion ?? classroom.revision;

  await context.addInitScript(() => {
    window.__previewAudio = [];
    window.Audio = new Proxy(window.Audio, { construct(Target, args) {
      const audio = new Target(...args);
      window.__previewAudio.push(audio);
      return audio;
    } });
    window.__visibleCues = [];
    window.__previewPhase = 'initial';
    let observedNodes = new WeakMap();
    const insertedNodes = new WeakMap();
    new MutationObserver((mutations) => {
      for (const mutation of mutations) for (const added of mutation.addedNodes) {
        if (!(added instanceof Element)) continue;
        for (const node of [added, ...added.querySelectorAll('[data-visual-cue]')]) {
          if (!node.matches('[data-visual-cue]')) continue;
          const audio = window.__previewAudio.findLast((item) => !item.paused && !item.ended && item.duration > 0.3);
          insertedNodes.set(node, { domInsertedAt: performance.now(), domInsertedAudioTime: audio?.currentTime });
        }
      }
    }).observe(document, { childList: true, subtree: true });
    window.__previewResetObservations = () => { observedNodes = new WeakMap(); };
    setInterval(() => {
      for (const node of document.querySelectorAll('[data-visual-cue], [data-whiteboard-element-id]')) {
        const visualNode = node.hasAttribute('data-whiteboard-element-id') ? node.firstElementChild ?? node : node;
        const rect = visualNode.getBoundingClientRect();
        const style = getComputedStyle(visualNode);
        if (rect.width <= 0 || rect.height <= 0 || !visualNode.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || Number(style.opacity) < 0.1 || style.visibility === 'hidden' || style.display === 'none') continue;
        const sceneId = document.querySelector('[data-stage-host-mode]')?.getAttribute('data-active-scene-id');
        const kind = node.getAttribute('data-visual-cue') ?? 'whiteboard';
        const audio = window.__previewAudio.findLast((item) => !item.paused && !item.ended && item.duration > 0.3);
        if (kind !== 'whiteboard' && !audio) continue;
        const targetId = node.getAttribute('data-visual-target-id');
        const signature = `${sceneId}:${kind}:${targetId}:${audio?.src}`;
        if (observedNodes.get(node) === signature) continue;
        observedNodes.set(node, signature);
        window.__visibleCues.push({ ...insertedNodes.get(node), kind, sceneId, targetId, phase: window.__previewPhase, at: performance.now(), width: rect.width, height: rect.height, audioTime: audio?.currentTime, audioUrl: audio?.src, playbackRate: audio?.playbackRate });
      }
    }, 30);
  });
  page = await context.newPage();
  page.on('pageerror', (error) => report.errors.push(error.message));
  // A requested job can be inspected in the real teacher player without changing
  // which classroom is linked to the course. Every payload still comes from its
  // real authorized API; no action/audio content is manufactured by this script.
  if (classroomOverride || whiteboardFixture) await page.route('**/api/openmaic/classroom?*', async (route) => {
    const response = await context.request.get(`${baseUrl}/api/openmaic/classroom?id=${encodeURIComponent(classroomId)}`);
    if (whiteboardFixture) {
      const payload = await response.json();
      await route.fulfill({ status: response.status(), contentType: 'application/json', body: JSON.stringify({ ...payload, classroom: applyBrowserFixture(payload.classroom) }) });
    } else await route.fulfill({ response });
  });
  const navigation = await page.goto(`${baseUrl}/teacher/prepare/${courseId}/preview?view=student`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  assert.ok(navigation?.ok(), `Preview navigation failed: ${navigation?.status()}`);
  const host = page.locator('[data-stage-host-mode="teacher-preview"]');
  await host.waitFor({ timeout: 90_000 });
  console.log(JSON.stringify({ phase: 'preview-mounted' }));
  const speeches = classroom.scenes.flatMap((scene) => (scene.actions ?? []).filter((action) => action.type === 'speech' && action.text?.trim()));
  assert.ok(speeches.length > 0, 'No narrated speech');
  assert.ok(speeches.every((speech) => speech.audioUrl && !speech.audioInvalidated), 'Some narration still lacks durable audio');
  const reusedUrls = new Set();
  for (const previous of reusedBaseline) {
    const current = speeches.find((speech) => speech.id === previous.id);
    assert.ok(current, `Accepted test speech disappeared: ${previous.id}`);
    assert.equal(current.text, previous.text, `Accepted test narration changed: ${previous.id}`);
    assert.equal(current.audioUrl, previous.audioUrl, `Accepted test audio URL changed: ${previous.id}`);
    reusedUrls.add(previous.audioUrl);
  }
  if (reusedUrls.size) {
    report.reusedAudio = await page.evaluate(async (audioUrls) => {
      const results = [];
      for (const url of audioUrls) {
        const response = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Reused audio HTTP ${response.status()}: ${url}`);
        const bytes = await response.arrayBuffer();
        if (!bytes.byteLength) throw new Error(`Reused audio is empty: ${url}`);
        results.push({ url, status: response.status, bytes: bytes.byteLength });
      }
      return results;
    }, [...reusedUrls]);
    report.reusedAudioValidation = 'Exact accepted speech IDs/text/URLs retained and all reused audio bodies load; prior decode evidence reused.';
  }
  const urls = [...new Set(speeches.map((speech) => speech.audioUrl))].filter((url) => !reusedUrls.has(url));
  if (process.argv.includes('--playback-only')) report.audioValidation = 'Skipped bulk decode for targeted playback regression; actual played narration still uses native audio.';
  else report.audio = await page.evaluate(async (audioUrls) => {
    const decoder = new AudioContext();
    const results = [];
    try {
      for (const url of audioUrls) {
        const response = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Audio HTTP ${response.status()}: ${url}`);
        const bytes = await response.arrayBuffer();
        const decoded = await decoder.decodeAudioData(bytes.slice(0));
        if (!(decoded.duration > 0)) throw new Error(`Audio has no decoded duration: ${url}`);
        results.push({ url, bytes: bytes.byteLength, duration: decoded.duration, sampleRate: decoded.sampleRate });
      }
    } finally { await decoder.close(); }
    return results;
  }, urls);

  console.log(JSON.stringify({ phase: process.argv.includes('--playback-only') ? 'bulk-audio-decode-skipped' : 'audio-decoded', count: report.audio.length }));
  if (process.argv.includes('--audio-only')) {
    report.passed = true;
    report.validation = 'authorized API and all audio decoded; playback controls/cues not checked';
  } else {
  await host.getByTestId('scene-list').waitFor({ state: 'visible', timeout: 90_000 });
  const narrated = classroom.scenes.filter((scene) => scene.type === 'slide' && (scene.actions ?? []).some((action) => action.type === 'speech' && action.audioUrl));
  const targetScenes = new Map();
  for (const kind of ['laser', 'spotlight', 'whiteboard']) {
    const scene = narrated.find((item) => item.actions.some((action) => kind === 'whiteboard' ? action.type.startsWith('wb_draw_') : action.type === kind));
    if (scene) targetScenes.set(scene.id, scene);
  }
  assert.ok(targetScenes.size, 'No authored teaching cues to verify');
  const firstContinued = reusedSpeechIds.size ? narrated.find((scene) => scene.actions.some((action) => action.type === 'speech' && !reusedSpeechIds.has(action.id))) : undefined;
  if (firstContinued) targetScenes.set(firstContinued.id, firstContinued);
  const requestedOutlineId = arg('--check-outline-id');
  if (requestedOutlineId) {
    const requestedScene = narrated.find((scene) => scene.outlineId === requestedOutlineId);
    assert.ok(requestedScene, `Narrated slide not found for outline ${requestedOutlineId}`);
    targetScenes.set(requestedScene.id, requestedScene);
  }
  targetScenes.set(narrated[0].id, narrated[0]);
  targetScenes.set(narrated.at(-1).id, narrated.at(-1));
  let testedControls = false;
  for (const scene of targetScenes.values()) {
    console.log(JSON.stringify({ phase: "playing-scene", id: scene.id, index: classroom.scenes.findIndex((item) => item.id === scene.id) }));
    const index = classroom.scenes.findIndex((item) => item.id === scene.id);
    await host.getByTestId('scene-item').nth(index).click();
    await expect(host).toHaveAttribute('data-active-scene-id', scene.id);
    // Let outgoing overlay exit animations finish before observing the new page.
    await page.waitForTimeout(400);
    await page.evaluate((id) => { window.__visibleCues = window.__visibleCues.filter((cue) => cue.sceneId !== id); window.__previewResetObservations(); }, scene.id);
    const autoPlay = host.getByRole('button', { name: /^(Auto-play|自动)$/ });
    if (await autoPlay.count() && await autoPlay.getAttribute('aria-pressed') === 'true') await autoPlay.click();
    await host.getByRole('button', { name: /^(Play|继续讲解)$/ }).click();
    await page.waitForFunction(() => window.__previewAudio.some((audio) => !audio.paused && audio.duration > 0.3 && audio.currentTime > 0.1), undefined, { timeout: 30_000 });
    if (!testedControls) {
      await host.getByRole('button', { name: /^(Pause|暂停讲解)$/ }).click();
      await page.waitForFunction(() => window.__previewAudio.every((audio) => audio.paused || audio.ended));
      const paused = await page.evaluate(() => window.__previewAudio.map((audio) => audio.currentTime));
      await page.waitForTimeout(500);
      const stillPaused = await page.evaluate(() => window.__previewAudio.map((audio) => audio.currentTime));
      assert.deepEqual(stillPaused, paused, 'Audio continued during pause');
      await host.getByRole('button', { name: /^(Play|继续讲解)$/ }).click();
      await page.waitForFunction(() => window.__previewAudio.some((audio) => !audio.paused && audio.currentTime > 0.1));
      const speed = host.getByRole('button', { name: /^(Playback speed|切换播放倍速)$/ });
      await speed.click();
      const requestedSpeed = parseFloat(await speed.innerText());
      await page.waitForFunction((rate) => window.__previewAudio.some((audio) => !audio.paused && Math.abs(audio.playbackRate - rate) < 0.01), requestedSpeed);
      report.controls = { pause: true, resume: true, playbackRate: requestedSpeed };
      await page.evaluate(() => { window.__previewPhase = 'after-pause-resume-speed'; });
      const other = narrated.find((item) => item.id !== scene.id);
      if (other) {
        await host.getByRole('button', { name: /^(Pause|暂停讲解)$/ }).click();
        await host.getByTestId('scene-item').nth(classroom.scenes.findIndex((item) => item.id === other.id)).click();
        await expect(host).toHaveAttribute('data-active-scene-id', other.id);
        await host.getByTestId('scene-item').nth(index).click();
        await expect(host).toHaveAttribute('data-active-scene-id', scene.id);
        await page.waitForTimeout(400);
        await page.evaluate(() => window.__previewResetObservations());
        await host.getByRole('button', { name: /^(Play|继续讲解)$/ }).click();
        await page.waitForFunction((rate) => window.__previewAudio.some((audio) => !audio.paused && audio.currentTime > 0.1 && Math.abs(audio.playbackRate - rate) < 0.01), requestedSpeed);
        report.controls.jumpAwayAndBack = true;
      }
      testedControls = true;
    }
    const required = [...new Set(scene.actions.flatMap((action) => ['laser', 'spotlight'].includes(action.type) ? [action.type] : action.type.startsWith('wb_draw_') ? ['whiteboard'] : []))];
    const duration = scene.actions.filter((action) => action.type === 'speech').reduce((sum, action) => sum + (action.audioDurationSec ?? 30), 0);
    if (required.length) await page.waitForFunction(({ id, kinds }) => kinds.every((kind) => window.__visibleCues.some((cue) => cue.sceneId === id && cue.kind === kind && (kind !== 'spotlight' || cue.phase === 'after-pause-resume-speed'))), { id: scene.id, kinds: required }, { timeout: Math.max(30_000, Math.ceil(duration * 1000 + 15_000)) });
    const visible = await page.evaluate((id) => window.__visibleCues.filter((cue) => cue.sceneId === id), scene.id);
    const synchronizedSpotlights = visible.filter((cue) => cue.kind === 'spotlight' && cue.audioUrl).flatMap((cue) => {
      const candidates = scene.actions.filter((action) => action.type === 'spotlight' && action.elementId === cue.targetId).flatMap((action) => {
        const speech = scene.actions.find((item) => item.id === action.speechId && item.type === 'speech');
        if (!speech?.audioUrl || new URL(speech.audioUrl, baseUrl).href !== cue.audioUrl || !Number.isFinite(action.speechOffsetMs)) return [];
        return [{ actionId: action.id, speechId: speech.id, expectedMs: action.speechOffsetMs, actualMs: cue.audioTime * 1000, deltaMs: Math.abs(cue.audioTime * 1000 - action.speechOffsetMs), playbackRate: cue.playbackRate, phase: cue.phase }];
      });
      const closest = candidates.sort((left, right) => left.deltaMs - right.deltaMs)[0];
      return closest ? [closest] : [];
    });
    report.scenes.push({ id: scene.id, index, required, visible, synchronizedSpotlights, audioStarted: true });
    if (required.includes('spotlight')) {
      assert.ok(synchronizedSpotlights.some((cue) => cue.deltaMs <= 500), `No spotlight synchronized within 500ms on ${scene.id}`);
    }
    const pause = host.getByRole('button', { name: /^(Pause|暂停讲解)$/ });
    if (await pause.isVisible()) await pause.click();
    if (whiteboardFixture && required.includes('whiteboard')) {
      const note = host.locator(`[data-whiteboard-element-id="${fixtureBoardId}"] > :first-child`);
      await expect(note).toBeVisible();
      await page.waitForFunction(() => window.__previewAudio.every((audio) => audio.paused || audio.ended));
      await page.waitForTimeout(500);
      await expect(note).toBeVisible();
      const other = narrated.find((item) => item.id !== scene.id);
      assert.ok(other, 'Whiteboard fixture needs another scene');
      await host.getByTestId('scene-item').nth(classroom.scenes.findIndex((item) => item.id === other.id)).click();
      await expect(host).toHaveAttribute('data-active-scene-id', other.id);
      await expect(note).not.toBeVisible();
      report.whiteboardControls = { visibleWhilePaused: true, audioPaused: true, clearedOnSceneSwitch: true, browserOnlyFixture: true };
    }
  }
  report.controls.sceneNavigation = report.scenes.length > 1;
  const allSync = report.scenes.flatMap((scene) => scene.synchronizedSpotlights ?? []);
  if (report.scenes.some((scene) => scene.required.includes('spotlight'))) {
    assert.ok(allSync.some((cue) => cue.phase === 'after-pause-resume-speed' && cue.deltaMs <= 500), 'No synchronized spotlight after pause/resume and speed change');
  }
  assert.equal(report.errors.length, 0, `Browser errors: ${report.errors.join('; ')}`);
  report.passed = true;
  }
} catch (error) {
  report.passed = false;
  report.failure = error instanceof Error ? error.message : String(error);
  report.failureStack = error instanceof Error ? error.stack : undefined;
  if (page) report.audioAtFailure = await page.evaluate(() => window.__previewAudio?.map((audio) => ({ src: audio.src, duration: audio.duration, currentTime: audio.currentTime, paused: audio.paused, ended: audio.ended, error: audio.error?.message }))).catch(() => []);
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  console.log(JSON.stringify({ passed: report.passed, decodedAudio: report.audio.length, testedScenes: report.scenes.length, report: path.join(output, 'report.json'), failure: report.failure }));
}
