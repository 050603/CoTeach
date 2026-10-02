/** Real student UI with browser-only fixtures. Uses an existing participation,
 * signs a short-lived session, reads the course/classroom, and intercepts every
 * non-GET request. It never creates an account, changes a course, or makes audio.
 * Run after the production build has been deployed to port 3000.
 * --prepare-only checks actual production scene assembly offline, without DB,
 * browser, model, narration, or audio calls. Legacy eight-sample defaults remain.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';
import { chromium } from '@playwright/test';
import { require as tsxRequire } from 'tsx/cjs/api';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const root = process.cwd();
// The workspace generation package exposes its ESM entry under `import`.
// Load the real TS scene builder through tsx, while preserving the old `node`
// command by adding that Node condition before any data or credential read.
if (!process.execArgv.includes('--conditions=import') && !/(?:^|\s)--conditions=import(?:\s|$)/u.test(process.env.NODE_OPTIONS ?? '')) {
  const child = spawn(process.execPath, ['--conditions=import', ...process.execArgv, fileURLToPath(import.meta.url), ...args], { stdio: 'inherit', cwd: root });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code) => resolve(code ?? 1)); });
  process.exit(code);
}
const probeOnly = args.includes('--probe');
const prepareOnly = args.includes('--prepare-only');
const origin = new URL(option('--base-url', 'http://127.0.0.1:3000')).origin;
const input = path.resolve(option('--input', '.openpbl-runtime/teaching-visuals/samples-20261002-v11'));
const output = path.resolve(option('--output', path.join(input, prepareOnly ? 'student-fixtures-preparation' : probeOnly ? 'student-browser-probe' : 'student-browser')));
const json = async (filename) => JSON.parse(await readFile(filename, 'utf8'));
const sha256 = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const summary = await json(path.join(input, 'summary.json'));
const source = await json(path.join(input, 'source-snapshot', 'snapshot.json'));
const requestedInstance = option('--course-id');
const requestedStudent = option('--student-id');
const requestedIds = option('--ids')?.split(',');
const includeContinuations = args.includes('--include-continuations');
const expectedCases = Number(option('--expected-cases', '8'));
const cases = await Promise.all(summary.reports.filter((item) => requestedIds
  ? requestedIds.includes(item.id) || requestedIds.includes(item.caseId) : item.sample).map(async (item) => {
  const [result, originalInput] = await Promise.all([json(path.join(input, 'results', `${item.id}.json`)), json(path.join(input, 'attempts', item.id, 'input.json'))]);
  assert.ok(originalInput.target?.outline, `缺少原教学大纲：${item.id}`);
  return { ...result, outline: originalInput.target.outline };
}));
assert.equal(cases.length, expectedCases, '实际加载的验证案例数量与明确期望不同');
assert.ok(cases.every((item) => item.final?.elements?.length), '验证案例包含真实未生成结果，不能静默跳过');
const samples = cases.flatMap((item) => (includeContinuations ? [item.final, ...(item.final.continuationPages ?? [])] : [item.final])
  .map((content, index) => ({ ...item, id: index ? `${item.id}:continuation-${index + 1}` : item.id,
    final: { ...content, continuationPages: undefined }, parentCaseId: item.caseId, generatedPageIndex: index })));
const { buildCompleteScene } = tsxRequire('../src/lib/openmaic/generation/scene-builder.ts', import.meta.url);
const assemblyReports = [];
function assembleScenes(classroomId) {
  return samples.map((sample, index) => {
    const visualPage = sample.final.teachingVisual?.scene.pages.find((item) => item.id === sample.final.teachingVisual.pageId);
    const outline = { ...sample.outline, title: visualPage?.title ?? sample.source.title, order: index,
      stageKey: 'ai-learning', audience: 'student', generationPurpose: 'knowledge-teaching', detailKind: 'teaching' };
    const scene = buildCompleteScene(outline, sample.final, [], classroomId);
    assert.ok(scene?.content.type === 'slide', `生产场景装配没有输出幻灯片：${sample.id}`);
    assert.deepEqual(scene.content.canvas.elements, sample.final.elements, '生产装配不得改变已生成元素');
    scene.id = `student-visual:${sample.id}`;
    scene.content.canvas.id = sample.id;
    scene.createdAt = 0; scene.updatedAt = 0;
    assemblyReports.push({ sampleId: sample.id, caseId: sample.parentCaseId, generatedPageIndex: sample.generatedPageIndex,
      method: 'buildCompleteScene', defaultThemeApplied: !sample.final.theme, nativeElementsUnchanged: true,
      routeFixture: 'ai-learning/student/knowledge-teaching/teaching', audioActions: [] });
    return scene;
  });
}
await mkdir(output, { recursive: true });
const sourceBuilderSha256 = createHash('sha256').update(await readFile(path.join(root, 'src/lib/openmaic/generation/scene-builder.ts'))).digest('hex');
if (prepareOnly) {
  const scenes = assembleScenes(path.basename(source.classroomFile, '.json'));
  await writeFile(path.join(output, 'prepared-scenes.json'), JSON.stringify(scenes, null, 2));
  const preparation = { mode: 'prepare-only', expectedCases, includeContinuations, preparedPages: scenes.length,
    sourceBuilderSha256, assemblyReports, providerCalls: 0, narrationCalls: 0, audioCalls: 0, dbReads: 0, dbWrites: 0,
    courseWrites: 0, browserLaunched: false, fullStudentScreenReview: 'not-run' };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(preparation, null, 2));
  console.log(JSON.stringify(preparation));
  process.exit(0);
}
const databaseUrl = process.env.DATABASE_URL ?? (await readFile(path.join(root, 'deploy/secrets/database_url.txt'), 'utf8')).trim();
const secret = process.env.JWT_SECRET ?? (await readFile(path.join(root, 'deploy/secrets/jwt_secret.txt'), 'utf8')).trim();
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
let browser;
const report = {
  method: '生产 /student/ai-learning 页面 → AdaptiveAiLearningRuntime → StudentStageHost(student) → 原生 ScreenCanvas；浏览器隔离样板',
  productionOrigin: origin,
  input,
  sourceScope: summary.sourceScope,
  fullStudentScreenReview: 'not-run',
  staticRenderingOnly: true,
  probeOnly,
  sourceBuilderSha256,
  sceneAssemblyReports: assemblyReports,
  audioPlaybackReview: 'not-run',
  beautyReview: 'pending',
  dbWrites: 0,
  courseWrites: 0,
  audioGenerationCalls: 0,
  mutationsSentToServer: 0,
  blockedMutations: [],
  interceptedReads: [],
  unexpectedRequests: [],
  isolatedWebSockets: [],
  pageErrors: [],
  failedResources: [],
  screenshots: [],
};

async function launchBrowser() {
  let lastError;
  for (const executablePath of [...new Set([process.env.OPENPBL_CHROMIUM_EXECUTABLE_PATH, undefined, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'])]) {
    if (executablePath && !await access(executablePath).then(() => true, () => false)) continue;
    try {
      return await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    } catch (error) { lastError = error; }
  }
  throw lastError ?? new Error('缺少 Chromium');
}

async function readJson(context, endpoint) {
  const response = await context.request.get(new URL(endpoint, origin).toString(), {
    headers: { 'X-OpenPBL-Role': 'student' },
  });
  assert.equal(response.status(), 200, `只读请求失败：${endpoint.split('?')[0]}`);
  return response.json();
}

// Kept inside the browser: DOM measurements reflect the actual player scale,
// available screen space, native chart labels, and the player's own overlays.
function inspectStudentSlide(expected) {
  const host = document.querySelector('[data-stage-host-mode="student"]');
  if (!host) throw new Error('真实学生 StageHost 未挂载');
  const wrapper = host.querySelector('[data-slide-element-id]');
  const canvas = wrapper?.parentElement;
  if (!canvas) throw new Error('真实学生 ScreenCanvas 未挂载');
  const bounds = canvas.getBoundingClientRect();
  const scale = bounds.width / 1000;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const rect = (value) => ({ left: value.left, top: value.top, width: value.width, height: value.height });
  const outside = (value, box, tolerance = 2) => value.left < box.left - tolerance || value.top < box.top - tolerance
    || value.right > box.right + tolerance || value.bottom > box.bottom + tolerance;
  const screen = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  const fontSizes = [];
  const issues = [];
  const elements = expected.elements.map((element) => {
    const node = [...canvas.querySelectorAll('[data-slide-element-id]')].find((item) => item.dataset.slideElementId === element.id);
    if (!node) {
      issues.push({ code: 'missing-element', elementId: element.id, type: element.type });
      return { id: element.id, type: element.type, missing: true };
    }
    const visual = node.querySelector('[class*="base-element-"]');
    const box = (visual ?? node).getBoundingClientRect();
    const textRoots = [...node.querySelectorAll('.ProseMirror-static, [data-slide-cell-id]')]
      .filter((root) => !root.parentElement?.closest('.ProseMirror-static, [data-slide-cell-id]'));
    const glyphs = [];
    const sizes = [];
    const families = new Set();
    for (const textRoot of textRoots) {
      const textBox = textRoot.matches('[data-slide-cell-id]') ? textRoot.getBoundingClientRect() : box;
      const walker = document.createTreeWalker(textRoot, NodeFilter.SHOW_TEXT);
      let text;
      while ((text = walker.nextNode())) {
        if (!text.textContent?.trim()) continue;
        const style = getComputedStyle(text.parentElement);
        const range = document.createRange();
        range.selectNodeContents(text);
        const ranges = [...range.getClientRects()].filter((item) => item.width > 0 && item.height > 0);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || !ranges.length) {
          issues.push({ code: 'invisible-text', elementId: element.id, text: text.textContent });
        }
        for (const value of ranges) {
          glyphs.push(value);
          if (outside(value, bounds)) issues.push({ code: 'canvas-overflow', elementId: element.id, text: text.textContent });
          if (outside(value, screen)) issues.push({ code: 'viewport-overflow', elementId: element.id, text: text.textContent });
          if (outside(value, textBox, 6 * scale)) issues.push({ code: 'text-box-overflow', elementId: element.id, text: text.textContent });
        }
        const size = Number.parseFloat(style.fontSize);
        if (Number.isFinite(size)) { sizes.push(size); fontSizes.push(size); }
        families.add(style.fontFamily);
      }
    }
    const chartText = [...node.querySelectorAll('svg text')].map((text) => {
      const style = getComputedStyle(text);
      const size = Number.parseFloat(style.fontSize);
      const value = text.getBoundingClientRect();
      if (text.textContent?.trim() && Number.isFinite(size)) fontSizes.push(size);
      if (outside(value, bounds)) issues.push({ code: 'chart-canvas-overflow', elementId: element.id, text: text.textContent });
      if (outside(value, screen)) issues.push({ code: 'chart-viewport-overflow', elementId: element.id, text: text.textContent });
      return { text: text.textContent, fontSize: size, displayedFontPx: size * scale, fontFamily: style.fontFamily };
    });
    if (element.type === 'chart') {
      for (const label of element.data.labels) {
        if (!chartText.some((text) => text.text === String(label))) issues.push({ code: 'missing-chart-category', elementId: element.id, label });
      }
      for (const value of element.data.series.flat()) {
        if (!chartText.some((text) => text.text === String(value))) issues.push({ code: 'missing-chart-value', elementId: element.id, value });
      }
    }
    if (element.type === 'table') {
      for (const cell of element.data.flat().filter((cell) => cell.colspan > 0 && cell.rowspan > 0)) {
        const rendered = [...node.querySelectorAll('[data-slide-cell-id]')].find((item) => item.dataset.slideCellId === cell.id);
        const html = document.createElement('div');
        html.innerHTML = cell.text;
        const normalize = (value) => (value ?? '').replace(/\s+/gu, ' ').trim();
        if (!rendered || normalize(rendered.textContent) !== normalize(html.textContent)) {
          issues.push({ code: 'missing-table-cell-text', elementId: element.id, cellId: cell.id, text: html.textContent });
        }
      }
    }
    const images = [...node.querySelectorAll('img')];
    if (element.type === 'image' && (!images.length || images.some((image) => !image.complete || !image.naturalWidth))) {
      issues.push({ code: 'missing-image', elementId: element.id });
    }
    return { id: element.id, type: element.type, text: textRoots.map((textRoot) => textRoot.textContent).join('\n'), box: rect(box),
      glyphs: glyphs.map(rect), fontSizes: sizes, fontFamilies: [...families], chartText,
      displayedFontPx: sizes.length ? Math.min(...sizes) * scale : undefined,
      imageLoaded: element.type === 'image' ? images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0) : undefined };
  });
  const playHint = host.querySelector('[data-canvas-play-hint] .cursor-pointer');
  const hintBounds = playHint?.getBoundingClientRect();
  const playHintGlyphIntersections = hintBounds ? elements.flatMap((element) => (element.glyphs ?? []).filter((glyph) =>
    glyph.left < hintBounds.right && glyph.left + glyph.width > hintBounds.left
    && glyph.top < hintBounds.bottom && glyph.top + glyph.height > hintBounds.top
  ).map(() => ({ elementId: element.id, text: element.text }))) : [];
  const playHintObjectIntersections = hintBounds ? elements.flatMap((element, index) => {
    const definition = expected.elements[index];
    if (!['shape', 'image', 'chart', 'line'].includes(element.type) || (definition.opacity ?? 1) <= 0.05 || !element.box) return [];
    const box = element.box;
    const width = Math.max(0, Math.min(box.left + box.width, hintBounds.right) - Math.max(box.left, hintBounds.left));
    const height = Math.max(0, Math.min(box.top + box.height, hintBounds.bottom) - Math.max(box.top, hintBounds.top));
    return width * height > 1 ? [{ elementId: element.id, type: element.type, intersectionArea: width * height }] : [];
  }) : [];
  const fontIssues = fontSizes.filter((size) => size < 18 - 0.01);
  if (fontIssues.length) issues.push({ code: 'canvas-font-below-18', sizes: fontIssues });
  const canvasFullyVisible = !outside(bounds, screen);
  if (!canvasFullyVisible) issues.push({ code: 'canvas-not-fully-visible', bounds: rect(bounds) });
  const horizontalPageOverflow = document.documentElement.scrollWidth > window.innerWidth + 2;
  if (horizontalPageOverflow) issues.push({ code: 'page-horizontal-overflow' });
  return { viewport, sceneId: host.dataset.activeSceneId, canvas: rect(bounds), scale, canvasFullyVisible,
    horizontalPageOverflow, elements, issues, minimumCanvasFontPx: fontSizes.length ? Math.min(...fontSizes) : undefined,
    minimumDisplayedFontPx: fontSizes.length ? Math.min(...fontSizes) * scale : undefined,
    playHint: hintBounds ? { bounds: rect(hintBounds), glyphIntersections: playHintGlyphIntersections, objectIntersections: playHintObjectIntersections } : undefined,
    playerControlLabels: [...host.querySelectorAll('button[aria-label]')].filter((button) => button.getBoundingClientRect().width > 0)
      .map((button) => button.getAttribute('aria-label')) };
}

try {
  const participation = await db.classroomParticipation.findFirst({
    where: {
      ...(requestedInstance ? { instanceId: requestedInstance } : { instance: { templateVersion: { templateId: source.courseId } } }),
      enrollment: { status: { in: ['ACTIVE', 'active', 'COMPLETED', 'completed'] }, user: {
        ...(requestedStudent ? { id: requestedStudent } : {}), role: { in: ['STUDENT', 'student'] }, status: { in: ['ACTIVE', 'active'] },
      } },
    },
    orderBy: { lastEnteredAt: 'desc' },
    select: { id: true, instanceId: true, stageProgress: true, lastEnteredAt: true,
      enrollment: { select: { user: { select: { id: true, displayName: true, sessionVersion: true, updatedAt: true, lastLoginAt: true } } } } },
  });
  assert.ok(participation, '未找到现存有权限的学生 participation；禁止为验收创建账号');
  const student = participation.enrollment.user;
  const token = await new SignJWT({ role: 'student', userId: student.id, studentName: student.displayName, sv: student.sessionVersion })
    .setSubject(student.id).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer('openpbl').setAudience('openpbl-app')
    .setIssuedAt().setExpirationTime('20m').sign(new TextEncoder().encode(secret));
  browser = await launchBrowser();
  const readContext = await browser.newContext({ serviceWorkers: 'block' });
  await readContext.addCookies([{ name: 'openpbl_student', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  const baseSession = await readJson(readContext, `/api/courses?courseId=${encodeURIComponent(participation.instanceId)}`);
  const course = baseSession.courses.find((item) => item.id === participation.instanceId);
  assert.ok(course, '现存学生不能只读获取目标课堂');
  const classroomId = course.aiLearningClassroomId ?? course.content?._openmaicClassroomId;
  assert.ok(classroomId, '现存课堂没有 OpenMAIC classroomId');
  const baseClassroom = await readJson(readContext, `/api/openmaic/classroom?id=${encodeURIComponent(classroomId)}`);
  assert.ok(baseClassroom.classroom?.scenes?.length, '只读课堂没有 scenes');
  const before = { participation: sha256(participation), classroom: sha256(baseClassroom.classroom) };
  const scenes = assembleScenes(classroomId);
  const fixtureClassroom = { ...baseClassroom, classroom: { ...baseClassroom.classroom, scenes, generationPreview: undefined } };
  const fixtureCourse = structuredClone(course);
  fixtureCourse.content.adaptiveLearningPlan = undefined;
  fixtureCourse.content.knowledgeLectureSections = [];
  fixtureCourse.content._openmaicSceneOutlines = [];
  fixtureCourse.aiLearningProgress = {};
  const fixtureSession = { ...baseSession, courses: [fixtureCourse], studentId: student.id, studentName: student.displayName, joinedCourseId: course.id };
  Object.assign(report, { courseId: course.id, classroomId, usedExistingStudentParticipation: true, sessionTtl: '20m', sampleIds: samples.map((item) => item.id),
    expectedCases, renderedGeneratedPages: samples.length, includeContinuations,
    fixtureChanges: ['浏览器课程读取绑定已授权 instance，适配全屏入口把 classroomId 当 courseId 的读取', '原 classroom.scenes 仅在浏览器替换为本轮实际验证原生页面',
      '使用实际buildCompleteScene装配原生页面及其默认theme；仅将stageKey等路由字段适配为ai-learning，不改原生元素',
      '进度 GET 设置隔离恢复游标；先决知识、quiz 与音频 actions 不参与本次静态页面验收', '非 GET 的遥测/进度仅在浏览器返回本地回执，其余 mutation 返回拒绝'] });
  const productionBuild = await readFile(path.join(root, process.env.NEXT_DIST_DIR || '.next-build', 'BUILD_ID'), 'utf8').catch(() => undefined);
  report.productionBuildId = productionBuild?.trim();
  const shotViewports = [{ width: 1366, height: 768 }, ...probeOnly ? [] : [{ width: 1440, height: 900 }]];
  for (const viewport of shotViewports) {
    let sceneIndex = 0;
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, serviceWorkers: 'block' });
    await context.addCookies([{ name: 'openpbl_student', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
    await context.routeWebSocket('**/*', (socket) => {
      report.isolatedWebSockets.push({ viewport, path: new URL(socket.url()).pathname });
      // A local open socket allows the normal UI to mount without contacting
      // the realtime server or forwarding any client messages.
      socket.onMessage(() => undefined);
    });
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const pathname = url.pathname;
      if (request.method() !== 'GET') {
        const receiptOnly = request.method() === 'POST' && ['/api/learning-events', '/api/openmaic/progress'].includes(pathname);
        report.blockedMutations.push({ viewport, method: request.method(), path: pathname, receiptOnly });
        if (!receiptOnly) report.unexpectedRequests.push({ method: request.method(), path: pathname });
        await route.fulfill({ status: receiptOnly ? 200 : 405, contentType: 'application/json',
          body: JSON.stringify(receiptOnly ? { success: true, isolatedVerification: true } : { code: 'READ_ONLY_VERIFICATION' }) });
        return;
      }
      if (url.origin !== origin && !['data:', 'blob:'].includes(url.protocol)) {
        report.unexpectedRequests.push({ method: 'GET', path: pathname, externalOrigin: url.origin });
        await route.abort('blockedbyclient'); return;
      }
      let payload;
      if (pathname === '/api/courses') payload = fixtureSession;
      else if (pathname === '/api/openmaic/classroom' && url.searchParams.get('id') === classroomId) payload = fixtureClassroom;
      else if (pathname === '/api/openmaic/progress') payload = { success: true, data: { progress: { [student.id]: {
        completionModelVersion: 2, currentSceneIndex: sceneIndex, completedScenes: [], adaptiveLearning: { evidence: [], branchRuns: [], microLessons: [] },
      } } } };
      if (payload) {
        report.interceptedReads.push({ viewport, path: pathname, sceneIndex });
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => report.pageErrors.push({ viewport, sceneIndex, message: error.message }));
    page.on('response', (response) => {
      if (response.status() >= 400 && !response.url().includes('favicon')) report.failedResources.push({
        viewport, sceneIndex, path: new URL(response.url()).pathname, status: response.status(),
      });
    });
    for (sceneIndex = 0; sceneIndex < (probeOnly ? 1 : scenes.length); sceneIndex++) {
      const url = `${origin}/student/ai-learning/${encodeURIComponent(classroomId)}?courseId=${encodeURIComponent(course.id)}`;
      await page.goto(url, { waitUntil: 'load' });
      await page.locator(`[data-stage-host-mode="student"][data-active-scene-id="${scenes[sceneIndex].id}"] [data-slide-element-id] [class*="base-element-"]`).first().waitFor({ timeout: 30_000 });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map((image) => image.decode().catch(() => undefined)));
      });
      await page.waitForTimeout(samples[sceneIndex].kind === 'data' ? 1600 : 400);
      await page.mouse.move(1, 1);
      const playbackButton = page.getByRole('button', { name: '继续讲解', exact: true });
      assert.ok(await playbackButton.isEnabled(), '画布外播放控件不可用');
      await playbackButton.focus();
      const keyboardFocusable = await playbackButton.evaluate((button) => document.activeElement === button);
      assert.ok(keyboardFocusable, '画布外播放控件不能获取键盘焦点');
      await playbackButton.evaluate((button) => button.blur());
      const measured = await page.evaluate(inspectStudentSlide, samples[sceneIndex].final);
      assert.equal(measured.sceneId, scenes[sceneIndex].id, '恢复游标未进入待检查样板');
      const id = `${samples[sceneIndex].id}-${viewport.width}x${viewport.height}`;
      const filename = path.join(output, `${id}.png`);
      await page.screenshot({ path: filename, fullPage: false });
      const item = { id, title: scenes[sceneIndex].title, sampleId: samples[sceneIndex].id, kind: samples[sceneIndex].kind,
        url, screenshot: filename, externalPlaybackControl: { enabled: true, keyboardFocusable }, ...measured, status: measured.issues.length ? 'failed' : 'passed' };
      await writeFile(path.join(output, `${id}.json`), JSON.stringify(item, null, 2));
      report.screenshots.push(item);
      console.log(`${item.status} ${id}: canvas=${Math.round(measured.canvas.width)}px, min displayed=${measured.minimumDisplayedFontPx?.toFixed(1)}px, issues=${measured.issues.length}`);
    }
    await context.close();
  }
  const afterParticipation = await db.classroomParticipation.findUniqueOrThrow({ where: { id: participation.id }, select: {
    id: true, instanceId: true, stageProgress: true, lastEnteredAt: true,
    enrollment: { select: { user: { select: { id: true, displayName: true, sessionVersion: true, updatedAt: true, lastLoginAt: true } } } },
  } });
  const afterClassroom = await readJson(readContext, `/api/openmaic/classroom?id=${encodeURIComponent(classroomId)}`);
  report.persistentStateUnchanged = before.participation === sha256(afterParticipation) && before.classroom === sha256(afterClassroom.classroom);
  assert.ok(report.persistentStateUnchanged, '验收期间原课堂或学生持久状态发生变化');
  report.fontAndOverflowReview = report.screenshots.every((item) => item.status === 'passed') && !report.pageErrors.length
    && !report.failedResources.length && !report.unexpectedRequests.length ? 'passed' : 'failed';
  report.playHintOcclusionCount = report.screenshots.reduce((count, item) => count + (item.playHint?.glyphIntersections?.length ?? 0), 0);
  report.playHintObjectOcclusionCount = report.screenshots.reduce((count, item) => count + (item.playHint?.objectIntersections?.length ?? 0), 0);
  report.playerOverlayReview = report.playHintOcclusionCount || report.playHintObjectOcclusionCount ? 'potential-obstruction' : 'passed';
  report.fullStudentScreenReview = probeOnly ? 'not-run'
    : report.fontAndOverflowReview === 'passed' && report.playerOverlayReview === 'passed' ? 'passed' : 'failed';
  report.completion = 'completed';
  await readContext.close();
} catch (error) {
  report.completion = 'failed';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const body = report.screenshots.map((item) => `<figure><h2>${escape(item.title)} · ${item.viewport.width}×${item.viewport.height}</h2><img src="${escape(path.basename(item.screenshot))}" alt="${escape(item.title)}"><figcaption>${escape(item.status)}；原生字号 ≥ ${item.minimumCanvasFontPx}px；屏幕最小字号 ${item.minimumDisplayedFontPx?.toFixed(1)}px；问题 ${item.issues.length}</figcaption></figure>`).join('');
  await writeFile(path.join(output, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>八页样板：真实学生界面验收</title><style>body{font:16px sans-serif;margin:24px;background:#eef2f6;color:#182633}figure{margin:24px 0}img{width:100%;max-width:1440px;border:1px solid #cbd5e1}figcaption{padding:8px 0}h2{font-size:20px}</style><h1>真实学生学习界面</h1><p>仅浏览器隔离样板，生产学生组件。字体与溢出检查：${escape(report.fontAndOverflowReview ?? 'not-run')}；完整学生界面检查：${escape(report.fullStudentScreenReview)}；播放器覆盖层：${escape(report.playerOverlayReview ?? 'not-run')}；音频播放、美观逐页评审尚未验收。</p>${body}</html>`);
  await browser?.close();
  await db.$disconnect();
}
console.log(JSON.stringify({ report: path.join(output, 'report.json'), fullStudentScreenReview: report.fullStudentScreenReview,
  screenshots: report.screenshots.length, persistentStateUnchanged: report.persistentStateUnchanged, pageErrors: report.pageErrors.length,
  issues: report.screenshots.reduce((count, item) => count + item.issues.length, 0), playHintOcclusionCount: report.playHintOcclusionCount,
  playHintObjectOcclusionCount: report.playHintObjectOcclusionCount, error: report.error }, null, 2));
if (report.fontAndOverflowReview !== 'passed') process.exitCode = 1;
if (!probeOnly && report.fullStudentScreenReview !== 'passed') process.exitCode = 1;
