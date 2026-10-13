import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { SignJWT } from 'jose';
import { DEFAULT_STAGES, type ClassroomSubmission, type Course } from '../src/lib/session/types';

// Exercise the shipped Monaco workspace. All business APIs and sockets are
// intercepted; only immutable editor runtime assets reach the running service.
test.use({ serviceWorkers: 'block' });
const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || 'http://localhost:3000';
const courseId = 'e2e-code-reliability-course';
const studentId = 'e2e-code-reliability-student';
const at = '2026-10-13T00:00:00.000Z';
const initialCode = 'print("server baseline")\n';
const serialize = (code: string) => JSON.stringify({ version: 1, language: 'python', activeFileId: 'main', files: [{ id: 'main', path: 'main.py', content: code }] });

async function fixture(context: BrowserContext) {
  const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE
    ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, 'utf8').trim()
    : process.env.JWT_SECRET;
  if (!secret) throw new Error('Acceptance JWT secret is required');
  const token = await new SignJWT({ role: 'student', sv: 1, userId: studentId, studentName: '代码恢复验收学生' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(studentId).setIssuer('openpbl')
    .setAudience('openpbl-app').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  await context.addCookies([{ name: 'openpbl_student', value: token, url: baseURL }]);
  const course = {
    id: courseId, name: '代码课堂可靠性验收', version: 1, status: 'teaching',
    subject: '信息科技', grade: '七年级', hours: 1, summary: '', drivingQuestion: '如何用代码计算能源用量？',
    stages: DEFAULT_STAGES.map(stage => ({ ...stage })), currentStageIndex: 2,
    pblConfig: { makeArtifactMode: 'python' },
    students: [{ id: studentId, name: '代码恢复验收学生', joinedAt: at, stageProgress: {} }],
    groups: [], resources: [], activityLog: [], uiState: {},
    submissions: [{ id: 'code-1', courseId, studentId, stageKey: 'make', type: 'code', title: 'Python 项目代码', content: serialize(initialCode), status: 'draft', version: 1, createdAt: at, updatedAt: at }],
    content: { pblOutline: '', knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: '' } },
    createdAt: at, updatedAt: at,
  } as Course;
  const faults = { offline: false };
  const writes: Array<{ content: string; expectedVersion: number }> = [];
  const receipts = new Map<string, unknown>();
  let conflicts = 0;
  await context.routeWebSocket(/.*/, socket => {
    socket.onMessage(message => {
      if (JSON.parse(String(message)).type === 'subscribe') socket.send(JSON.stringify({ type: 'subscribed', courseId }));
    });
  });
  await context.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/openmaic/interactive-runtime/monaco/')) return route.continue();
    const body = request.method() === 'GET' ? {} : request.postDataJSON() ?? {};
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/auth/me') return json({ user: { id: studentId, role: 'student', name: '代码恢复验收学生' } });
    if (path === '/api/courses') return json({ courses: [course], user: { role: 'student', name: '代码恢复验收学生' }, studentId, studentName: '代码恢复验收学生', joinedCourseId: courseId, hydrated: true, updatedAt: at });
    if (path.endsWith('/state')) return json({ course, eventCursor: '0' });
    if (path.endsWith('/projection')) return json({ courseId, courseVersion: course.version, projectionVersion: 0, projectionUpdatedAt: at, serverTime: at, resourceProjection: null, teacherResourceProjection: null });
    if (path.endsWith('/events')) return json({ events: [], nextCursor: '0', courseVersion: course.version, requiresReconciliation: true });
    if (path.endsWith('/presence')) return json({ members: [], degraded: false });
    if (path === '/api/ai-collaboration/code') return json({ conversationId: 'legacy', messages: [], commentThreads: [], memories: [], result: { kind: 'review', message: '', findings: [] }, starters: [] });
    if (path === '/api/ai-collaboration/memory') return json({ memories: [] });
    if (path === `/api/courses/${courseId}/actions`) {
      if (faults.offline) return route.abort('internetdisconnected');
      if (receipts.has(body.requestId)) return json(receipts.get(body.requestId));
      if (body.action.type === 'UPSERT_SUBMISSION') {
        const next = body.action.payload.submission as ClassroomSubmission;
        const current = course.submissions?.find(item => item.id === next.id);
        if ((current?.version ?? 0) !== body.action.payload.expectedSubmissionVersion) {
          conflicts += 1;
          return json({ code: 'DRAFT_VERSION_CONFLICT', message: '另一窗口已更新代码，请保留本机草稿。', details: { currentVersion: current?.version ?? 0, currentSubmission: current } }, 409);
        }
        const version = (current?.version ?? 0) + 1;
        course.submissions = [...(course.submissions ?? []).filter(item => item.id !== next.id), { ...next, version }];
        course.version = (course.version ?? 0) + 1;
        const ack = { requestId: body.requestId, courseVersion: course.version, submissionVersion: version, updatedAt: at };
        receipts.set(body.requestId, ack);
        writes.push({ expectedVersion: body.action.payload.expectedSubmissionVersion, content: next.content });
        return json(ack);
      }
      return json({ requestId: body.requestId, courseVersion: course.version, updatedAt: at });
    }
    return json({ ok: true, events: [], messages: [], items: [], enabled: false });
  });
  return { course, faults, writes, conflicts: () => conflicts };
}

