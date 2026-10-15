import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { SignJWT } from 'jose';
import type { LectureChatInput, LectureChatMessage, LectureChatThread } from '../src/lib/courses/lecture-chat-types';

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || 'http://127.0.0.1:3000';
const courseId = 'lecture-chat-fixture';
const classroomId = 'lecture-chat-classroom';
const now = '2026-10-15T00:00:00.000Z';

type ReaderStream = { push: (text: string) => void; finish: () => void; ready: () => boolean };

// Keep the production NDJSON reader and player DOM, while controlling when each
// response chunk arrives. No model requests or student records are written.
async function installReaderStream(page: Page) {
  await page.addInitScript(({ courseId, classroomId, now }) => {
    const originalFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let input: LectureChatInput;
    let content = '';
    const messages: LectureChatMessage[] = [];
    const emit = (event: unknown) => controller!.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    (window as typeof window & { __lectureReader: ReaderStream }).__lectureReader = {
      ready: () => controller !== null,
      push: (text) => { content += text; emit({ type: 'delta', text }); },
      finish: () => {
        const common = { requestId: input.requestId, createdAt: now, position: { actionIndex: input.actionIndex } };
        messages.push({ ...common, id: `${input.requestId}-student`, role: 'student', content: input.message },
          { ...common, id: `${input.requestId}-assistant`, role: 'assistant', content, citations: [] });
        emit({ type: 'done', thread: { id: input.sceneId, page: { classroomId, sceneId: input.sceneId }, pageTitle: '科学观察', messages } });
        controller!.close();
        controller = null;
      },
    };
    window.fetch = async (resource, options) => {
      const url = new URL(typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url, location.href);
      if (url.pathname !== `/api/courses/${courseId}/lecture-chat` || options?.method !== 'POST') return originalFetch(resource, options);
      input = JSON.parse(options.body as string) as LectureChatInput;
      content = '';
      return new Response(new ReadableStream<Uint8Array>({ start(value) {
        controller = value;
        emit({ type: 'status', message: '正在组织回答…' });
      } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
    };
  }, { courseId, classroomId, now });
}

async function mountLecture(page: Page, stream = false) {
  const errors: string[] = [];
  const cancelledReads = new Set<string>();
  const failedReads: string[] = [];
  const posts: LectureChatInput[] = [];
  const threads = new Map<string, LectureChatThread>();
  let failNext = false;
  let supplementaryGate: Promise<void> = Promise.resolve();
  const scene = (id: string, order: number) => ({
    id, stageId: classroomId, outlineId: id, type: 'slide', title: `科学观察第${order + 1}页`, order,
    audience: 'student', stageKey: 'ai-learning', generationPurpose: 'knowledge-teaching', actions: [], knowledgePointIds: ['observe'],
    content: { type: 'slide', canvas: { id: `canvas-${id}`, viewportSize: 1000, viewportRatio: 0.5625,
      theme: { backgroundColor: '#ffffff', themeColors: ['#344A6A'], fontColor: '#1F2933', fontName: 'Noto Sans SC' },
      background: { type: 'solid', color: '#ffffff' }, elements: [
        { id: 'title', type: 'text', left: 48, top: 50, width: 860, height: 100, rotate: 0,
          defaultFontName: 'Noto Sans SC', defaultColor: '#1F2933', content: `<p style="font-size:36px">科学观察第${order + 1}页</p>` },
        { id: 'body', type: 'text', left: 48, top: 190, width: 850, height: 220, rotate: 0,
          defaultFontName: 'Noto Sans SC', defaultColor: '#1F2933', content: '<p style="font-size:24px">记录日期、地点与数量；保持相同观察时长，才能合理比较。</p>' },
      ] } },
  });
  const scenes = [scene('page-1', 0), scene('page-2', 1), {
    id: 'quiz', stageId: classroomId, outlineId: 'quiz', type: 'quiz', title: '小测', order: 2, actions: [],
    audience: 'student', stageKey: 'ai-learning', generationPurpose: 'knowledge-teaching',
    content: { type: 'quiz', questions: [{ id: 'q', type: 'single', question: '观察时长应该怎样？', points: 1,
      options: [{ value: 'A', label: '保持一致' }, { value: 'B', label: '随意变化' }], answer: ['A'] }] },
  }];
  const course = {
    id: courseId, version: 1, name: '随课提问验收', status: 'teaching', subject: '科学', grade: '初中', hours: 1,
    createdAt: now, updatedAt: now, currentStageIndex: 1, aiLearningClassroomId: classroomId,
    stages: [{ key: 'launch', label: '项目启动', view: 'simple-resource' }, { key: 'ai-learning', label: '知识讲授', view: 'ai-learning' }],
    students: [{ id: 'lecture-chat-student', name: '答疑验收', joinedAt: now, stageProgress: {} }],
    content: { knowledgePoints: [{ id: 'observe', name: '科学观察' }], lessonOutline: [], pblOutline: '',
      evaluationPlan: { dimensions: [], overallRubric: '' } },
    resources: [], groups: [], submissions: [], activityLog: [], uiState: {},
  };
  const secret = (await readFile(process.env.OPENPBL_E2E_JWT_SECRET_FILE || process.env.LAYOUT_JWT_SECRET_FILE || 'deploy/secrets/jwt_secret.txt', 'utf8')).trim();
  const token = await new SignJWT({ role: 'student', sv: 1, userId: 'lecture-chat-student', studentName: '答疑验收', displayName: '答疑验收', username: 'lecture-chat-student' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject('lecture-chat-student').setIssuer('openpbl').setAudience('openpbl-app')
    .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: 'openpbl_student', value: token, url: baseURL }]);
  await page.routeWebSocket('**/*', socket => socket.close());
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && ['events', 'projection', 'presence', 'public-discussion']
      .some(endpoint => url.pathname === `/api/courses/${courseId}/${endpoint}`)) {
      const failure = request.failure()?.errorText ?? 'unknown';
      failedReads.push(`${url.pathname}: ${failure}`);
      if (/cancelled|canceled|abort/i.test(failure)) cancelledReads.add(url.pathname);
    }
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (pathname.startsWith('/api/openmaic/interactive-runtime/')) return route.continue();
    if (pathname === `/api/courses/${courseId}/lecture-chat`) {
      if (request.method() === 'GET') {
        const id = url.searchParams.get('sceneId')!;
        const thread = threads.get(id) ?? { id, page: { classroomId, sceneId: id }, pageTitle: '科学观察', messages: [] };
        return json({ thread, requests: [...new Set(thread.messages.map(message => message.requestId))]
          .map(requestId => ({ requestId, status: 'COMPLETED' })), writable: true });
      }
      const body = request.postDataJSON() as LectureChatInput;
      posts.push(body);
      if (failNext) { failNext = false; return json({ error: 'AI_BUSY', message: '课堂 AI 正忙，请重试' }, 503); }
      const supplementary = body.message === '什么是劣构问题？';
      if (supplementary) await supplementaryGate;
      const thread = threads.get(body.sceneId) ?? { id: body.sceneId, page: { classroomId, sceneId: body.sceneId }, pageTitle: '科学观察', messages: [] };
      if (!thread.messages.some(message => message.requestId === body.requestId)) {
        const common = { requestId: body.requestId, createdAt: now, position: { actionIndex: body.actionIndex } };
        thread.messages.push({ ...common, id: `${body.requestId}-student`, role: 'student', content: body.message },
          { ...common, id: `${body.requestId}-assistant`, role: 'assistant',
            content: supplementary ? '劣构问题的目标、条件或评价标准不完全明确，通常存在多种合理的解决方案。例如如何设计一次校园环保活动，需要权衡预算、参与度和实际效果。'
              : '应保持相同观察时长。例如比较两个地点，各观察十分钟，再记录数量。\n\n平均数可写为 $\\bar{x}=\\frac{1}{n}\\sum x_i$。',
            citations: supplementary ? [] : [
              { id: 'S1', textbookTitle: '科学观察教材', revisionId: 'rev-1', sectionPath: ['观察方法'], quote: '比较观察结果时，应保持相同观察时长。'.repeat(30) },
              { id: 'S2', textbookTitle: '科学观察教材', revisionId: 'rev-1', sectionPath: ['记录条件'], quote: '记录观察时长与天气条件。' },
              { id: 'S3', textbookTitle: '科学活动手册', revisionId: 'rev-2', sectionPath: ['比较与分析'], quote: '比较前应确认观察条件一致。' },
            ] } as LectureChatMessage);
      }
      threads.set(body.sceneId, thread);
      return route.fulfill({ contentType: 'application/x-ndjson', body: [
        { type: 'status', message: '正在组织回答…' },
        { type: 'delta', text: thread.messages.at(-1)!.content }, { type: 'done', thread },
      ].map(event => JSON.stringify(event)).join('\n') + '\n' });
    }
    if (pathname === '/api/auth/me') return json({ user: { id: 'lecture-chat-student', role: 'student', displayName: '答疑验收' } });
    if (pathname === '/api/courses') return json({ courses: [course], hydrated: true,
      user: { role: 'student', name: '答疑验收' }, studentId: 'lecture-chat-student', joinedCourseId: courseId });
    if (pathname.endsWith('/state')) return json({ course, eventCursor: '0' });
    if (pathname.endsWith('/events')) return json({ events: [], nextCursor: '0', hasMore: false });
    if (pathname.endsWith('/presence')) return json({ members: [] });
    if (pathname.endsWith('/projection')) return json({ courseId, courseVersion: 1, projectionVersion: 0, resourceProjection: null, teacherResourceProjection: null });
    if (pathname.endsWith('/public-discussion')) return json({ enabled: false, session: null });
    if (pathname === '/api/openmaic/classroom') return json({ success: true, classroom: { stage: { id: classroomId, name: course.name, createdAt: 1, updatedAt: 1 }, scenes } });
    if (pathname === '/api/openmaic/progress') return json({ data: { progress: {} } });
    if (pathname.includes('learning-events') || pathname.includes('learning-analytics')) return json({ success: true });
    if (/provider|server-providers/.test(pathname)) return json({ providers: [], models: [], success: true });
    if (pathname.endsWith('/actions')) return json({ success: true, courseVersion: 1 });
    errors.push(`Missing fixture: ${request.method()} ${pathname}`);
    return json({}, 404);
  });
  if (stream) await installReaderStream(page);
  await page.goto(`${baseURL}/student/classroom/${courseId}`);
  await expect(page.getByPlaceholder('这里没听懂？问一下')).toBeVisible();
  return {
    // WebKit reports intentionally aborted background polling during reload as
    // an access-control error. Ignore only a matching, confirmed cancellation;
    // lecture requests and all other JavaScript/network errors remain failures.
    get errors() { return errors.filter(message => !message.includes('due to access control checks.')
      || ![...cancelledReads].some(path => message.includes(path))); },
    posts, failedReads, fail() { failNext = true; },
    holdSupplementaryAnswer() {
      let release!: () => void;
      supplementaryGate = new Promise<void>(resolve => { release = resolve; });
      return release;
    },
  };
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 1024, height: 768 },
  { width: 390, height: 844 }, { width: 390, height: 480 }, { width: 320, height: 568 }, { width: 844, height: 390 }, { width: 568, height: 320 }]) {
  test.describe(`随课提问 ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, ...(viewport.width <= 1024 ? { hasTouch: true,
      ...(process.env.PRELAUNCH_E2E_BROWSER === 'firefox' ? {} : { isMobile: true }) } : {}) });
    test('quiet input, IME, evidence, recovery and page isolation in the actual player', async ({ page }, info) => {
      test.setTimeout(60_000);
      const fixture = await mountLecture(page);
      const input = page.getByPlaceholder('这里没听懂？问一下');
      await expect(page.getByText('应保持相同观察时长。', { exact: true })).toHaveCount(0);
      await input.fill('这里为什么要保持一致？');
      await input.dispatchEvent('compositionstart');
      await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
      await expect.poll(() => fixture.posts.length).toBe(0);
      await input.dispatchEvent('compositionend');
      await page.getByRole('button', { name: '发送问题', exact: true }).click();
      await expect(page.getByText('这里为什么要保持一致？', { exact: true })).toBeVisible();
      const sources = page.getByRole('group', { name: '教材出处', exact: true });
      await expect(sources.getByRole('button')).toHaveCount(2);
      await expect(page.getByRole('dialog', { name: '教材来源', exact: true })).toHaveCount(0);
      await sources.getByRole('button', { name: '查看教材来源：科学观察教材', exact: true }).click();
      const source = page.getByRole('dialog', { name: '教材来源', exact: true });
      await expect(source.getByText('观察方法', { exact: true })).toBeVisible();
      await expect(source.locator('details[open]')).toHaveCount(0);
      await source.getByText('查看原文', { exact: true }).first().click();
      await expect(source.getByText('比较观察结果时，应保持相同观察时长。'.repeat(30), { exact: true })).toBeVisible();
      const sourceBounds = (await source.boundingBox())!;
      expect(sourceBounds.x).toBeGreaterThanOrEqual(0);
      expect(sourceBounds.y).toBeGreaterThanOrEqual(0);
      expect(sourceBounds.x + sourceBounds.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(sourceBounds.y + sourceBounds.height).toBeLessThanOrEqual(viewport.height + 1);
      await source.getByRole('button', { name: '关闭教材来源', exact: true }).click();
      await expect(page.locator('.katex').first()).toBeVisible();
      const geometry = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth,
        input: document.querySelector('textarea[placeholder="这里没听懂？问一下"],input[placeholder="这里没听懂？问一下"]')!.getBoundingClientRect().toJSON(), height: innerHeight }));
      expect(geometry.overflow).toBeLessThanOrEqual(2);
      expect(geometry.input.bottom).toBeLessThanOrEqual(geometry.height);
      const canvas = page.locator('[class~="group/canvas"]').filter({ visible: true }).first();
      await expect(canvas.locator('[data-slide-element-id="title"]').getByText('科学观察第1页', { exact: true })).toBeVisible();
      expect((await canvas.boundingBox())!.height).toBeGreaterThan(80);
      await info.attach('答疑展开', { body: await page.screenshot({ path: info.outputPath('answer.png') }), contentType: 'image/png' });
      await page.getByRole('button', { name: '收起答疑', exact: true }).click();
      await page.getByRole('button', { name: /下一页/ }).click();
      await expect(input).toHaveValue('');
      await expect(page.getByText('这里为什么要保持一致？', { exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: /上一页/ }).click();
      await page.reload();
      await page.getByRole('button', { name: /本页问答/ }).click();
      await expect(page.getByText('这里为什么要保持一致？', { exact: true })).toBeVisible();
      fixture.fail();
      await input.fill('再举一个例子');
      await page.getByRole('button', { name: '发送问题', exact: true }).click();
      await expect(page.getByText(/课堂 AI 正忙/)).toBeVisible();
      await page.getByRole('button', { name: /重试/ }).click();
      await expect(page.getByText('再举一个例子', { exact: true })).toBeVisible();
      await expect.poll(() => fixture.posts.length).toBe(3);
      expect(fixture.posts[1].requestId).toBe(fixture.posts[2].requestId);
      // WebKit can emit pageerror before the matching requestfailed cancellation.
      await expect.poll(() => fixture.errors, { message: fixture.failedReads.join('\n') }).toEqual([]);
    });
  });
}

test('shows supplementary knowledge without invented textbook sources and still renders a later textbook answer', async ({ page }) => {
  const fixture = await mountLecture(page);
  const release = fixture.holdSupplementaryAnswer();
  await page.getByPlaceholder('这里没听懂？问一下').fill('什么是劣构问题？');
  await page.getByRole('button', { name: '发送问题', exact: true }).click();
  try { await expect(page.getByPlaceholder('正在组织回答…')).toBeVisible(); }
  finally { release(); }
  await expect(page.getByText(/劣构问题的目标、条件或评价标准不完全明确/)).toBeVisible();
  await expect(page.getByRole('log').getByRole('group', { name: '教材出处', exact: true })).toHaveCount(0);
  await expect(page.getByRole('log').getByText('随课答疑', { exact: true })).toBeVisible();
  await page.getByPlaceholder('这里没听懂？问一下').fill('比较观察结果时为什么要保持一致？');
  await page.getByRole('button', { name: '发送问题', exact: true }).click();
  await page.getByRole('button', { name: '查看教材来源：科学观察教材', exact: true }).click();
  const source = page.getByRole('dialog', { name: '教材来源', exact: true });
  await expect(source.locator('details[open]')).toHaveCount(0);
  await source.getByText('查看原文', { exact: true }).first().click();
  await expect(source.getByText('比较观察结果时，应保持相同观察时长。'.repeat(30), { exact: true })).toBeVisible();
  await expect(source.locator('details')).toHaveCount(2);
  await source.getByRole('button', { name: '关闭教材来源', exact: true }).click();
  await expect(page.locator('.katex').first()).toBeVisible();
  expect(fixture.posts).toHaveLength(2);
  await expect.poll(() => fixture.errors, { message: fixture.failedReads.join('\n') }).toEqual([]);
});

test('textbook icons preview on hover, pin for reading and close with Escape in the actual player', async ({ page }) => {
  const fixture = await mountLecture(page);
  await page.getByPlaceholder('这里没听懂？问一下').fill('为什么要记录观察时长？');
  await page.getByRole('button', { name: '发送问题', exact: true }).click();
  const trigger = page.getByRole('button', { name: '查看教材来源：科学观察教材', exact: true });
  const source = page.getByRole('dialog', { name: '教材来源', exact: true });
  await trigger.hover();
  await expect(source.getByText('科学观察教材', { exact: true })).toBeVisible();
  await expect(source.locator('details[open]')).toHaveCount(0);
  await source.getByText('观察方法', { exact: true }).hover();
  await expect(source).toBeVisible();
  await page.getByRole('link', { name: '返回课程空间', exact: true }).hover();
  await expect(source).toHaveCount(0);
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(source).toBeVisible();
  await expect(source.getByRole('button', { name: '关闭教材来源', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(source.locator('summary').first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(source.locator('details[open]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(source).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect.poll(() => fixture.errors, { message: fixture.failedReads.join('\n') }).toEqual([]);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 568, height: 320 }]) {
  test.describe(`回答阅读位置 ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });
    test('anchors the answer start without following chunks, preserves manual reading and reopens at the latest answer', async ({ page }) => {
      const fixture = await mountLecture(page, true);
      const input = page.getByPlaceholder('这里没听懂？问一下');
      const reader = page.getByRole('log');
      const stream = (operation: 'push' | 'finish', text = '') => page.evaluate(({ operation, text }) => {
        const controller = (window as typeof window & { __lectureReader: ReaderStream }).__lectureReader;
        if (operation === 'push') controller.push(text);
        else controller.finish();
      }, { operation, text });
      const position = () => reader.evaluate(element => {
        const answer = element.querySelector<HTMLElement>('[data-lecture-chat-answer]:last-of-type')!;
        return { scrollTop: element.scrollTop, top: answer.getBoundingClientRect().top - element.getBoundingClientRect().top,
          height: element.clientHeight, scrollHeight: element.scrollHeight };
      });
      const start = async (question: string) => {
        await input.fill(question);
        await page.getByRole('button', { name: '发送问题', exact: true }).click();
        await expect.poll(() => page.evaluate(() => (window as typeof window & { __lectureReader: ReaderStream }).__lectureReader.ready())).toBe(true);
        await stream('push', '先从问题的核心解释：比较观察结果时，需要让观察时长保持一致。\n\n');
        await expect(reader.locator('[data-answer-complete="false"]')).toBeVisible();
        await expect.poll(async () => Math.abs((await position()).top)).toBeLessThan(2);
      };
      const paragraph = '例如比较校园里两个地点的鸟类数量，每个地点都观察十分钟，记录日期、地点和数量，再比较所得结果。'.repeat(3) + '\n\n';
      await start('请详细解释为什么观察时长要一致');
      const initial = await position();
      expect(initial.scrollTop).toBeGreaterThan(0);
      for (let index = 0; index < 3; index++) {
        await stream('push', paragraph);
        await expect(reader.locator('[data-answer-complete="false"] p')).toHaveCount(index + 3);
        expect(Math.abs((await position()).scrollTop - initial.scrollTop)).toBeLessThan(2);
        expect(Math.abs((await position()).top)).toBeLessThan(2);
      }
      expect((await position()).scrollHeight).toBeGreaterThan(initial.scrollHeight);
      await stream('finish');
      await expect(reader.locator('[data-answer-complete="true"]')).toHaveCount(1);
      await expect.poll(async () => Math.abs((await position()).top)).toBeLessThan(2);
      await expect(input).toBeEnabled();

      await start('再详细解释第二个问题');
      await stream('push', paragraph.repeat(2));
      await expect(reader.locator('[data-answer-complete="false"]')).toContainText('校园');
      const beforeWheel = await position();
      await reader.hover();
      await page.mouse.wheel(0, 80);
      await expect.poll(async () => (await position()).scrollTop).toBeGreaterThan(beforeWheel.scrollTop + 10);
      // Let the native wheel settle before checking that later chunks leave it alone.
      await page.waitForTimeout(150);
      const manual = await position();
      await stream('push', paragraph);
      await stream('finish');
      await expect(reader.locator('[data-answer-complete="true"]')).toHaveCount(2);
      expect(Math.abs((await position()).scrollTop - manual.scrollTop)).toBeLessThan(2);
      expect((await position()).top).toBeLessThan(-10);
      await page.getByRole('button', { name: '收起答疑', exact: true }).click();
      await page.getByRole('button', { name: /本页问答/ }).click();
      await expect.poll(async () => Math.abs((await position()).top)).toBeLessThan(2);
      const inputBounds = (await input.boundingBox())!;
      expect(inputBounds.y + inputBounds.height).toBeLessThanOrEqual(viewport.height + 1);
      await expect.poll(() => fixture.errors, { message: fixture.failedReads.join('\n') }).toEqual([]);
    });
  });
}

test('typing cancels an already queued auto advance until explicit continue; quiz has no input', async ({ page }) => {
  const fixture = await mountLecture(page);
  await page.getByRole('button', { name: '继续讲解', exact: true }).click();
  await expect(page.getByText('即将播放下一页')).toBeVisible();
  await page.getByPlaceholder('这里没听懂？问一下').fill('等一下');
  await page.waitForTimeout(2300); // The original 2s advance deadline must expire without switching.
  await expect(page.locator('[data-stage-host-mode="student"]')).toHaveAttribute('data-active-scene-id', 'page-1');
  await page.getByRole('button', { name: '继续学习', exact: true }).click();
  await expect(page.locator('[data-stage-host-mode="student"]')).toHaveAttribute('data-active-scene-id', 'page-2');
  await page.getByRole('button', { name: /下一页/ }).click();
  await expect(page.getByPlaceholder('这里没听懂？问一下')).toHaveCount(0);
  await expect.poll(() => fixture.errors, { message: fixture.failedReads.join('\n') }).toEqual([]);
});
