import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { SignJWT } from 'jose';
import type { KnowledgeLectureAttempt, KnowledgeLectureTutorThread } from '../src/lib/session/types';
import type { KnowledgeLectureExplanation } from '../src/lib/courses/knowledge-explanation-types';

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || 'http://127.0.0.1:3000';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname)) {
  throw new Error('Prepared explanation fixtures require a local acceptance service.');
}
test.use({ baseURL, serviceWorkers: 'block', reducedMotion: 'reduce' });

const courseId = 'prepared-explanation-fixture';
const classroomId = 'prepared-explanation-classroom';
const studentId = 'prepared-explanation-student';
const now = '2026-10-15T00:00:00.000Z';
const prompt = '比较两处绿地的鸟类数量时，哪一种记录方式更可靠？';
const options = [
  { value: 'A', label: '保持相同观察时长，记录日期、地点和数量' },
  { value: 'B', label: '仅凭一次观察后的印象判断' },
  { value: 'C', label: '在一处观察十分钟，在另一处观察一小时' },
  { value: 'D', label: '只记录天气，不记录鸟类数量' },
];
const sharedText = '比较鸟类数量，需要统一观察条件，并保留能够核对的记录。\n'
  + 'A选项正确：相同观察时长让两处记录具有可比性，日期、地点与数量便于回查。\n'
  + 'B选项不正确：个人印象容易遗漏细节，不能代替实际数量记录。\n'
  + 'C选项不正确：观察时间差异会影响发现的鸟类数量，无法据此直接比较。\n'
  + 'D选项不正确：天气可以作为观察条件，但没有鸟类数量便无法比较数量差异。\n'
  + '记住这个方法：先统一观察时长，再完整记录和比较数量。';
const fillText = '填空答案是“观察时长”。只有保持观察时长一致，数量记录才具有可比性。'
  + '例如两处都观察十分钟，再结合日期、地点和天气解释差异。';
const followupReply = '针对你选择的B，印象无法说明具体数量。可以把两处都观察十分钟的数量写下来，再作比较。';

const attempt: KnowledgeLectureAttempt = {
  id: 'prepared-attempt', sectionId: 'prepared-section', quizOutlineId: 'prepared-quiz', runtimeSceneId: 'prepared-scene',
  submittedAt: now, score: 1, maxScore: 2, gradingSource: 'server', gradingStatus: 'graded', knowledgePointIds: ['observe'],
  questions: [
    { questionId: 'choice', questionType: 'single', questionFormat: 'single_choice', prompt, options, answer: 'B', rawAnswer: ['B'],
      points: 1, earned: 0, correct: false, feedback: '你选择了B，请进一步核对比较依据。', authoredAnalysis: sharedText,
      referenceAnswer: 'A', gradingStatus: 'graded', knowledgePointIds: ['observe'] },
    { questionId: 'blank', questionType: 'short_answer', questionFormat: 'fill_blank', prompt: '比较鸟类数量时，应保持______一致。',
      answer: '观察时长', rawAnswer: '观察时长', points: 1, earned: 1, correct: true, feedback: '本题作答正确。',
      authoredAnalysis: fillText, referenceAnswer: '观察时长', gradingStatus: 'graded', knowledgePointIds: ['observe'] },
  ],
};

// A real browser audio element plays a local silent WAV. This checks loading,
// pause and replay, without provider calls or claims about speech quality.
function silentWav(seconds: number): Buffer {
  const sampleRate = 8_000;
  const bytes = seconds * sampleRate * 2;
  const wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + bytes, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(bytes, 40);
  return wav;
}

type AudioSnapshot = { src: string; paused: boolean; pauseCalls: number; playCalls: number };
async function audioSnapshot(page: Page): Promise<AudioSnapshot[]> {
  return page.evaluate(() => (window as typeof window & { __preparedAudio: () => AudioSnapshot[] }).__preparedAudio());
}

