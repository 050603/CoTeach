/** Real student course playback in isolated browser contexts. No response mocks. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { captureCapacityBrowserEvents } from './verify-capacity-projection-browser.mjs';
import { capacityBrowserEnvironment } from './capacity-network.mjs';
import { createCapacityAudioSink } from './capacity-audio-sink.mjs';

export const capacityLectureText = 'AI讲授验收：保持测量条件相同，用真实数据比较用电量。';

export function seedCapacityLectureScene({ runId, sectionId, audioUrl = '', speechText, repeatCount = 60 }) {
  assert.match(runId, /^capacity-[0-9a-f-]{36}$/);
  assert.ok(sectionId && speechText?.trim());
  assert.ok(Number.isInteger(repeatCount) && repeatCount >= 1 && repeatCount <= 120);
  const sceneId = `${runId}-student-lecture`;
  const outline = { id: sceneId, type: 'slide', title: '真实语音讲授验收', order: -1, stageKey: 'ai-learning', audience: 'student', knowledgePointIds: ['energy'] };
  return { sceneId, outline, scene: { ...outline, outlineId: sceneId, lectureSectionId: sectionId,
    generationPurpose: 'knowledge-teaching', actions: Array.from({ length: repeatCount }, (_, index) => ({
      id: `${sceneId}-speech-${index}`, type: 'speech', text: speechText, ...(audioUrl ? { audioUrl } : {}),
    })), content: { type: 'slide', schemaVersion: 1, canvas: { id: sceneId, viewportSize: 1000, viewportRatio: 0.5625,
      theme: { fontName: 'Noto Sans SC', fontColor: '#163B3C', themeColor: '#163B3C', backgroundColor: '#ffffff' },
      background: { type: 'solid', color: '#ffffff' },
      elements: [{ id: `${sceneId}-text`, type: 'text', left: 60, top: 180, width: 880, height: 120, rotate: 0,
        content: `<p style="font-size:34px">${capacityLectureText}</p>`, defaultFontName: 'Noto Sans SC', defaultColor: '#163B3C' }],
    } } } };
}

/** Browser-side instrumentation observes native Audio objects, including the
 * detached elements used by the player. It never starts, mutes or seeks audio.
 */
export function observeCapacityAudio({ audioUrl }) {
  const target = new URL(audioUrl, location.href);
  const counters = { canplay: 0, playing: 0, ended: 0, playedSeconds: 0, mediaErrors: [], samples: 0 };
  const NativeAudio = window.Audio;
  const observed = [];
  window.__capacityLectureAudioDetails = () => observed.filter(item => item.matches()).slice(-5).map(({ audio, events }) => ({
    src: audio.currentSrc || audio.src, currentTime: audio.currentTime, duration: audio.duration,
    paused: audio.paused, ended: audio.ended, seeking: audio.seeking, readyState: audio.readyState,
    networkState: audio.networkState, playbackRate: audio.playbackRate, events,
  }));
  function ObservedAudio(...args) {
    const audio = new NativeAudio(...args);
    let previous = 0;
    const matches = () => [audio.src, audio.currentSrc].some(value => {
      if (!value) return false;
      try { const candidate = new URL(value, location.href); return candidate.origin === target.origin && candidate.pathname === target.pathname; }
      catch { return false; }
    });
    const events = [];
    observed.push({ audio, matches, events });
    if (observed.length > 8) observed.shift();
    for (const name of ['canplay', 'playing', 'pause', 'waiting', 'stalled', 'seeking', 'seeked', 'ended', 'error']) audio.addEventListener(name, () => {
      if (!matches()) return;
      events.push({ event: name, at: Date.now(), currentTime: audio.currentTime, paused: audio.paused, readyState: audio.readyState });
      if (events.length > 30) events.shift();
    });
    audio.addEventListener('canplay', () => { if (matches()) counters.canplay++; });
    audio.addEventListener('playing', () => { if (matches()) counters.playing++; });
    audio.addEventListener('ended', () => { if (matches()) counters.ended++; });
    audio.addEventListener('timeupdate', () => {
      const current = audio.currentTime;
      if (matches() && !audio.seeking && current > previous && current - previous < 5) {
        counters.playedSeconds += current - previous; counters.samples++;
      }
      previous = current;
    });
    audio.addEventListener('error', () => { if (matches() && audio.error) counters.mediaErrors.push({ code: audio.error.code, message: audio.error.message }); });
    return audio;
  }
  ObservedAudio.prototype = NativeAudio.prototype;
  Object.setPrototypeOf(ObservedAudio, NativeAudio);
  window.Audio = ObservedAudio;
  window.__capacityLectureAudio = counters;
}

