import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { SignJWT } from 'jose';
import { readFileSync } from 'node:fs';
import type { PPTVideoElement } from '@openmaic/dsl';
import { DEFAULT_STAGES, type Course } from '../src/lib/session/types';
import type { Action } from '../src/lib/openmaic/types/action';
import type { Scene, Stage } from '../src/lib/openmaic/types/stage';

// Every API request and WebSocket is intercepted; saves only update this
// in-memory fixture. Unknown endpoints fail closed instead of reaching the DB.
test.use({
  serviceWorkers: 'block',
  ...(process.env.OPENPBL_EDITOR_E2E_BASE_URL ? { baseURL: process.env.OPENPBL_EDITOR_E2E_BASE_URL } : {}),
});

const courseId = 'e2e-teacher-classroom-editor';
const classroomId = 'e2e-editable-classroom';
const sceneId = 'e2e-editable-scene';
const fixedTime = '2026-09-12T00:00:00.000Z';
const boardText = '观察教室用电，比较两种节能方案。';
const narration = '先读表格中的耗电量，再说明你选择的方案。';
const aiBoardText = 'AI 协作后的板书';
const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const imageDataUrl = `data:image/png;base64,${imageBase64}`;

type ClassroomResource = { id: string; stage: Stage; scenes: Scene[]; revision: number; createdAt: string };
type ClassroomPatch = { classroomId: string; revision: number; stage: Stage; scenes: Scene[]; audioUploads?: unknown[] };
type AgentRequest = {
  message: string;
  courseId: string;
  scene: { id: string; title: string };
  sceneContextMap: Record<string, { actions: Action[]; stageId: string }>;
};
type Fixture = {
  resource: () => ClassroomResource;
  patches: ClassroomPatch[];
  agentRequests: AgentRequest[];
  requests: string[];
  unexpected: string[];
  errors: string[];
};
const fixtures = new WeakMap<Page, Fixture>();

function course(): Course {
  return {
    id: courseId,
    version: 1,
    name: '校园节能：从观察到行动',
    subject: '科学',
    grade: '七年级',
    hours: 1,
    summary: '',
    drivingQuestion: '怎样改进校园能源使用？',
    status: 'preparing',
    aiLearningClassroomId: classroomId,
    stages: DEFAULT_STAGES.map((stage) => ({ ...stage })),
    currentStageIndex: 0,
    students: [],
    resources: [],
    groups: [],
    content: {
      pblOutline: '',
      knowledgePoints: [],
      lessonOutline: [],
      evaluationPlan: { dimensions: [], overallRubric: '' },
    },
    createdAt: fixedTime,
    updatedAt: fixedTime,
  } as Course;
}

function resource(): ClassroomResource {
  const timestamp = Date.parse(fixedTime);
  return {
    id: classroomId,
    revision: 3,
    createdAt: fixedTime,
    stage: { id: classroomId, name: '校园节能 AI 课堂', createdAt: timestamp, updatedAt: timestamp },
    scenes: [{
      id: sceneId,
      stageId: classroomId,
      title: '观察能源使用',
      type: 'slide',
      order: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      content: {
        type: 'slide',
        schemaVersion: 1,
        canvas: {
          id: 'e2e-canvas',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          elements: [],
          background: { type: 'solid', color: '#ffffff' },
          theme: {
            backgroundColor: '#ffffff',
            themeColors: ['#344a6a', '#2f6f65', '#566f7f', '#8a6422', '#8a3e3e'],
            fontColor: '#243447',
            fontName: 'Noto Sans SC',
            outline: { color: '#344a6a', width: 2, style: 'solid' },
            shadow: { h: 0, v: 0, blur: 0, color: '#000000' },
          },
        },
      },
      actions: [{ id: 'e2e-introduction', type: 'speech', text: '今天我们一起观察校园中的能源使用。' }],
    }],
  };
}