async function openEditor(page: Page) {
  await page.goto(`/student/ai-collaboration/${courseId}`);
  await expect(page.getByRole('textbox', { name: '编辑器内容', exact: true })).toBeVisible({ timeout: 25_000 });
}
async function replaceCode(page: Page, content: string) {
  const editor = page.getByRole('textbox', { name: '编辑器内容', exact: true });
  await editor.focus();
  await editor.press('ControlOrMeta+A');
  await page.keyboard.insertText(content);
}
async function editorValue(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const monaco = (window as unknown as { monaco?: { editor: { getModels(): Array<{ getValue(): string; uri: { toString(): string } }> } } }).monaco;
    return monaco?.editor.getModels().find(model => model.uri.toString().includes('/main.py'))?.getValue();
  });
}
async function drafts(page: Page) {
  return page.evaluate(() => Object.keys(localStorage)
    .filter(key => key.startsWith('openpbl:document-draft:v1:'))
    .map(key => JSON.parse(localStorage.getItem(key)!)));
}
const saveButton = (page: Page) => page.getByRole('button', { name: '保存', exact: true });

test('failed code save never claims success and identical content can be retried', async ({ page, context }) => {
  const server = await fixture(context);
  server.faults.offline = true;
  await openEditor(page);
  const content = 'print("retry without another edit")\n';
  await replaceCode(page, content);
  await expect(page.getByText('保存失败', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('已保存', { exact: true })).toHaveCount(0);
  expect(server.writes).toHaveLength(0);
  expect((await drafts(page)).some(draft => draft.content.includes('retry without another edit'))).toBe(true);
  server.faults.offline = false;
  await saveButton(page).click();
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  await expect.poll(() => server.writes.length).toBe(1);
  expect(JSON.parse(server.writes[0].content).files[0].content).toBe(content);
  expect(server.writes[0].expectedVersion).toBe(1);
});

for (const recovery of ['reload', 'reopen'] as const) {
  test(`unsent code survives ${recovery} and saves the recovered content`, async ({ page, context }) => {
    const server = await fixture(context);
    server.faults.offline = true;
    await openEditor(page);
    const content = `print("recover after ${recovery}")\n`;
    await replaceCode(page, content);
    await expect(page.getByText('保存失败', { exact: true }).last()).toBeVisible();
    expect((await drafts(page)).some(draft => draft.content.includes(`recover after ${recovery}`))).toBe(true);
    let restored = page;
    if (recovery === 'reload') await page.reload();
    else { await page.close(); restored = await context.newPage(); await openEditor(restored); }
    await expect.poll(() => editorValue(restored), { timeout: 25_000 }).toBe(content);
    await expect(restored.getByText('保存失败', { exact: true }).last()).toBeVisible();
    server.faults.offline = false;
    await saveButton(restored).click();
    await expect(restored.getByText('已保存', { exact: true })).toBeVisible();
    expect(JSON.parse(server.writes.at(-1)!.content).files[0].content).toBe(content);
  });
}

test('a stale code tab cannot overwrite a newer save and retains its local draft after reload', async ({ page, context }) => {
  const server = await fixture(context);
  const other = await context.newPage();
  await openEditor(page);
  await openEditor(other);
  const first = 'print("accepted by server")\n';
  const second = 'print("stale tab work must survive")\n';
  await replaceCode(page, first);
  await expect.poll(() => server.writes.length).toBe(1);
  await replaceCode(other, second);
  await expect(other.getByText('保存失败', { exact: true }).last()).toBeVisible();
  expect(server.conflicts()).toBeGreaterThan(0);
  expect(server.writes).toHaveLength(1);
  expect(await editorValue(other)).toBe(second);
  expect((await drafts(other)).some(draft => draft.content.includes('stale tab work must survive'))).toBe(true);
  await other.reload();
  await expect.poll(() => editorValue(other), { timeout: 25_000 }).toBe(first);
  await expect(other.getByText(/本机有与服务器版本冲突的代码草稿/)).toBeVisible();
  await expect(other.getByRole('button', { name: '下载本机代码草稿', exact: true })).toBeVisible();
  expect((await drafts(other)).some(draft => draft.content.includes('stale tab work must survive'))).toBe(true);
  expect(server.writes).toHaveLength(1);
});