async function mountPreparedLecture(page: Page) {
  const pageErrors: string[] = [];
  const unexpected: string[] = [];
  const tutorPosts: Array<Record<string, unknown>> = [];
  const synthesisPosts: Array<Record<string, unknown>> = [];
  const settingsReads: string[] = [];
  const threads: KnowledgeLectureTutorThread[] = [{
    id: 'thread-choice', attemptId: attempt.id, questionId: 'choice', boardNotes: [], createdAt: now, updatedAt: now,
    messages: [
      { id: 'old-initial', role: 'assistant', content: '旧的个性化首轮讲解。', createdAt: now },
      { id: 'old-student', role: 'student', content: '以前的追问', createdAt: now },
      { id: 'old-assistant', role: 'assistant', content: '以前的个性化追问回答', createdAt: now },
    ],
  }];
  const wav = silentWav(60);
  const course = {
    id: courseId, version: 1, name: '预生成助教讲解浏览器验收', subject: '科学', grade: '初中', hours: 1, status: 'teaching',
    summary: '', drivingQuestion: '如何依据观察记录比较数量？', createdAt: now, updatedAt: now, currentStageIndex: 1,
    stages: [{ key: 'launch', label: '项目启动', view: 'simple-resource' }, { key: 'ai-learning', label: '知识讲授', view: 'ai-learning' }],
    students: [{ id: studentId, name: '讲解验收学生', joinedAt: now, stageProgress: {} }],
    resources: [], groups: [], submissions: [], activityLog: [], uiState: {}, aiLearningClassroomId: classroomId,
    content: { pblOutline: '', lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: '' },
      knowledgePoints: [{ id: 'observe', name: '科学观察', description: '统一观察条件，记录并比较数量。' }],
      knowledgeLectureSections: [{ id: 'prepared-section', title: '科学观察', order: 0, quizOutlineId: 'prepared-quiz',
        sceneOutlineIds: [], knowledgePointIds: ['observe'] }] },
    aiLearningProgress: { [studentId]: { classroomId, currentSceneIndex: 0, totalScenes: 1, completedScenes: ['prepared-scene'],
      lastActiveAt: now, knowledgeLectureAttempts: [attempt], knowledgeLectureTutorThreads: threads } },
  };
  const questions = [
    { id: 'choice', type: 'single', format: 'single_choice', question: prompt, options, answer: ['A'], analysis: sharedText, points: 1, knowledgePointIds: ['observe'] },
    { id: 'blank', type: 'short_answer', format: 'fill_blank', question: attempt.questions[1]!.prompt, answer: '观察时长', analysis: fillText, points: 1, knowledgePointIds: ['observe'] },
  ];
  const secret = (await readFile(process.env.OPENPBL_E2E_JWT_SECRET_FILE || process.env.LAYOUT_JWT_SECRET_FILE || 'deploy/secrets/jwt_secret.txt', 'utf8')).trim();
  const token = await new SignJWT({ role: 'student', sv: 1, userId: studentId, studentName: '讲解验收学生', displayName: '讲解验收学生' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(studentId).setIssuer('openpbl').setAudience('openpbl-app')
    .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: 'openpbl_student', value: token, url: baseURL }]);
  await page.addInitScript(() => {
    const NativeAudio = window.Audio;
    const observed: Array<{ audio: HTMLAudioElement; pauseCalls: number; playCalls: number }> = [];
    const InstrumentedAudio = function (src?: string) {
      const audio = new NativeAudio(src);
      if (!src || (!src.includes('/audio/prepared-') && !src.startsWith('data:audio/'))) return audio;
      const entry = { audio, pauseCalls: 0, playCalls: 0 };
      const pause = audio.pause.bind(audio);
      const play = audio.play.bind(audio);
      audio.pause = () => { entry.pauseCalls += 1; pause(); };
      audio.play = () => { entry.playCalls += 1; return play(); };
      observed.push(entry);
      return audio;
    };
    InstrumentedAudio.prototype = NativeAudio.prototype;
    Object.setPrototypeOf(InstrumentedAudio, NativeAudio);
    window.Audio = InstrumentedAudio as unknown as typeof Audio;
    (window as typeof window & { __preparedAudio: () => AudioSnapshot[] }).__preparedAudio = () => observed.map(({ audio, pauseCalls, playCalls }) => ({
      src: audio.src.startsWith('data:') ? 'data:audio/wav' : new URL(audio.src).pathname,
      paused: audio.paused, pauseCalls, playCalls,
    }));
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.routeWebSocket('**/*', socket => socket.close());
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== new URL(baseURL).origin) { unexpected.push(`${method} ${url}`); return route.abort('blockedbyclient'); }
    if (!pathname.startsWith('/api/')) {
      if (['GET', 'HEAD'].includes(method)) return route.continue();
      unexpected.push(`${method} ${pathname}`);
      return json({}, 405);
    }
    if (method === 'GET' && pathname.startsWith('/api/openmaic/interactive-runtime/')) return route.continue();
    if (method === 'GET' && pathname.startsWith(`/api/openmaic/classroom-media/${classroomId}/`)) {
      return route.fulfill({ contentType: 'audio/wav', body: wav });
    }
    if (pathname === '/api/auth/me') return json({ user: { id: studentId, role: 'student', displayName: '讲解验收学生' } });
    if (pathname === '/api/courses') return json({ courses: [course], hydrated: true,
      user: { role: 'student', name: '讲解验收学生' }, studentId, studentName: '讲解验收学生', joinedCourseId: courseId });
    if (pathname === `/api/courses/${courseId}/state`) return json({ course, eventCursor: '0' });
    if (pathname === `/api/courses/${courseId}/events`) return json({ events: [], nextCursor: '0', hasMore: false, courseVersion: 1 });
    if (pathname === `/api/courses/${courseId}/presence`) return json({ members: [] });
    if (pathname === `/api/courses/${courseId}/projection`) return json({ courseId, courseVersion: 1, projectionVersion: 0, resourceProjection: null, teacherResourceProjection: null });
    if (pathname === `/api/courses/${courseId}/public-discussion`) return json({ enabled: false, session: null });
    if (pathname === `/api/courses/${courseId}/actions`) return json({ success: true, courseVersion: 1 });
    if (pathname === '/api/openmaic/classroom') return json({ success: true, classroom: {
      stage: { id: classroomId, name: course.name, createdAt: now, updatedAt: now },
      scenes: [{ id: 'prepared-scene', stageId: classroomId, outlineId: 'prepared-quiz', lectureSectionId: 'prepared-section',
        title: '科学观察小测', type: 'quiz', order: 0, audience: 'student', stageKey: 'ai-learning', generationPurpose: 'knowledge-teaching',
        content: { type: 'quiz', questions }, actions: [] }],
    } });
    if (pathname === '/api/openmaic/progress') return json({ data: { progress: {} } });
    if (pathname === '/api/knowledge-lecture/settings') {
      settingsReads.push(pathname);
      return json({ settings: { ttsProviderId: 'fixture-tts', ttsVoice: 'fixture-voice' } });
    }
    if (pathname === '/api/knowledge-lecture' && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      tutorPosts.push(body);
      const questionId = String(body.questionId);
      if (body.action === 'tutor-explain') {
        const explanation: KnowledgeLectureExplanation = { id: `prepared-${questionId}`, questionFingerprint: `fingerprint-${questionId}`,
          text: questionId === 'blank' ? fillText : sharedText, boardNotes: [], source: 'prepared', audioDurationSec: 60,
          audioUrl: `/api/openmaic/classroom-media/${classroomId}/audio/prepared-${questionId}.wav` };
        return json({ explanation });
      }
      if (body.action === 'tutor-message') {
        let thread = threads.find(item => item.questionId === questionId);
        if (!thread) {
          thread = { id: `thread-${questionId}`, attemptId: attempt.id, questionId, messages: [], boardNotes: [], createdAt: now, updatedAt: now };
          threads.push(thread);
        }
        thread.messages.push({ id: `${body.requestId}-student`, role: 'student', content: String(body.message), createdAt: now },
          { id: `${body.requestId}-assistant`, role: 'assistant', content: followupReply, createdAt: now });
        return json({ thread });
      }
    }
    if (pathname === '/api/openmaic/generate/tts' && method === 'POST') {
      synthesisPosts.push(request.postDataJSON() as Record<string, unknown>);
      return json({ base64: wav.toString('base64'), format: 'wav' });
    }
    if (pathname.includes('learning-events') || pathname.includes('learning-analytics')) return json({ success: true });
    if (/provider|server-providers/.test(pathname)) return json({ providers: [], models: [], success: true });
    unexpected.push(`${method} ${pathname}`);
    return json({ error: 'FIXTURE_MISSING' }, 404);
  });
  await page.goto(`${baseURL}/student/classroom/${courseId}`);
  await expect(page.getByRole('button', { name: '助教讲解', exact: true }).first()).toBeVisible();
  return { pageErrors, unexpected, tutorPosts, synthesisPosts, settingsReads };
}