async function mockEditor(page: Page, baseURL = 'http://localhost:3000', initialResource = resource(), agentOutcome: 'complete' | 'disconnect' = 'complete'): Promise<Fixture> {
  let saved = initialResource;
  const fixture: Fixture = {
    resource: () => saved,
    patches: [],
    agentRequests: [],
    requests: [],
    unexpected: [],
    errors: [],
  };
  fixtures.set(page, fixture);
  page.on('pageerror', (error) => fixture.errors.push(error.message));

  // A reused production service may use a different secret from .env.local.
  // Only use it to sign an ephemeral teacher cookie; never print the secret.
  const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE
    ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, 'utf8').trim()
    : process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('Set JWT_SECRET or OPENPBL_E2E_JWT_SECRET_FILE for the reused server before running this suite.');
  }
  const token = await new SignJWT({ role: 'teacher', sv: 1, username: 'e2e-classroom-editor', displayName: '课堂编辑验收教师' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('e2e-classroom-editor-teacher')
    .setIssuer('openpbl').setAudience('openpbl-app').setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: 'openpbl_teacher', value: token, domain: new URL(baseURL).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);

  // Next's development bootstrap needs its own HMR handshake. Only mock
  // application sockets; classroom traffic still cannot reach the database.
  await page.routeWebSocket((url) => !url.pathname.startsWith('/_next/'), (socket) => {
    socket.onMessage((message) => {
      const payload = JSON.parse(String(message)) as { type?: string; courseId?: string };
      if (payload.type === 'subscribe') socket.send(JSON.stringify({ type: 'subscribed', courseId: payload.courseId }));
    });
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const entry = `${method} ${path}`;
    fixture.requests.push(entry);
    const json = (value: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (method === 'GET' && path === '/api/auth/me') return json({ user: { id: 'e2e-classroom-editor-teacher', role: 'teacher', name: '课堂编辑验收教师', displayName: '课堂编辑验收教师' } });
    if (method === 'GET' && path === '/api/courses') return json({ courses: [course()], user: { role: 'teacher', name: '课堂编辑验收教师' }, hydrated: true, updatedAt: fixedTime });
    if (method === 'GET' && path === `/api/courses/${courseId}/state`) return json({ course: course(), eventCursor: '0' });
    if (method === 'GET' && path === `/api/courses/${courseId}/events`) return json({ events: [], nextCursor: '0', hasMore: false, courseVersion: 1 });
    if (method === 'GET' && path === `/api/courses/${courseId}/projection`) return json({ courseVersion: 1, resourceProjection: null, teacherResourceProjection: null });
    if (method === 'GET' && path === '/api/openmaic/classroom') return json({ success: true, classroom: saved });
    if (method === 'GET' && path === `/api/courses/${courseId}/generation`) return json({ backgroundEnabled: false, job: null });
    if (method === 'GET' && path === `/api/courses/${courseId}/design-workspace`) return json({ publication: { latestVersion: 1, publishedVersion: null, draftVersion: 1 } });
    if (method === 'GET' && path === `/api/courses/${courseId}/resource-repair`) return json({ issues: [] });
    if (method === 'GET' && path === '/api/server-providers') return json({
      providers: { openai: { models: ['gpt-4.1'], defaultModel: 'gpt-4.1' } },
      tts: {}, asr: {}, pdf: {}, image: {}, video: {}, webSearch: {},
    });
    if (path === `/api/courses/${courseId}/classroom-resource`) {
      if (method === 'GET') return json({ success: true, classroom: saved });
      if (method === 'PATCH') {
        const patch = request.postDataJSON() as ClassroomPatch;
        fixture.patches.push(structuredClone(patch));
        if (patch.classroomId !== saved.id || patch.revision !== saved.revision) {
          return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ success: false, code: 'REVISION_CONFLICT', error: 'Fixture revision mismatch' }) });
        }
        saved = { ...saved, stage: structuredClone(patch.stage), scenes: structuredClone(patch.scenes), revision: saved.revision + 1 };
        return json({ success: true, classroom: saved, forkedDraft: false, narrationChanged: false });
      }
    }
    if (method === 'POST' && path === '/api/openmaic/agent/edit') {
      const body = request.postDataJSON() as AgentRequest;
      fixture.agentRequests.push(body);
      const boardId = body.message.match(/白板 ID：([^。]+)/)?.[1];
      const actions = body.sceneContextMap[body.scene.id]?.actions ?? [];
      const start = actions.findIndex((action) => action.type === 'wb_open' && action.id === boardId);
      const end = actions.findIndex((action, index) => index > start && action.type === 'wb_close');
      if (!boardId || start < 0 || end <= start) {
        return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'The requested whiteboard is absent from the posted scene context.' }) });
      }
      const before = structuredClone(actions.slice(start + 1, end));
      const textStepId = before.find((action) => action.type === 'wb_draw_text')?.id;
      const steps = before.map((action) => action.id === textStepId && action.type === 'wb_draw_text'
        ? { ...action, content: aiBoardText } : action);
      const toolCallId = 'e2e-mock-whiteboard-edit';
      const toolMessage = {
        role: 'assistant',
        content: [{ type: 'toolCall', id: toolCallId, name: 'edit_whiteboard', arguments: { sceneId: body.scene.id, boardId, steps } }],
      };
      const summary = { role: 'assistant', content: [{ type: 'text', text: '已更新当前白板，并保留其他讲授内容。' }] };
      // Model/tool transport is mocked; the real browser runtime applies the
      // scoped patch, creates its undo snapshot and renders the actual tool UI.
      const events = [
        { type: 'message_start', message: { role: 'assistant' } },
        { type: 'message_end', message: toolMessage },
        {
          type: 'tool_execution_end', toolCallId, toolName: 'edit_whiteboard', isError: false,
          result: {
            content: [{ type: 'text', text: `已生成当前白板的 ${steps.length} 个步骤。` }],
            details: { sceneId: body.scene.id, whiteboardPatch: { boardId, before, steps } },
          },
        },
        { type: 'message_start', message: { role: 'assistant' } },
        { type: 'message_end', message: summary },
        { type: 'agent_end', messages: [toolMessage, summary] },
      ];
      const sentEvents = agentOutcome === 'disconnect' ? [...events.slice(0, 3),
        { type: 'message_start', message: { role: 'assistant' } },
        { type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall',
          id: 'e2e-interrupted-redraw', name: 'regenerate_scene', arguments: { sceneId: body.scene.id, instruction: '补充图示' },
        }] } },
      ] : events;
      return route.fulfill({ status: 200, contentType: 'text/event-stream',
        body: ': heartbeat\n\n' + sentEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
      });
    }
    fixture.unexpected.push(entry);
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'No fixture for this API request' }) });
  });

  await page.goto(`/teacher/prepare/${courseId}/classroom-editor`);
  await expect(page.getByRole('button', { name: '保存课堂', exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.canvas').filter({ visible: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: '添加白板', exact: true })).toBeVisible();
  return fixture;
}

test.afterEach(async ({ page }, info) => {
  const fixture = fixtures.get(page);
  if (fixture) await info.attach('fixture-api-traffic', {
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ requests: fixture.requests, unexpected: fixture.unexpected, pageErrors: fixture.errors }, null, 2)),
  });
});

async function assertNoPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    height: window.innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1);
  expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.height + 1);
}

async function assertEditorChrome(page: Page) {
  await expect(page.locator('main header')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '返回预览发布', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: '保存课堂', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: '返回首页', exact: true })).toHaveCount(0);
  const logo = page.getByTestId('slide-nav-rail').getByRole('img', { name: 'CoTeach', exact: true });
  await expect(logo).toBeInViewport({ ratio: 1 });
  await expect.poll(() => logo.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByTestId('slide-nav-rail').getByTitle('观察能源使用', { exact: true }).first()).toBeAttached();
  const canvas = page.locator('.canvas').filter({ visible: true });
  await expect(canvas).toBeInViewport({ ratio: 1 });
  const bounds = await canvas.boundingBox();
  expect(bounds?.width).toBeGreaterThan(150);
  expect(bounds?.height).toBeGreaterThan(120);
  for (const name of ['文本框', '图片', '背景', '收起插入工具']) {
    const insertControl = page.getByRole('button', { name, exact: true });
    await expect(insertControl).toBeInViewport({ ratio: 1 });
    const buttonBounds = await insertControl.boundingBox();
    expect(buttonBounds?.width).toBeGreaterThanOrEqual(44);
    expect(buttonBounds?.height).toBeGreaterThanOrEqual(44);
  }
  await assertNoPageOverflow(page);
}

async function addBoard(page: Page) {
  const add = page.getByRole('button', { name: '添加白板', exact: true });
  await add.scrollIntoViewIfNeeded();
  await add.click();
  const dialog = page.getByRole('dialog', { name: '编辑白板', exact: true });
  await expect(dialog).toBeVisible({ timeout: 2_000 });
  await expect(dialog.getByRole('textbox', { name: '板书内容', exact: true })).toHaveValue('板书要点');
  return dialog;
}

async function assertDialogControls(page: Page, dialog: Locator) {
  await expect(dialog).toBeInViewport({ ratio: 1 });
  for (const name of ['关闭白板编辑', '撤销白板编辑', '重做白板编辑', '完成编辑']) {
    const control = dialog.getByRole('button', { name, exact: true });
    await expect(control).toBeInViewport({ ratio: 1 });
    const bounds = await control.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
    expect(bounds?.width).toBeGreaterThanOrEqual(44);
  }
  for (const name of ['从头播放', '上一步', '下一步']) {
    const control = dialog.getByRole('button', { name, exact: true });
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeInViewport({ ratio: 1 });
  }
  const addStep = dialog.getByRole('combobox', { name: '添加教学步骤', exact: true });
  await addStep.scrollIntoViewIfNeeded();
  await expect(addStep).toBeInViewport({ ratio: 1 });
  await assertNoPageOverflow(page);
}

