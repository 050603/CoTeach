import { expect, test, type Page } from '@playwright/test';
import { SignJWT } from 'jose';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createPblTemplateCourse } from '../src/lib/platform/pbl-template';
import type { Scene, Stage } from '../src/lib/openmaic/types/stage';

// Point at a run's result.json or its exported playback-classroom.json.
// Reuse the production service with OPENPBL_RESOURCE_E2E_BASE_URL. All API
// traffic is intercepted; real audio is decoded and played at 1x. Quiz grading
// is a deterministic fixture, not evidence of model grading quality.
const artifactPath = process.env.OPENPBL_QUALITY_LAB_RESULT;
const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || 'http://localhost:3000';
const runtimeRoot = path.resolve(process.env.COURSE_QUALITY_LAB_ROOT || '.openpbl-runtime/course-quality-lab');
const courseId = 'e2e-quality-lab-playback';
const audioPrefix = '/api/__quality-lab-audio/';
test.use({ baseURL, serviceWorkers: 'block' });

type Classroom = { id: string; stage: Stage; scenes: Scene[]; createdAt?: string };
type ScriptSegment = { id: string; text: string; audioUrl?: string; durationSec?: number };
type MediaEvent = { event: string; url: string; time: number; duration: number; rate: number };
type BrowserEvidence = {
  events: MediaEvent[];
  audio: HTMLMediaElement[];
  browserTtsCalls: number;
  maxTime: Record<string, number>;
};
type AudioFixture = { bytes: Buffer; contentType: string; segmentId: string; durationSec: number };

function localLabFile(url: string, directory: 'audio' | 'artifacts'): string {
  const pathname = decodeURIComponent(new URL(url, baseURL).pathname);
  const prefix = `/files/${directory}/`;
  expect(pathname, `Expected a lab ${directory} URL, received ${url}`).toMatch(new RegExp(`^${prefix}`));
  const allowedRoot = path.join(runtimeRoot, directory);
  const resolved = path.resolve(allowedRoot, pathname.slice(prefix.length));
  expect(resolved.startsWith(`${allowedRoot}${path.sep}`), 'Artifact must remain inside the lab directory').toBe(true);
  expect(existsSync(resolved), `Missing real lab artifact: ${resolved}`).toBe(true);
  return resolved;
}

