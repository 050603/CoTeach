// Explicit production acceptance run. Creates students and submissions; the
// operator must remove these before admitting real students. No secrets or
// respondent data are written to the aggregate report.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';
import { chromium } from 'playwright';

assert.equal(process.env.CONFIRM_SURVEY_ACCEPTANCE, 'create-test-students');
const origin = 'https://coteach.cn';
const db = new PrismaClient({ datasourceUrl: fs.readFileSync('deploy/secrets/database_url.txt', 'utf8').trim() });
const samples = [];
const report = { startedAt: new Date().toISOString(), concurrentStudents: 40, transport: 'HTTPS through production Nginx; DNS mapped to loopback', stages: [] };
const prefix = `readiness-${Date.now()}`;
const password = randomBytes(18).toString('hex');
const agent = new https.Agent({ keepAlive: true, maxSockets: 100, lookup: (_host, options, callback) => options.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4) });
let browser;
async function request(path, { body, cookie, expected = 200, label = path } = {}) {
  const start = performance.now();
  const result = await new Promise((resolve, reject) => {
    const req = https.request(`${origin}${path}`, { agent, method: body ? 'POST' : 'GET', headers: { Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString(), cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }));
    });
    req.setTimeout(30000, () => req.destroy(new Error(`Timeout: ${label}`)));
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  samples.push({ label, ms: performance.now() - start, status: result.status });
  assert.equal(result.status, expected, `${label}: HTTP ${result.status}`);
  return { ...result, data: result.text.startsWith('{') ? JSON.parse(result.text) : null };
}
async function stage(name, tasks) {
  const start = performance.now();
  const results = await Promise.allSettled(tasks.map(task => task()));
  const failures = results.filter(r => r.status === 'rejected');
  report.stages.push({ name, count: tasks.length, failed: failures.length, durationMs: Math.round(performance.now() - start) });
  console.log(JSON.stringify(report.stages.at(-1)));
  assert.equal(failures.length, 0, failures.map(r => r.reason.message).join('\n'));
  return results.map(r => r.value);
}
try {
  const activity = await db.activity.findFirstOrThrow({ where: { type: 'FORM', isOpen: true, archivedAt: null, chapter: { isOpen: true, offering: { name: '人工智能教育导论', status: 'OPEN' } } }, include: { chapter: { include: { offering: { include: { invitations: true, teachers: { include: { user: true } } } } } } } });
  const offering = activity.chapter.offering;
  const invitation = offering.invitations.find(i => i.status === 'ACTIVE' && !i.disabledAt && (!i.expiresAt || i.expiresAt > new Date()));
  assert(invitation && invitation.maxUses === null, 'Acceptance needs an unlimited active invitation');
  const teacher = offering.teachers[0].user;
  const teacherToken = await new SignJWT({ role: 'teacher', username: teacher.username, displayName: teacher.displayName, sv: teacher.sessionVersion }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(teacher.id).setIssuedAt().setIssuer('openpbl').setAudience('openpbl-app').setExpirationTime('1h').sign(new TextEncoder().encode(fs.readFileSync('deploy/secrets/jwt_secret.txt', 'utf8').trim()));
  const teacherCookie = `openpbl_teacher=${teacherToken}`;
  const resultsPath = `/api/platform/activities/${activity.id}/survey-results`;
  const baseline = (await request(resultsPath, { cookie: teacherCookie, label: 'teacher-baseline' })).data.analytics;
  const people = Array.from({ length: 40 }, (_, i) => ({ username: `${prefix}-${i}`, displayName: `上线验收临时学生${i + 1}` }));
  await stage('40 simultaneous homepage requests', people.map(() => () => request('/', { label: 'homepage' })));
  await stage('40 simultaneous invitation checks', people.map(() => () => request('/api/platform/auth/invite', { body: { code: invitation.code }, label: 'invitation' })));
  await stage('40 simultaneous registrations from one IP', people.map(person => async () => {
    const result = await request('/api/platform/auth/register', { body: { ...person, invitationCode: invitation.code, password, confirmPassword: password }, expected: 201, label: 'register' });
    assert.equal(result.data.offeringId, offering.id);
    person.cookie = result.cookie;
    person.id = result.data.user.id;
  }));
  await stage('40 simultaneous logins', people.map(person => async () => {
    person.cookie = (await request('/api/platform/auth/login', { body: { username: person.username, password }, label: 'login' })).cookie;
  }));
  await stage('40 simultaneous course reads', people.map(person => async () => {
    const result = await request('/api/platform/courses', { cookie: person.cookie, label: 'courses' });
    assert(result.data.courses.some(c => c.id === offering.id));
  }));
  await request(resultsPath, { cookie: people[0].cookie, expected: 401, label: 'student-cannot-read-teacher-statistics' });
  await request(`/api/platform/activities/${activity.id}/submit`, { cookie: people[0].cookie, body: { answers: {} }, expected: 400, label: 'required-answer-validation' });

  browser = await chromium.launch({ headless: true, args: ['--no-proxy-server', '--host-resolver-rules=MAP coteach.cn 127.0.0.1'] });
  const errors = [];
  const failedResources = [];
  const pages = await Promise.all(people.map(async person => {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (response.status() >= 500 || response.status() === 429) failedResources.push({ path: new URL(response.url()).pathname, status: response.status() });
    });
    await context.addCookies([{ name: 'openpbl_student', value: person.cookie.split('=').slice(1).join('='), url: origin, httpOnly: true, secure: true, sameSite: 'Lax' }]);
    return page;
  }));
  await stage('40 cold browser homepages', pages.map(page => async () => {
    await page.goto(origin);
    await page.getByRole('link', { name: '开始学习', exact: true }).first().waitFor();
  }));
  await stage('40 browser course pages', pages.map(page => async () => {
    await page.goto(`${origin}/student/courses/${offering.id}`);
    await page.getByRole('link').filter({ hasText: activity.title }).first().waitFor();
  }));
  await stage('40 browser questionnaire pages', pages.map(page => async () => {
    await page.getByRole('link').filter({ hasText: activity.title }).first().click();
    await page.getByRole('heading', { name: activity.title, exact: true }).waitFor();
  }));
  await stage('40 browser questionnaire answers', pages.map((page, index) => async () => {
    for (const question of activity.config.questions) {
      if (question.type === 'short-text') await page.getByRole('textbox', { name: question.title, exact: true }).fill(`上线验收测试${index + 1}：希望学习人工智能教学设计与课堂实践。`);
      else {
        const option = question.options.find(o => !o.allowTextInput);
        const input = page.locator(`input[name="${question.id}"][value="${option.id}"]`);
        await input.locator('..').click();
        assert(await input.isChecked());
      }
    }
  }));
  await stage('40 simultaneous browser submissions with teacher polling', [...pages.map(page => async () => {
    const start = performance.now();
    const response = page.waitForResponse(r => r.url().endsWith('/submit'));
    await page.getByRole('button', { name: '提交问卷', exact: true }).click();
    const status = (await response).status();
    samples.push({ label: 'browser-submit', ms: performance.now() - start, status });
    assert.equal(status, 200);
    await page.getByText('回答已经保存，你仍然可以继续修改').waitFor();
  }), async () => { for (let i = 0; i < 5; i++) await request(resultsPath, { cookie: teacherCookie, label: 'teacher-poll-during-submit' }); }]);
  await stage('40 browser reloads preserve answers', pages.map(page => async () => {
    await page.reload();
    await page.getByRole('button', { name: '更新回答', exact: true }).waitFor();
    for (const question of activity.config.questions.filter(q => q.type === 'short-text')) assert(await page.getByRole('textbox', { name: question.title, exact: true }).inputValue());
  }));
  await stage('40 simultaneous repeat submissions', pages.map(page => async () => {
    const response = page.waitForResponse(r => r.url().endsWith('/submit'));
    await page.getByRole('button', { name: '更新回答', exact: true }).click();
    assert.equal((await response).status(), 200);
  }));
  const final = (await request(resultsPath, { cookie: teacherCookie, label: 'teacher-final' })).data.analytics;
  assert.equal(final.submittedCount, baseline.submittedCount + 40);
  assert.equal(final.totalStudents, baseline.totalStudents + 40);
  for (const q of final.questions) assert.equal(q.responseCount, baseline.questions.find(b => b.id === q.id).responseCount + 40);
  const context = await browser.newContext();
  await context.addCookies([{ name: 'openpbl_teacher', value: teacherToken, url: origin, httpOnly: true, secure: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/teacher/surveys/${activity.id}`);
  await page.getByRole('heading', { name: activity.title, exact: true }).waitFor();
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.equal(failedResources.length, 0, JSON.stringify(failedResources));
  report.browserErrors = errors.length;
  report.failedBrowserResources = failedResources.length;
  report.verified = { newStudents: 40, newRespondents: 40, repeatSubmissionInflation: 0, questions: final.questions.length, teacherPageRendered: true };
  report.success = true;
} catch (error) {
  report.success = false;
  report.error = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  agent.destroy();
  await db.$disconnect();
  report.finishedAt = new Date().toISOString();
  report.http = [...new Set(samples.map(s => s.label))].map(label => {
    const rows = samples.filter(s => s.label === label).sort((a, b) => a.ms - b.ms);
    return { label, count: rows.length, statuses: [...new Set(rows.map(s => s.status))], p95Ms: Math.round(rows[Math.ceil(rows.length * 0.95) - 1].ms), maxMs: Math.round(rows.at(-1).ms) };
  });
  fs.mkdirSync('docs/verification', { recursive: true });
  fs.writeFileSync('docs/verification/2026-09-15-survey-readiness.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ success: report.success, verified: report.verified }));
}
