// Real-page layout audit with browser-only fixtures; no business API reaches the server.
// Run: node scripts/check-desktop-layout.mjs [--source-css] [--assert]
// Optional filters: LAYOUT_SCENARIOS=home,student-courses LAYOUT_DEVICES=phone-portrait,pad-landscape
// Engine and viewport emulation check responsive behavior; they do not replace Windows/macOS hardware testing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, firefox, webkit, devices } from '@playwright/test';
const browserName = process.env.LAYOUT_BROWSER || 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(browserName)) throw new Error('LAYOUT_BROWSER must be chromium, firefox or webkit');
const baseURL = process.env.LAYOUT_BASE_URL || 'http://127.0.0.1:3000';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) throw new Error('Layout audit only supports a local instance');
const dpr = Number(process.env.LAYOUT_DPR || 1);
if (!Number.isFinite(dpr) || dpr < 1 || dpr > 3) throw new Error('LAYOUT_DPR must be between 1 and 3');
const output = process.env.LAYOUT_OUTPUT_DIR ? path.resolve(process.env.LAYOUT_OUTPUT_DIR) : fs.mkdtempSync(path.join(os.tmpdir(), 'openpbl-responsive-'));
fs.mkdirSync(output, { recursive: true });
const name = '城市生态与社区行动：跨学科项目实践';
const options = Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, label: `方案 ${i + 1}：通过社区观察与访谈了解真实问题并设计可行方案`, count: 3, percentage: 11, respondents: [{ studentId: 'layout-student', displayName: '布局测试学生' }] }));
const questions = ['donut', 'bar', 'column', 'text'].map((chartType, i) => ({ id: `q${i}`, title: `${i + 1}. 在这次跨学科项目实践中，你认为哪些学习方式最有助于解决社区中的实际问题？`, type: chartType === 'text' ? 'short-text' : chartType === 'donut' ? 'single-choice' : 'multiple-choice', chartType, required: true, responseCount: 27, options: chartType === 'text' ? [] : options, terms: [{ label: '社区观察', value: 18 }, { label: '团队合作', value: 12 }], responses: Array.from({ length: 16 }, (_, j) => ({ studentId: `s${j}`, displayName: `测试学生${j}`, content: '通过社区观察发现问题，通过团队合作整理资料并提出方案。'.repeat(5) })) }));
const course = { id: 'layout-course', name, coverImageUrl: '/brand/coteach/horizontal-color.png', term: '2026 秋季学期', status: 'open', description: '观察真实社区，分析证据并形成可以付诸实践的方案。'.repeat(4), outline: '研究目标与教学内容。'.repeat(15), teacher: { displayName: '跨学科项目实践教师' }, startsAt: '2026-09-01', endsAt: '2027-01-10', invitation: { code: 'A7B9C2' }, chapters: Array.from({ length: 4 }, (_, i) => ({ id: `ch${i}`, title: `第${i + 1}章：从真实生活中发现值得研究的问题并规划我们的行动`, description: '观察与实践', isOpen: true, activities: [{ id: `a${i}`, title: '社区观察方法与项目学习反思问卷', type: 'Form', isOpen: true, progress: { status: 'in_progress' }, config: { questions } }] })) };
course.chapters[0].activities.push({ id: 'layout-classroom', title: '城市生态调查课堂', type: 'Classroom', isOpen: true, version: 1, progress: { status: 'not_started' }, config: { schemaVersion: 1 } });
const courses = Array.from({ length: 6 }, (_, i) => ({ ...course, id: i ? `course-${i}` : course.id, name: `${name}（${i + 1}班）` }));
const longLink = `https://example.org/evidence/${'mixedChineseEnglishCourseReference2026'.repeat(12)}`;
const longCopyCourse = { ...course, name: `${name}：CommunityResearchAndEvidenceBasedLearning2026`, description: `课程参考链接：${longLink}`, outline: `项目说明和延伸阅读：${longLink}` };
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
  '/api/textbooks': { items: [] },
};

