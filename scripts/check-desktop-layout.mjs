// Real-page layout audit with browser-only fixtures; no business API reaches the server.
// Run: node scripts/check-desktop-layout.mjs [--source-css] [--assert]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
const baseURL = process.env.LAYOUT_BASE_URL || 'http://127.0.0.1:3000';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) throw new Error('Layout audit only supports a local instance');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'openpbl-desktop-'));
const name = '城市生态与社区行动：跨学科项目实践';
const options = Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, label: `方案 ${i + 1}：通过社区观察与访谈了解真实问题并设计可行方案`, count: 3, percentage: 11, respondents: [{ studentId: 'layout-student', displayName: '布局测试学生' }] }));
const questions = ['donut', 'bar', 'column', 'text'].map((chartType, i) => ({ id: `q${i}`, title: `${i + 1}. 在这次跨学科项目实践中，你认为哪些学习方式最有助于解决社区中的实际问题？`, type: chartType === 'text' ? 'short-text' : 'single-choice', chartType, required: true, responseCount: 27, options: chartType === 'text' ? [] : options, terms: [{ label: '社区观察', value: 18 }, { label: '团队合作', value: 12 }], responses: Array.from({ length: 16 }, (_, j) => ({ studentId: `s${j}`, displayName: `测试学生${j}`, content: '通过社区观察发现问题，通过团队合作整理资料并提出方案。'.repeat(5) })) }));
const course = { id: 'layout-course', name, term: '2026 秋季学期', status: 'open', description: '观察真实社区，分析证据并形成可以付诸实践的方案。'.repeat(4), outline: '研究目标与教学内容。'.repeat(15), teacher: { displayName: '跨学科项目实践教师' }, startsAt: '2026-09-01', endsAt: '2027-01-10', invitation: { code: 'A7B9C2' }, chapters: Array.from({ length: 4 }, (_, i) => ({ id: `ch${i}`, title: `第${i + 1}章：从真实生活中发现值得研究的问题并规划我们的行动`, description: '观察与实践', isOpen: true, activities: [{ id: `a${i}`, title: '社区观察方法与项目学习反思问卷', type: 'Form', isOpen: true, progress: { status: 'in_progress' }, config: { questions } }] })) };
const courses = Array.from({ length: 6 }, (_, i) => ({ ...course, id: i ? `course-${i}` : course.id, name: `${name}（${i + 1}班）` }));
const activity = { id: 'layout-survey', title: '项目学习过程与协作体验问卷', type: 'Form', description: null, isOpen: true, offering: course, chapter: { title: '学习反思' }, progress: { status: 'not_started' }, instance: null, config: { content: '请根据本次学习的实际体验作答，选择最符合自己情况的选项。', questions } };
const survey = { activity, analytics: { submittedCount: 27, totalStudents: 30, completionRate: 90, questions }, updatedAt: '2026-09-11T08:00:00Z' };
const fixtures = {
  '/api/auth/me': { user: { id: 'layout-teacher', username: 'layout', displayName: '布局测试教师', role: 'teacher' } },
  '/api/platform/auth/teacher-register': { available: true, mode: 'authenticated' },
  '/api/platform/auth/student-profile': { user: { id: 'layout-student', username: 'layout', displayName: '布局测试学生', role: 'student' } },
  '/api/platform/courses': { courses, viewer: { id: 'layout-student', displayName: '布局测试学生' } },
  '/api/platform/offerings': { offerings: [course, ...courses.slice(1)] },
  '/api/platform/templates': { templates: courses.map(c => ({ id: c.id, title: c.name, description: c.description, status: 'ACTIVE', versions: [{ id: 'v1', version: 1, status: 'published', createdAt: '2026-09-01', snapshot: {} }] })) },
  '/api/platform/activities/layout-survey': { activity },
  '/api/platform/activities/layout-survey/survey-results': survey,
  '/api/platform/auth/invite': { invitation: { code: 'A7B9C2', offering: course } },
};

