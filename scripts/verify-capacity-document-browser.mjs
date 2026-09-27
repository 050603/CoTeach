/** Real document editor checks on fixture-owned students. No response interception. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { capacityBrowserEnvironment } from './capacity-network.mjs';
import { captureCapacityBrowserEvents } from './verify-capacity-projection-browser.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);

/** Out-of-order response parsing must never regress the acknowledged manifest. */
export function createDocumentSaveCollector({ state, userId, courseId }) {
  assert.ok(state.submissionId && Number.isSafeInteger(state.version));
  const initialVersion = state.version;
  const observed = new Map();
  let applied = 0;
  const snapshot = () => [...observed.values()].sort((a, b) => a.ack.submissionVersion - b.ack.submissionVersion);
  return {
    accept(body, ack) {
      assert.equal(body?.action?.type, 'UPSERT_SUBMISSION');
      const payload = body.action.payload;
      const submission = payload.submission;
      assert.equal(payload.courseId, courseId); assert.equal(submission.courseId, courseId);
      assert.equal(submission.studentId, userId); assert.equal(submission.id, state.submissionId);
      assert.equal(submission.stageKey, 'make'); assert.equal(submission.type, 'document');
      assert.equal(typeof submission.content, 'string');
      assert.ok(typeof body.requestId === 'string' && body.requestId.length > 0);
      assert.equal(ack.requestId, body.requestId);
      assert.ok(Number.isSafeInteger(ack.submissionVersion) && ack.submissionVersion > initialVersion);
      assert.equal(payload.expectedSubmissionVersion + 1, ack.submissionVersion);
      const previous = observed.get(body.requestId);
      if (previous) { assert.deepEqual(previous.body, body); assert.deepEqual(previous.ack, ack); return false; }
      assert.ok(!snapshot().some(item => item.ack.submissionVersion === ack.submissionVersion), 'Two requests claim the same saved version');
      assert.equal(state.version, initialVersion + applied, 'A protocol writer changed this student during the browser check');
      observed.set(body.requestId, { body: clone(body), ack: clone(ack), receivedAt: new Date().toISOString() });
      for (;;) {
        const next = snapshot().find(item => item.ack.submissionVersion === initialVersion + applied + 1);
        if (!next) break;
        const content = next.body.action.payload.submission.content;
        const receipt = { requestId: next.body.requestId, version: next.ack.submissionVersion, contentSha256: digest(content) };
        state.receipts ??= [];
        assert.ok(!state.receipts.some(item => item.requestId === receipt.requestId), 'Browser save overlaps an existing receipt');
        state.receipts.push(receipt);
        state.browserSaves ??= []; state.browserSaves.push(receipt);
        state.saves++; state.version = next.ack.submissionVersion; state.content = content;
        state.groupId = next.body.action.payload.submission.groupId;
        state.lastAction = clone(next.body.action); state.lastRequestId = next.body.requestId; state.lastAck = clone(next.ack);
        applied++;
      }
      return true;
    },
    snapshot,
    assertComplete() { assert.equal(applied, observed.size, 'Acknowledged browser saves contain a version gap'); },
  };
}