async function settledValues(promises, label) {
  const results = await Promise.allSettled(promises);
  const failed = results.filter(result => result.status === 'rejected');
  if (failed.length) throw new AggregateError(failed.map(result => result.reason), `${label}: ${failed.length} failed; all operations drained; first cause: ${String(failed[0].reason)}`);
  return results.map(result => result.value);
}

export async function verifyCapacityLectureBrowsers({ users, fixture, origin, request, record, expected, browserArgs = [], connectAddress, observeMs = 180000,
  browserShards = Math.ceil(users.filter(user => user.role === 'student').length / 10), isolateAudioOutput = true }) {
  const students = users.filter(user => user.role === 'student');
  const teacher = users.find(user => user.role === 'teacher');
  assert.ok(teacher && students.length >= 2 && students.length <= 40);
  assert.ok(fixture.classroomId?.startsWith('capacity-') && fixture.lectureSceneId);
  assert.ok(fixture.lectureAudio?.url, 'Upload real TTS and patch lecture actions before opening students');
  assert.ok(Number.isFinite(observeMs) && observeMs >= 10000 && observeMs <= 300000);
  if (students.length === 40) assert.ok(observeMs >= 180000, 'Forty-browser acceptance needs at least three minutes');
  assert.ok(Number.isInteger(browserShards) && browserShards >= 1 && browserShards <= students.length);
  const endpoint = `/api/courses/${fixture.instanceId}`;
  const original = (await request(teacher, 'GET', `${endpoint}/state`, undefined, { category: 'lecture-browser-state' })).course;
  const stageIndex = original.stages.findIndex(stage => stage.key === 'ai-learning');
  assert.ok(stageIndex >= 0);
  const act = action => request(teacher, 'POST', `${endpoint}/actions`, { requestId: randomUUID(), action }, { category: 'lecture-browser-action' });
  const errors = [];
  const sessions = [];
  const flushTelemetry = [];
  const browsers = [];
  const audioSinks = [];
  const audioOutput = isolateAudioOutput ? 'private-clocked-pulseaudio-null-sink-per-browser' : 'host-default';
  try {
    if (original.currentStageIndex !== stageIndex) await act({ type: 'SET_STAGE', payload: { id: fixture.instanceId, index: stageIndex } });
    assert.ok(!original.uiState?.teacherResourceProjection && !original.uiState?.resourceProjection, 'Start student playback acceptance without a teacher projection');
    await settledValues(Array.from({ length: browserShards }, async () => {
      const sink = isolateAudioOutput ? await createCapacityAudioSink() : undefined;
      if (sink) audioSinks.push(sink);
      browsers.push(await chromium.launch({ headless: true, env: { ...capacityBrowserEnvironment(), ...sink?.env }, args: [...browserArgs, '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] }));
    }), 'Browser launch');
    await settledValues(students.map(async (user, index) => {
      const context = await browsers[index % browsers.length].newContext({ viewport: { width: 1280, height: 900 } });
      await context.addCookies(user.cookie.split(';').map(value => { const index = value.indexOf('='); return { name: value.slice(0, index).trim(), value: value.slice(index + 1).trim(), url: origin }; }));
      await context.addInitScript(observeCapacityAudio, { audioUrl: new URL(fixture.lectureAudio.playbackUrl ?? fixture.lectureAudio.url, origin).href });
      const page = await context.newPage();
      const diagnosticLogs = [];
      const appendLog = (kind, detail) => { diagnosticLogs.push({ kind, detail }); if (diagnosticLogs.length > 35) diagnosticLogs.shift(); };
      page.on('console', message => { if (['error', 'warning'].includes(message.type())) appendLog(`console-${message.type()}`, message.text()); });
      const cdp = await context.newCDPSession(page);
      await cdp.send('Media.enable');
      for (const event of ['playerErrorsRaised', 'playerMessagesLogged', 'playerEventsAdded', 'playerPropertiesChanged']) cdp.on(`Media.${event}`, value => appendLog(event, value));
      const audioResponses = [];
      page.on('response', response => {
        const candidate = new URL(response.url());
        if (candidate.origin === origin && response.status() >= 500) errors.push({ studentId: user.id, message: `HTTP ${response.status()} ${candidate.pathname}` });
        const target = new URL(fixture.lectureAudio.playbackUrl ?? fixture.lectureAudio.url, origin);
        if (candidate.origin === target.origin && candidate.pathname === target.pathname) audioResponses.push({ url: response.url(), status: response.status(), contentType: response.headers()['content-type'] });
      });
      sessions.push({ user, context, page, audioResponses, diagnosticLogs });
      flushTelemetry.push(captureCapacityBrowserEvents(page, { user, fixture, expected }));
      page.on('pageerror', error => errors.push({ studentId: user.id, message: error.message }));
      const response = await page.goto(`${origin}/student/classroom/${fixture.instanceId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      assert.equal(response.status(), 200);
      if (connectAddress) assert.equal((await response.serverAddr())?.ipAddress.replace(/^::ffff:/, ''), connectAddress);
      await page.getByText(capacityLectureText, { exact: true }).first().waitFor({ state: 'visible', timeout: 60000 });
    }), 'Student lecture rendering');
    record('all-student-real-browser-lecture-rendered', '通过', { students: students.length, browserShards, audioOutput, mocks: false });
    // Wait until all students rendered, then click real controls as one batch.
    await settledValues(sessions.map(async ({ page }) => {
      await page.getByRole('button', { name: '继续讲解', exact: true }).click({ timeout: 30000 });
      await page.waitForFunction(() => window.__capacityLectureAudio.canplay > 0 && window.__capacityLectureAudio.playedSeconds >= 1, null, { timeout: 30000 });
    }), 'Student audio start');
    record('all-student-real-browser-audio-started', '通过', { students: students.length, browserShards, audioOutput });
    const started = performance.now();
    const previous = new Map();
    let samples = 0;
    let previousSampleAt = started;
    while (true) {
      const snapshots = await settledValues(sessions.map(async ({ page, user }) => ({ userId: user.id, ...(await page.evaluate(() => window.__capacityLectureAudio)) })), 'Audio observations');
      const sampledAt = performance.now();
      for (const snapshot of snapshots) {
        assert.deepEqual(snapshot.mediaErrors, [], `Audio decoding failed for ${snapshot.userId}`);
        if (samples > 0 && sampledAt - previousSampleAt >= 2000) assert.ok(snapshot.playedSeconds > previous.get(snapshot.userId) + 0.5, `Lecture audio stopped advancing for ${snapshot.userId}`);
        previous.set(snapshot.userId, snapshot.playedSeconds);
      }
      previousSampleAt = sampledAt;
      assert.deepEqual(errors, [], 'No uncaught browser runtime errors');
      samples++;
      const elapsed = performance.now() - started;
      if (elapsed >= observeMs) {
        const audioRequests = sessions.map(({ user, audioResponses }) => ({
          studentId: user.id,
          uniqueSuccessfulUrls: new Set(audioResponses.filter(response => response.status >= 200 && response.status < 300).map(response => response.url)).size,
          statuses: Object.fromEntries([...new Set(audioResponses.map(response => response.status))].map(status => [status, audioResponses.filter(response => response.status === status).length])),
        }));
        for (const requests of audioRequests) assert.ok(requests.uniqueSuccessfulUrls > (students.length === 40 ? 10 : 1),
          `Expected sequential distinct real audio requests for ${requests.studentId}; received ${requests.uniqueSuccessfulUrls}`);
        const result = { students: students.length, browserShards, audioOutput, observedMs: Math.round(elapsed), samples, mocks: false,
          minPlayedSeconds: Math.round(Math.min(...snapshots.map(item => item.playedSeconds)) * 10) / 10,
          maxPlayedSeconds: Math.round(Math.max(...snapshots.map(item => item.playedSeconds)) * 10) / 10,
          canplayStudents: snapshots.filter(item => item.canplay > 0).length, runtimeErrors: errors.length,
          actualAudioUrl: fixture.lectureAudio.playbackUrl ?? fixture.lectureAudio.url, audioRequests,
          minSuccessfulAudioUrls: Math.min(...audioRequests.map(item => item.uniqueSuccessfulUrls)),
          maxSuccessfulAudioUrls: Math.max(...audioRequests.map(item => item.uniqueSuccessfulUrls)) };
        assert.equal(result.canplayStudents, students.length);
        record('all-student-real-browser-lecture-playback', '通过', result);
        return result;
      }
      await delay(Math.min(10000, observeMs - elapsed));
    }
  } catch (error) {
    const pages = await Promise.all(sessions.map(async ({ user, page, audioResponses, diagnosticLogs }) => {
      try { return { studentId: user.id, url: page.url(), title: await page.title(), body: (await page.locator('body').innerText({ timeout: 3000 })).slice(0, 1000), audio: await page.evaluate(() => window.__capacityLectureAudio), nativeAudio: await page.evaluate(() => window.__capacityLectureAudioDetails()), audioResponses, diagnosticLogs }; }
      catch (diagnosticError) { return { studentId: user.id, diagnosticError: String(diagnosticError) }; }
    }));
    record('all-student-real-browser-lecture-playback', '未通过', { students: students.length, browserShards, audioOutput, message: String(error), errors, pages });
    throw error;
  } finally {
    await Promise.allSettled(browsers.map(browser => browser.close()));
    await Promise.allSettled(audioSinks.map(sink => sink.stop()));
    await Promise.allSettled(flushTelemetry.map(flush => flush()));
    if (original.currentStageIndex !== stageIndex) await act({ type: 'SET_STAGE', payload: { id: fixture.instanceId, index: original.currentStageIndex } });
  }
}