async function saveClassroom(page: Page, fixture: Fixture, expectedCount: number) {
  const save = page.getByRole('button', { name: '保存课堂', exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => fixture.patches.length).toBe(expectedCount);
  await expect(save).toBeDisabled();
  await expect(page.getByText(/^所有修改已保存/)).toBeVisible();
  return fixture.patches[expectedCount - 1];
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
}

function untouchedTextResource(): ClassroomResource {
  const initial = resource();
  const first = initial.scenes[0];
  if (first.content.type !== 'slide') throw new Error('Expected slide');
  const base = { type: 'text' as const, left: 80, top: 80, width: 320, height: 92, rotate: 0,
    defaultFontName: 'Noto Sans SC', defaultColor: '#243447' };
  first.content.canvas.elements = [
    { ...base, id: 'untouched-note', content: '<p class="source">浏览时保留原文及尺寸</p>' },
    { ...base, id: 'untouched-vertical', left: 500, width: 96, height: 280, vertical: true, content: '<p>竖排文字</p>' },
    { ...base, id: 'untouched-empty', top: 320, content: '<p></p>' },
    { ...base, id: 'untouched-locked', top: 430, lock: true, content: '<p>锁定文字</p>' },
  ];
  first.actions = [...first.actions!,
    { id: 'reflection', type: 'speech', text: '', timelinePauseSec: 30, timelinePausePurpose: 'learner-reflection' },
    { id: 'transition', type: 'speech', text: '', timelinePauseSec: 2, timelinePausePurpose: 'page-transition' },
  ] as Action[];
  const second = structuredClone(first);
  second.id = 'untouched-second'; second.title = '第二页合法活动等待'; second.order = 1;
  if (second.content.type !== 'slide') throw new Error('Expected slide');
  second.content.canvas.id = 'untouched-second-canvas';
  second.actions = [{ id: 'activity', type: 'speech', text: '', activityPauseSec: 60, activityPausePurpose: 'interaction' }] as Action[];
  initial.scenes.push(second);
  return initial;
}

test('opening and browsing text pages preserves data, saved status and valid wait diagnostics', async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const initial = untouchedTextResource();
  const expected = structuredClone(initial.scenes);
  const fixture = await mockEditor(page, baseURL, initial);
  const save = page.getByRole('button', { name: '保存课堂', exact: true });
  const rail = page.getByTestId('slide-nav-rail');
  const note = page.locator('#editable-element-untouched-note .ProseMirror');
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.evaluate(() => document.fonts.ready);
  await note.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1024, height: 768 });
  await rail.getByTitle('第二页合法活动等待', { exact: true }).first().click();
  await expect(page.getByText('等待学生活动', { exact: true })).toBeVisible();
  await rail.getByTitle('观察能源使用', { exact: true }).first().click();
  await expect(page.getByText('时间线停顿', { exact: true }).first()).toBeVisible();
  await expect(page.locator('#editable-element-untouched-empty')).toBeAttached();
  // Allow the old observer and delayed empty-text cleanup paths to settle.
  await page.waitForTimeout(600);
  await expect(save).toBeDisabled();
  await expect(page.getByText('所有修改已保存', { exact: true })).toBeVisible();
  await expect(rail.locator('[aria-label^="本页讲解需补充"]')).toHaveCount(0);
  expect(fixture.patches).toHaveLength(0);
  expect(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })))).toBe(false);

  // Saving one explicit title edit also inspects all canonical data: browsing
  // must not have changed text HTML, geometry, empty elements or wait actions.
  await rail.getByTestId('slide-nav-more').first().click();
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  const rename = rail.getByRole('textbox', { name: '重命名', exact: true });
  await rename.fill('教师修改的标题');
  await rename.press('Enter');
  expected[0].title = '教师修改的标题';
  const patch = await saveClassroom(page, fixture, 1);
  expect(patch.scenes).toEqual(expected);
  await page.reload();
  await expect(note).toBeVisible();
  await expect(save).toBeDisabled();
  await page.route(`**/teacher/prepare/${courseId}/preview`, (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8', body: '<main>测试预览</main>',
  }));
  await page.getByRole('button', { name: '返回预览发布', exact: true }).click();
  await expect(page.getByText('测试预览', { exact: true })).toBeVisible();
  expect(dialogs).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('real text edits restore the exact saved baseline on undo and survive save and reload', async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  const fixture = await mockEditor(page, baseURL, untouchedTextResource());
  const save = page.getByRole('button', { name: '保存课堂', exact: true });
  const note = page.locator('#editable-element-untouched-note .ProseMirror');
  await expect(save).toBeDisabled();
  await note.fill('教师编辑后的正文\n需要额外一行的完整说明');
  await note.press('ControlOrMeta+z');
  await expect(note).toHaveText('浏览时保留原文及尺寸');
  await expect(save).toBeDisabled();
  await note.press('ControlOrMeta+Shift+z');
  await expect(note).toContainText('需要额外一行的完整说明');
  await note.blur();
  await expect(save).toBeEnabled();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(note).toHaveText('浏览时保留原文及尺寸');
  await page.waitForTimeout(400);
  await expect(save).toBeDisabled();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(note).toContainText('需要额外一行的完整说明');
  await saveClassroom(page, fixture, 1);
  await page.reload();
  await expect(note).toContainText('教师编辑后的正文');
  await expect(save).toBeDisabled();
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('horizontal and vertical text resizing forms one undo step and a click without movement stays saved', async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await mockEditor(page, baseURL, untouchedTextResource());
  const save = page.getByRole('button', { name: '保存课堂', exact: true });
  for (const id of ['untouched-note', 'untouched-vertical']) {
    await page.locator(`#editable-element-${id} .element-content`).click({ position: { x: 10, y: 10 } });
    const handle = page.locator('.text-element-operate .resize-handler').last();
    await expect(handle).toBeVisible();
    await handle.click();
    await expect(save).toBeDisabled();
    const bounds = await handle.boundingBox();
    if (!bounds) throw new Error('Missing text resize handle');
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - (id === 'untouched-note' ? 100 : 0), y - (id === 'untouched-vertical' ? 60 : 0), { steps: 5 });
    await page.mouse.up();
    await expect(save).toBeEnabled();
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(save).toBeDisabled();
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect(save).toBeEnabled();
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(save).toBeDisabled();
  }
  expect(fixture.patches).toHaveLength(0);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

function clipboardResource(): ClassroomResource {
  const initial = resource();
  const first = initial.scenes[0];
  if (first.content.type !== 'slide') throw new Error('Expected a slide');
  first.content.canvas.elements = [
    { id: 'clipboard-image', type: 'image', left: 80, top: 80, width: 160, height: 120, rotate: 0, src: imageDataUrl, fixedRatio: true },
    { id: 'clipboard-text', type: 'text', left: 440, top: 100, width: 320, height: 80, rotate: 0,
      content: '<p>保留文字复制粘贴</p>', defaultFontName: 'Noto Sans SC', defaultColor: '#243447' },
  ];
  const second = structuredClone(first);
  second.id = 'clipboard-target';
  second.title = '粘贴目标页';
  second.order = 1;
  if (second.content.type !== 'slide') throw new Error('Expected a slide');
  second.content.canvas.id = 'clipboard-target-canvas';
  second.content.canvas.elements = [];
  initial.scenes.push(second);
  return initial;
}

test('slide element keyboard copy, paste and cut preserve text editing and support undo', async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await mockEditor(page, baseURL, clipboardResource());
  const canvas = page.locator('.canvas');
  const elements = canvas.locator('[data-slide-element-id]');
  await expect(elements).toHaveCount(2);
  await canvas.locator('#editable-element-clipboard-image .element-content').click();
  await page.keyboard.press('ControlOrMeta+c');
  await page.keyboard.press('ControlOrMeta+v');
  await expect(elements).toHaveCount(3);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(elements).toHaveCount(2);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(elements).toHaveCount(3);
  const copy = elements.filter({ has: page.locator('.editable-element-image') }).last();
  await copy.locator('.element-content').click();
  await page.keyboard.press('ControlOrMeta+x');
  await expect(elements).toHaveCount(2);
  await page.keyboard.press('ControlOrMeta+v');
  await expect(elements).toHaveCount(3);

  const text = canvas.locator('#editable-element-clipboard-text [contenteditable="true"]');
  await text.click();
  await page.keyboard.press('ControlOrMeta+a');
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('保留文字复制粘贴');
  await page.keyboard.press('ControlOrMeta+c');
  await page.keyboard.press('End');
  await expect.poll(() => page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true);
  await page.keyboard.press('ControlOrMeta+v');
  await expect(text).toHaveText('保留文字复制粘贴保留文字复制粘贴');
  await expect(elements).toHaveCount(3);
  await expect(page.getByRole('button', { name: '保存课堂', exact: true })).toBeEnabled();
  // Rich-text updates debounce for 300 ms; wait for the actual content to save.
  await page.waitForTimeout(400);
  const saved = (await saveClassroom(page, fixture, 1)).scenes[0];
  if (saved.content.type !== 'slide') throw new Error('Expected slide content');
  expect(saved.content.canvas.elements).toHaveLength(3);
  const savedText = saved.content.canvas.elements.find((element) => element.id === 'clipboard-text');
  if (savedText?.type !== 'text') throw new Error('Expected text element');
  expect(savedText.content.replace(/<[^>]+>/g, '')).toBe('保留文字复制粘贴保留文字复制粘贴');
  expect(new Set(saved.content.canvas.elements.map((element) => element.id)).size).toBe(3);
  expect(saved.actions).toEqual(resource().scenes[0].actions);
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

for (const nativeClipboard of [true, false]) {
  test(`slide element context menus copy and paste across pages ${nativeClipboard ? 'with the native clipboard' : 'without clipboard permission'}`, async ({ page, baseURL }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    // Classroom hosts can use plain HTTP; menu operations must work without this API.
    if (!nativeClipboard) {
      await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
    }
    const fixture = await mockEditor(page, baseURL, clipboardResource());
    const canvas = page.locator('.canvas');
    await canvas.locator('#editable-element-clipboard-image .element-content').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^复制/ }).click();
    await page.getByRole('button', { name: /粘贴目标页/ }).click();
    await expect(canvas.locator('[data-slide-element-id]')).toHaveCount(0);
    await canvas.click({ button: 'right', position: { x: 20, y: 20 } });
    await page.getByRole('menuitem', { name: /^粘贴/ }).click();
    await expect(canvas.locator('[data-slide-element-id]')).toHaveCount(1);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(canvas.locator('[data-slide-element-id]')).toHaveCount(0);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect(canvas.locator('[data-slide-element-id]')).toHaveCount(1);
    const patch = await saveClassroom(page, fixture, 1);
    const target = patch.scenes[1];
    expect(target.content.type).toBe('slide');
    if (target.content.type !== 'slide') throw new Error('Expected slide content');
    expect(target.content.canvas.elements[0]).toMatchObject({ type: 'image', src: imageDataUrl, left: 80, top: 80, width: 160, height: 120 });
    expect(target.content.canvas.elements[0].id).not.toBe('clipboard-image');
    await page.reload();
    await page.getByRole('button', { name: /粘贴目标页/ }).click();
    await expect(page.locator('.canvas [data-slide-element-id]')).toHaveCount(1);
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}

function shapeTextResource(): ClassroomResource {
  const initial = resource();
  const first = initial.scenes[0];
  first.title = '支架式教学法的五步实施流程';
  if (first.content.type !== 'slide') throw new Error('Expected slide content');
  // Minimal native structure of the reported page: five labeled shapes,
  // four independent arrows, and the corresponding explanations on the right.
  const labels = ['搭脚手架：明确任务', '进入情境：分析问题', '独立探索：解决问题', '协作学习：集思广益', '效果评价：完成建构'];
  const elements = first.content.canvas.elements;
  for (let index = 0; index < labels.length; index += 1) {
    elements.push({
      id: `flow-step-${index + 1}`, type: 'shape', left: 100, top: 130 + index * 65,
      width: 230, height: 48, rotate: 0, fixedRatio: false,
      viewBox: [100, 100], path: 'M0 0 L100 0 L100 100 L0 100 Z', fill: '#EFF6FF',
      text: { content: `<p style="font-size:18px;text-align:center">${labels[index]}</p>`,
        defaultFontName: 'Noto Sans SC', defaultColor: '#1E3A8A', align: 'middle' },
    });
    elements.push({
      id: `explanation-${index + 1}`, type: 'text', left: 380, top: 130 + index * 65,
      width: 500, height: 50, rotate: 0, content: `<p>第${index + 1}步的具体教学说明</p>`,
      defaultFontName: 'Noto Sans SC', defaultColor: '#243447',
    });
    if (index < labels.length - 1) elements.push({
      id: `flow-arrow-${index + 1}`, type: 'line', left: 215, top: 178 + index * 65,
      start: [0, 0], end: [0, 17], points: ['', 'arrow'], width: 2, color: '#1E3A8A', style: 'solid',
    });
  }
  const empty = structuredClone(elements[0]);
  if (empty.type !== 'shape') throw new Error('Expected shape');
  empty.id = 'empty-shape'; empty.top = 480; delete empty.text;
  elements.push(empty, { ...empty, id: 'locked-shape', left: 500, lock: true,
    text: { content: '<p>锁定文字</p>', defaultFontName: 'Noto Sans SC', defaultColor: '#243447', align: 'middle' } });
  const next = structuredClone(first);
  next.id = 'flow-next-page'; next.title = '流程图后续页'; next.order = 1;
  if (next.content.type !== 'slide') throw new Error('Expected slide');
  next.content.canvas.id = 'flow-next-canvas';
  next.content.canvas.elements = [{ ...empty, id: 'flow-step-1', top: 130,
    text: { content: '<p>后续页原文</p>', defaultFontName: 'Noto Sans SC', defaultColor: '#243447', align: 'middle' } }];
  initial.scenes.push(next);
  return initial;
}

test('shape text supports direct editing, formatting, history and save without media generation', async ({ page, baseURL }, info) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const initial = shapeTextResource();
  const fixture = await mockEditor(page, baseURL, initial);
  const canvas = page.locator('.canvas');
  const node = (id: string) => canvas.locator(`#editable-element-${id}`);
  for (let step = 1; step <= 5; step += 1) {
    const shape = node(`flow-step-${step}`);
    await shape.locator('.shape-text').dblclick();
    const editor = shape.locator('[contenteditable="true"]');
    await expect(editor).toBeFocused();
    await editor.fill(`修改后的第${step}步`);
    if (step === 1) {
      await page.keyboard.press('ControlOrMeta+a');
      await page.getByRole('button', { name: '加粗', exact: true }).click();
      await page.getByRole('button', { name: '左对齐', exact: true }).click();
      const alignment = await editor.locator('p').evaluate((element) => ({
        textAlign: getComputedStyle(element).textAlign, direction: getComputedStyle(element).direction,
      }));
      expect(['left', 'start']).toContain(alignment.textAlign);
      expect(alignment.direction).toBe('ltr');
      await page.getByRole('textbox', { name: '字号', exact: true }).fill('20');
      await page.getByRole('textbox', { name: '字号', exact: true }).press('Enter');
      await page.getByRole('combobox', { name: '字体', exact: true }).click();
      await page.getByRole('option', { name: '思源宋体', exact: true }).click();
      await expect(editor).toBeFocused();
      await page.getByRole('button', { name: '文字颜色', exact: true }).click();
      await page.getByRole('button', { name: '#3b82f6', exact: true }).click();
      await expect(editor).toBeFocused();
      await page.getByRole('button', { name: '居中对齐', exact: true }).click();
      await expect(editor.locator('p')).toHaveCSS('text-align', 'center');
    }
  }
  // A plain text region continues to edit normally, and switching focus
  // commits the last node even inside its 300 ms debounce window.
  const note = node('explanation-1').locator('[contenteditable="true"]');
  await note.click();
  await note.fill('修改后的教学说明\n新增一段需要独立换行显示的具体说明。');
  await page.getByRole('button', { name: '保存课堂', exact: true }).click();
  await expect.poll(() => fixture.patches.length).toBe(1);
  const saved = fixture.resource().scenes[0];
  if (saved.content.type !== 'slide' || initial.scenes[0].content.type !== 'slide') throw new Error('Expected slide');
  for (let step = 1; step <= 5; step += 1) {
    const element = saved.content.canvas.elements.find((item) => item.id === `flow-step-${step}`);
    expect(element?.type === 'shape' && element.text?.content).toContain(`修改后的第${step}步`);
  }
  const first = saved.content.canvas.elements.find((item) => item.id === 'flow-step-1');
  if (first?.type !== 'shape') throw new Error('Expected shape');
  expect(first.text?.content).toMatch(/<strong>/);
  expect(first.text?.content).toContain('Noto Serif SC');
  expect(first.text?.content).toMatch(/font-size:\s*20px/);
  expect(first.text?.content).toMatch(/text-align:\s*center/);
  expect(first.text?.content).toMatch(/rgb\(59, 130, 246\)|#3b82f6/i);
  expect(saved.content.canvas.elements.filter((item) => item.type === 'line'))
    .toEqual(initial.scenes[0].content.canvas.elements.filter((item) => item.type === 'line'));
  expect(saved.actions).toEqual(initial.scenes[0].actions);

  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(note).toHaveText('第1步的具体教学说明');
  // Let ResizeObserver restore the shorter text's height before redo.
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(note).toContainText('新增一段需要独立换行显示的具体说明。');
  // Redo returns to the content already saved in the first PATCH.
  await expect(page.getByRole('button', { name: '保存课堂', exact: true })).toBeDisabled();
  expect(fixture.patches).toHaveLength(1);
  await page.reload();
  await expect(node('flow-step-1')).toContainText('修改后的第1步');
  await expect(node('explanation-1')).toContainText('修改后的教学说明');
  await screenshot(page, info, 'native-flowchart-text-saved');
  expect(fixture.requests.some((request) => /generate|media-generation/.test(request))).toBe(false);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('shape text action edits empty shapes and quick page changes preserve repeated element IDs', async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1024, height: 768 });
  const fixture = await mockEditor(page, baseURL, shapeTextResource());
  const canvas = page.locator('.canvas');
  const empty = canvas.locator('#editable-element-empty-shape');
  await empty.locator('.shape-path').click();
  const editButton = page.getByRole('button', { name: '编辑文字', exact: true });
  await expect(editButton).toBeVisible();
  expect((await editButton.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await editButton.click();
  await expect(empty.locator('[contenteditable="true"]')).toBeFocused();
  await empty.locator('[contenteditable="true"]').fill('空方块中的新增文字');
  await page.keyboard.press('Escape');
  await expect(empty.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(empty).toContainText('空方块中的新增文字');
  await empty.locator('.shape-text').click();
  await expect(editButton).toBeVisible();
  const bounds = await empty.locator('.editable-element-shape').boundingBox();
  if (!bounds) throw new Error('Missing shape bounds');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 25, bounds.y + bounds.height / 2 + 15, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await empty.locator('.editable-element-shape').boundingBox())!.x)
    .toBeGreaterThan(bounds.x + 10);

  const step = canvas.locator('#editable-element-flow-step-1');
  await step.locator('.shape-text').dblclick();
  await step.locator('[contenteditable="true"]').fill('第一页保留文字');
  await page.getByTestId('slide-nav-rail').getByTitle('流程图后续页', { exact: true }).first().click();
  await expect(canvas.locator('#editable-element-flow-step-1')).toContainText('后续页原文');
  await page.getByTestId('slide-nav-rail').getByTitle('支架式教学法的五步实施流程', { exact: true }).first().click();
  await expect(step).toContainText('第一页保留文字');
  const patch = await saveClassroom(page, fixture, 1);
  const next = patch.scenes[1];
  if (next.content.type !== 'slide') throw new Error('Expected slide');
  expect(next.content.canvas.elements[0]).toMatchObject({ id: 'flow-step-1', text: { content: '<p>后续页原文</p>' } });
  await canvas.locator('#editable-element-locked-shape .shape-text').dblclick();
  await expect(canvas.locator('#editable-element-locked-shape [contenteditable="true"]')).toHaveCount(0);
  await assertNoPageOverflow(page);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('whiteboard text, narration, table, image and step history survive saving and reload', async ({ page, baseURL }, info) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await mockEditor(page, baseURL);
  await assertEditorChrome(page);
  let dialog = await addBoard(page);
  await dialog.getByRole('textbox', { name: '板书内容', exact: true }).fill(boardText);
  await expect(dialog.getByRole('img', { name: '白板步骤预览' })).toContainText(boardText);

  const addStep = dialog.getByRole('combobox', { name: '添加教学步骤', exact: true });
  await addStep.selectOption('speech');
  await dialog.getByRole('textbox', { name: 'AI 讲解内容', exact: true }).fill(narration);
  await addStep.selectOption('wb_draw_table');
  await dialog.getByLabel('第 1 行第 1 列', { exact: true }).fill('对比项');
  await dialog.getByLabel('第 1 行第 2 列', { exact: true }).fill('节能方案');
  await dialog.getByLabel('第 2 行第 1 列', { exact: true }).fill('照明');
  await dialog.getByLabel('第 2 行第 2 列', { exact: true }).fill('按需开启');
  await expect(dialog.getByRole('img', { name: '白板步骤预览' })).toContainText('按需开启');

  await dialog.getByRole('button', { name: '新建白板页', exact: true }).click();
  await addStep.selectOption('wb_draw_image');
  await dialog.getByLabel('上传白板图片', { exact: true }).setInputFiles({ name: 'energy-observation.png', mimeType: 'image/png', buffer: Buffer.from(imageBase64, 'base64') });
  await expect(dialog.getByRole('status')).toContainText('energy-observation.png');
  await expect(dialog.getByRole('img', { name: '白板步骤预览' }).locator('[data-whiteboard-element-type="image"] img')).toHaveAttribute('src', imageDataUrl);

  const imageStep = dialog.getByRole('button', { name: /^步骤 \d+：图片$/ });
  const originalIndex = Number((await imageStep.getAttribute('aria-label'))?.match(/\d+/)?.[0]);
  expect(originalIndex).toBeGreaterThan(1);
  await dialog.getByRole('button', { name: '步骤上移', exact: true }).click();
  await expect(imageStep).toHaveAttribute('aria-label', `步骤 ${originalIndex - 1}：图片`);
  await dialog.getByRole('button', { name: '步骤下移', exact: true }).click();
  await expect(imageStep).toHaveAttribute('aria-label', `步骤 ${originalIndex}：图片`);
  await dialog.getByRole('button', { name: '撤销白板编辑', exact: true }).click();
  await expect(imageStep).toHaveAttribute('aria-label', `步骤 ${originalIndex - 1}：图片`);
  await dialog.getByRole('button', { name: '重做白板编辑', exact: true }).click();
  await expect(imageStep).toHaveAttribute('aria-label', `步骤 ${originalIndex}：图片`);
  await screenshot(page, info, 'whiteboard-content-and-steps');
  await dialog.getByRole('button', { name: '完成编辑', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  const patch = await saveClassroom(page, fixture, 1);
  expect(patch.classroomId).toBe(classroomId);
  expect(patch.revision).toBe(3);
  expect(patch.stage.id).toBe(classroomId);
  const actions = patch.scenes.find((scene) => scene.id === sceneId)!.actions ?? [];
  expect(actions[0]).toEqual({ id: 'e2e-introduction', type: 'speech', text: '今天我们一起观察校园中的能源使用。' });
  expect(actions.filter((action) => action.type === 'wb_open')).toHaveLength(1);
  expect(actions.at(-1)?.type).toBe('wb_close');
  expect(actions).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'wb_draw_text', content: boardText }),
    expect.objectContaining({ type: 'speech', text: narration }),
    expect.objectContaining({ type: 'wb_draw_table', data: [['对比项', '节能方案'], ['照明', '按需开启']] }),
    expect.objectContaining({ type: 'wb_draw_image', src: imageDataUrl, title: 'energy-observation.png' }),
  ]));

  await page.reload();
  await expect(page.getByRole('button', { name: '保存课堂', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '编辑白板内容与讲解', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '编辑白板', exact: true });
  await expect(dialog.getByRole('textbox', { name: '板书内容', exact: true })).toHaveValue(boardText);
  await dialog.getByRole('button', { name: /^步骤 \d+：AI 讲解$/ }).click();
  await expect(dialog.getByRole('textbox', { name: 'AI 讲解内容', exact: true })).toHaveValue(narration);
  await dialog.getByRole('button', { name: /^步骤 \d+：表格$/ }).click();
  await expect(dialog.getByLabel('第 2 行第 2 列', { exact: true })).toHaveValue('按需开启');
  await dialog.getByRole('button', { name: /^步骤 \d+：图片$/ }).click();
  await expect(dialog.getByRole('img', { name: '白板步骤预览' }).locator('[data-whiteboard-element-type="image"] img')).toHaveAttribute('src', imageDataUrl);
  await dialog.getByRole('button', { name: /^步骤 \d+：板书文字$/ }).click();
  await dialog.getByRole('textbox', { name: '板书内容', exact: true }).fill(`${boardText}请补充你的证据。`);
  await dialog.getByRole('button', { name: '完成编辑', exact: true }).click();
  const secondPatch = await saveClassroom(page, fixture, 2);
  expect(secondPatch.revision).toBe(4);
  expect(fixture.resource().scenes[0].actions).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'wb_draw_text', content: `${boardText}请补充你的证据。` })]));
  await assertEditorChrome(page);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('video playback shows a retry when the browser denies automatic play', async ({ page, baseURL }, info) => {
  test.setTimeout(90_000);
  const mediaWarnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') mediaWarnings.push(message.text());
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addInitScript(() => {
    if (location.origin === 'null') return;
    localStorage.setItem('locale', 'zh-CN');
    const originalPlay = HTMLMediaElement.prototype.play;
    let denied = false;
    HTMLMediaElement.prototype.play = function () {
      if (this instanceof HTMLVideoElement && this.getAttribute('src')?.includes('prelaunch-video.webm') && !denied) {
        denied = true;
        return Promise.reject(new DOMException('Autoplay denied', 'NotAllowedError'));
      }
      return originalPlay.call(this);
    };
  });
  await page.route('**/prelaunch-video.webm', route => route.fulfill({
    status: 200, contentType: 'video/webm', body: readFileSync('e2e/fixtures/prelaunch-video.webm'),
  }));
  const classroom = resource();
  const scene = classroom.scenes[0];
  if (scene.content.type !== 'slide') throw new Error('Video acceptance fixture requires a slide');
  scene.content.canvas.elements.push({
    id: 'e2e-video', type: 'video', src: '/prelaunch-video.webm', autoplay: false,
    left: 180, top: 130, width: 640, height: 360, rotate: 0,
  } as PPTVideoElement);
  scene.actions = [{ id: 'e2e-play-video', type: 'play_video', elementId: 'e2e-video' }];
  const fixture = await mockEditor(page, baseURL, classroom);
  await page.goto(`/teacher/prepare/${courseId}/preview?view=student`);
  await expect(page.getByRole('tabpanel', { name: '学生课堂预览' })).toBeVisible();
  const video = page.locator('#screen-element-e2e-video video');
  await expect(video).toBeVisible();
  await page.getByRole('button', { name: '继续讲解' }).click();
  const alert = page.locator('#screen-element-e2e-video [role="alert"]');
  await expect(alert).toContainText('浏览器阻止了自动播放');
  await expect(alert.getByRole('button', { name: '重试' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('video-autoplay-denied.png') });
  await page.setViewportSize({ width: 768, height: 576 });
  await expect(page.getByRole('button', { name: '收起页面目录' })).toBeHidden();
  await page.getByRole('button', { name: '打开页面目录' }).click();
  await expect(page.getByRole('button', { name: '收起页面目录' })).toBeVisible();
  await expect.poll(() => page.locator('[data-testid="scene-list"]').evaluate((list) =>
    list.parentElement?.parentElement?.getBoundingClientRect().width ?? 0)).toBeGreaterThan(210);
  await page.evaluate(() => {
    const events: string[] = [];
    const close = document.querySelector('button[aria-label="收起页面目录"]');
    close?.addEventListener('pointerdown', () => events.push('pointerdown'));
    close?.addEventListener('click', () => events.push('click'));
    (window as Window & { __prelaunchCloseEvents?: string[] }).__prelaunchCloseEvents = events;
  });
  await page.getByRole('button', { name: '收起页面目录' }).click();
  try {
    await expect(page.getByRole('button', { name: '打开页面目录' })).toBeVisible();
  } catch (error) {
    const closeEvents = await page.evaluate(() => (window as Window & { __prelaunchCloseEvents?: string[] }).__prelaunchCloseEvents);
    throw new Error(`${String(error)}\n${JSON.stringify({ closeEvents })}`);
  }
  await expect(alert.getByRole('button', { name: '重试' })).toBeVisible();
  await alert.scrollIntoViewIfNeeded();
  await expect(alert.getByRole('button', { name: '重试' })).toBeInViewport();
  await page.screenshot({ path: info.outputPath('video-autoplay-denied-split.png') });
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  await alert.getByRole('button', { name: '重试' }).click();
  try {
    await expect(alert).toHaveCount(0, { timeout: 15_000 });
  } catch (error) {
    const mediaState = await video.evaluate((element) => {
      const media = element as HTMLVideoElement;
      return { paused: media.paused, currentTime: media.currentTime, readyState: media.readyState, networkState: media.networkState,
        error: media.error ? { code: media.error.code, message: media.error.message } : null };
    });
    throw new Error(`${String(error)}\n${JSON.stringify({ mediaState, mediaWarnings })}`);
  }
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0.05);
  await page.screenshot({ path: info.outputPath('video-autoplay-recovered.png') });
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test('chart values and all chart forms render and survive saving', async ({ page, baseURL }, info) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await mockEditor(page, baseURL);
  const dialog = await addBoard(page);
  await dialog.getByRole('combobox', { name: '以新页插入示例模板', exact: true }).selectOption('comparison');
  await dialog.getByRole('button', { name: /^步骤 \d+：图表$/ }).click();
  await dialog.getByRole('textbox', { name: '数据项 1 名称', exact: true }).fill('照明');
  await dialog.getByRole('spinbutton', { name: '数据项 1，系列 1 数值', exact: true }).fill('36');
  const type = dialog.getByRole('combobox', { name: '图表类型', exact: true });
  const chart = dialog.locator('[data-whiteboard-element-type="chart"]');
  for (const chartType of ['column', 'bar', 'line', 'area', 'radar', 'scatter']) {
    await type.selectOption(chartType);
    await expect.poll(() => chart.locator('svg path').count()).toBeGreaterThan(0);
  }
  await expect(dialog.getByRole('spinbutton', { name: '数据项 1，X 数值', exact: true })).toHaveValue('36');
  await type.selectOption('column');
  await dialog.getByRole('button', { name: '删除末系列', exact: true }).click();
  for (const chartType of ['pie', 'ring']) {
    await type.selectOption(chartType);
    await expect.poll(() => chart.locator('svg path').count()).toBeGreaterThan(0);
  }
  // ECharts animates a newly selected ring from zero sweep; inspect the final drawing.
  await page.waitForTimeout(1100);
  await screenshot(page, info, 'editable-data-chart');
  await dialog.getByRole('button', { name: '完成编辑', exact: true }).click();
  const patch = await saveClassroom(page, fixture, 1);
  expect(patch.scenes[0].actions).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'wb_draw_chart', chartType: 'ring', data: { labels: ['照明', '项目 B', '项目 C'], legends: ['方案一'], series: [[36, 18, 24]] } }),
    expect.objectContaining({ type: 'wb_draw_table' }),
  ]));
  await page.reload();
  await page.getByRole('button', { name: '编辑白板内容与讲解', exact: true }).click();
  await page.getByRole('button', { name: /^步骤 \d+：图表$/ }).click();
  await expect(page.getByRole('combobox', { name: '图表类型', exact: true })).toHaveValue('ring');
  await expect(page.getByRole('spinbutton', { name: '数据项 1，系列 1 数值', exact: true })).toHaveValue('36');
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('diagram labels and attached arrows follow edits, and derivations render styled formulas', async ({ page, baseURL }, info) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await mockEditor(page, baseURL);
  const dialog = await addBoard(page);
  const templates = dialog.getByRole('combobox', { name: '以新页插入示例模板', exact: true });
  await templates.selectOption('steps');
  await dialog.getByRole('button', { name: /^步骤 \d+：AI 讲解$/ }).last().click();
  const firstLine = dialog.locator('[data-whiteboard-element-type="line"]').first();
  await expect(firstLine.locator('path[marker-end]')).toHaveAttribute('marker-end', /url\(#.+arrow-end\)/);
  await expect(firstLine.locator('.base-element-line')).toHaveCSS('left', '305px');
  await dialog.getByRole('button', { name: /^步骤 \d+：图形$/ }).first().click();
  await dialog.getByRole('spinbutton', { name: '左距 %', exact: true }).fill('4.5');
  await dialog.getByRole('button', { name: /^步骤 \d+：AI 讲解$/ }).last().click();
  await expect(firstLine.locator('.base-element-line')).toHaveCSS('left', '285px');
  const label = dialog.locator('[data-whiteboard-element-type="text"]').filter({ hasText: '1. 观察' });
  await expect(label.locator('.base-element-text')).toHaveCSS('left', '63px');
  await screenshot(page, info, 'anchored-step-demonstration');
  await templates.selectOption('derivation');
  await dialog.getByRole('button', { name: /^步骤 \d+：AI 讲解$/ }).last().click();
  const formulae = dialog.locator('[data-whiteboard-element-type="latex"]');
  await expect(formulae).toHaveCount(3);
  await expect(formulae.last().locator('.katex')).toBeVisible();
  await expect.poll(() => formulae.last().locator('.frac-line').evaluate((element) => parseFloat(getComputedStyle(element).borderBottomWidth))).toBeGreaterThan(0);
  await screenshot(page, info, 'step-by-step-formula-derivation');
  await dialog.getByRole('button', { name: '完成编辑', exact: true }).click();
  const patch = await saveClassroom(page, fixture, 1);
  expect(patch.scenes[0].actions?.filter((action) => action.type === 'wb_draw_line')).toEqual(expect.arrayContaining([
    expect.objectContaining({ startAnchor: { elementId: expect.any(String), side: 'right' }, endAnchor: { elementId: expect.any(String), side: 'left' } }),
  ]));
  expect(patch.scenes[0].actions?.filter((action) => action.type === 'wb_draw_latex')).toHaveLength(3);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

for (const viewport of [{ width: 1024, height: 576 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`classroom editor and whiteboard controls fit ${viewport.width}x${viewport.height}`, async ({ page, baseURL }, info) => {
    test.setTimeout(60_000);
    await page.setViewportSize(viewport);
    const fixture = await mockEditor(page, baseURL);
    await assertEditorChrome(page);
    await screenshot(page, info, 'compact-editor');
    const dialog = await addBoard(page);
    await assertDialogControls(page, dialog);
    await dialog.getByRole('combobox', { name: '添加教学步骤', exact: true }).selectOption('speech');
    const speech = dialog.getByRole('textbox', { name: 'AI 讲解内容', exact: true });
    await speech.scrollIntoViewIfNeeded();
    await speech.fill(narration);
    await expect(speech).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByRole('button', { name: '完成编辑', exact: true })).toBeInViewport({ ratio: 1 });
    await assertNoPageOverflow(page);
    await screenshot(page, info, 'whiteboard-editor');
    await dialog.getByRole('button', { name: '完成编辑', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await assertEditorChrome(page);
    expect(fixture.patches).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

test('mock model whiteboard edit updates the board, preserves other steps and supports restore/resume', async ({ page, baseURL }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1024, height: 576 });
  const fixture = await mockEditor(page, baseURL);
  await expect(page.getByTestId('right-rail')).toHaveAttribute('data-collapsed', 'true');
  const dialog = await addBoard(page);
  await dialog.getByRole('textbox', { name: '板书内容', exact: true }).fill(boardText);
  await dialog.getByRole('combobox', { name: '添加教学步骤', exact: true }).selectOption('speech');
  await dialog.getByRole('textbox', { name: 'AI 讲解内容', exact: true }).fill(narration);
  const instruction = '分三步讲解，用表格对比两种节能方案。';
  await dialog.getByRole('textbox', { name: '白板 AI 修改要求', exact: true }).fill(instruction);
  await dialog.getByRole('button', { name: '交给 AI 修改', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => fixture.agentRequests.length).toBe(1);
  await expect(page.getByTestId('right-rail')).toHaveAttribute('data-collapsed', 'false');
  const aiRail = page.getByTestId('right-rail');
  await expect(aiRail.getByTitle('白板已更新', { exact: true })).toBeVisible();
  await expect(aiRail.getByText('已更新当前白板，并保留其他讲授内容。', { exact: true })).toBeVisible();
  const request = fixture.agentRequests[0];
  const boardId = await page.locator('[data-whiteboard-id]').getAttribute('data-whiteboard-id');
  expect(request.courseId).toBe(courseId);
  expect(request.scene).toEqual({ id: sceneId, title: '观察能源使用' });
  expect(request.message).toContain('edit_whiteboard');
  expect(request.message).toContain(`页面 ID：${sceneId}`);
  expect(request.message).toContain(`白板 ID：${boardId}`);
  expect(request.message).toContain(instruction);
  expect(request.sceneContextMap[sceneId].stageId).toBe(classroomId);
  expect(request.sceneContextMap[sceneId].actions).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'wb_draw_text', content: boardText })]));
  const board = page.locator('[data-whiteboard-id]');
  await expect(board).toContainText(aiBoardText);
  await expect(board).toContainText('1 段讲解');
  await screenshot(page, info, 'mock-model-whiteboard-applied');

  await aiRail.getByRole('button', { name: '还原到重生成前', exact: true }).click();
  await expect(board).toContainText(boardText);
  await expect(board).not.toContainText(aiBoardText);
  await aiRail.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(board).toContainText(aiBoardText);
  await aiRail.getByRole('button', { name: '收起', exact: true }).click();
  await page.getByRole('button', { name: '编辑白板内容与讲解', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '板书内容', exact: true })).toHaveValue(aiBoardText);
  await dialog.getByRole('button', { name: /^步骤 \d+：AI 讲解$/ }).click();
  await expect(dialog.getByRole('textbox', { name: 'AI 讲解内容', exact: true })).toHaveValue(narration);
  await dialog.getByRole('button', { name: '完成编辑', exact: true }).click();

  const patch = await saveClassroom(page, fixture, 1);
  const originalActions = request.sceneContextMap[sceneId].actions;
  const originalText = originalActions.find((action) => action.type === 'wb_draw_text');
  const expectedActions = originalActions.map((action) => action.id === originalText?.id && action.type === 'wb_draw_text'
    ? { ...action, content: aiBoardText } : action);
  expect(patch.scenes.find((scene) => scene.id === sceneId)?.actions).toEqual(expectedActions);
  expect(expectedActions[0]).toEqual({ id: 'e2e-introduction', type: 'speech', text: '今天我们一起观察校园中的能源使用。' });
  await assertNoPageOverflow(page);
  await screenshot(page, info, 'mock-model-whiteboard-saved');
  expect(fixture.patches).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('an interrupted AI edit keeps completed changes and restoration while failing the unfinished redraw', async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const initial = resource();
  const initialContent = structuredClone(initial.scenes[0].content);
  const fixture = await mockEditor(page, baseURL, initial, 'disconnect');
  const dialog = await addBoard(page);
  await dialog.getByRole('textbox', { name: '板书内容', exact: true }).fill(boardText);
  await dialog.getByRole('textbox', { name: '白板 AI 修改要求', exact: true }).fill('先改白板，再补充页面图示。');
  await dialog.getByRole('button', { name: '交给 AI 修改', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const rail = page.getByTestId('right-rail');
  await expect(rail.getByText(/连接提前结束.*已完成的修改已保留/)).toBeVisible();
  await expect(rail.getByTitle('白板已更新', { exact: true })).toBeVisible();
  await expect(rail.getByTitle('未生成', { exact: true })).toBeVisible();
  const board = page.locator('[data-whiteboard-id]');
  await expect(board).toContainText(aiBoardText);
  expect(fixture.agentRequests).toHaveLength(1);
  await rail.getByRole('button', { name: '还原到重生成前', exact: true }).click();
  await expect(board).toContainText(boardText);
  await rail.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(board).toContainText(aiBoardText);
  const patch = await saveClassroom(page, fixture, 1);
  expect(patch.scenes[0].content).toEqual(initialContent);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});