export function captureDocumentBrowserTraffic(page, { user, fixture, expected, question, expectedNetworkFailure = () => false }) {
  const state = expected.get(user.id);
  const saves = createDocumentSaveCollector({ state, userId: user.id, courseId: fixture.instanceId });
  const pending = new Set(); const inFlight = new Set(); const errors = [];
  const aiRequests = new Map(); const traffic = [];
  const actionPath = `/api/courses/${fixture.instanceId}/actions`;
  const aiPath = '/api/ai-collaboration/document';
  const eventPath = '/api/ai-collaboration/events';
  const relevant = req => req.method() === 'POST' && [actionPath, aiPath, eventPath].includes(new URL(req.url()).pathname);
  const fail = error => errors.push(error instanceof Error ? error : new Error(String(error)));
  const onRequest = req => {
    if (!relevant(req)) return;
    inFlight.add(req);
    try {
      const body = req.postDataJSON();
      if (new URL(req.url()).pathname === aiPath && body?.action === 'proactive-document-comments') {
        assert.ok(body.requestId, 'Automatic review must persist a stable request ID before sending');
        assert.equal(body.courseId, fixture.instanceId); assert.equal(body.studentId, user.id);
        state.browserReviewRequests ??= [];
        const previous = state.browserReviewRequests.find(item => item.requestId === body.requestId);
        if (previous) assert.deepEqual(previous.body, body);
        else state.browserReviewRequests.push({ requestId: body.requestId, body: clone(body), status: 'processing' });
        return;
      }
      if (new URL(req.url()).pathname !== aiPath || body?.message !== question || body?.action) return;
      assert.equal(body.courseId, fixture.instanceId); assert.equal(body.studentId, user.id);
      assert.equal(body.stageKey, 'make'); assert.equal(body.workspaceKind, 'document'); assert.equal(body.intent, 'discuss');
      assert.ok(typeof body.requestId === 'string' && body.requestId.length > 0);
      const previous = aiRequests.get(body.requestId);
      if (previous) { assert.deepEqual(previous.body, body); return; }
      const entry = { requestId: body.requestId, status: 'processing', startedAt: Date.now(),
        messageSha256: digest(body.message), documentSha256: digest(body.documentHtml),
        documentVersion: digest(JSON.stringify(body.documentHtml)), requestConversationId: body.conversationId };
      state.browserDocumentRequests ??= [];
      assert.ok(!state.browserDocumentRequests.some(item => item.requestId === entry.requestId));
      state.browserDocumentRequests.push(entry);
      aiRequests.set(entry.requestId, { body: clone(body), entry });
    } catch (error) { fail(error); }
  };
  const onFinished = req => {
    const url = new URL(req.url());
    if (!relevant(req) && !(req.method() === 'GET' && url.pathname === aiPath && aiRequests.has(url.searchParams.get('requestId')))) return;
    const task = (async () => {
      const response = await req.response();
      assert.ok(response, 'Tracked browser response is unavailable');
      const payload = await response.json();
      const body = req.method() === 'POST' ? req.postDataJSON() : undefined;
      traffic.push({ path: url.pathname, method: req.method(), status: response.status(), requestId: body?.requestId ?? url.searchParams.get('requestId'), action: body?.action?.type ?? body?.action });
      if (url.pathname === eventPath) {
        assert.ok(response.ok() && payload.ok && payload.event?.id, 'Browser interaction event lacks a committed acknowledgement');
        assert.equal(body.courseId, fixture.instanceId); assert.equal(body.studentId, user.id);
        assert.equal(payload.event.requestId, body.requestId); assert.equal(payload.event.studentId, user.id);
        state.browserInteractionEvents ??= [];
        const previous = state.browserInteractionEvents.find(item => item.eventId === payload.event.id);
        const receipt = { eventId: payload.event.id, requestId: body.requestId, body: clone(body), ack: clone(payload.event) };
        if (previous) assert.deepEqual(previous, receipt);
        else state.browserInteractionEvents.push(receipt);
      }
      if (url.pathname === actionPath && body?.action?.type === 'UPSERT_SUBMISSION') {
        assert.ok(response.ok(), `Browser save returned HTTP ${response.status()}: ${payload.code ?? 'unknown'}`);
        saves.accept(body, payload);
      }
      const requestId = body?.requestId ?? url.searchParams.get('requestId');
      const review = url.pathname === aiPath && state.browserReviewRequests?.find(item => item.requestId === requestId);
      if (review) {
        review.attempts ??= []; review.attempts.push({ status: response.status(), state: payload.status });
        if (payload.status === 'completed') {
          assert.ok(response.ok()); assert.equal(payload.requestId, review.requestId);
          assert.equal(payload.documentVersion, digest(JSON.stringify(review.body.documentHtml)));
          assert.equal(payload.reviewDecision?.action, review.body.action);
          if (review.response) assert.deepEqual(review.response, payload);
          review.status = 'completed'; review.response = clone(payload);
        } else if (payload.status === 'cancelled') review.status = 'cancelled';
      }
      const tracked = url.pathname === aiPath && aiRequests.get(requestId);
      if (tracked) {
        if (payload.status === 'failed' || payload.status === 'cancelled') Object.assign(tracked.entry, {
          status: payload.status, completedAt: Date.now(), error: payload.error ?? payload.code ?? 'AI_REQUEST_FAILED',
        });
        assert.ok(response.ok(), `Browser AI returned HTTP ${response.status()}: ${payload.error ?? 'unknown'}`);
        if (response.status() === 202 || payload.status === 'processing') return;
        assert.equal(payload.requestId, requestId); assert.equal(payload.status, 'completed');
        assert.ok(payload.result?.message?.trim(), 'Browser AI response is empty');
        const assistant = payload.messages?.find(message => message.role === 'agent');
        const student = payload.messages?.find(message => message.role === 'student');
        assert.ok(assistant?.id && student?.id, 'Browser AI response lacks persisted message IDs');
        if (tracked.entry.status === 'completed') assert.equal(tracked.entry.responseSha256, digest(payload.result.message));
        Object.assign(tracked.entry, { status: 'completed', completedAt: Date.now(), conversationId: payload.conversationId,
          assistantMessageId: assistant.id, studentMessageId: student.id, responseSha256: digest(payload.result.message) });
      }
    })().catch(fail).finally(() => { inFlight.delete(req); pending.delete(task); });
    pending.add(task);
  };
  const onFailed = req => {
    if (!inFlight.has(req)) return;
    inFlight.delete(req);
    if (expectedNetworkFailure(req)) {
      traffic.push({ path: new URL(req.url()).pathname, method: req.method(), fault: 'injected-offline', error: req.failure()?.errorText });
      return;
    }
    fail(new Error(`Browser POST failed: ${new URL(req.url()).pathname}: ${req.failure()?.errorText ?? 'network error'}`));
  };
  page.on('request', onRequest); page.on('requestfinished', onFinished); page.on('requestfailed', onFailed);
  return {
    saves, errors, traffic,
    ai: () => [...aiRequests.values()].map(value => value.entry),
    assertHealthy() { if (errors.length) throw new AggregateError(errors, errors[0].message); },
    async drain(timeout = 30000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        await Promise.allSettled([...pending]);
        if (!inFlight.size && !pending.size) {
          await delay(200);
          if (!inFlight.size && !pending.size) break;
        }
        assert.ok(Date.now() < deadline, 'Browser mutations did not drain before closing the context');
        await delay(100);
      }
      saves.assertComplete();
      this.assertHealthy();
    },
    detach() { page.off('request', onRequest); page.off('requestfinished', onFinished); page.off('requestfailed', onFailed); },
  };
}