const student = { id: 'layout-student', enrollmentId: 'layout-enrollment', username: 'community_research_student_2026', displayName: '跨学科项目实践测试学生', status: 'active', joinedAt: '2026-09-01T08:00:00Z', participated: true, completedOpenActivities: 1, openActivityCount: 4, classroomParticipationCount: 1, lastLearningAt: '2026-09-10T08:00:00Z', activityStatuses: { a0: 'completed' }, attentionReasons: ['incomplete_open_activity'] };
const memberActivity = { id: 'a0', chapterId: 'ch0', chapterTitle: course.chapters[0].title, chapterPosition: 1, position: 1, title: course.chapters[0].activities[0].title, type: 'FORM', isOpen: true, archived: false };
fixtures['/api/platform/offerings/layout-course/students'] = { offering: course, activities: [memberActivity], totals: { members: 1, participated: 1, incomplete: 1, pendingEvaluation: 0 }, updatedAt: '2026-09-10T08:00:00Z', students: [student] };
fixtures['/api/platform/offerings/layout-course/students/layout-enrollment'] = { student, activities: [{ ...memberActivity, progress: { status: 'completed' } }], classrooms: [] };
fixtures['/api/openmaic/provider-config'] = { providers: {} };
fixtures['/api/server-providers'] = { providers: {}, tts: {}, asr: {}, pdf: {}, image: {}, video: {}, webSearch: {} };
fixtures['/api/platform/survey-settings'] = { mode: 'local' };
fixtures['/api/knowledge-lecture/settings'] = { settings: {} };
fixtures['/api/course-quality-review/settings'] = { settings: {} };

