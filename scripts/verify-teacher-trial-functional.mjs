// Focused, disposable acceptance for the currently shipped classroom workflow.
// Uses a fresh PostgreSQL, Redis and upload directory; never reads production data.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const output = path.resolve(process.env.TRIAL_FUNCTIONAL_OUTPUT_DIR || 'test-results/teacher-trial/functional-core');
const port = Number(process.env.TRIAL_FUNCTIONAL_PORT || 3199);
const origin = `http://127.0.0.1:${port}`;
const id = randomUUID();
const postgresContainer = `openpbl-trial-postgres-${id}`;
const redisContainer = `openpbl-trial-redis-${id}`;
const temporary = path.join(tmpdir(), `openpbl-teacher-trial-${id}`);
const password = randomBytes(20).toString('base64url');
mkdirSync(output, { recursive: true });
mkdirSync(temporary, { recursive: true });
const buildId = readFileSync(path.join(root, '.next-build/BUILD_ID'), 'utf8').trim();
const env = {
  ...process.env,
  DATABASE_URL: '', REDIS_URL: '', PROVIDER_CONFIG_DATABASE_URL: '',
  JWT_SECRET: randomBytes(48).toString('base64url'),
  PROVIDER_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  INTERNAL_MONITOR_TOKEN: randomBytes(32).toString('base64url'),
  TRUST_PROXY_HEADERS: 'true', ENABLE_WEBSOCKET: 'false',
  COURSE_GENERATION_BACKGROUND_ENABLED: 'false',
  UPLOAD_DIR: path.join(temporary, 'uploads'),
  WHITEBOARD_DATA_DIR: path.join(temporary, 'whiteboards'),
  CLASSROOM_DATA_DIR: path.join(temporary, 'classrooms'),
  PUBLIC_BASE_URL: origin, PORT: String(port), HOSTNAME: '127.0.0.1',
  NEXT_TELEMETRY_DISABLED: '1',
};
const results = [];
const record = (name, status, detail = '') => {
  results.push({ name, status, detail });
  console.log(`${status} ${name}${detail ? `: ${detail}` : ''}`);
};
const command = (binary, args, options = {}) => execFileSync(binary, args, {
  cwd: root, env, encoding: 'utf8', timeout: 120_000, ...options,
}).trim();
let postgresStarted = false;
let redisStarted = false;
let server;
let browser;
let db;
let serverOutput = '';

async function request(context, method, endpoint, data, expected = 200) {
  const response = await context.request.fetch(`${origin}${endpoint}`, {
    method, headers: { Origin: origin }, ...(data === undefined ? {} : { data }), timeout: 30_000,
  });
  const body = await response.json().catch(() => ({}));
  assert.equal(response.status(), expected, `${method} ${endpoint}: ${response.status()} ${JSON.stringify(body).slice(0, 250)}`);
  return body;
}

async function pageContains(context, route, content) {
  const page = await context.newPage();
  try {
    const response = await page.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    assert.equal(response?.status(), 200, route);
    await page.getByText(content).filter({ visible: true }).first().waitFor({ timeout: 30_000 });
    assert.equal(new URL(page.url()).pathname, route);
  } finally {
    await page.close();
  }
}