async function until(predicate, collector, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    collector.assertHealthy();
    if (await predicate()) return;
    assert.ok(Date.now() < deadline, message);
    await delay(100);
  }
}

export async function verifyCapacityDocumentBrowsers({ users, fixture, origin, request, record, expected,
  browserArgs = [], connectAddress }) {
  const runId = fixture.classroomId?.match(/^(capacity-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-|$)/)?.[1];
  assert.ok(runId, 'Only capacity fixture classrooms may be edited');
  const students = users.filter(user => user.role === 'student').slice(0, 2);
  assert.equal(students.length, 2); assert.ok(connectAddress);
  for (const user of students) {
    assert.match(user.id, /^[0-9a-f-]{36}$/);
    assert.ok(fixture.userIds.includes(user.id)); assert.match(user.username, new RegExp(`^${runId}-[0-9]+$`));
    assert.ok(expected.get(user.id)?.submissionId);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const output = path.join(root, 'test-results/capacity', runId, 'document-browsers');
  await mkdir(output, { recursive: true, mode: 0o700 });
  const browser = await chromium.launch({ headless: true, args: browserArgs, env: capacityBrowserEnvironment() });
  const verifyStudent = async user => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies(user.cookie.split(';').map(item => {
      const index = item.indexOf('='); assert.ok(index > 0);
      return { name: item.slice(0, index).trim(), value: item.slice(index + 1).trim(), url: origin };
    }));
    let page = await context.newPage();
    const question = `如何记录一次节能测量的条件，以便比较前后用电量？（浏览器核验 ${randomUUID()}）`;
    let offline = false;
    const track = () => captureDocumentBrowserTraffic(page, { user, fixture, expected, question,
      expectedNetworkFailure: req => offline && req.failure()?.errorText?.includes('ERR_INTERNET_DISCONNECTED') });
    let collector = track();
    let drainEvents = captureCapacityBrowserEvents(page, { user, fixture, expected });
    const state = expected.get(user.id); const originalDocumentRequestId = state.documentRequestId;
    const evidence = { userId: user.id, outcome: 'running', steps: [], sessions: [], pageErrors: [], networkFailures: [] };
    page.on('pageerror', error => evidence.pageErrors.push(error.message));
    page.on('requestfailed', req => evidence.networkFailures.push({ path: new URL(req.url()).pathname, reason: req.failure()?.errorText }));
    let failed;
    const checkPeer = async response => {
      assert.equal(response?.status(), 200);
      assert.equal((await response.serverAddr())?.ipAddress.replace(/^::ffff:/, ''), connectAddress, 'Browser must use the selected campus address');
    };
    const assertSaved = async marker => {
      await until(() => state.content.includes(marker), collector, 'The browser edit has no committed save acknowledgement');
      await expect(page.getByText('服务器已保存', { exact: true })).toBeVisible({ timeout: 30000 });
      await until(() => page.evaluate(scope => Object.keys(localStorage).filter(key => key.startsWith('openpbl:document-draft:v1:'))
        .map(key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }).every(value => value?.scope !== scope),
      `${fixture.instanceId}:${user.id}:make:document`), collector, 'Local document draft was not acknowledged');
    };
    const checkServer = async () => {
      await collector.drain();
      const { course } = await request(user, 'GET', `/api/courses/${fixture.instanceId}/state`, undefined, { category: 'document-browser-state' });
      assert.equal(course.status, 'teaching'); assert.equal(course.stages[course.currentStageIndex].key, 'make');
      const draft = course.submissions.find(item => item.id === state.submissionId);
      assert.ok(draft); assert.equal(draft.studentId, user.id);
      assert.equal(draft.version, state.version); assert.equal(draft.content, state.content);
      return draft;
    };
    const append = async marker => {
      const editor = page.locator('[data-slate-editor="true"]').first();
      await editor.focus(); await editor.press('Control+End'); await editor.press('Enter'); await page.keyboard.insertText(marker);
      await expect(editor).toContainText(marker);
    };
    const pendingOutbox = () => page.evaluate(({ courseId, studentId }) => Object.keys(localStorage)
      .filter(key => (key.startsWith('openpbl.learning-outbox.v1:') || key.startsWith('openpbl:document-review:v1:'))
        && decodeURIComponent(key).includes(courseId) && decodeURIComponent(key).includes(studentId))
      .map(key => ({ key, entry: JSON.parse(localStorage.getItem(key)) })), { courseId: fixture.instanceId, studentId: user.id });
    const assertOutboxDrained = async () => {
      await until(async () => (await pendingOutbox()).length === 0, collector, 'Browser process events or reviews remain pending after reconnect', 120000);
      await collector.drain(); await drainEvents();
    };
    try {
      await checkServer();
      await checkPeer(await page.goto(`${origin}/student/ai-collaboration/${fixture.instanceId}`, { waitUntil: 'domcontentloaded', timeout: 45000 }));
      await expect(page.locator('[data-slate-editor="true"]').first()).toBeVisible({ timeout: 45000 });
      const firstMarker = `浏览器保存与刷新证据 ${randomUUID()}`;
      await append(firstMarker); await assertSaved(firstMarker); await checkServer();
      evidence.steps.push({ name: 'edit-server-ack', version: state.version, requestId: state.lastRequestId });
      await checkPeer(await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }));
      await expect(page.locator('[data-slate-editor="true"]').first()).toContainText(firstMarker, { timeout: 45000 });
      await assertSaved(firstMarker); await checkServer();
      evidence.steps.push({ name: 'reload-retains-server-content', version: state.version });
      const beforeOffline = state.version;
      const offlineMarker = `断网后重新打开保留草稿 ${randomUUID()}`;
      offline = true; await context.setOffline(true);
      await append(offlineMarker);
      await until(() => page.evaluate(({ scope, marker }) => Object.keys(localStorage)
        .filter(key => key.startsWith('openpbl:document-draft:v1:')).some(key => {
          try { const value = JSON.parse(localStorage.getItem(key)); return value.scope === scope && value.content.includes(marker); }
          catch { return false; }
        }), { scope: `${fixture.instanceId}:${user.id}:make:document`, marker: offlineMarker }),
      collector, 'Offline content was not persisted in browser storage');
      await delay(60000);
      await checkServer(); assert.equal(state.version, beforeOffline, 'Offline edits must not claim a server receipt');
      evidence.steps.push({ name: 'offline-60s-local-draft', serverVersion: state.version, pendingOutbox: await pendingOutbox(), traffic: [...collector.traffic] });
      await collector.drain();
      evidence.sessions.push({ phase: 'before-offline-reopen', saves: collector.saves.snapshot(), traffic: [...collector.traffic] });
      collector.detach(); await page.close(); await drainEvents();
      page = await context.newPage(); collector = track();
      drainEvents = captureCapacityBrowserEvents(page, { user, fixture, expected });
      page.on('pageerror', error => evidence.pageErrors.push(error.message));
      page.on('requestfailed', req => evidence.networkFailures.push({ path: new URL(req.url()).pathname, reason: req.failure()?.errorText }));
      offline = false; await context.setOffline(false);
      await checkPeer(await page.goto(`${origin}/student/ai-collaboration/${fixture.instanceId}`, { waitUntil: 'domcontentloaded', timeout: 45000 }));
      await expect(page.locator('[data-slate-editor="true"]').first()).toContainText(offlineMarker, { timeout: 45000 });
      await assertSaved(offlineMarker); await assertOutboxDrained(); await checkServer();
      evidence.steps.push({ name: 'reopen-replays-offline-draft', version: state.version, requestId: state.lastRequestId });
      await page.getByRole('button', { name: 'AI 组员', exact: true }).click();
      const panel = page.getByRole('region', { name: 'AI 组员工作区', exact: true });
      await expect(panel).toBeVisible();
      await panel.locator('textarea').fill(question);
      await panel.getByRole('button', { name: '发送给 AI 组员', exact: true }).click();
      await until(() => collector.ai().length === 1, collector, 'No real document AI request was observed');
      const ai = collector.ai()[0];
      const editingAt = Date.now();
      assert.equal(ai.status, 'processing', 'AI completed before the overlapping browser edit started');
      const secondMarker = `AI 回答期间继续编辑 ${randomUUID()}`;
      await append(secondMarker); await assertSaved(secondMarker);
      evidence.steps.push({ name: 'edit-during-real-ai', requestId: state.lastRequestId, version: state.version, editingAt });
      await until(() => ai.status === 'completed', collector, 'Real document AI did not complete', 180000);
      assert.ok(ai.startedAt <= editingAt && editingAt <= ai.completedAt, 'Browser editing must overlap the real AI request');
      const article = panel.locator(`article[id=${JSON.stringify(ai.assistantMessageId)}]`);
      await expect(article).toBeVisible({ timeout: 15000 });
      assert.ok((await article.innerText()).trim().length > 10, 'Persisted AI answer is not visibly rendered');
      // A valid model answer may offer a change. Resolve that student decision
      // through the actual UI before expecting its background review scheduler.
      for (const name of ['保留原文', '暂不采用']) {
        const decision = panel.getByRole('button', { name, exact: true });
        if (await decision.isVisible()) {
          await decision.click();
          evidence.steps.push({ name: 'student-keeps-existing-document', decision: name, requestId: ai.requestId });
        }
      }
      await until(() => (state.browserReviewRequests ?? []).some(review => review.status === 'completed'
        && Array.isArray(review.response?.reviewDecision?.rawOutputs) && review.response.reviewDecision.rawOutputs.length > 0),
      collector, 'No automatic paragraph review completed with real model output', 120000);
      await assertOutboxDrained(); await checkServer();
      assert.ok((state.browserReviewRequests ?? []).every(review => ['completed', 'cancelled'].includes(review.status)), 'An accepted background review has no terminal receipt');
      evidence.steps.push({ name: 'real-ai-reply-visible', requestId: ai.requestId, assistantMessageId: ai.assistantMessageId });
      assert.equal(state.documentRequestId, originalDocumentRequestId, 'The original whole-class AI request must remain in the manifest');
      assert.deepEqual(evidence.pageErrors, []);
      evidence.outcome = 'passed';
    } catch (error) { failed = error; evidence.outcome = 'failed'; evidence.error = String(error); }
    finally {
      try { await collector.drain(180000); await drainEvents(); }
      catch (error) { failed ??= error; evidence.outcome = 'failed'; evidence.drainError = String(error); }
      evidence.screenshot = path.join(output, `${user.id}.png`);
      await page.screenshot({ path: evidence.screenshot, fullPage: true }).catch(error => { evidence.screenshotError = String(error); });
      try { await collector.drain(180000); await drainEvents(); }
      catch (error) { failed ??= error; evidence.outcome = 'failed'; evidence.drainError = String(error); }
      evidence.sessions.push({ phase: 'final-page', saves: collector.saves.snapshot(), traffic: [...collector.traffic] });
      evidence.saves = evidence.sessions.flatMap(session => session.saves); evidence.aiRequests = collector.ai();
      evidence.traffic = evidence.sessions.flatMap(session => session.traffic);
      evidence.collectorErrors = collector.errors.map(error => error.message);
      collector.detach();
      await context.close(); await drainEvents();
      await writeFile(path.join(output, `${user.id}.json`), JSON.stringify(evidence, null, 2), { mode: 0o600 });
    }
    if (failed) throw Object.assign(new Error(`Document browser ${user.id}: ${failed.message ?? failed}`), { evidence });
    return evidence;
  };
  let outcomes;
  try { outcomes = await Promise.allSettled(students.map(verifyStudent)); }
  finally { await browser.close(); }
  const failures = outcomes.filter(result => result.status === 'rejected');
  const summary = { students: students.length, completed: outcomes.length - failures.length, mocks: false, output,
    failures: failures.map(result => ({ message: result.reason.message, steps: result.reason.evidence?.steps, error: result.reason.evidence?.error })) };
  record('two-real-document-browser-editors', failures.length ? '未通过' : '通过', summary);
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), failures[0].reason.message);
  return summary;
}
