// Browser acceptance against the disposable DB created by verify-research-database.mjs.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marker = process.env.OPENPBL_VERIFICATION_MARKER;
assert.match(marker ?? '', /^openpbl-research-check-[0-9a-f-]{36}$/);
const target = new URL(process.env.DATABASE_URL ?? '');
assert.equal(target.hostname, '127.0.0.1'); assert.equal(target.pathname, '/postgres'); assert.equal(target.password, '');
const db = new PrismaClient({ datasources: { db: { url: target.href } } });
const temporary = mkdtempSync(path.join(tmpdir(), 'openpbl-pages-'));
const distDir = `.next-verification-${process.pid}`;
const nextEnvPath = path.join(root, 'next-env.d.ts');
const nextEnvBefore = existsSync(nextEnvPath) ? readFileSync(nextEnvPath, 'utf8') : null;
const configPath = path.join(root, 'tsconfig.json');
const configBefore = readFileSync(configPath, 'utf8');
const screenshotDir = process.env.OPENPBL_VERIFICATION_SCREENSHOTS ? path.resolve(process.env.OPENPBL_VERIFICATION_SCREENSHOTS) : null;
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });
const jwtSecret = randomBytes(48).toString('base64url');
const port = Number(process.env.OPENPBL_VERIFICATION_PORT ?? 3199);
assert.ok(Number.isInteger(port) && port >= 3199 && port <= 3299);
const origin = `http://127.0.0.1:${port}`;
const pageScope = process.env.OPENPBL_VERIFICATION_PAGES ?? 'all';
assert.ok(['all', 'authoring'].includes(pageScope));
let server;
let browser;
let serverOutput = '';
try {
  assert.equal((await db.$queryRaw`SELECT marker FROM "_OpenpblVerification" WHERE marker = ${marker}`).length, 1);
  const teacher = await db.user.findUniqueOrThrow({ where: { usernameKey: 'verification-teacher' } });
  const student = await db.user.findUniqueOrThrow({ where: { usernameKey: 'verification-alice' } });
  const template = await db.classroomTemplate.findFirstOrThrow({ where: { title: 'Showcase verification', ownerId: teacher.id } });
  const instance = await db.classroomInstance.findFirstOrThrow({ where: { templateVersion: { templateId: template.id } } });
  const networkGuard = path.join(temporary, 'isolation.cjs');
  writeFileSync(networkGuard, `
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const root = ${JSON.stringify(root)};
function isolatedFile(value) {
  const target = String(value);
  if (target === path.join(root, 'server-providers.yml') || target === path.join(root, '.openpbl-data/ai-settings.json')) return '{}';
  if (path.dirname(target) === root && path.basename(target).startsWith('.env')) return '';
}
const readSync = fs.readFileSync;
fs.readFileSync = function(file, options) { const text = isolatedFile(file); return text === undefined ? readSync.call(this, file, options) : (typeof options === 'string' || options?.encoding ? text : Buffer.from(text)); };
const readAsync = fsp.readFile;
fsp.readFile = async function(file, options) { const text = isolatedFile(file); return text === undefined ? readAsync.call(this, file, options) : (typeof options === 'string' || options?.encoding ? text : Buffer.from(text)); };
require('node:module').syncBuiltinESMExports();
const realFetch = globalThis.fetch;
globalThis.fetch = (input, options) => { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return Promise.reject(new Error('OPENPBL_VERIFICATION_EXTERNAL_NETWORK_BLOCKED')); return realFetch(input, options); };
`);
  const isolatedEnvironment = Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key, /API_KEY$|^OPENPBL_LLM_/.test(key) ? '' : value]));
  server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: root, env: { ...isolatedEnvironment, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${networkGuard}`, NODE_ENV: 'development', NEXT_DIST_DIR: distDir, JWT_SECRET: jwtSecret,
      DATABASE_URL: target.href, REDIS_URL: '', ENABLE_WEBSOCKET: 'false', ENABLE_TLDRAW_SYNC: 'false',
      COURSE_GENERATION_BACKGROUND_ENABLED: 'false', NEXT_TELEMETRY_DISABLED: '1',
      NEXT_PUBLIC_OPENPBL_SYSTEM_MODE: 'new', UPLOAD_DIR: temporary }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => { serverOutput = (serverOutput + chunk.toString()).slice(-20000); });
  let ready = false;
  for (let attempt = 0; attempt < 180; attempt++) {
    if (server.exitCode !== null) throw new Error(`Isolated Next server exited with code ${server.exitCode}`);
    try { const response = await fetch(`${origin}/api/auth/me`, { signal: AbortSignal.timeout(2000) }); if (response.ok) { ready = true; break; } } catch { /* boot or compilation */ }
    await delay(1000);
  }
  assert.ok(ready, 'Isolated Next server did not become ready within three minutes');
  browser = await chromium.launch({ headless: true });
  const token = (user, role) => new SignJWT({ role, sv: user.sessionVersion, ...(role === 'teacher' ? { username: user.username, displayName: user.displayName } : { userId: user.id, studentName: user.displayName }) })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(user.id).setIssuedAt().setIssuer('openpbl').setAudience('openpbl-app').setExpirationTime('1h').sign(new TextEncoder().encode(jwtSecret));
  const scenarios = [
    { name: 'teacher/settings', user: teacher, role: 'teacher', route: '/teacher/settings', text: 'AI 服务设置' },
    { name: 'teacher/prepare', user: teacher, role: 'teacher', route: `/teacher/prepare/${template.id}/verify`, text: 'AI INSIDE PRACTICE.', controlName: '描述课程生成要求' },
    { name: 'teacher/classroom', user: teacher, role: 'teacher', route: `/teacher/teach/${instance.id}/classroom`, text: /成果汇报|第四阶段|阶段 4|学习反思/ },
    { name: 'student/classroom', user: student, role: 'student', route: `/student/classroom/${instance.id}`, text: /成果汇报|第四阶段|阶段 4|学习反思/ },
  ];
  async function verifyScenario(scenario) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: scenario.role === 'teacher' ? 'openpbl_teacher' : 'openpbl_student', value: await token(scenario.user, scenario.role), url: origin, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    try {
    const apiErrors = []; const pageErrors = []; const responseChecks = []; const unavailableAi = [];
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.origin === origin && url.pathname.startsWith('/api/') && response.status() >= 400) responseChecks.push((async () => {
        const body = await response.json().catch(() => ({}));
        const summary = `${response.status()} ${url.pathname} ${JSON.stringify(body).slice(0, 800)}`;
        if (url.pathname === '/api/teaching-ai/support' && response.status() === 503 && body.error === 'AI_NOT_CONFIGURED') unavailableAi.push(summary);
        else apiErrors.push(summary);
      })());
    });
    page.on('pageerror', (error) => { pageErrors.push((error.stack ?? error.message).slice(0, 1000)); });
    // Acceptance does not invoke external AI providers, analytics, or remote media.
    await page.route('**/*', (route) => new URL(route.request().url()).origin === origin || route.request().url().startsWith('data:') ? route.continue() : route.abort());
    const response = await page.goto(`${origin}${scenario.route}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
    assert.ok(response?.ok(), `${scenario.name}: page returned ${response?.status()}`);
    await (scenario.controlName ? page.getByRole('textbox', { name: scenario.controlName }) : page.getByText(scenario.text).filter({ visible: true }).first()).waitFor({ timeout: 60000 }).catch(async () => { throw new Error(`${scenario.name}: expected ${scenario.text}; API ${apiErrors.join(', ')}; body ${(await page.locator('body').innerText()).slice(0, 2500)}`); });
    await page.waitForTimeout(3000);
    assert.equal(new URL(page.url()).pathname, scenario.expectedRoute ?? scenario.route, `${scenario.name}: unexpected redirect`);
    if (scenario.stageIndex !== undefined) {
      const state = await context.request.get(`${origin}/api/courses/${instance.id}/state`);
      assert.ok(state.ok(), `${scenario.name}: state endpoint failed`);
      assert.equal((await state.json()).course.currentStageIndex, scenario.stageIndex);
      assert.ok(await page.locator('main').count(), `${scenario.name}: missing main classroom content`);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 180000 });
      await (scenario.controlName ? page.getByRole('textbox', { name: scenario.controlName }) : page.getByText(scenario.text).filter({ visible: true }).first()).waitFor({ timeout: 60000 }).catch(async () => { throw new Error(`${scenario.name}: expected ${scenario.text}; API ${apiErrors.join(', ')}; body ${(await page.locator('body').innerText()).slice(0, 2500)}`); });
      await page.waitForTimeout(3000);
    }
    if (scenario.name !== 'teacher/settings') assert.equal(await page.locator('.pbl-platform-theme').count(), 0, `${scenario.name}: platform theme leaked into the original teaching workspace`);
    if (screenshotDir) {
      const screenshotPath = path.join(screenshotDir, `${scenario.name.replaceAll('/', '-')}-1440.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true, animations: 'disabled' });
      console.log(`SCREENSHOT ${screenshotPath}`);
    }
    if (scenario.controlName) assert.ok(await page.getByRole('textbox', { name: scenario.controlName }).isEditable(), 'Preparation request input must be editable');
    const text = await page.locator('body').innerText();
    assert.ok(!text.includes('无法读取课堂数据'), `${scenario.name}: legacy session failure toast`);
    if (scenario.name === 'teacher/settings') {
      const config = await context.request.get(`${origin}/api/openmaic/provider-config?section=providers`);
      assert.ok(config.ok(), `Provider config returned ${config.status()}`);
    }
    await Promise.all(responseChecks);
    if (unavailableAi.length) console.log(`ENV browser ${scenario.name}: AI_NOT_CONFIGURED; no external model called`);
    assert.deepEqual(apiErrors, [], `${scenario.name}: API failures`);
    assert.deepEqual(pageErrors, [], `${scenario.name}: uncaught browser errors`);
    console.log(`PASS browser ${scenario.name}: authenticated page, expected content and no failed APIs`);
    } finally { await context.close(); }
  }
  const failures = [];
  async function attemptScenario(scenario) {
    try { await verifyScenario(scenario); } catch (error) {
      console.error(`${scenario.name}: first attempt failed: ${error.message}`);
      // A cold development compile can replace a chunk while it is loading; retry a fresh context once.
      try { await verifyScenario(scenario); } catch (retryError) { failures.push(retryError.message); console.error(retryError.message); }
    }
  }
  for (const scenario of scenarios.slice(0, 2)) await attemptScenario(scenario);
  const teacherContext = await browser.newContext();
  await teacherContext.addCookies([{ name: 'openpbl_teacher', value: await token(teacher, 'teacher'), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  const labels = ['项目启动', '知识讲授', '项目实践', '成果汇报与评价', '学习反思'];
  for (let index = 0; pageScope === 'all' && index < labels.length; index++) {
    const result = await teacherContext.request.post(`${origin}/api/courses/${instance.id}/actions`, {
      headers: { Origin: origin }, data: { requestId: randomUUID(), action: { type: 'SET_STAGE', payload: { id: instance.id, index } } },
    });
    assert.ok(result.ok(), `Stage ${index + 1} transition failed: ${result.status()} ${await result.text()}`);
    for (const scenario of scenarios.slice(2)) await attemptScenario({ ...scenario, name: `${scenario.name}/stage-${index + 1}`,
      stageIndex: index, text: `阶段 ${index + 1}/5 · ${labels[index]}`, expectedRoute: scenario.role === 'student' && index === 2 ? `/student/ai-collaboration/${instance.id}` : scenario.route });
  }
  await teacherContext.close();
  assert.deepEqual(failures, [], 'Browser acceptance failures');
} catch (error) {
  // The log tail remains in memory; report only error/compiler identifiers, never environment values.
  const diagnostics = serverOutput.split('\n').filter((line) => /Module not found|Cannot find module|Error:|error TS|EADDRINUSE/.test(line)).slice(-8);
  console.error('Browser verification diagnostics:', diagnostics.map((line) => line.replace(/postgres(?:ql)?:\/\/\S+/g, '[database]').replace(/eyJ[\w.-]+/g, '[token]')).join('\n'));
  throw error;
} finally {
  await browser?.close();
  if (server?.pid) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already stopped */ }
    for (let attempt = 0; attempt < 30 && server.exitCode === null; attempt++) await delay(200);
    if (server.exitCode === null) try { process.kill(-server.pid, 'SIGKILL'); } catch { /* already stopped */ }
  }
  await db.$disconnect();
  // Next adds its generated type paths automatically; remove only this run's paths.
  if (existsSync(nextEnvPath) && readFileSync(nextEnvPath, 'utf8').includes(`./${distDir}/`)) {
    if (nextEnvBefore === null) rmSync(nextEnvPath); else writeFileSync(nextEnvPath, nextEnvBefore);
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const includes = config.include.filter((entry) => !entry.startsWith(`${distDir}/`));
  if (includes.length !== config.include.length) {
    const cleaned = { ...config, include: includes };
    writeFileSync(configPath, JSON.stringify(cleaned) === JSON.stringify(JSON.parse(configBefore)) ? configBefore : `${JSON.stringify(cleaned, null, 2)}\n`);
  }
  rmSync(temporary, { recursive: true, force: true }); rmSync(path.join(root, distDir), { recursive: true, force: true });
}