function loadFixture() {
  const inputPath = path.resolve(artifactPath!);
  const input = JSON.parse(readFileSync(inputPath, 'utf8')) as {
    result?: { downloads?: { classroom?: string }; script?: ScriptSegment[] };
  } & Partial<Classroom>;
  let classroomPath = inputPath;
  if (path.basename(inputPath) !== 'playback-classroom.json') {
    const download = input.result?.downloads?.classroom;
    expect(download, 'result.json must contain result.downloads.classroom pointing to playback-classroom.json; regenerate the lab export before playback acceptance').toBeTruthy();
    classroomPath = localLabFile(download!, 'artifacts');
  }
  const classroom = JSON.parse(readFileSync(classroomPath, 'utf8')) as Classroom;
  expect(classroom.stage?.id, 'playback-classroom.json must contain standard { id, stage, scenes }').toBeTruthy();
  expect(classroom.id).toBeTruthy();
  expect(classroom.scenes?.length).toBeGreaterThanOrEqual(3);
  expect(classroom.scenes.filter((scene) => scene.type === 'slide').length).toBeGreaterThanOrEqual(2);
  const quizScenes = classroom.scenes.filter((scene) => scene.type === 'quiz');
  expect(quizScenes, 'Export the original QuizContent as one playable final quiz scene').toHaveLength(1);
  const quiz = quizScenes[0];
  expect(classroom.scenes.at(-1)?.id, 'The lesson must lead naturally into the final quiz').toBe(quiz.id);
  if (quiz.content.type !== 'quiz') throw new Error('Quiz scene must contain QuizContent');
  expect(quiz.content.questions.length).toBeGreaterThan(0);
  expect(quiz.content.questions.every((question) => question.type === 'short_answer'), 'This acceptance fixture expects the lab’s frozen short-answer questions').toBe(true);
  expect((quiz.actions ?? []).some((action) => {
    const gate = action as { activityPausePurpose?: string; activityPauseSec?: number };
    return gate.activityPausePurpose === 'quiz' && Number(gate.activityPauseSec) > 0;
  }), 'Quiz playback must wait for submission and review confirmation').toBe(true);

  const script = new Map((input.result?.script ?? []).map((segment) => [segment.id, segment]));
  const audio = new Map<string, AudioFixture>();
  const expectedAudio: string[] = [];
  const sceneAudio = new Map<string, string[]>();
  for (const scene of classroom.scenes) {
    expect({ stageKey: scene.stageKey, audience: scene.audience, generationPurpose: scene.generationPurpose },
      `Scene ${scene.id} would be filtered by StudentStageHost`).toEqual({
      stageKey: 'ai-learning', audience: 'student', generationPurpose: 'knowledge-teaching',
    });
    if (scene.type === 'slide') expect(scene.ttsPolicy, 'Missing audio must stop production playback').toBe('target-duration');
    const urls: string[] = [];
    for (const action of scene.actions ?? []) {
      if (action.type !== 'speech' || !action.text.trim()) continue;
      const segmentId = `${scene.outlineId ?? scene.id}:${action.id}`;
      expect(action.audioUrl, `Speech ${segmentId} has no audioUrl; bind the compound script ID to the unchanged action ID`).toBeTruthy();
      expect(action.audioDurationSec, `Speech ${segmentId} requires measured audioDurationSec`).toBeGreaterThan(0);
      if (script.size && scene.type === 'slide') {
        const segment = script.get(segmentId);
        expect(segment, `No script segment matches ${segmentId}; do not prefix action IDs or cue.speechId`).toBeTruthy();
        expect(segment?.text).toBe(action.text);
        expect(segment?.audioUrl).toBe(action.audioUrl);
        expect(segment?.durationSec).toBe(action.audioDurationSec);
      }
      const file = localLabFile(action.audioUrl!, 'audio');
      const extension = path.extname(file).toLowerCase();
      const url = `${audioPrefix}${audio.size}${extension}`;
      const contentType = ({ '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac' })[extension] ?? 'application/octet-stream';
      const bytes = readFileSync(file);
      expect(bytes.length, `Empty audio: ${file}`).toBeGreaterThan(0);
      audio.set(url, { bytes, contentType, segmentId, durationSec: action.audioDurationSec! });
      // Only the transport URL changes. Text, IDs, cues and audio bytes remain
      // exactly as exported; the test must not repair malformed artifacts.
      action.audioUrl = url;
      expectedAudio.push(url);
      urls.push(url);
    }
    if (scene.type === 'slide') expect(urls.length, `Slide ${scene.id} has no narration`).toBeGreaterThan(0);
    sceneAudio.set(scene.id, urls);
  }
  return { classroom, quiz, audio, expectedAudio, sceneAudio, classroomPath };
}

async function evidence(page: Page) {
  return page.evaluate(() => {
    const state = (window as unknown as { __qualityLabPlayback: BrowserEvidence }).__qualityLabPlayback;
    return {
      events: state.events,
      browserTtsCalls: state.browserTtsCalls,
      maxTime: state.maxTime,
      active: state.audio.filter((audio) => audio.src.includes('/api/__quality-lab-audio/')).map((audio) => ({
        url: new URL(audio.src).pathname, paused: audio.paused, time: audio.currentTime, ended: audio.ended,
      })),
    };
  });
}

