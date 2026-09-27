import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { SignJWT } from 'jose';
import { DEFAULT_STAGES, type ClassroomSubmission, type Course } from '../src/lib/session/types';

// Only browser requests are faulted. All business APIs/sockets are intercepted;
// these tests never create users or write to the running service's database.
test.use({ serviceWorkers: 'block' });
const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || 'http://localhost:3000';
const courseId = 'e2e-reliability-course';
const studentId = 'e2e-reliability-student';
const at = '2026-09-26T00:00:00.000Z';

async function fixture(context: BrowserContext) {
  const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE
    ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, 'utf8').trim()
    : process.env.JWT_SECRET;
  if (!secret) throw new Error('Acceptance JWT secret is required');
  const token = await new SignJWT({ role: 'student', sv: 1, userId: studentId, studentName: '恢复验收学生' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(studentId).setIssuer('openpbl')
    .setAudience('openpbl-app').setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
  await context.addCookies([{ name: 'openpbl_student', value: token, url: baseURL }]);
  const course = {
    id: courseId, name: '课堂可靠性验收', version: 1, status: 'teaching',
    subject: '科学', grade: '七年级', hours: 1, summary: '', drivingQuestion: '如何节约校园能源？',
    stages: DEFAULT_STAGES.map(stage => ({ ...stage })), currentStageIndex: 2,
    students: [{ id: studentId, name: '恢复验收学生', joinedAt: at, stageProgress: {} }],
    groups: [], resources: [], activityLog: [], uiState: {},
    submissions: [{ id: 'document-1', courseId, studentId, stageKey: 'make', type: 'document', title: '成果', content: '<p>保存起点</p>', status: 'draft', version: 1, createdAt: at, updatedAt: at }],
    content: { pblOutline: '', knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: '' } },
    createdAt: at, updatedAt: at,
  } as Course;
  const faults = { offline: false, loseSaveAck: false, loseFinalizeAck: false };
  const writes: Array<{ requestId: string; expectedVersion: number; content: string }> = [];
  const receipts = new Map<string, Record<string, unknown>>();
  const finalizeIds: string[] = [];
  let finalizations = 0;
  let conflicts = 0;
  await context.routeWebSocket(/.*/, socket => {
    socket.onMessage(message => {
      const data = JSON.parse(String(message));
      if (data.type === 'subscribe') socket.send(JSON.stringify({ type: 'subscribed', courseId }));
    });
  });
  await context.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.method() === 'GET' ? {} : request.postDataJSON() ?? {};
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/auth/me') return json({ user: { id: studentId, role: 'student', name: '恢复验收学生' } });
    if (path === '/api/courses') return json({ courses: [course], user: { role: 'student', name: '恢复验收学生' }, studentId, studentName: '恢复验收学生', joinedCourseId: courseId, hydrated: true, updatedAt: course.updatedAt });
    if (path.endsWith('/state')) return json({ course, eventCursor: '0' });
    if (path.endsWith('/projection')) return json({ courseId, courseVersion: course.version, projectionVersion: 0, projectionUpdatedAt: at, serverTime: at, resourceProjection: null, teacherResourceProjection: null });
    if (path === `/api/courses/${courseId}/events`) return json({ events: [], nextCursor: '0', courseVersion: course.version, requiresReconciliation: true });
    if (path.endsWith('/presence')) return json({ members: [], degraded: false });
    if (path === '/api/ai-collaboration/document') return json({ conversationId: 'test-conversation', messages: [], commentThreads: [], requests: [], proactiveReviewEnabled: false });
    if (path === '/api/ai-collaboration/memory') return json({ memories: [] });
    if (path === `/api/courses/${courseId}/actions`) {
      if (faults.offline) return route.abort('internetdisconnected');
      if (receipts.has(body.requestId)) return json(receipts.get(body.requestId));
      const action = body.action;
      if (action.type === 'UPSERT_SUBMISSION') {
        const next = action.payload.submission as ClassroomSubmission;
        const current = course.submissions?.find(item => item.id === next.id);
        if ((current?.version ?? 0) !== action.payload.expectedSubmissionVersion) {
          conflicts += 1;
          return json({ code: 'DRAFT_VERSION_CONFLICT', message: '另一标签页已更新，请保留本机草稿并核对。', details: { currentVersion: current?.version ?? 0, currentSubmission: current } }, 409);
        }
        const version = (current?.version ?? 0) + 1;
        course.submissions = [...(course.submissions ?? []).filter(item => item.id !== next.id), { ...next, version }];
        course.version = (course.version ?? 0) + 1;
        const ack = { requestId: body.requestId, courseVersion: course.version, submissionVersion: version, updatedAt: at };
        receipts.set(body.requestId, ack);
        writes.push({ requestId: body.requestId, expectedVersion: action.payload.expectedSubmissionVersion, content: next.content });
        if (faults.loseSaveAck) { faults.loseSaveAck = false; return route.abort('connectionreset'); }
        return json(ack);
      }
      return json({ requestId: body.requestId, courseVersion: course.version, updatedAt: at });
    }
    if (path === '/api/project-practice/submissions/finalize') {
      finalizeIds.push(body.requestId);
      if (receipts.has(body.requestId)) return json(receipts.get(body.requestId));
      const current = course.submissions?.find(item => item.id === body.submissionId);
      if (current?.version !== body.expectedVersion) return json({ code: 'DRAFT_VERSION_CONFLICT', message: '保存版本冲突' }, 409);
      current.version += 1;
      const ack = { sequence: ++finalizations, submissionVersion: current.version, downloadUrl: '/api/uploads/fixture-docx?download=1', submittedAt: at };
      receipts.set(body.requestId, ack);
      if (faults.loseFinalizeAck) { faults.loseFinalizeAck = false; return route.abort('connectionreset'); }
      return json(ack);
    }
    return json({ ok: true, events: [], messages: [], items: [], enabled: false });
  });
  return { faults, writes, finalizeIds, course, finalizations: () => finalizations, conflicts: () => conflicts };
}

