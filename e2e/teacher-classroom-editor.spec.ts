import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { SignJWT } from 'jose';
import { readFileSync } from 'node:fs';
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

async function mockEditor(page: Page, baseURL = 'http://localhost:3000'): Promise<Fixture> {
  let saved = resource();
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

  await page.routeWebSocket(/.*/, (socket) => {
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
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') });
    }
    fixture.unexpected.push(entry);
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'No fixture for this API request' }) });
  });

  await page.goto(`/teacher/prepare/${courseId}/classroom-editor`);
  await expect(page.getByRole('button', { name: '保存课堂', exact: true })).toBeVisible();
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
  const logo = page.getByTestId('slide-nav-rail').getByRole('img', { name: 'PrAIxis', exact: true });
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