(async () => {
  const { SignJWT } = await import('jose');
  // Only needed for the optimistic page gate. Fixture identities do not exist in the database.
  const secret = process.env.LAYOUT_JWT_SECRET || fs.readFileSync(process.env.LAYOUT_JWT_SECRET_FILE || 'deploy/secrets/jwt_secret.txt', 'utf8').trim();
  const cookies = [];
  for (const role of ['teacher', 'student']) {
    const sub = `layout-${role}`;
    const token = await new SignJWT({ role, sv: 1, username: 'layout', displayName: '布局测试', userId: sub, studentName: '布局测试' }).setProtectedHeader({ alg: 'HS256' }).setSubject(sub).setIssuer('openpbl').setAudience('openpbl-app').setExpirationTime('1h').sign(new TextEncoder().encode(secret));
    cookies.push({ name: `openpbl_${role}`, value: token, url: baseURL });
  }
  const browser = await ({ chromium, firefox, webkit })[browserName].launch();
  const reports = [];
  const desktopSizes = [[768, 576], [768, 768], [1024, 768], [1280, 720], [1366, 768], [1440, 900], [1920, 1080], [2560, 1440], [3840, 2160], [1024, 576]];
  const profiles = [
    ...desktopSizes.map(([width, height]) => ({ id: `desktop-${width}x${height}`, viewport: { width, height } })),
    { ...devices['iPad Mini'], defaultBrowserType: undefined, id: 'pad-portrait', viewport: { width: 768, height: 1024 } },
    { ...devices['iPad Mini landscape'], defaultBrowserType: undefined, id: 'pad-landscape', viewport: { width: 1024, height: 768 } },
    { ...devices['iPhone 13'], defaultBrowserType: undefined, id: 'phone-portrait', viewport: { width: 390, height: 844 } },
    { ...devices['iPhone 13 landscape'], defaultBrowserType: undefined, id: 'phone-landscape', viewport: { width: 844, height: 390 } },
    { ...devices['iPhone SE'], defaultBrowserType: undefined, id: 'phone-small-portrait', viewport: { width: 320, height: 568 } },
    { ...devices['iPhone SE landscape'], defaultBrowserType: undefined, id: 'phone-small-landscape', viewport: { width: 568, height: 320 } },
  ];
  const scenarios = [
    ['home', '/', '.pbl-aurora-light'],
    ['teacher-root', '/teacher', '.pbl-teacher-class-card', async page => { await page.waitForURL('**/teacher/classes'); }],
    ['student-root', '/student', '.pbl-student-course-card'],
    ['teacher-settings', '/teacher/settings', '.pbl-settings-section-nav'],
    ['teacher-settings-ai', '/teacher/settings', '.pbl-settings-section-nav', async (page) => {
      await page.getByRole('button', { name: /AI 服务/ }).click();
      await page.getByRole('heading', { name: '课程设计与质量' }).waitFor();
    }],
    ['teacher-settings-ai-detail', '/teacher/settings', '.pbl-settings-section-nav', async (page) => {
      await page.getByRole('button', { name: /AI 服务/ }).click();
      await page.getByRole('button', { name: /AI 大模型/ }).click();
      await page.locator('.pbl-settings-editor').waitFor();
    }],
    ['teacher-settings-ai-model-form', '/teacher/settings', '.pbl-settings-section-nav', async (page) => {
      await page.getByRole('button', { name: /AI 服务/ }).click();
      await page.getByRole('button', { name: /AI 大模型/ }).click();
      const modelHeading = page.getByRole('heading', { name: '模型配置' });
      await modelHeading.waitFor();
      await modelHeading.scrollIntoViewIfNeeded();
    }],
    ['teacher-students', '/teacher/classes/layout-course/students', '[data-enrollment-id]'],
    ['teacher-student-detail', '/teacher/classes/layout-course/students', '[data-enrollment-id]', async (page) => { await page.locator('[data-enrollment-id]').first().click(); await page.getByRole('navigation', { name: '学生档案内容' }).filter({ visible: true }).waitFor(); }],
    ['student-login', '/student/login', '.pbl-auth-input'],
    ['student-reset-password', '/student/reset-password?token=layout-placeholder-token', '.pbl-auth-input'],
    ['student-login-rotation', '/student/login', '.pbl-auth-input', async (page) => {
      const original = page.viewportSize();
      const username = page.getByPlaceholder('输入你的学号');
      await username.fill('layout_rotation_student_2026');
      for (const viewport of [{ width: original.height, height: original.width }, original]) {
        await page.setViewportSize(viewport);
        await page.waitForTimeout(150);
        if (await username.inputValue() !== 'layout_rotation_student_2026' || !await username.isVisible()) throw new Error('Orientation change lost the login input');
        const overflow = await page.evaluate(() => {
          if (document.documentElement.scrollWidth <= innerWidth + 1) return null;
          return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, visualViewport: { width: visualViewport?.width, height: visualViewport?.height, scale: visualViewport?.scale }, elements: [...document.querySelectorAll('body *')].filter(el => { const rect = el.getBoundingClientRect(); return rect.width > 0 && (rect.right > innerWidth + 1 || rect.left < -1); }).slice(0, 12).map(el => ({ tag: el.tagName, selector: String(el.className), left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, client: el.clientWidth, scroll: el.scrollWidth })) };
        });
        if (overflow) throw new Error(`Orientation change caused document overflow: ${JSON.stringify(overflow)}`);
      }
    }],
    ['student-register', '/student/register?code=A7B9C2', '.pbl-student-code-cell'],
    ['student-register-account', '/student/register?code=A7B9C2', '.pbl-student-code-cell', async (page) => { await page.getByRole('button', { name: /验证|下一步|查找课程/ }).click(); await page.locator('.pbl-auth-register-fields').waitFor(); }],
    ['teacher-login', '/teacher/login?reason=layout-check', '.pbl-auth-input'],
    ['teacher-register', '/teacher/register', '.pbl-auth-input'],
    ['student-courses', '/student?all=1', '.pbl-student-course-card'],
    ['student-profile', '/student/profile', '.pbl-student-profile'],
    ['student-course', '/student/courses/layout-course', '.pbl-student-course-main', async (page) => {
      const back = page.getByRole('link', { name: '返回我的课程', exact: true });
      const reminder = page.getByRole('button', { name: /^课程提醒/ });
      const account = page.getByRole('button', { name: /^学生个人中心/ });
      const viewport = page.viewportSize();
      const assertInViewport = async (locator, label) => {
        let rect;
        for (let attempt = 0; attempt < 20; attempt++) {
          rect = await locator.boundingBox();
          if (rect && rect.x >= -1 && rect.y >= -1 && rect.x + rect.width <= viewport.width + 1 && rect.y + rect.height <= viewport.height + 1) return;
          await page.waitForTimeout(100);
        }
        throw new Error(`${label} is outside the viewport after layout settled: ${JSON.stringify(rect)}`);
      };
      for (const [control, label] of [[back, 'Course back link'], [reminder, 'Course reminder'], [account, 'Student account']]) {
        await assertInViewport(control, label);
        await control.click({ trial: true });
      }
      const backLines = await back.evaluate(el => {
        const tops = [];
        for (const node of el.childNodes) {
          if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
          const range = document.createRange(); range.selectNodeContents(node);
          tops.push(...[...range.getClientRects()].map(rect => Math.round(rect.top)));
        }
        return new Set(tops).size;
      });
      if (backLines > 1) throw new Error('Course back link wraps onto multiple lines');
      await reminder.click();
      await page.locator('.pbl-course-reminder-popover').waitFor();
      await page.waitForTimeout(150);
      await assertInViewport(page.locator('.pbl-course-reminder-popover'), 'Course reminder popover');
      await page.keyboard.press('Escape');
      await account.click();
      await page.getByRole('menu').waitFor();
      await page.waitForTimeout(150);
      await assertInViewport(page.getByRole('menu'), 'Student account menu');
      await page.keyboard.press('Escape');
      await page.locator('.pbl-student-chapter-progress-row').evaluateAll(rows => {
        for (const row of rows) {
          row.children[0].textContent = '12 / 12';
          row.children[2].textContent = '100%';
        }
      });
    }],
    ['student-course-long-copy', '/student/courses/layout-course', '.pbl-student-course-main', async (page) => {
      await page.getByRole('button', { name: '课程介绍' }).click();
      await page.locator('.pbl-student-secondary-copy').waitFor();
    }],
    ['teacher-courses', '/teacher/classes', '.pbl-teacher-class-card'],
    ['teacher-course', '/teacher/classes/layout-course', '.pbl-teacher-course-heading'],
    ['teacher-access-redirect', '/teacher/classes/layout-course/access', '.pbl-teacher-course-heading', async page => { await page.waitForURL('**/teacher/classes/layout-course'); }],
    ['teacher-experiment', '/teacher/classes/layout-course/activities/layout-classroom/experiment', 'h1', async page => { await page.getByRole('heading', { name: '前后测配置' }).waitFor(); await page.getByText('城市生态调查课堂').filter({ visible: true }).first().waitFor(); }],
    ['teacher-course-dialog', '/teacher/classes/layout-course', '.pbl-teacher-course-heading', async (page) => { await page.getByRole('button', { name: /课程设置/ }).click(); await page.getByRole('dialog').waitFor(); }],
    ['teacher-library', '/teacher/templates', '.pbl-template-card'],
    ['teacher-template-new', '/teacher/templates/new', 'h1', async page => { await page.getByRole('heading', { name: '创建课程' }).waitFor(); }],
    ['teacher-template-pbl-new', '/teacher/templates/pbl/new', 'h1', async page => { await page.getByRole('heading', { name: '创建 PBL 课程' }).waitFor(); }],
    ['teacher-textbooks', '/teacher/textbooks', 'h1', async page => { await page.getByText('教材库还是空的').waitFor(); }],
    ['student-survey', '/student/activities/layout-survey', '.survey-sheet-question'],
    ['survey-donut', '/teacher/surveys/layout-survey', '.survey-donut'],
    ['survey-bar', '/teacher/surveys/layout-survey', '.survey-donut', async (page) => { await page.locator('.survey-question-tab').nth(1).click(); }],
    ['survey-column', '/teacher/surveys/layout-survey', '.survey-donut', async (page) => { await page.locator('.survey-question-tab').nth(2).click(); }],
    ['survey-text', '/teacher/surveys/layout-survey', '.survey-donut', async (page) => { await page.locator('.survey-question-tab').nth(3).click(); }],
    ['survey-presentation', '/teacher/surveys/layout-survey?display=1', '.survey-donut'],
    ['survey-presentation-bar', '/teacher/surveys/layout-survey?display=1', '.survey-donut', async (page) => { await page.locator('.survey-display-pager').getByRole('button', { name: '下一题' }).click(); }],
    ['survey-presentation-column', '/teacher/surveys/layout-survey?display=1', '.survey-donut', async (page) => { await page.locator('.survey-display-pager').getByRole('button', { name: '下一题' }).click(); await page.locator('.survey-display-pager').getByRole('button', { name: '下一题' }).click(); }],
    ['survey-presentation-text', '/teacher/surveys/layout-survey?display=1', '.survey-donut', async (page) => { for (let i = 0; i < 3; i++) await page.locator('.survey-display-pager').getByRole('button', { name: '下一题' }).click(); }],
  ];
  const select = (value, id) => !value || value.split(',').includes(id);
  const selectedScenarios = scenarios.filter(([id]) => select(process.env.LAYOUT_SCENARIOS, id));
  const selectedProfiles = profiles.filter(({ id }) => select(process.env.LAYOUT_DEVICES, id));
  if (!selectedScenarios.length || !selectedProfiles.length) throw new Error('No matching layout scenarios/devices');
  const isFailure = r => r.scenarioError || r.errors.length || r.failedResources.length || r.missingFixtures.length || r.blockedMutations.length || r.brokenImages?.length || r.chapterProgressIssues?.length || r.inviteHeadingIssues?.length || r.clippedClouds || r.missingTheme || r.undersizedColumns || r.invisibleSurveyBars || r.clippedDialogs || r.surveyRailUnexpected || r.settingsTrailingSpace > 32 || r.textIssues?.length || r.scrollWidth > r.width + 1 || r.boxes?.some(b => b.scroll > b.client + 2 && !b.scrollable);
  try {
    for (const profile of selectedProfiles) {
      const { id: device, ...deviceOptions } = profile;
      delete deviceOptions.defaultBrowserType;
      // Device presets pin screen dimensions; let viewport rotation update screen too,
      // otherwise WebKit keeps its original media-query/layout width after rotating.
      if (browserName === 'firefox') delete deviceOptions.isMobile;
      const context = await browser.newContext({ ...deviceOptions, screen: undefined, deviceScaleFactor: dpr, reducedMotion: 'reduce', serviceWorkers: 'block' });
      await context.addCookies(cookies);
      for (const [id, routePath, ready, prepare] of selectedScenarios) {
        const page = await context.newPage();
        await context.tracing.start({ screenshots: true, snapshots: true });
        page.setDefaultTimeout(12000);
        const errors = [], failedResources = [], missingFixtures = [], blockedMutations = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('requestfailed', request => {
          const failure = request.failure()?.errorText;
          // Browser engines report requests superseded by navigation using
          // different names. The settled destination is checked separately.
          if (!['net::ERR_ABORTED', 'NS_BINDING_ABORTED', 'Load request cancelled'].includes(failure)) failedResources.push({ url: request.url(), type: request.resourceType(), error: failure });
        });
        page.on('response', response => {
          if (response.status() >= 400 && !new URL(response.url()).pathname.startsWith('/api/')) failedResources.push({ url: response.url(), type: response.request().resourceType(), status: response.status() });
        });
        // Explicitly mock API reads. Reject mutations except the read-only invite lookup;
        // never let fixture identities or attempted writes reach a business endpoint.
        await page.route('**/api/**', intercepted => {
          const request = intercepted.request();
          const pathname = new URL(request.url()).pathname;
          const readOnly = ['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || pathname === '/api/platform/auth/invite' && request.method() === 'POST';
          if (!readOnly) blockedMutations.push({ pathname, method: request.method() });
          else if (!fixtures[pathname]) missingFixtures.push(pathname);
          const fixture = id === 'student-course-long-copy' && pathname === '/api/platform/courses'
            ? { ...fixtures[pathname], courses: [longCopyCourse] }
            : fixtures[pathname];
          return intercepted.fulfill({ status: !readOnly ? 405 : fixture ? 200 : 404, contentType: 'application/json', body: JSON.stringify(readOnly && fixture || { message: 'Layout fixture unavailable' }) });
        });
        const started = Date.now();
        let report = { id, device, dpr, width: profile.viewport.width, height: profile.viewport.height, errors, failedResources, missingFixtures, blockedMutations };
        try {
          await page.goto(baseURL + routePath, { waitUntil: 'load' });
          if (process.argv.includes('--source-css')) {
            for (const file of ['platform.css', 'desktop-layout.css', 'mobile-layout.css']) {
              const cssPath = `src/components/platform/${file}`;
              if (fs.existsSync(cssPath)) await page.addStyleTag({ content: fs.readFileSync(cssPath, 'utf8') });
            }
          }
          await page.locator(ready).first().waitFor();
          if (prepare) await prepare(page);
          await page.evaluate(async () => {
            await document.fonts.ready;
            // Exercise native lazy images below the first fold before checking decode.
            for (const img of document.images) img.loading = 'eager';
            await Promise.all([...document.images].map(img => Promise.race([
              img.decode().catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000)),
            ])));
          });
          await page.waitForTimeout(150);
          const metrics = await page.evaluate(({ isHome, isStudentSurvey }) => {
            const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
            const selectors = '.pbl-auth-stage,.pbl-auth-content,.pbl-student-course-layout,.pbl-teacher-course-heading,.pbl-settings-workbench,.pbl-settings-editor,.pbl-settings-provider-list,.survey-choice-layout,.survey-column-chart,.survey-insight-canvas,[role=dialog]';
            const boxes = [...document.querySelectorAll(selectors)].filter(visible).map(el => ({ selector: String(el.className), client: el.clientWidth, scroll: el.scrollWidth, height: el.clientHeight, scrollHeight: el.scrollHeight, right: Math.round(el.getBoundingClientRect().right), children: el.scrollWidth > el.clientWidth + 2 ? [...el.children].map(child => ({ selector: String(child.className), left: child.getBoundingClientRect().left, right: child.getBoundingClientRect().right, width: child.getBoundingClientRect().width, client: child.clientWidth, scroll: child.scrollWidth, minWidth: getComputedStyle(child).minWidth, gap: getComputedStyle(child).gap })) : [], scrollable: ['auto', 'scroll'].includes(getComputedStyle(el).overflowX) }));
            const clippedClouds = [...document.querySelectorAll('.survey-word-cloud')].filter(el => visible(el) && el.querySelector('svg')?.getBoundingClientRect().height > el.clientHeight + 2).length;
            const missingTheme = !isHome && !document.querySelector('.pbl-platform-theme');
            const undersizedColumns = [...document.querySelectorAll('.survey-column-chart button')].some(el => visible(el) && el.getBoundingClientRect().width < 44);
            const invisibleSurveyBars = [...document.querySelectorAll('.survey-column-chart button, .survey-bar-chart button')].filter(button => {
              const count = Number((button.getAttribute('aria-label') || '').match(/，(\d+) 人$/)?.[1] || 0);
              if (!visible(button) || count <= 0) return false;
              const column = button.closest('.survey-column-chart');
              const fill = button.querySelector(column ? 'span > i' : 'i > b');
              if (!fill) return true;
              const rect = fill.getBoundingClientRect();
              return column ? rect.height < 3 : rect.width < 3;
            }).length;
            const clippedDialogs = [...document.querySelectorAll('[role=dialog]')].some(el => { if (!visible(el)) return false; const rect = el.getBoundingClientRect(); return rect.top < -1 || rect.bottom > innerHeight + 1 || rect.left < -1 || rect.right > innerWidth + 1; });
            const brokenImages = [...document.images].filter(el => visible(el) && (!el.complete || !el.naturalWidth)).map(el => el.currentSrc || el.src);
            const surveyRail = document.querySelector('.survey-student-rail');
            const compactSurvey = innerWidth <= 1180 && innerHeight > innerWidth || innerWidth <= 1023 && innerHeight <= 600;
            const surveyRailUnexpected = isStudentSurvey && (!surveyRail || visible(surveyRail) === compactSurvey);
            const settingsLayout = document.querySelector('.pbl-settings-layout');
            const settingsLastChild = settingsLayout?.lastElementChild;
            const settingsTrailingSpace = settingsLayout && settingsLastChild && document.documentElement.scrollHeight > innerHeight
              ? Math.max(0, Math.round(document.documentElement.scrollHeight - (settingsLastChild.getBoundingClientRect().bottom + scrollY)))
              : 0;
            const chapterProgressIssues = [...document.querySelectorAll('.pbl-student-chapter-progress-row')].filter(row => {
              if (!visible(row) || row.scrollWidth > row.clientWidth + 1) return visible(row) && row.scrollWidth > row.clientWidth + 1;
              return [...row.children].filter(child => !child.classList.contains('pbl-student-mini-progress')).some(child => {
                const range = document.createRange();
                range.selectNodeContents(child);
                return new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top))).size > 1;
              });
            }).map(row => ({ width: row.clientWidth, scrollWidth: row.scrollWidth, text: row.textContent.trim() }));
            const inviteHeadingIssues = [...document.querySelectorAll('.pbl-student-invite-heading')].filter(heading => {
              if (!visible(heading) || heading.scrollWidth > heading.clientWidth + 1) return visible(heading) && heading.scrollWidth > heading.clientWidth + 1;
              return [...heading.children].some(child => {
                const tops = [];
                for (const node of child.childNodes) {
                  if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
                  const range = document.createRange();
                  range.selectNodeContents(node);
                  tops.push(...[...range.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top)));
                }
                return new Set(tops).size > 1;
              });
            }).map(heading => ({ width: heading.clientWidth, scrollWidth: heading.scrollWidth, text: heading.textContent.trim() }));
            const headings = [...document.querySelectorAll('h1,h2,h3,.pbl-course-chapter-title,.survey-question-title')].filter(visible).map(el => {
              const css = getComputedStyle(el), rect = el.getBoundingClientRect();
              const range = document.createRange(); range.selectNodeContents(el);
              const lines = new Set([...range.getClientRects()].filter(r => r.width > 0).map(r => Math.round(r.top))).size;
              const intentionalTruncation = css.textOverflow === 'ellipsis' || Number(css.webkitLineClamp) > 0;
              return { text: el.textContent.trim().slice(0, 160), width: Math.round(rect.width), lines, fontSize: parseFloat(css.fontSize), overflow: !intentionalTruncation && el.scrollWidth > el.clientWidth + 2, unusuallyNarrow: el.textContent.trim().length >= 8 && rect.width < parseFloat(css.fontSize) * 4 && lines >= 3 };
            });
            return { scrollWidth: document.documentElement.scrollWidth, width: innerWidth, boxes, chapterProgressIssues, inviteHeadingIssues, clippedClouds, missingTheme, undersizedColumns, invisibleSurveyBars, clippedDialogs, brokenImages, surveyRailUnexpected, settingsTrailingSpace, headings, textIssues: headings.filter(h => h.overflow || h.unusuallyNarrow), touch: navigator.maxTouchPoints, userAgent: navigator.userAgent, imageCount: document.images.length, resources: performance.getEntriesByType('resource').map(r => ({ url: r.name, durationMs: Math.round(r.duration), bytes: r.transferSize, type: r.initiatorType })) };
          }, { isHome: id === 'home', isStudentSurvey: id === 'student-survey' });
          report = { ...report, ...metrics };
        } catch (error) {
          report.scenarioError = error.message;
          report.visibleText = (await page.locator('body').innerText().catch(() => '')).slice(0, 500);
        }
        report.durationMs = Date.now() - started;
        report.failed = Boolean(isFailure(report));
        if (process.env.LAYOUT_CAPTURE_ALL === '1' || report.failed || ['phone-portrait', 'phone-landscape', 'pad-portrait', 'pad-landscape', 'desktop-1440x900'].includes(device)) {
          report.screenshot = path.join(output, `${browserName}-${id}-${device}-dpr${dpr}.png`);
          await page.screenshot({ path: report.screenshot }).catch(error => errors.push(`Screenshot: ${error.message}`));
        }
        report.trace = report.failed ? path.join(output, `${browserName}-${id}-${device}-dpr${dpr}.zip`) : undefined;
        await context.tracing.stop(report.trace ? { path: report.trace } : undefined);
        reports.push(report);
        fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ baseURL, browser: browserName, browserVersion: browser.version(), dpr, sourceCss: process.argv.includes('--source-css'), reports }, null, 2));
        await page.close();
      }
      await context.close();
      console.log(`checked ${device}: ${selectedScenarios.length} scenarios`);
    }
  } finally {
    await browser.close();
  }
  const failures = reports.filter(isFailure);
  const summary = { output, browser: browserName, browserVersion: browser.version(), dpr, scenarios: selectedScenarios.length, devices: selectedProfiles.length, checks: reports.length, failures: failures.length, failedChecks: failures.map(r => `${r.id}@${r.device}`) };
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (process.argv.includes('--assert') && failures.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exit(1); });