async function reachable(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeInViewport();
  await control.click({ trial: true });
}

for (const viewport of [{ width: 390, height: 844 }, { width: 1024, height: 768 }, { width: 1366, height: 900 }]) {
  test.describe(`预生成题目讲解 ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, ...(viewport.width === 390 ? { hasTouch: true,
      ...(process.env.PRELAUNCH_E2E_BROWSER === 'firefox' ? {} : { isMobile: true }) } : {}) });
    test('shared narration, replay, follow-up, IME and audio lifecycle in the actual student player', async ({ page }, info) => {
      test.setTimeout(60_000);
      const fixture = await mountPreparedLecture(page);
      const trigger = page.getByRole('button', { name: '助教讲解', exact: true }).first();
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: '助教题目讲解', exact: true });
      const lesson = dialog.getByLabel('统一题目讲解', { exact: true });
      await expect(lesson).toHaveText(sharedText);
      await lesson.scrollIntoViewIfNeeded();
      await expect(lesson).toBeInViewport();
      await expect.poll(async () => (await audioSnapshot(page))[0]?.paused).toBe(false);
      expect(fixture.tutorPosts.map(body => body.action)).toEqual(['tutor-explain']);
      expect(fixture.tutorPosts[0]).not.toHaveProperty('requestId');
      expect(fixture.synthesisPosts).toEqual([]);
      expect(fixture.settingsReads).toEqual([]);
      await expect(dialog.getByText('以前的个性化追问回答', { exact: true })).toBeVisible();
      await expect(dialog.getByText('旧的个性化首轮讲解。', { exact: true })).toHaveCount(0);
      const bounds = (await dialog.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(2);
      await info.attach('完整统一讲解', { body: await page.screenshot({ path: info.outputPath('shared-explanation.png') }), contentType: 'image/png' });

      await dialog.getByRole('button', { name: '再听一遍', exact: true }).click();
      await expect.poll(async () => (await audioSnapshot(page)).length).toBe(2);
      await expect.poll(async () => (await audioSnapshot(page))[1]?.paused).toBe(false);
      expect((await audioSnapshot(page))[0]).toMatchObject({ paused: true, pauseCalls: 1 });
      expect(fixture.tutorPosts).toHaveLength(1);
      expect(fixture.synthesisPosts).toEqual([]);

      const input = dialog.getByPlaceholder('把不明白的地方告诉助教…');
      await input.fill('为什么我选的B不合适？');
      await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
      await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 });
      await input.press('Shift+Enter');
      expect(fixture.tutorPosts.filter(body => body.action === 'tutor-message')).toHaveLength(0);
      await input.fill('为什么我选的B不合适？');
      await reachable(dialog.getByRole('button', { name: '发送追问', exact: true }));
      await info.attach('追问输入可达', { body: await page.screenshot({ path: info.outputPath('followup-composer.png') }), contentType: 'image/png' });
      await input.press('Enter');
      await expect(dialog.getByText(followupReply, { exact: true })).toBeVisible();
      await expect.poll(() => fixture.synthesisPosts.length).toBe(1);
      expect(fixture.synthesisPosts[0].text).toBe(followupReply);
      expect(fixture.tutorPosts.filter(body => body.action === 'tutor-message')).toHaveLength(1);
      expect((await audioSnapshot(page))[1]).toMatchObject({ paused: true, pauseCalls: 1 });
      await expect.poll(async () => (await audioSnapshot(page))[2]?.paused).toBe(false);

      await dialog.getByRole('button', { name: /第 2 题/ }).click();
      await expect(lesson).toHaveText(fillText);
      await expect.poll(async () => (await audioSnapshot(page))[3]?.paused).toBe(false);
      expect((await audioSnapshot(page))[2]).toMatchObject({ paused: true, pauseCalls: 1 });
      expect(fixture.tutorPosts.filter(body => body.action === 'tutor-explain')).toHaveLength(2);
      expect(fixture.tutorPosts.find(body => body.questionId === 'blank')).not.toHaveProperty('requestId');
      await dialog.getByRole('button', { name: '关闭讲解', exact: true }).click();
      await expect(dialog).toBeHidden();
      expect((await audioSnapshot(page))[3].paused).toBe(true);
      expect((await audioSnapshot(page))[3].pauseCalls).toBeGreaterThanOrEqual(1);
      await expect(trigger).toBeFocused();

      await trigger.click();
      await expect(lesson).toHaveText(sharedText);
      await expect.poll(async () => (await audioSnapshot(page))[4]?.paused).toBe(false);
      expect(fixture.tutorPosts.filter(body => body.action === 'tutor-message')).toHaveLength(1);
      expect(fixture.synthesisPosts).toHaveLength(1);
      expect(fixture.settingsReads).toHaveLength(1);
      await dialog.getByRole('button', { name: '关闭讲解', exact: true }).click();
      await expect(dialog).toBeHidden();
      expect(fixture.pageErrors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  });
}
