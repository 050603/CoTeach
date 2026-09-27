import { capacityEvidenceDirectory } from './capacity-evidence-paths.mjs';
import { retainLearningAcknowledgement } from './verify-capacity-learning-records.mjs';
/** Real browser projection checks against the capacity runner's isolated fixture.
 * No route interception, response mocks, credential files, or production fixture edits.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { capacityBrowserEnvironment } from './capacity-network.mjs';

export const projectionSlideText = '投屏验收：同等条件下比较测量证据';

/** Add scene to classroom.scenes, outline to design.content._openmaicSceneOutlines,
 * and sceneId to fixture.projectionSceneId. Do not add to student lecture sections.
 */
export function seedCapacityProjectionScene({ runId }) {
  assert.match(runId, /^capacity-[0-9a-f-]{36}$/);
  const sceneId = `${runId}-projection-slide`;
  return {
    sceneId,
    // The teacher's lesson selector indexes student-facing outline metadata;
    // the runtime scene itself is teacher-only, outside required student progress.
    outline: { id: sceneId, type: 'slide', title: '投屏恢复验收', stageKey: 'ai-learning', audience: 'student', knowledgePointIds: ['energy'], order: 99 },
    scene: {
      id: sceneId, outlineId: sceneId, type: 'slide', title: '投屏恢复验收', order: 99,
      stageKey: 'ai-learning', audience: 'teacher', generationPurpose: 'teacher-resource', actions: [],
      content: { type: 'slide', schemaVersion: 1, canvas: {
        id: sceneId, viewportSize: 1000, viewportRatio: 0.5625,
        theme: { fontName: 'Noto Sans SC', fontColor: '#163B3C', themeColor: '#163B3C', backgroundColor: '#ffffff' },
        background: { type: 'solid', color: '#ffffff' },
        elements: [{ id: `${sceneId}-text`, type: 'text', left: 60, top: 180, width: 880, height: 120, rotate: 0,
          content: `<p style="font-size:36px">${projectionSlideText}</p>`, defaultFontName: 'Noto Sans SC', defaultColor: '#163B3C' }],
      } },
    },
  };
}

const cookieValues = (cookie, origin) => cookie.split(';').map(item => {
  const separator = item.indexOf('=');
  assert.ok(separator > 0, 'Expected in-memory session cookies');
  return { name: item.slice(0, separator).trim(), value: item.slice(separator + 1).trim(), url: origin };
});

/** Record only IDs explicitly acknowledged by the real telemetry endpoint.
 * Duplicates whose original response was lost remain visible in DB reconciliation
 * as extra facts; a successful retry must not invent an acknowledgement for a
 * new event ID that reused an older event's idempotency key.
 */
