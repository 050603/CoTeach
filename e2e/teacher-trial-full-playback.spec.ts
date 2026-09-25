import { expect, test } from '@playwright/test';
import { SignJWT } from 'jose';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createPblTemplateCourse } from '../src/lib/platform/pbl-template';
import type { Scene, Stage } from '../src/lib/openmaic/types/stage';

// Full-speed content check in teacher preview. The lesson and WAV bytes are the
// exact published artifacts; business APIs are fixtures and make no writes.
const classroomFile = process.env.TRIAL_CLASSROOM_FILE;
const baseURL = process.env.TRIAL_PLAYBACK_BASE_URL || 'http://127.0.0.1:3000';
const buildId = process.env.TRIAL_PLAYBACK_BUILD_ID || null;
const output = path.resolve(process.env.TRIAL_PLAYBACK_OUTPUT_DIR || 'test-results/teacher-trial/full-playback');
const debugRate = Number(process.env.TRIAL_DEBUG_RATE || 1);
const courseId = 'teacher-trial-full-playback';
const mediaPrefix = '/api/__teacher-trial-audio/';
test.use({ baseURL, serviceWorkers: 'block' });

type Classroom = { id: string; stage: Stage; scenes: Scene[] };
type MediaEvidence = { event: string; pathname: string; time: number; duration: number; rate: number };