try {
  command('docker', ['run', '--detach', '--rm', '--name', postgresContainer,
    '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data:rw',
    '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', 'pgvector/pgvector:0.8.6-pg16']);
  postgresStarted = true;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { command('docker', ['exec', postgresContainer, 'pg_isready', '-U', 'postgres'], { timeout: 3000 }); break; }
    catch { if (attempt === 59) throw new Error('PostgreSQL did not become ready'); await delay(500); }
  }
  const address = command('docker', ['port', postgresContainer, '5432/tcp']);
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  env.DATABASE_URL = `postgresql://postgres@${address}/postgres?schema=public`;
  command('node', ['scripts/run-prisma.mjs', 'migrate', 'deploy']);
  db = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  await db.$queryRaw`SELECT 1`;
  record('disposable-postgresql-and-migrations', '通过');

  command('docker', ['run', '--detach', '--rm', '--name', redisContainer,
    '--publish', '127.0.0.1::6379', 'redis:7.4.5-alpine']);
  redisStarted = true;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { if (command('docker', ['exec', redisContainer, 'redis-cli', 'ping']) === 'PONG') break; }
    catch { if (attempt === 29) throw new Error('Redis did not become ready'); await delay(300); }
  }
  env.REDIS_URL = `redis://${command('docker', ['port', redisContainer, '6379/tcp'])}/0`;
  record('disposable-redis', '通过');

  const release = path.join(root, '.openpbl-runtime/releases', buildId, 'server.js');
  readFileSync(release);
  server = spawn(process.execPath, [release], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [server.stdout, server.stderr]) {
    stream.on('data', chunk => { serverOutput = (serverOutput + chunk.toString()).slice(-8000); });
  }
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Isolated server exited ${server.exitCode}`);
    try { if ((await fetch(`${origin}/api/health/live`, { signal: AbortSignal.timeout(1500) })).ok) { ready = true; break; } }
    catch { /* startup */ }
    await delay(1000);
  }
  assert.ok(ready, 'Isolated production server did not start');
  record('isolated-production-build', '通过', buildId);

  browser = await chromium.launch();
  const teacher = await browser.newContext();
  const teacherB = await browser.newContext();
  const studentA = await browser.newContext();
  const studentB = await browser.newContext();
  const outsider = await browser.newContext();
  await request(teacher, 'POST', '/api/platform/auth/teacher-register', {
    username: 'trial-teacher-a', displayName: '试用验收教师 A', password, confirmPassword: password,
  }, 201);
  await teacherB.addCookies(await teacher.cookies());
  await request(teacherB, 'POST', '/api/platform/auth/teacher-register', {
    username: 'trial-teacher-b', displayName: '试用验收教师 B', password, confirmPassword: password,
  }, 201);
  record('two-teachers-real-login-cookies', '通过');
  const teacherLogin = await browser.newContext();
  await request(teacherLogin, 'POST', '/api/platform/auth/teacher-login', {
    username: 'trial-teacher-a', password: `${password}-wrong`,
  }, 401);
  await request(teacherLogin, 'POST', '/api/platform/auth/teacher-login', {
    username: 'trial-teacher-a', password,
  });
  await request(teacherLogin, 'GET', '/api/platform/offerings');
  await request(teacherLogin, 'POST', '/api/auth/logout', {});
  await request(teacherLogin, 'GET', '/api/platform/offerings', undefined, 401);
  record('teacher-password-login-and-logout', '通过');

  const offering = (await request(teacher, 'POST', '/api/platform/offerings', {
    name: '试用验收测试课程', description: '仅在一次性数据库中使用',
  }, 201)).offering;
  await request(teacher, 'PATCH', `/api/platform/offerings/${offering.id}`, { status: 'open' });
  const invitation = (await request(teacher, 'POST', `/api/platform/offerings/${offering.id}/invitation`, {})).invitation;
  const chapter = (await request(teacher, 'POST', `/api/platform/offerings/${offering.id}/chapters`, { title: '第一章' }, 201)).chapter;
  await request(teacher, 'PATCH', `/api/platform/chapters/${chapter.id}`, { isOpen: true });
  const template = await request(teacher, 'POST', '/api/platform/templates', {
    title: '试用验收课堂', snapshot: { schemaVersion: 1, title: '试用验收课堂' },
  }, 201);
  const classroom = (await request(teacher, 'POST',
    `/api/platform/offerings/${offering.id}/chapters/${chapter.id}/activities`, {
      type: 'Classroom', title: '现有课堂活动', templateVersionId: template.versions[0].id,
      config: { schemaVersion: 1 },
    }, 201)).activity;
  await request(teacher, 'PATCH', `/api/platform/activities/${classroom.id}`, { isOpen: true });
  const instance = await db.classroomInstance.findFirstOrThrow({ where: { activityId: classroom.id } });
  record('existing-course-classroom-activity-prepared', '通过');

  for (const [context, username] of [[studentA, 'trial-student-a'], [studentB, 'trial-student-b']]) {
    await request(context, 'POST', '/api/platform/auth/register', {
      invitationCode: invitation.code, username, displayName: username, password, confirmPassword: password,
    }, 201);
  }
  const enrollmentCount = await db.enrollment.count({ where: { offeringId: offering.id } });
  const inviteBeforeRetry = await db.courseInvitation.findUniqueOrThrow({ where: { code: invitation.code } });
  await request(studentA, 'POST', '/api/platform/auth/join', { invitationCode: invitation.code });
  assert.equal(await db.enrollment.count({ where: { offeringId: offering.id } }), enrollmentCount);
  const inviteAfterRetry = await db.courseInvitation.findUniqueOrThrow({ where: { code: invitation.code } });
  assert.equal(inviteAfterRetry.useCount, inviteBeforeRetry.useCount);
  await request(studentA, 'POST', '/api/platform/auth/join', { invitationCode: 'NOPE1234' }, 404);
  const other = (await request(teacherB, 'POST', '/api/platform/offerings', {
    name: '另一教学班', description: '访问隔离',
  }, 201)).offering;
  await request(teacherB, 'PATCH', `/api/platform/offerings/${other.id}`, { status: 'open' });
  const otherInvitation = (await request(teacherB, 'POST', `/api/platform/offerings/${other.id}/invitation`, {})).invitation;
  await request(outsider, 'POST', '/api/platform/auth/register', {
    invitationCode: otherInvitation.code, username: 'trial-student-c', displayName: '试用验收学生 C',
    password, confirmPassword: password,
  }, 201);
  const disabledInvitation = (await request(teacherB, 'POST',
    `/api/platform/offerings/${other.id}/invitation`, { disabled: true })).invitation;
  await request(studentA, 'POST', '/api/platform/auth/join', { invitationCode: disabledInvitation.code }, 404);
  record('invalid-disabled-and-repeated-invitation-rules', '通过');
  assert.ok(!(await request(outsider, 'GET', '/api/platform/courses')).courses.some(item => item.id === offering.id));
  record('two-enrolled-students-and-outsider-isolated', '通过');

  const firstStart = (await request(teacher, 'POST', `/api/platform/classroom-instances/${instance.id}/start`, {})).instance;
  const repeatedStart = (await request(teacher, 'POST', `/api/platform/classroom-instances/${instance.id}/start`, {})).instance;
  assert.equal(repeatedStart.id, firstStart.id);
  assert.equal(await db.domainEvent.count({ where: {
    classroomInstanceId: instance.id, eventType: 'classroom_started',
  } }), 1);
  const a = (await request(studentA, 'POST', `/api/platform/classroom-instances/${instance.id}/enter`, {})).participation;
  const b = (await request(studentB, 'POST', `/api/platform/classroom-instances/${instance.id}/enter`, {})).participation;
  assert.notEqual(a.id, b.id);
  const repeated = (await request(studentA, 'POST', `/api/platform/classroom-instances/${instance.id}/enter`, {})).participation;
  assert.equal(repeated.id, a.id);
  assert.equal(await db.classroomParticipation.count({ where: { instanceId: instance.id } }), 2);
  await request(outsider, 'POST', `/api/platform/classroom-instances/${instance.id}/enter`, {}, 403);
  const teacherBParticipants = await teacherB.request.get(`${origin}/api/platform/classroom-instances/${instance.id}/participants`);
  assert.ok([403, 404].includes(teacherBParticipants.status()));
  const otherStudentWorkspace = await studentB.request.get(`${origin}/api/platform/participations/${a.id}`);
  assert.ok([403, 404].includes(otherStudentWorkspace.status()));
  record('start-enter-idempotency-and-role-boundaries', '通过');

  const deepLinkContext = await browser.newContext();
  try {
    const deepLinkPage = await deepLinkContext.newPage();
    await deepLinkPage.goto(`${origin}/student/activities/${classroom.id}`, { waitUntil: 'domcontentloaded' });
    await deepLinkPage.waitForURL('**/student/login?redirect=*', { timeout: 20_000 });
    assert.equal(new URL(deepLinkPage.url()).searchParams.get('redirect'), `/student/activities/${classroom.id}`);
    await deepLinkPage.getByLabel('学号').fill('trial-student-a');
    await deepLinkPage.locator('input[autocomplete="current-password"]').fill(password);
    await deepLinkPage.getByRole('button', { name: '登录', exact: true }).click();
    await deepLinkPage.waitForURL(`**/student/activities/${classroom.id}`, { timeout: 30_000 });
    await deepLinkPage.getByRole('button', { name: '进入课堂' }).waitFor({ timeout: 20_000 });
    record('student-deep-link-restored-after-browser-login', '通过');
  } finally {
    await deepLinkContext.close();
  }

  await pageContains(teacher, `/teacher/teach/${instance.id}/classroom`, '课堂数据速览');
  await pageContains(studentA, `/student/classroom/${instance.id}`, '当前学习任务');
  record('teacher-and-student-classroom-pages', '通过');

  const teacherStagePage = await teacher.newPage();
  const studentStagePage = await studentA.newPage();
  try {
    await teacherStagePage.goto(`${origin}/teacher/teach/${instance.id}/classroom`, { waitUntil: 'domcontentloaded' });
    await studentStagePage.goto(`${origin}/student/classroom/${instance.id}`, { waitUntil: 'domcontentloaded' });
    const before = (await request(teacher, 'GET', `/api/courses/${instance.id}/state`)).course;
    assert.ok(before.stages.length > 1, 'Disposable classroom has no next stage');
    const nextLabel = before.stages[1].label;
    await teacherStagePage.getByRole('button', { name: /^结束「.+」并进入「.+」$/ }).click();
    await teacherStagePage.getByRole('dialog').getByRole('button', { name: /进入“/ }).click();
    let stageChanged = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const state = (await request(teacher, 'GET', `/api/courses/${instance.id}/state`)).course;
      if (state.currentStageIndex === 1) { stageChanged = true; break; }
      await delay(500);
    }
    assert.ok(stageChanged, 'Teacher stage transition was not saved');
    await studentStagePage.getByText(nextLabel).filter({ visible: true }).first().waitFor({ timeout: 30_000 });
    await teacherStagePage.reload({ waitUntil: 'domcontentloaded' });
    await teacherStagePage.getByRole('button', { name: `回退到「${before.stages[0].label}」` })
      .waitFor({ timeout: 30_000 });
    record('teacher-stage-change-student-sync-and-refresh', '通过', nextLabel);
  } finally {
    await teacherStagePage.close();
    await studentStagePage.close();
  }

  await request(studentA, 'PATCH', `/api/platform/participations/${a.id}`, {
    version: 0, idempotencyKey: randomUUID(), document: '学生 A 的中文课堂记录', stageKey: 'make',
  });
  await request(studentB, 'PATCH', `/api/platform/participations/${b.id}`, {
    version: 0, idempotencyKey: randomUUID(), document: '学生 B 的独立课堂记录', stageKey: 'make',
  });
  assert.equal((await request(studentA, 'GET', `/api/platform/participations/${a.id}`)).workspace.projectState.document,
    '学生 A 的中文课堂记录');
  assert.equal((await request(studentB, 'GET', `/api/platform/participations/${b.id}`)).workspace.projectState.document,
    '学生 B 的独立课堂记录');
  const participants = await request(teacher, 'GET', `/api/platform/classroom-instances/${instance.id}/participants`);
  assert.equal(participants.participants.length, 2);
  record('two-student-save-reload-and-teacher-roster', '通过');

  await request(teacher, 'POST', `/api/platform/classroom-instances/${instance.id}/finish`, {});
  await request(teacher, 'POST', `/api/platform/classroom-instances/${instance.id}/finish`, {});
  assert.equal((await db.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } })).status, 'FINISHED');
  assert.equal(await db.domainEvent.count({ where: {
    classroomInstanceId: instance.id, eventType: 'classroom_finished',
  } }), 1);
  assert.equal((await request(studentA, 'GET', `/api/platform/participations/${a.id}`)).workspace.projectState.document,
    '学生 A 的中文课堂记录');
  record('finish-and-learning-record-retained', '通过');
} catch (error) {
  record('fatal', '失败', String(error instanceof Error ? error.message : error).slice(0, 500));
  const diagnostics = serverOutput.split('\n').filter(line => /Error:|Cannot find module|Migration/.test(line)).slice(-5);
  if (diagnostics.length) record('server-diagnostics', '信息', diagnostics.join(' | ').slice(0, 600));
  process.exitCode = 1;
} finally {
  writeFileSync(path.join(output, 'report.json'), JSON.stringify({
    checkedAt: new Date().toISOString(), buildId, mode: 'disposable-postgresql-redis-and-production-build',
    browser: browser?.version() ?? null, results,
  }, null, 2));
  await browser?.close().catch(() => undefined);
  await db?.$disconnect().catch(() => undefined);
  if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already stopped */ } }
  if (redisStarted) { try { command('docker', ['rm', '--force', redisContainer]); } catch { /* best effort */ } }
  if (postgresStarted) { try { command('docker', ['rm', '--force', postgresContainer]); } catch { /* best effort */ } }
  rmSync(temporary, { recursive: true, force: true });
}