export function captureCapacityBrowserEvents(page, { user, fixture, expected }) {
  const pending = new Set();
  const failures = [];
  if (!expected || user.role !== 'student') return async () => {};
  page.on('requestfinished', req => {
    if (req.method() !== 'POST' || new URL(req.url()).pathname !== '/api/learning-events') return;
    const task = (async () => {
      const body = req.postDataJSON();
      if (body?.courseId !== fixture.instanceId || body.studentId !== user.id || !Array.isArray(body.events)) return;
      const response = await req.response();
      if (!response?.ok()) return;
      const ack = await response.json();
      assert.ok(Array.isArray(ack.acceptedIds), 'Successful telemetry response has no acceptedIds');
      const state = expected.get(user.id);
      if (!state) return;
      const ids = new Set(body.events.filter(event => event.courseId === fixture.instanceId && event.studentId === user.id).map(event => event.id));
      state.browserEvents ??= [];
      for (const event of body.events.filter(event => ids.has(event.id))) retainLearningAcknowledgement(state, event, ack, 'browserEventReceipts');
      for (const id of ack.acceptedIds) {
        if (typeof id === 'string' && ids.has(id) && !state.browserEvents.includes(id)) state.browserEvents.push(id);
      }
    })().catch(error => { if (error?.code === 'ERR_ASSERTION') failures.push(error); /* Closed contexts may discard response bodies; other observed ACKs remain mandatory. */ });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  return async () => { await Promise.allSettled([...pending]); assert.deepEqual(failures, [], 'Browser learning-event acknowledgement validation failed'); };
}

export async function verifyCapacityProjectionBrowser({ users, fixture, origin, request, record, browserArgs = [], connectAddress, expected }) {
  const teachers = users.filter(user => user.role === 'teacher');
  const students = users.filter(user => user.role === 'student').slice(0, 2);
  assert.equal(teachers.length, 2);
  assert.equal(students.length, 2);
  assert.ok(fixture.projectionSceneId, 'Seed the teacher-only projection scene before publishing the fixture');
  assert.ok(fixture.classroomId.startsWith('capacity-'), 'Only capacity-owned classrooms may be used');
  const endpoint = `/api/courses/${fixture.instanceId}`;
  const readState = () => request(teachers[0], 'GET', `${endpoint}/state`, undefined, { category: 'projection-browser-state' });
  const act = (actor, type, payload) => request(actor, 'POST', `${endpoint}/actions`, { requestId: randomUUID(), action: { type, payload } }, { category: 'projection-browser-action' });
  const original = (await readState()).course;
  const stageIndex = original.stages.findIndex(stage => stage.key === 'ai-learning');
  assert.ok(stageIndex >= 0);
  const clientId = `browser-${randomUUID()}`;
  const project = (sceneId, sceneType, title) => act(teachers[0], 'SET_UI_STATE', {
    courseId: fixture.instanceId, projectionControl: { clientId, takeover: true },
    patch: { resourceProjection: null, teacherResourceProjection: {
      classroomId: fixture.classroomId, sceneId, sceneType, stageKey: 'ai-learning', title,
      startedAt: new Date().toISOString(), mode: 'forced', engineMode: 'idle',
      playback: { sceneId, sceneIndex: 0, actionIndex: 0, consumedDiscussions: [] },
    } },
  });
  let browser;
  const errors = [];
  const observerWrites = [];
  const flushTelemetry = [];
  const sessions = [];
  const result = { browsers: { student: 2, observerTeacher: 1 }, leadTeacher: 'authenticated HTTP actions', mocks: false };
  try {
    await act(teachers[0], 'SET_STAGE', { id: fixture.instanceId, index: stageIndex });
    const initial = await project(fixture.projectionSceneId, 'slide', '投屏浏览器验收：初始页面');
    const initialVersion = initial.projection.projectionVersion;
    browser = await chromium.launch({ headless: true, args: browserArgs, env: capacityBrowserEnvironment() });
    const open = async (user, route) => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await context.addCookies(cookieValues(user.cookie, origin));
      // Track actual sockets only to close an established TCP connection during
      // the offline fault. Chromium's offline mode alone can leave existing WS alive.
      await context.addInitScript(() => {
        const sockets = new Set();
        const NativeWebSocket = window.WebSocket;
        window.WebSocket = class extends NativeWebSocket {
          constructor(...args) {
            super(...args); sockets.add(this);
            this.addEventListener('close', () => sockets.delete(this));
          }
        };
        window.__capacityCloseSockets = () => {
          const count = sockets.size;
          for (const socket of sockets) socket.close();
          return count;
        };
      });
      const page = await context.newPage();
      sessions.push({ user, page });
      flushTelemetry.push(captureCapacityBrowserEvents(page, { user, fixture, expected }));
      page.on('pageerror', error => errors.push({ role: user.role, message: error.message }));
      if (user.role === 'teacher') page.on('request', req => {
        if (new URL(req.url()).pathname !== `${endpoint}/actions` || req.method() !== 'POST') return;
        const action = req.postDataJSON()?.action;
        if (action?.type === 'SET_UI_STATE' && ['teacherResourceProjection', 'resourceProjection'].some(key => Object.hasOwn(action.payload?.patch ?? {}, key))) observerWrites.push(action.type);
      });
      const response = await page.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      assert.equal(response.status(), 200);
      if (connectAddress) assert.equal((await response.serverAddr())?.ipAddress.replace(/^::ffff:/, ''), connectAddress, 'Projection browsers must use the internal address');
      return { context, page };
    };
    const followers = await Promise.all(students.map(student => open(student, `/student/classroom/${fixture.instanceId}`)));
    await Promise.all(followers.map(async ({ page }) => {
      await page.locator('[data-openpbl-embed][data-projection-version]').waitFor({ state: 'visible', timeout: 15000 });
      assert.equal(await page.locator('[data-stage-host-mode="student"]').count(), 0,
        'Personal learning must unmount while forced teacher projection owns the shared player');
    }));
    const waitProjection = async (page, version, text, timeout = 10000) => {
      await page.waitForFunction(({ version, text }) => {
        const surface = document.querySelector('[data-openpbl-embed][data-projection-version]');
        return surface && Number(surface.getAttribute('data-projection-version')) >= version && surface.textContent.includes(text);
      }, { version, text }, { timeout });
      await page.locator('[data-openpbl-embed][data-projection-version]').getByText(text, { exact: true }).first().waitFor({ state: 'visible', timeout });
    };
    await Promise.all(followers.map(({ page }) => waitProjection(page, initialVersion, projectionSlideText, 30000)));
    record('projection-real-browser-initial-slide', '通过', { ...result, version: initialVersion });

    const observer = await open(teachers[1], `/teacher/teach/${fixture.instanceId}/classroom`);
    await observer.page.getByLabel('自主选择知识讲授PPT页面').selectOption(fixture.projectionSceneId, { timeout: 30000 });
    await observer.page.getByRole('region', { name: '补讲页面调用区' }).getByText(projectionSlideText, { exact: true }).first().waitFor({ state: 'visible', timeout: 30000 });
    await observer.page.getByRole('button', { name: '接管并投屏', exact: true }).first().waitFor({ state: 'visible' });
    await delay(2500);
    assert.deepEqual(observerWrites, [], 'Opening the observing teacher player must not publish projection state');
    const observed = (await readState()).course.uiState;
    assert.equal(observed.projectionVersion, initialVersion);
    assert.deepEqual(observed.projectionController, { teacherId: teachers[0].id, clientId });
    record('projection-observer-player-does-not-write', '通过', { observerProjectionWrites: observerWrites.length });

    const disconnected = followers[0];
    await disconnected.context.setOffline(true);
    const closedSockets = await disconnected.page.evaluate(() => window.__capacityCloseSockets());
    const offlineStarted = performance.now();
    const latest = await project(fixture.quizId, 'quiz', '投屏浏览器验收：断网期间切换测验');
    const latestVersion = latest.projection.projectionVersion;
    // The teacher selected this quiz without starting an attempt. The real
    // projected player therefore shows its introduction, not a question body.
    const quizText = 'Test your knowledge';
    await waitProjection(followers[1].page, latestVersion, quizText);
    await delay(Math.max(0, 60000 - (performance.now() - offlineStarted)));
    const staleVersion = await disconnected.page.locator('[data-course-projection-version]').getAttribute('data-course-projection-version');
    assert.equal(Number(staleVersion), initialVersion, 'Offline browser must remain disconnected from real projection events');
    const offlineMs = performance.now() - offlineStarted;
    const reconnectStarted = performance.now();
    await disconnected.context.setOffline(false);
    await waitProjection(disconnected.page, latestVersion, quizText, 10000);
    const recoveryMs = performance.now() - reconnectStarted;
    assert.ok(recoveryMs <= 10000, `Projection recovery exceeded 10 seconds: ${recoveryMs}`);
    assert.deepEqual(observerWrites, []);
    assert.deepEqual(errors, [], 'No uncaught browser runtime exceptions');
    Object.assign(result, { offlineMs: Math.round(offlineMs), recoveryMs: Math.round(recoveryMs), initialVersion, latestVersion, closedSockets, observerProjectionWrites: observerWrites.length });
    record('projection-browser-offline-60s-recovery-under-10s', '通过', { ...result });

    // Only this explicit user action is allowed to turn the observer into a
    // writer. The preceding assertions must continue to require zero writes.
    const takeoverStarted = performance.now();
    await observer.page.getByRole('region', { name: '补讲页面调用区' }).getByRole('button', { name: '接管并投屏', exact: true }).click();
    let takenOver;
    const takeoverDeadline = performance.now() + 15000;
    do {
      const state = await request(teachers[0], 'GET', `${endpoint}/state`, undefined, { category: 'projection-browser-state', timeout: 5000 });
      const owner = state.course.uiState?.projectionController;
      if (owner?.teacherId === teachers[1].id && typeof owner.clientId === 'string' && owner.clientId.trim()) {
        takenOver = state.course.uiState;
        break;
      }
      await delay(150);
    } while (performance.now() < takeoverDeadline);
    assert.ok(takenOver, 'Explicit teacher takeover must persist a new teacher and browser controller');
    assert.ok(observerWrites.length > 0, 'The explicit takeover should publish projection state');
    assert.notEqual(takenOver.projectionController.clientId, clientId);
    await Promise.all(followers.map(({ page }) => waitProjection(page, takenOver.projectionVersion, projectionSlideText)));
    assert.deepEqual(errors, [], 'No uncaught browser runtime exceptions after explicit takeover');
    const takeover = { teacherId: teachers[1].id, controllerBound: true, projectionVersion: takenOver.projectionVersion,
      observerProjectionWrites: observerWrites.length, takeoverMs: Math.round(performance.now() - takeoverStarted), studentBrowsersFollowing: followers.length };
    Object.assign(result, { takeover });
    record('projection-observer-explicit-takeover', '通过', takeover);
    return result;
  } catch (error) {
    const diagnosticDirectory = path.join(capacityEvidenceDirectory(fixture.classroomId.replace(/-lesson$/, '')), 'projection-browser-diagnostics');
    await mkdir(diagnosticDirectory, { recursive: true }).catch(() => {});
    const pages = await Promise.all(sessions.map(async ({ user, page }) => {
      try {
        const screenshot = path.join(diagnosticDirectory, `${user.role}-${user.id}.png`);
        const screenshotSaved = await page.screenshot({ path: screenshot, timeout: 3000 }).then(() => true, () => false);
        return { userId: user.id, role: user.role, url: page.url(), title: await page.title(),
          ...(screenshotSaved ? { screenshot } : {}),
          body: (await page.locator('body').innerText({ timeout: 3000 })).slice(0, 1800),
          surfaces: await page.locator('[data-openpbl-embed], [data-projection-version], [data-course-projection-version]').evaluateAll(nodes => nodes.map(node => ({ tag: node.tagName, attributes: Object.fromEntries([...node.attributes].map(attr => [attr.name, attr.value])), text: node.textContent?.slice(0, 500) }))) };
      } catch (diagnosticError) { return { userId: user.id, diagnosticError: String(diagnosticError) }; }
    }));
    record('projection-browser-acceptance', '未通过', { message: error.message, errors, observerProjectionWrites: observerWrites.length, pages });
    throw error;
  } finally {
    await browser?.close();
    await Promise.allSettled(flushTelemetry.map(flush => flush()));
    // Restore the fixture stage and projection/controller so the parent's soak
    // starts from its own state and does not inherit this helper's controller.
    await act(teachers[0], 'SET_STAGE', { id: fixture.instanceId, index: original.currentStageIndex });
    const oldController = original.uiState?.projectionController;
    const restoreActor = teachers.find(teacher => teacher.id === oldController?.teacherId) ?? teachers[0];
    await act(restoreActor, 'SET_UI_STATE', { courseId: fixture.instanceId,
      projectionControl: { clientId: oldController?.clientId ?? clientId, takeover: true },
      patch: { teacherResourceProjection: original.uiState?.teacherResourceProjection ?? null, resourceProjection: original.uiState?.resourceProjection ?? null },
    });
    const restored = (await readState()).course;
    assert.equal(restored.currentStageIndex, original.currentStageIndex);
    assert.equal(restored.uiState?.teacherResourceProjection?.sceneId ?? null, original.uiState?.teacherResourceProjection?.sceneId ?? null);
    assert.equal(restored.uiState?.resourceProjection?.resourceId ?? null, original.uiState?.resourceProjection?.resourceId ?? null);
    const hadProjection = Boolean(original.uiState?.teacherResourceProjection || original.uiState?.resourceProjection);
    assert.deepEqual(restored.uiState?.projectionController ?? null, hadProjection
      ? { teacherId: restoreActor.id, clientId: oldController?.clientId ?? clientId }
      : null, 'Stopping both projections must release the browser controller before the API soak');
    record('projection-browser-state-restored', '通过', { stageIndex: restored.currentStageIndex, controllerReleased: !restored.uiState?.projectionController,
      confirmedBrowserEvents: students.reduce((sum, student) => sum + (expected?.get(student.id)?.browserEvents?.length ?? 0), 0) });
  }
}
