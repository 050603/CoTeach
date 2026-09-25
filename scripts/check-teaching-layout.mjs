// Internal teaching UI audit using browser-only fixtures. No business API or
// WebSocket reaches the server; only compiled pages and static runtime assets do.
// Run after building: node scripts/check-teaching-layout.mjs [--assert]
// Filters: TEACHING_SCENARIOS=preparation,code,player TEACHING_DEVICES=phone-portrait
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, firefox, webkit } from '@playwright/test';
import { SignJWT } from 'jose';

const baseURL = process.env.LAYOUT_BASE_URL || 'http://127.0.0.1:3000';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) throw new Error('Only local instances are supported');
const browserName = process.env.TEACHING_BROWSER || 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(browserName)) throw new Error('TEACHING_BROWSER must be chromium, firefox or webkit');
const dpr = Number(process.env.TEACHING_DPR || 1);
if (!Number.isFinite(dpr) || dpr < 1 || dpr > 3) throw new Error('TEACHING_DPR must be between 1 and 3');
const health = await fetch(`${baseURL}/api/health/live`, { signal: AbortSignal.timeout(5000) });
if (!health.ok) throw new Error(`Local service is not ready (${health.status})`);
const output = process.env.TEACHING_OUTPUT_DIR ? path.resolve(process.env.TEACHING_OUTPUT_DIR) : fs.mkdtempSync(path.join(os.tmpdir(), 'openpbl-teaching-'));
fs.mkdirSync(output, { recursive: true });
const title = '社区生态调查与跨学科项目实践：从真实问题到有证据支持的行动方案';
const stages = [
  { key: 'launch', label: '项目启动', view: 'simple-resource' },
  { key: 'ai-learning', label: '知识讲授', view: 'ai-learning' },
  { key: 'make', label: '项目实践', view: 'ai-collaboration' },
  { key: 'showcase', label: '成果汇报与评价', view: 'showcase-reporting' },
  { key: 'reflection', label: '学习反思', view: 'reflection-survey' },
];
const scene = {
  id: 'layout-scene', type: 'slide', title: '如何开展社区生态调查', order: 0, actions: [], stageKey: 'ai-learning', audience: 'student', generationPurpose: 'knowledge-teaching',
  content: { type: 'slide', canvas: { id: 'layout-slide', viewportSize: 1000, viewportRatio: 0.5625, theme: { backgroundColor: '#ffffff', themeColors: ['#344A6A'], fontColor: '#1F2933', fontName: 'Noto Sans SC' }, background: { type: 'solid', color: '#ffffff' }, elements: [
    { id: 'title', type: 'text', left: 48, top: 50, width: 860, height: 80, rotate: 0, defaultFontName: 'Noto Sans SC', defaultColor: '#1F2933', content: '<p style="font-size:36px">如何开展社区生态调查</p>' },
    { id: 'body', type: 'text', left: 48, top: 155, width: 780, height: 180, rotate: 0, defaultFontName: 'Noto Sans SC', defaultColor: '#1F2933', content: '<p style="font-size:24px">观察真实社区，记录环境变化，分析证据并形成可实践的行动方案。</p>' },
    { id: 'image', type: 'image', src: '/brand/coteach/horizontal-color.png', left: 48, top: 385, width: 240, height: 70, rotate: 0, fixedRatio: true },
  ] } },
};
const fixtureCourse = {
  id: 'layout-teaching', name: title, subject: '跨学科科学', grade: '初中', hours: 3,
  status: 'teaching', systemMode: 'new', generationMode: 'detailed',
  summary: '以真实社区为研究对象，通过观察记录与团队讨论形成有证据支持的方案。', drivingQuestion: '我们如何通过生态调查改善社区环境？',
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', stages, currentStageIndex: 0,
  content: { pblOutline: '开展社区调查', knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: '基于证据开展分析' }, sceneOutlines: [{ id: scene.id, type: 'slide', title: scene.title, description: '课堂说明', keyPoints: [], order: 0, estimatedDuration: 60 }] },
  students: [{ id: 'layout-student', name: '布局测试学生', joinedAt: '2026-09-01T00:00:00Z', stageProgress: {} }],
  resources: [], groups: [], submissions: [], activityLog: [], uiState: {},
  aiLearningClassroomId: 'layout-player', pblConfig: { makeArtifactMode: 'python' },
};
const profiles = [
  ['desktop-split', 768, 576, false], ['desktop-laptop', 1024, 576, false], ['desktop', 1440, 900, false], ['desktop-4k', 3840, 2160, false], ['pad-portrait', 768, 1024, true], ['pad-landscape', 1024, 768, true],
  ['phone-portrait', 390, 844, true], ['phone-landscape', 844, 390, true], ['phone-small', 320, 568, true], ['phone-small-landscape', 568, 320, true],
];
const scenarios = [
  ['student-player', '/student/classroom/layout-teaching', '[aria-label="AI 授课字幕与播放控制"]', async page => {
    const close = page.getByRole('button', { name: '收起页面目录' });
    if ((page.viewportSize()?.width ?? 0) <= 1023) {
      await close.waitFor({ state: 'hidden', timeout: 5000 });
      await page.getByRole('button', { name: '打开页面目录' }).waitFor();
    }
    else if (await close.isVisible()) await close.click();
  }],
  ['student-standalone-player', '/student/ai-learning/layout-player?courseId=layout-teaching', '[aria-label="AI 授课字幕与播放控制"]', async () => {}],
  ['teacher-classroom', '/teacher/teach/layout-teaching/classroom', 'button[aria-label="在线学生"]', async page => {
    await page.getByRole('button', { name: '在线学生', exact: true }).filter({ visible: true }).click();
    await page.getByText('0 在线 / 12 总数', { exact: true }).filter({ visible: true }).waitFor();
  }],
  ['quick-preparation', '/teacher/prepare/layout-teaching/verify', 'text=课程资料导入', async () => {}],
  ['generate-redirect', '/teacher/prepare/layout-teaching/generate', 'text=课程资料导入', async page => { await page.waitForURL('**/teacher/prepare/layout-teaching/verify'); }],
  ['resources-empty', '/teacher/prepare/layout-teaching/resources', 'h1', async page => { await page.getByText('暂无教师授课资源。').waitFor(); }],
  ['preparation', '/teacher/prepare/layout-teaching/verify/edit', '[aria-label="课程设计环节"]', async page => {
    const picker = page.getByRole('combobox', { name: '当前设计环节' });
    if (await picker.isVisible()) { await picker.selectOption('stage-plan'); await picker.selectOption('materials'); }
    else { const steps = page.locator('[aria-label="课程设计环节"] button'); await steps.nth(1).click(); await steps.nth(0).click(); }
  }],
  ['dashboard-popover', '/student/classroom/layout-teaching', 'button[aria-label="个人信息"]', async page => {
    await page.getByRole('button', { name: '个人信息', exact: true }).click();
    await page.getByText('当前身份：学生端').waitFor();
  }],
  ['code', '/student/ai-collaboration/layout-teaching', '.monaco-editor', async page => {
    await page.getByRole('button', { name: '新建代码文件', exact: true }).click();
    await page.getByRole('textbox', { name: '新文件名' }).fill('community_analysis.py');
    await page.getByRole('button', { name: '取消新建' }).click();
    await page.getByRole('button', { name: 'AI 组员', exact: true }).click();
    await page.locator('[class*="memberPanel"]').waitFor();
  }],
  ['player', '/teacher/prepare/layout-teaching/preview', '[role="tablist"]', async page => {
    await page.getByRole('tab', { name: '学生课堂预览' }).click();
    await page.locator('[data-testid="scene-list"]').waitFor({ state: 'attached' });
    const close = page.getByRole('button', { name: '收起页面目录' });
    if ((page.viewportSize()?.width ?? 0) <= 1023) {
      await close.waitFor({ state: 'hidden', timeout: 5000 });
      await page.getByRole('button', { name: '打开页面目录' }).waitFor();
    }
    else if (await close.isVisible()) await close.click();
  }],
];
const select = (items, env) => env ? items.filter(([id]) => env.split(',').includes(id)) : items;
const secret = process.env.LAYOUT_JWT_SECRET || fs.readFileSync(process.env.LAYOUT_JWT_SECRET_FILE || 'deploy/secrets/jwt_secret.txt', 'utf8').trim();
const cookies = await Promise.all(['teacher', 'student'].map(async role => ({
  name: `openpbl_${role}`, url: baseURL,
  value: await new SignJWT({ role, sv: 1, username: 'layout', displayName: '布局测试', userId: `layout-${role}`, studentName: '布局测试' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(`layout-${role}`).setIssuer('openpbl').setAudience('openpbl-app').setExpirationTime('1h').sign(new TextEncoder().encode(secret)),
})));
const browser = await ({ chromium, firefox, webkit })[browserName].launch();
const reports = [];
try {
  for (const [device, width, height, touch] of select(profiles, process.env.TEACHING_DEVICES)) {
    for (const [id, route, ready, exercise] of select(scenarios, process.env.TEACHING_SCENARIOS)) {
      const context = await browser.newContext({ viewport: { width, height }, ...(browserName === 'firefox' ? {} : { isMobile: touch && width < 1024 }), hasTouch: touch, deviceScaleFactor: dpr });
      await context.addCookies(cookies);
      await context.routeWebSocket('**/*', ws => ws.close());
      const page = await context.newPage();
      await context.tracing.start({ screenshots: true, snapshots: true });
      page.setDefaultTimeout(20000);
      const errors = [], missingFixtures = [], failedResources = [], interceptedWrites = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', response => { if (response.status() >= 400 && /\.(?:png|jpg|webp|woff2?|css|js)(?:\?|$)/.test(response.url())) failedResources.push(`${response.status()} ${response.url()}`); });
      const role = route.startsWith('/teacher') ? 'teacher' : 'student';
      const course = structuredClone(fixtureCourse);
      if (id === 'teacher-classroom') course.students = Array.from({ length: 12 }, (_, index) => ({ ...course.students[0], id: `layout-student-${index}`, name: `跨学科项目测试学生${index + 1}` }));
      if (id === 'code') course.currentStageIndex = 2;
      if (id === 'student-player' || id === 'student-standalone-player') course.currentStageIndex = 1;
      const state = { courses: [course], hydrated: true, user: { role, name: '布局测试' }, studentId: 'layout-student', studentName: '布局测试学生', joinedCourseId: course.id };
      await context.route('**/api/**', async intercepted => {
        const request = intercepted.request(), pathname = new URL(request.url()).pathname;
        if (request.method() === 'GET' && pathname.startsWith('/api/openmaic/interactive-runtime/')) return intercepted.continue();
        let body;
        if (pathname === '/api/courses') body = state;
        else if (pathname === '/api/auth/me') body = { user: { id: `layout-${role}`, role, displayName: '布局测试', username: 'layout' } };
        else if (pathname.endsWith('/presence')) body = { members: [] };
        else if (pathname.endsWith('/events')) body = { events: [], nextCursor: 0 };
        else if (pathname.endsWith('/state')) body = { course, eventCursor: '0' };
        else if (pathname.endsWith('/projection')) body = { courseId: course.id, courseVersion: 0, projectionVersion: 0, projectionUpdatedAt: course.updatedAt, serverTime: new Date().toISOString() };
        else if (pathname.endsWith('/public-discussion')) body = { enabled: false, session: null };
        else if (pathname.endsWith('/design-workspace')) body = { course, sections: [], statuses: Object.fromEntries(['materials', 'stage-plan', 'knowledge', 'timing', 'blueprint', 'classroom'].map(key => [key, 'missing'])), pendingUpdates: [], publication: { latestVersion: null, publishedVersion: null, draftVersion: null }, jobs: { design: null, classroom: null } };
        else if (pathname.endsWith('/actions')) body = { state, course, success: true };
        else if (pathname.endsWith('/design-generation')) body = { job: null };
        else if (pathname.endsWith('/generation')) body = { backgroundEnabled: false, job: null };
        else if (pathname.endsWith('/resource-repair')) body = { issues: [] };
        else if (pathname === '/api/ai-collaboration/code') body = { messages: [], commentThreads: [], starters: [] };
        else if (pathname === '/api/ai-collaboration/memory') body = { memories: [], continuation: null };
        else if (pathname === '/api/openmaic/classroom') body = { success: true, classroom: { stage: { id: 'layout-player', name: title, createdAt: 1, updatedAt: 1 }, scenes: [scene] } };
        else if (pathname === '/api/openmaic/progress') body = { data: { progress: {} } };
        else if (pathname === '/api/textbooks') body = { items: [] };
        else if (pathname.endsWith('/resource-package')) body = { job: null };
        else if (/provider|server-providers/.test(pathname)) body = { providers: [], models: [], success: true };
        else if (pathname.includes('learning-events') || pathname.includes('learning-analytics') || pathname.includes('/learning/')) body = { success: true };
        else { if (!missingFixtures.includes(pathname)) missingFixtures.push(pathname); body = {}; }
        if (!['GET', 'HEAD'].includes(request.method())) interceptedWrites.push(pathname);
        await intercepted.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      });
      const report = { id, device, browser: browserName, dpr, width, height, sourceCss: process.argv.includes('--source-css'), errors, missingFixtures, failedResources, interceptedWrites };
      try {
        await page.goto(baseURL + route, { waitUntil: 'load' });
        await page.locator(ready).filter({ visible: true }).first().waitFor();
        await exercise(page);
        if (process.argv.includes('--source-css')) {
          await page.evaluate(() => {
            document.querySelector('main > .pbl-wide-container')?.classList.add('teaching-audit-viewport');
            for (const panel of document.querySelectorAll('.pbl-glass')) {
              if (panel.textContent.includes('在线学生')) {
                panel.style.maxHeight = innerWidth < 768 ? 'calc(100dvh - 6rem)' : 'calc(100dvh - 5rem)';
                panel.style.overflowY = 'auto';
              }
            }
            const switcher = document.querySelector('header button:has(.lucide-graduation-cap)');
            if (switcher) {
              switcher.classList.add('teaching-audit-switcher');
              switcher.children[0]?.classList.add('teaching-audit-switcher-icon');
              switcher.children[2]?.classList.add('teaching-audit-switcher-status');
            } else if ([...document.querySelectorAll('header button')].some(el => el.textContent.includes('离开课堂'))) {
              [...document.querySelectorAll('header p')].find(el => el.getAttribute('title'))?.parentElement?.classList.add('teaching-audit-identity');
            }
            const preview = document.querySelector('[data-stage-host-mode="teacher-preview"]');
            if (preview) {
              const h1 = document.querySelector('main header h1');
              const row = h1?.parentElement?.parentElement;
              row?.classList.add('teaching-audit-preview-grid');
              h1?.classList.add('teaching-audit-preview-title');
              row?.lastElementChild?.classList.add('teaching-audit-preview-actions');
            }

            const dock = document.querySelector('[aria-label="AI 授课字幕与播放控制"]');
            const grid = dock?.closest('[class*="xl:grid-cols-"]');
            if (grid) {
              grid.classList.add('teaching-audit-grid');
              [...grid.children].find(el => el.contains(dock))?.classList.add('teaching-audit-rail');
              dock.classList.add('teaching-audit-dock');
            }
          });
          await page.addStyleTag({ content:
            fs.readFileSync('src/components/openmaic/edit/playback-responsive.module.css', 'utf8').replaceAll('.landscapeGrid', '.teaching-audit-grid').replaceAll('.landscapeRail', '.teaching-audit-rail')
            + fs.readFileSync('src/components/openmaic/roundtable/lecture-subtitle-dock.module.css', 'utf8').replaceAll('.dock', '.teaching-audit-dock')
            + `
              .teaching-audit-switcher{width:100%;gap:.5rem;padding-inline:.5rem}
              @media(min-width:1024px){.teaching-audit-switcher{gap:.75rem;padding-inline:1rem}}
              @media(max-width:1279px){.teaching-audit-switcher-status{display:none}}
              @media(max-width:1023px){.teaching-audit-viewport{max-width:100%!important}.teaching-audit-switcher-icon{display:none}[data-stage-host-mode="teacher-preview"]{min-height:520px}}
              @media(min-width:768px) and (max-width:1023px){.teaching-audit-identity{display:block}}
              @media(max-width:639px){.teaching-audit-preview-grid{display:grid;grid-template-columns:auto minmax(0,1fr)}.teaching-audit-preview-actions{grid-column:span 2}.teaching-audit-preview-title{font-size:20px;line-height:1.375;white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:break-word}}
            `
          });
        }

        if (id === 'teacher-classroom') {
          const lastStudent = page.getByText('跨学科项目测试学生12', { exact: true }).filter({ visible: true });
          await lastStudent.scrollIntoViewIfNeeded();
          if (!await lastStudent.evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })) throw new Error('The final student is outside the visible viewport');
        }
        await page.evaluate(async () => {
          await document.fonts.ready;
          for (const img of document.images) img.loading = 'eager';
          await Promise.all([...document.images].map(img => Promise.race([img.decode().catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000))])));
        });
        await page.waitForTimeout(250);
        Object.assign(report, await page.evaluate(() => {
          const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
          const panels = [...document.querySelectorAll('[class*="memberPanel"],.pbl-glass,[role=dialog]')].filter(visible).map(el => {
            const r = el.getBoundingClientRect(); return { className: String(el.className), left: r.left, right: r.right, top: r.top, bottom: r.bottom, clipped: r.left < -1 || r.right > innerWidth + 1 || r.top < -1 || r.bottom > innerHeight + 1 };
          });
          const headingIssues = [...document.querySelectorAll('h1,h2,h3')].filter(visible).filter(el => {
            const style = getComputedStyle(el), width = el.getBoundingClientRect().width;
            return (style.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 2) || (el.textContent.trim().length >= 8 && width < parseFloat(style.fontSize) * 4);
          }).map(el => el.textContent.slice(0, 100));
          const controlIssues = [...document.querySelectorAll('[data-subtitle-controls] button')].filter(visible).filter(el => {
            const r = el.getBoundingClientRect(), dock = el.closest('[aria-label="AI 授课字幕与播放控制"]').getBoundingClientRect();
            return el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2 || r.right > dock.right + 1 || r.left < dock.left - 1 || r.bottom > dock.bottom + 1;
          }).map(el => el.getAttribute('aria-label') || el.textContent.trim());
          const canvasBoxes = [...document.querySelectorAll('[class~="group/canvas"]')].filter(visible).map(el => {
            const r = el.getBoundingClientRect(); return { width: r.width, height: r.height };
          });
          const narrowText = [...document.querySelectorAll('main p,main h1,main h2,main h3')].filter(visible).filter(el => {
            if (el.closest('[class~="group/canvas"], [data-testid="scene-list"]')) return false;
            const style = getComputedStyle(el), r = el.getBoundingClientRect();
            return el.textContent.trim().length >= 8 && style.textOverflow !== 'ellipsis' && r.width < parseFloat(style.fontSize) * 4 && r.height > parseFloat(style.fontSize) * 3;
          }).map(el => el.textContent.slice(0, 100));
          return { scrollWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, panels, headingIssues, narrowText, canvasBoxes, controlIssues, brokenImages: [...document.images].filter(img => visible(img) && (!img.complete || !img.naturalWidth)).map(img => img.src) };
        }));
      } catch (error) { report.scenarioError = error.message; report.body = (await page.locator('body').innerText({ timeout: 3000 }).catch(() => 'Page text unavailable')).slice(0, 800); }
      report.failed = !!(report.scenarioError || errors.length || missingFixtures.length || failedResources.length || report.scrollWidth > width + 2 || report.panels?.some(panel => panel.clipped) || report.headingIssues?.length || report.narrowText?.length || report.controlIssues?.length || report.canvasBoxes?.some(box => box.height < 120 || box.width < 200) || report.brokenImages?.length);
      report.screenshot = path.join(output, `${browserName}-${id}-${device}-dpr${dpr}.png`);
      await page.screenshot({ path: report.screenshot });
      report.trace = report.failed ? path.join(output, `${browserName}-${id}-${device}-dpr${dpr}.zip`) : undefined;
      await context.tracing.stop(report.trace ? { path: report.trace } : undefined);
      reports.push(report);
      fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(reports, null, 2));
      console.log(`${report.failed ? 'FAIL' : 'PASS'} ${id}@${device}`);
      await context.close();
    }
  }
} finally { await browser.close(); }
const summary = { output, browser: browserName, browserVersion: browser.version(), dpr, checks: reports.length, failures: reports.filter(r => r.failed).length, failedChecks: reports.filter(r => r.failed).map(r => `${r.id}@${r.device}`) };
fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
if (process.argv.includes('--assert') && reports.some(report => report.failed)) process.exitCode = 1;