test('plays the complete published trial lesson at 1x, including every quiz gate', async ({ page }) => {
  test.skip(!classroomFile, 'Set TRIAL_CLASSROOM_FILE to the published classroom JSON');
  if (!['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname)) throw new Error('Use a local production build');
  mkdirSync(output, { recursive: true });
  const classroom = JSON.parse(readFileSync(classroomFile!, 'utf8')) as Classroom;
  const media = new Map<string, Buffer>();
  const expectedAudio: string[] = [];
  const quizTargets: number[] = [];
  let totalDuration = 0;
  for (const scene of classroom.scenes) {
    for (const action of scene.actions || []) {
      if (scene.type === 'quiz' && (action as { activityPausePurpose?: string }).activityPausePurpose === 'quiz') {
        quizTargets.push(expectedAudio.length);
      }
      if (action.type !== 'speech' || !action.audioUrl) continue;
      const source = new URL(action.audioUrl, baseURL).pathname;
      const prefix = `/api/openmaic/classroom-media/${classroom.id}/`;
      expect(source.startsWith(prefix), `Unexpected media URL: ${source}`).toBe(true);
      const file = path.resolve(path.dirname(classroomFile!), classroom.id, source.slice(prefix.length));
      expect(file.startsWith(`${path.resolve(path.dirname(classroomFile!), classroom.id)}${path.sep}`)).toBe(true);
      expect(existsSync(file), `Missing narration file ${file}`).toBe(true);
      const url = `${mediaPrefix}${expectedAudio.length}.wav`;
      media.set(url, readFileSync(file));
      action.audioUrl = url;
      expectedAudio.push(url);
      totalDuration += action.audioDurationSec || 0;
    }
  }
  expect(classroom.scenes.filter(scene => scene.type === 'quiz')).toHaveLength(8);
  expect(expectedAudio).toHaveLength(85);
  test.setTimeout(Math.ceil(totalDuration * 1000) + 600_000);

  // The preview uses a synthetic teacher session, so supply only the immutable
  // course's actual picture bytes from the read-only database and data directory.
  process.env.DATABASE_URL ||= readFileSync('deploy/secrets/database_url.txt', 'utf8').trim();
  const db = new PrismaClient();
  const uploadIds = [...new Set([...JSON.stringify(classroom.scenes).matchAll(/\/api\/uploads\/([0-9a-f-]{36})/g)].map(match => match[1]))];
  const uploads = await db.fileAsset.findMany({ where: { id: { in: uploadIds }, deletedAt: null },
    select: { id: true, storageKey: true, mimeType: true } });
  await db.$disconnect();
  expect(uploads).toHaveLength(uploadIds.length);
  const uploadImages = new Map(uploads.map(file => [`/api/uploads/${file.id}`, {
    bytes: readFileSync(path.resolve(process.env.UPLOAD_DIR || '.openpbl-data/uploads', file.storageKey)),
    mimeType: file.mimeType,
  }]));

  const secret = readFileSync(process.env.TRIAL_JWT_SECRET_FILE || 'deploy/secrets/jwt_secret.txt', 'utf8').trim();
  const token = await new SignJWT({ role: 'teacher', sv: 1, username: 'teacher-trial-preview', displayName: '试用预览验收' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject('teacher-trial-preview')
    .setIssuer('openpbl').setAudience('openpbl-app').setIssuedAt().setExpirationTime('2h')
    .sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: 'openpbl_teacher', value: token, domain: new URL(baseURL).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
  if (!Number.isFinite(debugRate) || debugRate < 1 || debugRate > 16) throw new Error('TRIAL_DEBUG_RATE must be between 1 and 16');
  await page.addInitScript((rate) => {
    localStorage.setItem('settings-storage', JSON.stringify({ version: 5, state: {
      language: 'zh-CN', playbackSpeed: 1, autoPlayLecture: true, ttsEnabled: false,
      ttsProvidersConfig: { 'browser-native-tts': { enabled: false, apiKey: '', baseUrl: '' } },
    } }));
    const evidence: { events: MediaEvidence[]; errors: string[]; maxTimeByPath: Record<string, number> } = {
      events: [], errors: [], maxTimeByPath: {},
    };
    (window as unknown as { __trialPlayback: typeof evidence }).__trialPlayback = evidence;
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      if (!(this as HTMLMediaElement & { __trialObserved?: boolean }).__trialObserved) {
        (this as HTMLMediaElement & { __trialObserved?: boolean }).__trialObserved = true;
        for (const event of ['playing', 'ended', 'error']) this.addEventListener(event, () => {
          const pathname = new URL(this.currentSrc || this.src).pathname;
          evidence.events.push({ event, pathname, time: this.currentTime, duration: this.duration, rate: this.playbackRate });
        });
        this.addEventListener('timeupdate', () => {
          const pathname = new URL(this.currentSrc || this.src).pathname;
          evidence.maxTimeByPath[pathname] = Math.max(evidence.maxTimeByPath[pathname] || 0, this.currentTime);
        });
      }
      if (rate > 1) this.playbackRate = rate;
      return original.apply(this, args);
    };
  }, debugRate);

  const course = createPblTemplateCourse(courseId, {
    name: classroom.stage.name, subject: '教育学', grade: '试用验收', hours: 1,
    drivingQuestion: '验证现有课程完整授课播放',
  });
  course.aiLearningClassroomId = classroom.id;
  course.content._openmaicSceneOutlines = classroom.scenes.map(scene => ({
    id: scene.outlineId ?? scene.id, title: scene.title, type: scene.type,
    stageKey: 'ai-learning', audience: 'student', generationPurpose: 'knowledge-teaching',
    targetDurationSec: scene.targetDurationSec,
  }));
  const errors: string[] = [];
  const unexpected: string[] = [];
  const writes: string[] = [];
  const failedResources: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.status() >= 400 && /\/api\/uploads\/|\.(?:png|jpg|jpeg|webp|css|js)(?:\?|$)/.test(response.url())) {
      failedResources.push(`${response.status()} ${new URL(response.url()).pathname}`);
    }
  });
  await page.routeWebSocket(url => !url.pathname.startsWith('/_next/'), socket => socket.onMessage(() => undefined));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    const json = (value: unknown) => route.fulfill({ status: 200, json: value });
    const upload = uploadImages.get(pathname);
    if (upload && method === 'GET') return route.fulfill({ status: 200, body: upload.bytes, contentType: upload.mimeType });
    const classroomPrefix = `/api/openmaic/classroom-media/${classroom.id}/`;
    if (pathname.startsWith(classroomPrefix) && method === 'GET') {
      const root = path.resolve(path.dirname(classroomFile!), classroom.id);
      const file = path.resolve(root, pathname.slice(classroomPrefix.length));
      if (file.startsWith(`${root}${path.sep}`) && existsSync(file)) {
        return route.fulfill({ status: 200, body: readFileSync(file),
          contentType: file.endsWith('.png') ? 'image/png' : file.endsWith('.jpg') || file.endsWith('.jpeg') ? 'image/jpeg' : 'application/octet-stream' });
      }
    }
    const audio = media.get(pathname);
    if (audio && method === 'GET') return route.fulfill({ status: 200, body: audio, contentType: 'audio/wav', headers: { 'Accept-Ranges': 'bytes' } });
    if (method !== 'GET') {
      writes.push(`${method} ${pathname}`);
      return route.fulfill({ status: 409, json: { error: 'Preview writes are forbidden' } });
    }
    if (pathname === '/api/auth/me') return json({ user: { id: 'teacher-trial-preview', role: 'teacher', displayName: '试用预览验收' } });
    if (pathname === '/api/courses') return json({ courses: [course], user: { role: 'teacher', name: '试用预览验收' }, hydrated: true, updatedAt: course.updatedAt });
    if (pathname === `/api/courses/${courseId}/state`) return json({ course, eventCursor: '0' });
    if (pathname === `/api/courses/${courseId}/events`) return json({ events: [], nextCursor: '0', hasMore: false, courseVersion: 1 });
    if (pathname === `/api/courses/${courseId}/presence`) return json({ members: [], degraded: false });
    if (pathname === `/api/courses/${courseId}/resource-repair`) return json({ issues: [] });
    if (pathname === `/api/courses/${courseId}/generation`) return json({ backgroundEnabled: false, job: null });
    if (pathname === `/api/courses/${courseId}/design-workspace`) return json({ publication: { latestVersion: 1, publishedVersion: null, draftVersion: 1 } });
    if (pathname === `/api/courses/${courseId}/quality-review`) return json({ required: false, classroom, quality: null, renderReview: null, teacherReview: null });
    if (pathname === '/api/openmaic/classroom') return json({ success: true, classroom });
    if (pathname === '/api/server-providers') return json({ providers: {}, tts: {}, asr: {}, pdf: {}, image: {}, video: {}, webSearch: {} });
    unexpected.push(`${method} ${pathname}`);
    return route.fulfill({ status: 404, json: { error: 'Missing preview fixture' } });
  });

  try {
    await page.goto(`/teacher/prepare/${courseId}/preview`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: '学生课堂预览', exact: true }).click();
    const resume = page.getByRole('button', { name: '继续讲解', exact: true });
    await resume.waitFor({ state: 'visible', timeout: 60_000 });
    await resume.click();
    let lastProgressLog = 0;
    for (const [quizIndex, target] of quizTargets.entries()) {
      await expect.poll(async () => {
        const progress = await page.evaluate(() => {
          const events = (window as unknown as { __trialPlayback: { events: MediaEvidence[] } }).__trialPlayback.events;
          return { ended: new Set(events.filter(event => event.event === 'ended' && event.pathname.startsWith('/api/__teacher-trial-audio/'))
            .map(event => event.pathname)).size, last: events.at(-1) };
        });
        if (Date.now() - lastProgressLog > 15_000) {
          console.log(`Audio progress ${progress.ended}/${expectedAudio.length}, last=${JSON.stringify(progress.last)}`);
          lastProgressLog = Date.now();
        }
        return progress.ended;
      },
      { timeout: Math.ceil(totalDuration * 1000) + 60_000 }).toBeGreaterThanOrEqual(target);
      const start = page.getByRole('button', { name: /^(开始答题|Start Quiz)$/ });
      await start.waitFor({ state: 'visible', timeout: 30_000 });
      await start.click();
      const quiz = classroom.scenes.filter(scene => scene.type === 'quiz')[quizIndex];
      if (quiz.content.type !== 'quiz') throw new Error('Unexpected quiz content');
      const cards = page.locator('div[class*="rounded-[14px]"][class*="overflow-hidden"]').filter({ has: page.locator('button[aria-pressed]') });
      await expect(cards).toHaveCount(quiz.content.questions.length);
      for (let index = 0; index < quiz.content.questions.length; index += 1) {
        await cards.nth(index).locator('button[aria-pressed]').first().click();
      }
      await page.getByRole('button', { name: /^(提交答案|Submit Answers)$/ }).click();
      const confirm = page.getByRole('button', { name: '我已经理解，可以继续', exact: true });
      await confirm.waitFor({ state: 'visible', timeout: 30_000 });
      await confirm.click();
      console.log(`Completed trial quiz ${quizIndex + 1}/8 after ${target} audio segments`);
    }
    await page.getByRole('region', { name: /^(课程完成|Course complete)$/ }).waitFor({ timeout: 60_000 });
    const evidence = await page.evaluate(() => (window as unknown as {
      __trialPlayback: { events: MediaEvidence[]; maxTimeByPath: Record<string, number> };
    }).__trialPlayback);
    const { events, maxTimeByPath } = evidence;
    const ended = events.filter(event => event.event === 'ended' && event.pathname.startsWith(mediaPrefix));
    const uniqueEnded = ended.filter((event, index) => index === 0 || event.pathname !== ended[index - 1].pathname);
    expect(uniqueEnded.map(event => event.pathname)).toEqual(expectedAudio);
    if (debugRate === 1) expect(ended.map(event => event.pathname)).toEqual(expectedAudio);
    for (const event of ended) {
      expect(event.rate).toBe(debugRate);
      if (debugRate === 1) {
        // The playback engine can reset currentTime synchronously in its ended
        // listener before this observer runs; the last timeupdate is stable.
        expect(maxTimeByPath[event.pathname]).toBeGreaterThanOrEqual(event.duration - 0.8);
      }
    }
    expect(events.filter(event => event.event === 'error')).toEqual([]);
    expect(errors).toEqual([]);
    expect(unexpected).toEqual([]);
    expect(writes).toEqual([]);
    expect(failedResources).toEqual([]);
    writeFileSync(path.join(output, 'report.json'), JSON.stringify({
      checkedAt: new Date().toISOString(), buildId, course: classroom.stage.name,
      scenes: classroom.scenes.length, quizzes: quizTargets.length, audioSegments: ended.length,
      uniqueAudioSegments: uniqueEnded.length, repeatEvents: ended.length - uniqueEnded.length,
      audioSeconds: totalDuration, playbackRate: debugRate,
      result: debugRate === 1 ? '通过' : '调试通过（非完整时长验收）',
    }, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => undefined);
    writeFileSync(path.join(output, 'report.json'), JSON.stringify({
      checkedAt: new Date().toISOString(), buildId, result: '失败', error: String(error), errors, unexpected, writes, failedResources,
      endedAudio: await page.evaluate(() => (window as unknown as { __trialPlayback?: { events: MediaEvidence[] } }).__trialPlayback?.events
        .filter(event => event.event === 'ended').length).catch(() => null),
    }, null, 2));
    throw error;
  }
});