async function openEditor(page: Page) {
  await page.goto(`/student/ai-collaboration/${courseId}`);
  const editor = page.locator('[data-slate-editor="true"]').first();
  await expect(editor).toBeVisible();
  return editor;
}

async function drafts(page: Page) {
  return page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('openpbl:document-draft:v1:')).map(key => JSON.parse(localStorage.getItem(key)!)));
}

test('offline document edits survive reload and replay to the server', async ({ page, context }) => {
  const server = await fixture(context);
  server.faults.offline = true;
  const editor = await openEditor(page);
  await editor.fill('离线仍然保留的完整项目方案');
  await expect.poll(async () => (await drafts(page)).some(draft => draft.content.includes('离线仍然保留'))).toBe(true);
  await expect(page.getByText(/同步失败/).first()).toBeVisible();
  server.faults.offline = false;
  await page.reload();
  await expect(page.locator('[data-slate-editor="true"]').first()).toContainText('离线仍然保留');
  await expect.poll(() => server.writes.some(write => write.content.includes('离线仍然保留'))).toBe(true);
  await expect.poll(() => drafts(page)).toEqual([]);
});

test('a lost save acknowledgement retries one stable request without duplicate writes', async ({ page, context }) => {
  const server = await fixture(context);
  server.faults.loseSaveAck = true;
  const editor = await openEditor(page);
  await editor.fill('一次写入经过丢失回执后恢复');
  await expect(page.getByText('服务器已保存', { exact: true })).toBeVisible();
  await expect.poll(() => server.writes.length).toBe(1);
  await expect.poll(() => drafts(page)).toEqual([]);
  expect(server.course.submissions?.[0].version).toBe(2);
});

test('another tab cannot overwrite the accepted draft and retains its own unsent content', async ({ page, context }) => {
  const server = await fixture(context);
  const other = await context.newPage();
  const firstEditor = await openEditor(page);
  const otherEditor = await openEditor(other);
  await firstEditor.fill('第一个标签页已确认的方案');
  await expect.poll(() => server.writes.length).toBe(1);
  await otherEditor.fill('第二个标签页尚未合并的方案');
  await expect(other.getByText(/同步失败/).first()).toBeVisible();
  expect(server.writes).toHaveLength(1);
  const conflicts = server.conflicts();
  await other.waitForTimeout(1_900);
  expect(server.conflicts()).toBe(conflicts);
  await expect(otherEditor).toContainText('第二个标签页尚未合并');
  expect((await drafts(other)).some(draft => draft.content.includes('第二个标签页尚未合并'))).toBe(true);
  await other.close();
});

test('finalization retries a lost acknowledgement and the next edit uses the new draft version', async ({ page, context }) => {
  const server = await fixture(context);
  server.faults.loseFinalizeAck = true;
  const editor = await openEditor(page);
  await page.getByRole('button', { name: '提交最终版', exact: true }).click();
  await expect.poll(() => server.finalizeIds.length).toBe(1);
  await page.getByRole('button', { name: '提交最终版', exact: true }).click();
  await expect(page.getByRole('link', { name: '下载第 1 版 Word', exact: true })).toBeVisible();
  expect(server.finalizeIds[0]).toBe(server.finalizeIds[1]);
  expect(server.finalizations()).toBe(1);
  await editor.fill('提交最终版后继续修改的方案');
  await expect.poll(() => server.writes.length).toBe(1);
  expect(server.writes[0].expectedVersion).toBe(2);
  expect(server.course.submissions?.[0].version).toBe(3);
});