(async () => {
  const { SignJWT } = await import('jose');
  // Only needed for the optimistic page gate. Fixture identities do not exist in the database.
  const secret = process.env.LAYOUT_JWT_SECRET || fs.readFileSync(process.env.LAYOUT_JWT_SECRET_FILE || 'deploy/secrets/jwt_secret.txt', 'utf8').trim();
  const browser = await chromium.launch();
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const errors = [];
  await context.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    return route.fulfill({ status: fixtures[pathname] ? 200 : 404, contentType: 'application/json', body: JSON.stringify(fixtures[pathname] || { message: 'Layout fixture unavailable' }) });
  });
  for (const role of ['teacher', 'student']) {
    const sub = `layout-${role}`;
    const token = await new SignJWT({ role, sv: 1, username: 'layout', displayName: '布局测试', userId: sub, studentName: '布局测试' }).setProtectedHeader({ alg: 'HS256' }).setSubject(sub).setIssuer('openpbl').setAudience('openpbl-app').setExpirationTime('15m').sign(new TextEncoder().encode(secret));
    await context.addCookies([{ name: `openpbl_${role}`, value: token, url: baseURL }]);
  }
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const reports = [];
  const sizes = [[1024, 768], [1280, 720], [1366, 768], [1440, 900], [1920, 1080], [2560, 1440], [3840, 2160], [1024, 576]];
  const scenarios = [
    ['student-login', '/student/login', '.pbl-auth-input'],
    ['student-register', '/student/register?code=A7B9C2', '.pbl-student-code-cell'],
    ['student-register-account', '/student/register?code=A7B9C2', '.pbl-student-code-cell', async () => { await page.getByRole('button', { name: /验证|下一步|查找课程/ }).click(); await page.locator('.pbl-auth-register-fields').waitFor(); }],
    ['teacher-login', '/teacher/login?reason=layout-check', '.pbl-auth-input'],
    ['teacher-register', '/teacher/register', '.pbl-auth-input'],
    ['student-courses', '/student?all=1', '.pbl-student-course-card'],
    ['student-profile', '/student/profile', '.pbl-student-profile'],
    ['student-course', '/student/courses/layout-course', '.pbl-student-course-main'],
    ['teacher-courses', '/teacher/classes', '.pbl-teacher-class-card'],
    ['teacher-course', '/teacher/classes/layout-course', '.pbl-teacher-course-heading'],
    ['teacher-course-dialog', '/teacher/classes/layout-course', '.pbl-teacher-course-heading', async () => { await page.getByRole('button', { name: /课程设置/ }).click(); await page.getByRole('dialog').waitFor(); }],
    ['teacher-library', '/teacher/templates', '.pbl-template-card'],
    ['student-survey', '/student/activities/layout-survey', '.survey-sheet-question'],
    ['survey-donut', '/teacher/surveys/layout-survey', '.survey-donut'],
    ['survey-bar', '/teacher/surveys/layout-survey', '.survey-donut', async () => { await page.locator('.survey-question-tab').nth(1).click(); }],
    ['survey-column', '/teacher/surveys/layout-survey', '.survey-donut', async () => { await page.locator('.survey-question-tab').nth(2).click(); }],
    ['survey-text', '/teacher/surveys/layout-survey', '.survey-donut', async () => { await page.locator('.survey-question-tab').nth(3).click(); }],
    ['survey-presentation', '/teacher/surveys/layout-survey?display=1', '.survey-donut'],
    ['survey-presentation-bar', '/teacher/surveys/layout-survey?display=1', '.survey-donut', async () => { await page.locator('.survey-display-pager').getByRole('button', { name: '下一题' }).click(); }],
    ['survey-presentation-column', '/teacher/surveys/layout-survey?display=1', '.survey-donut', async () => { await page.locator('.survey-display-pager').getByRole('button', { name: '下一题' }).click(); await page.locator('.survey-display-pager').getByRole('button', { name: '下一题' }).click(); }],
    ['survey-presentation-text', '/teacher/surveys/layout-survey?display=1', '.survey-donut', async () => { for (let i = 0; i < 3; i++) await page.locator('.survey-display-pager').getByRole('button', { name: '下一题' }).click(); }],
  ];
  const selectedScenarios = scenarios.filter(([id]) => !process.env.LAYOUT_SCENARIOS || process.env.LAYOUT_SCENARIOS.split(',').includes(id));
  for (const [id, route, ready, prepare] of selectedScenarios) {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(baseURL + route);
    await page.locator(ready).first().waitFor();
    if (prepare) await prepare();
    if (process.argv.includes('--source-css')) {
      await page.addStyleTag({ content: fs.readFileSync('src/components/platform/platform.css', 'utf8') });
      const responsive = 'src/components/platform/desktop-layout.css';
      if (fs.existsSync(responsive)) await page.addStyleTag({ content: fs.readFileSync(responsive, 'utf8') });
    }
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(120);
      const report = await page.evaluate(() => {
        const selectors = '.pbl-auth-stage,.pbl-auth-content,.pbl-student-course-layout,.pbl-teacher-course-heading,.survey-choice-layout,.survey-column-chart,.survey-insight-canvas,[role=dialog]';
        const boxes = [...document.querySelectorAll(selectors)].map(el => ({ selector: el.className, client: el.clientWidth, scroll: el.scrollWidth, height: el.clientHeight, scrollHeight: el.scrollHeight, right: Math.round(el.getBoundingClientRect().right) }));
        const clippedClouds = [...document.querySelectorAll('.survey-word-cloud')].filter(el => el.querySelector('svg')?.getBoundingClientRect().height > el.clientHeight + 2).length;
        const missingTheme = !document.querySelector('.pbl-platform-theme');
        const undersizedColumns = [...document.querySelectorAll('.survey-column-chart button')].some(el => el.getBoundingClientRect().width < 44);
        const clippedDialogs = [...document.querySelectorAll('[role=dialog]')].some(el => { const rect = el.getBoundingClientRect(); return rect.top < -1 || rect.bottom > innerHeight + 1 || rect.left < -1 || rect.right > innerWidth + 1; });
        return { scrollWidth: document.documentElement.scrollWidth, width: innerWidth, boxes, clippedClouds, missingTheme, undersizedColumns, clippedDialogs };
      });
      reports.push({ id, width, height, ...report });
      if ([1024, 1280, 2560].includes(width)) await page.screenshot({ path: path.join(output, `${id}-${width}x${height}.png`) });
    }
    console.log('checked', id);
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ reports, errors }, null, 2));
  const overflow = reports.filter(r => r.clippedClouds || r.missingTheme || r.undersizedColumns || r.clippedDialogs || r.scrollWidth > r.width + 1 || r.boxes.some(b => b.scroll > b.client + 2 && !String(b.selector).includes('survey-column-chart')));
  console.log(JSON.stringify({ output, scenarios: selectedScenarios.length, checks: reports.length, overflow: overflow.map(r => ({ id: r.id, width: r.width, height: r.height, clippedClouds: r.clippedClouds, missingTheme: r.missingTheme, undersizedColumns: r.undersizedColumns, clippedDialogs: r.clippedDialogs, boxes: r.boxes.filter(b => b.scroll > b.client + 2) })), errors }, null, 2));
  await browser.close();
  if (process.argv.includes('--assert') && (overflow.length || errors.length)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exit(1); });