test('plays a complete lab lesson through the production teacher preview without formal writes', async ({ page }, info) => {
  test.skip(!artifactPath, 'Set OPENPBL_QUALITY_LAB_RESULT to result.json or exported playback-classroom.json');
  const { classroom, quiz, audio, expectedAudio, sceneAudio, classroomPath } = loadFixture();
  const durationSec = [...audio.values()].reduce((sum, file) => sum + file.durationSec, 0);
  test.setTimeout(Math.ceil(durationSec * 1000) + 180_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE
    ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, 'utf8').trim()
    : process.env.JWT_SECRET;
  expect(secret && secret.length >= 32, 'Set JWT_SECRET or OPENPBL_E2E_JWT_SECRET_FILE to the reused app server’s signing secret').toBeTruthy();
  const token = await new SignJWT({ role: 'teacher', sv: 1, username: 'e2e-lab', displayName: '实验课堂播放验收' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject('e2e-lab-teacher')
    .setIssuer('openpbl').setAudience('openpbl-app').setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret!));
  await page.context().addCookies([{ name: 'openpbl_teacher', value: token, domain: new URL(baseURL).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
  await page.addInitScript(() => {
    localStorage.setItem('settings-storage', JSON.stringify({ version: 5, state: {
      language: 'zh-CN', playbackSpeed: 1, autoPlayLecture: true, ttsEnabled: false,
      ttsProvidersConfig: { 'browser-native-tts': { enabled: false, apiKey: '', baseUrl: '' } },
    } }));
    const state: BrowserEvidence = { events: [], audio: [], browserTtsCalls: 0, maxTime: {} };
    (window as unknown as { __qualityLabPlayback: BrowserEvidence }).__qualityLabPlayback = state;
    const nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (!state.audio.includes(this)) {
        state.audio.push(this);
        this.addEventListener('timeupdate', () => {
          const pathname = new URL(this.currentSrc || this.src).pathname;
          state.maxTime[pathname] = Math.max(state.maxTime[pathname] || 0, this.currentTime);
        });
        for (const event of ['playing', 'pause', 'ended', 'error']) {
          this.addEventListener(event, () => state.events.push({
            event, url: this.currentSrc || this.src, time: this.currentTime,
            duration: this.duration, rate: this.playbackRate,
          }));
        }
      }
      return nativePlay.call(this);
    };
    if (window.speechSynthesis) {
      const speak = window.speechSynthesis.speak.bind(window.speechSynthesis);
      window.speechSynthesis.speak = (utterance) => { state.browserTtsCalls += 1; speak(utterance); };
    }
  });

  const course = createPblTemplateCourse(courseId, { name: classroom.stage.name, subject: '教育学', grade: '实验冻结学习对象', hours: 1, drivingQuestion: '通过实际课堂播放验证生成产物' });
  course.aiLearningClassroomId = classroom.id;
  course.content._openmaicSceneOutlines = classroom.scenes.map((scene) => ({
    id: scene.outlineId ?? scene.id, title: scene.title, type: scene.type,
    stageKey: 'ai-learning', audience: 'student', generationPurpose: 'knowledge-teaching',
    targetDurationSec: scene.targetDurationSec,
  }));
  const errors: string[] = [], unexpected: string[] = [], writes: string[] = [], requestedAudio: string[] = [];
  let gradeCalls = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.routeWebSocket((url) => !url.pathname.startsWith('/_next/'), (socket) => socket.onMessage(() => undefined));
  await page.route('**/api/**', async (route) => {
    const request = route.request(), pathname = new URL(request.url()).pathname, method = request.method();
    const json = (value: unknown) => route.fulfill({ status: 200, json: value });
    const media = audio.get(pathname);
    if (media && method === 'GET') {
      requestedAudio.push(pathname);
      const range = request.headers().range?.match(/^bytes=(\d+)-(\d*)$/);
      if (range) {
        const start = Number(range[1]), end = Math.min(Number(range[2] || media.bytes.length - 1), media.bytes.length - 1);
        return route.fulfill({ status: 206, contentType: media.contentType, body: media.bytes.subarray(start, end + 1), headers: {
          'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${media.bytes.length}`,
        } });
      }
      return route.fulfill({ status: 200, contentType: media.contentType, body: media.bytes, headers: { 'Accept-Ranges': 'bytes' } });
    }
    if (method === 'POST' && pathname === '/api/openmaic/quiz-grade') {
      gradeCalls += 1;
      const body = request.postDataJSON() as { points: number; userAnswer: string };
      expect(body.userAnswer.trim()).not.toBe('');
      return json({ score: body.points, comment: '隔离播放验收的固定评分响应；不代表模型评分质量。' });
    }
    if (method !== 'GET') {
      writes.push(`${method} ${pathname}`);
      return route.fulfill({ status: 409, json: { error: 'Formal writes are forbidden in lab playback acceptance' } });
    }
    if (pathname === '/api/auth/me') return json({ user: { id: 'e2e-lab-teacher', role: 'teacher', name: '实验课堂播放验收', displayName: '实验课堂播放验收' } });
    if (pathname === '/api/courses') return json({ courses: [course], user: { role: 'teacher', name: '实验课堂播放验收' }, hydrated: true, updatedAt: course.updatedAt });
    if (pathname === `/api/courses/${courseId}/state`) return json({ course, eventCursor: '0' });
    if (pathname === `/api/courses/${courseId}/events`) return json({ events: [], nextCursor: '0', hasMore: false, courseVersion: 1 });
    if (pathname === `/api/courses/${courseId}/presence`) return json({ members: [], degraded: false });
    if (pathname === `/api/courses/${courseId}/resource-repair`) return json({ issues: [] });
    if (pathname === `/api/courses/${courseId}/quality-review`) return json({ required: false, classroom, quality: null, renderReview: null, teacherReview: null });
    if (pathname === '/api/openmaic/classroom') return json({ success: true, classroom });
    if (pathname === '/api/server-providers') return json({ providers: {}, tts: {}, asr: {}, pdf: {}, image: {}, video: {}, webSearch: {} });
    unexpected.push(`${method} ${pathname}`);
    return route.fulfill({ status: 404, json: { error: 'No fixture for this endpoint' } });
  });

  try {
    await page.goto(`/teacher/prepare/${courseId}/preview`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: '学生 AI 课堂实景', exact: true }).click();
    const resume = page.getByRole('button', { name: '继续讲解', exact: true });
    await expect(resume, 'Exported scenes must survive the production student-scene filter').toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('scene-title')).toHaveText(classroom.scenes.map((scene) => scene.title));
    await resume.click();
    await expect.poll(async () => (await evidence(page)).active.some((item) => !item.paused && item.time > 0.2)).toBe(true);
    await page.getByRole('button', { name: '暂停讲解', exact: true }).click();
    await expect(resume).toBeVisible();
    const paused = (await evidence(page)).active.find((item) => item.url === expectedAudio[0])!;
    expect(paused.paused).toBe(true);
    await page.waitForTimeout(350);
    const stillPaused = (await evidence(page)).active.find((item) => item.url === expectedAudio[0])!;
    expect(stillPaused.time).toBeCloseTo(paused.time, 1);
    await resume.click();
    await expect.poll(async () => (await evidence(page)).active.some((item) => item.url === expectedAudio[0] && !item.paused && item.time > paused.time)).toBe(true);

    // No seek, synthetic ended event, fast clock or speed change: the production
    // engine must consume every real audio file and advance the pages itself.
    const startQuiz = page.getByRole('button', { name: /^(开始答题|Start Quiz)$/ });
    await expect(startQuiz).toBeVisible({ timeout: Math.ceil(durationSec * 1000) + 60_000 });
    const playback = await evidence(page);
    const played = playback.events.filter((event) => event.event === 'ended' && new URL(event.url, baseURL).pathname.startsWith(audioPrefix));
    expect(played.map((event) => new URL(event.url, baseURL).pathname)).toEqual(expectedAudio);
    for (const event of played) {
      expect(event.rate).toBe(1);
      const pathname = new URL(event.url, baseURL).pathname;
      expect(playback.maxTime[pathname]).toBeGreaterThanOrEqual(event.duration - 0.5);
    }
    for (const [sceneId, urls] of sceneAudio) {
      expect(urls.every((url) => played.some((event) => new URL(event.url, baseURL).pathname === url)), `Scene ${sceneId} did not automatically finish all narration`).toBe(true);
    }
    await startQuiz.click();
    if (quiz.content.type !== 'quiz') throw new Error('Expected quiz content');
    const answers = page.getByPlaceholder(/^(请在此输入你的回答\.\.\.|Type your answer here\.\.\.|写出你的判断、依据和解决思路|填写关键概念或关系)$/);
    await expect(answers).toHaveCount(quiz.content.questions.length);
    for (let index = 0; index < quiz.content.questions.length; index += 1) {
      await answers.nth(index).fill(quiz.content.questions[index].analysis || '依据本节课程中的概念、证据与条件解释判断。');
    }
    await page.getByRole('button', { name: /^(提交答案|Submit Answers)$/ }).click();
    const confirm = page.getByRole('button', { name: '我已经理解，可以继续', exact: true });
    await expect(confirm).toBeVisible();
    expect(gradeCalls).toBe(quiz.content.questions.length);
    await confirm.click();
    await expect(page.getByRole('region', { name: /^(课程完成|Course complete)$/ })).toBeVisible({ timeout: 15_000 });
    const final = await evidence(page);
    expect(final.browserTtsCalls, 'Pre-generated narration must not fall back to browser TTS').toBe(0);
    expect(final.events.filter((event) => event.event === 'error')).toEqual([]);
    expect([...new Set(requestedAudio)].sort()).toEqual([...expectedAudio].sort());
    expect(writes, 'Teacher preview must not save courses, classrooms or student progress').toEqual([]);
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await info.attach('lab-playback-evidence', { contentType: 'application/json', body: JSON.stringify({
      classroomPath, expectedAudio: [...audio].map(([url, value]) => ({ url, segmentId: value.segmentId, durationSec: value.durationSec })),
      requestedAudio, gradeCalls, writes, unexpected, errors,
      browser: await evidence(page).catch(() => null),
    }, null, 2) });
  }
});
