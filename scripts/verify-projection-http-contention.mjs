/** Independent real HTTP/WS contention probe. Creates only UUID-owned fixtures;
 * never restarts services or changes a non-fixture classroom. Short JWTs remain
 * in memory. Run: CAPACITY_CONNECT_HOST=172.16.185.157 pnpm exec tsx scripts/verify-projection-http-contention.mjs
 */
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';
import { WebSocket } from 'ws';
import { configureCapacityNetwork } from './capacity-network.mjs';
import templateModule from '../src/lib/platform/pbl-template.ts';
const { createPblTemplateCourse, encodePblTemplate } = templateModule;

const runId = `capacity-${randomUUID()}`;
const origin = 'https://coteach.cn';
const network = configureCapacityNetwork(origin);
const rounds = Number(process.env.PROJECTION_CONTENTION_ROUNDS || 50);
const heartbeats = process.env.PROJECTION_CONTENTION_HEARTBEATS !== '0';
const includeState = process.env.PROJECTION_CONTENTION_INCLUDE_STATE !== '0';
const modes = (process.env.PROJECTION_CONTENTION_MODES || 'draft,mixed').split(',');
assert.ok(modes.length > 0 && new Set(modes).size === modes.length && modes.every(mode => ['draft', 'mixed'].includes(mode)));
assert.ok(Number.isInteger(rounds) && rounds >= 2 && rounds <= 60);
const output = path.resolve('test-results/capacity', runId);
await mkdir(output, { recursive: true, mode: 0o700 });
const url = new URL((await readFile('deploy/secrets/database_url.txt', 'utf8')).trim());
url.searchParams.set('connection_limit', '2');
const db = new PrismaClient({ datasourceUrl: url.href });
const secret = new TextEncoder().encode((await readFile('deploy/secrets/jwt_secret.txt', 'utf8')).trim());
const report = { runId, origin, connectAddress: network.address, startedAt: new Date().toISOString(), rounds, heartbeats, includeState, modes,
  deploymentId: process.env.PROJECTION_DEPLOYMENT_ID || null,
  workload: `real HTTP/42 WebSocket receivers; no mocked API; practice=40 draft${includeState ? '+40 state' : ''}${heartbeats ? '+40 heartbeat' : ''}; extra cross-stage stress=those plus40 quiz+40 progress`,
  fixture: null, batches: [], databaseWaitSamples: [], errors: [], outcome: 'running' };
const users = [], sockets = [], pendingProjection = new Map();
const metrics = new Map();
let instanceId, classroomId, monitorRunning = false;
const percentile = (list, p) => list.length ? list.toSorted((a, b) => a - b)[Math.ceil(list.length * p) - 1] : null;
const stats = list => ({ count: list.length, p95Ms: percentile(list, .95), maxMs: list.length ? Math.max(...list) : null });
async function request(actor, method, endpoint, body, category) {
  const start = performance.now();
  try {
    const response = await fetch(`${origin}${endpoint}`, { method, headers: { Origin: origin,
      Cookie: actor.cookie, 'X-OpenPBL-Role': actor.role, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
    const payload = await response.json().catch(() => null);
    assert.equal(response.status, 200, `${method} ${endpoint}: ${response.status} ${JSON.stringify(payload)?.slice(0, 500)}`);
    return payload;
  } finally {
    if (category) { const values = metrics.get(category) ?? []; values.push(performance.now() - start); metrics.set(category, values); }
  }
}
const action = (actor, value, category) => request(actor, 'POST', `/api/courses/${instanceId}/actions`, { requestId: randomUUID(), action: value }, category);
async function allFinished(work) {
  const results = await Promise.allSettled(work);
  const failures = results.filter(value => value.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(value => value.reason), String(failures[0].reason));
  return results.map(value => value.value);
}
async function seed() {
  for (let i = 0; i < 42; i++) {
    const role = i < 2 ? 'teacher' : 'student';
    const username = `${runId}-projection-${i}`;
    const user = await db.user.create({ data: { username, usernameKey: username, displayName: `投屏混合验收${i}`,
      role: role.toUpperCase(), passwordHash: `unusable-fixture-${randomBytes(24).toString('hex')}` } });
    const token = await new SignJWT({ role, sv: user.sessionVersion, username, displayName: user.displayName, studentName: user.displayName, userId: user.id })
      .setSubject(user.id).setProtectedHeader({ alg: 'HS256' }).setIssuer('openpbl').setAudience('openpbl-app')
      .setIssuedAt().setExpirationTime('30m').sign(secret);
    users.push({ id: user.id, role, index: i, cookie: `openpbl_${role}=${token}`, version: 0, submissionId: randomUUID() });
  }
  const design = createPblTemplateCourse(randomUUID(), { name: `投屏混合验收 ${runId}`, subject: '科学', grade: '七年级', drivingQuestion: '如何用真实测量验证节能方案？' });
  classroomId = `${runId}-projection-load`;
  design.aiLearningClassroomId = classroomId;
  design.pblConfig.makeArtifactMode = 'document';
  design.content.knowledgePoints = [{ id: 'energy', name: '节能证据', description: '比较相同条件下的用电量' }];
  const scenes = Array.from({ length: Math.max(rounds, 50) }, (_, i) => ({ id: `${runId}-quiz-${i}`, outlineId: `${runId}-quiz-${i}`,
    lectureSectionId: `${runId}-section-${i}`, type: 'quiz', title: `证据测验${i}`, order: i,
    stageKey: 'ai-learning', audience: 'student', generationPurpose: 'knowledge-teaching', knowledgePointIds: ['energy'], actions: [],
    content: { type: 'quiz', questions: [{ id: 'q1', type: 'single', question: '哪种证据支持节能结论？',
      options: [{ label: '比较相同条件下的用电量', value: 'A' }, { label: '凭感觉判断', value: 'B' }], answer: ['A'], points: 4, score: 4, explanation: '测量条件需相同。', knowledgePointIds: ['energy'] }] } }));
  design.content.knowledgeLectureSections = scenes.map((scene, i) => ({ id: scene.lectureSectionId, title: scene.title, quizOutlineId: scene.id, knowledgePointIds: ['energy'], sceneOutlineIds: [scene.id], order: i }));
  const template = await db.classroomTemplate.create({ data: { id: design.id, ownerId: users[0].id, title: design.name, status: 'PUBLISHED',
    versions: { create: { version: 1, status: 'PUBLISHED', snapshot: encodePblTemplate(design) } } }, include: { versions: true } });
  const offering = await db.courseOffering.create({ data: { name: design.name, description: runId, status: 'OPEN', teachers: { create: users.slice(0, 2).map(user => ({ userId: user.id })) } } });
  const chapter = await db.chapter.create({ data: { offeringId: offering.id, title: '独立混合锁验收', position: 0, isOpen: true } });
  const activity = await db.activity.create({ data: { chapterId: chapter.id, title: design.name, position: 0, type: 'CLASSROOM', isOpen: true } });
  const instance = await db.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: template.versions[0].id,
    status: 'TEACHING', startedAt: new Date(), runtimeConfig: { version: 1, currentStageIndex: 1, classConfig: { groupMode: 'solo', totalStudents: 40, perGroup: 1, crossClass: false } } } });
  instanceId = instance.id;
  for (const user of users.slice(2)) {
    const enrollment = await db.enrollment.create({ data: { offeringId: offering.id, userId: user.id } });
    await db.classroomParticipation.create({ data: { instanceId, enrollmentId: enrollment.id, firstEnteredAt: new Date() } });
  }
  await mkdir('.openpbl-data/classrooms', { recursive: true });
  await writeFile(`.openpbl-data/classrooms/${classroomId}.json`, JSON.stringify({ id: classroomId, revision: 1, createdAt: new Date().toISOString(),
    stage: { id: classroomId, name: design.name, description: design.drivingQuestion, mode: 'playback', createdAt: Date.now(), updatedAt: Date.now() }, scenes }));
  report.fixture = { offeringId: offering.id, templateId: template.id, instanceId, activityId: activity.id, chapterId: chapter.id, classroomId, userIds: users.map(user => user.id) };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  return scenes;
}
async function connect(user) {
  const socket = new WebSocket(`wss://coteach.cn/ws?role=${user.role}`, { headers: { Cookie: user.cookie, Origin: origin }, lookup: network.lookup, handshakeTimeout: 10_000 });
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Subscribe timeout')), 10_000);
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.once('open', () => {
      const address = socket._socket?.remoteAddress?.replace(/^::ffff:/, '');
      if (address !== network.address) { clearTimeout(timer); socket.close(); reject(new Error(`Unexpected WS peer ${address}`)); return; }
      socket.send(JSON.stringify({ type: 'subscribe', courseId: instanceId }));
    });
    socket.on('message', data => {
      let item; try { item = JSON.parse(data.toString()); } catch { return; }
      if (item.type === 'subscribed') { clearTimeout(timer); resolve(); }
      const marker = item.event?.payload?.teacherResourceProjection?.title;
      const pending = pendingProjection.get(marker);
      if (pending && !pending.receivers.has(user.id)) pending.receivers.set(user.id, performance.now() - pending.started);
    });
  });
}
async function projection(scene, category) {
  const marker = `${runId}-${randomUUID()}`;
  const pending = { started: performance.now(), receivers: new Map() };
  pendingProjection.set(marker, pending);
  const result = await action(users[0], { type: 'SET_UI_STATE', payload: { courseId: instanceId, projectionControl: { clientId: runId },
    patch: { teacherResourceProjection: { classroomId, sceneId: scene.id, sceneType: 'quiz', stageKey: 'ai-learning', title: marker, startedAt: new Date().toISOString() } } } }, `${category}-projection-http`);
  const httpMs = performance.now() - pending.started;
  while (pending.receivers.size < users.length && performance.now() - pending.started < 10_000) await delay(10);
  assert.equal(pending.receivers.size, users.length, 'Every projection must reach all 42 subscribers');
  return { httpMs, receivers: pending.receivers.size, websocket: stats([...pending.receivers.values()]), courseVersion: result.courseVersion };
}
async function save(user, batch) {
  const now = new Date().toISOString();
  const content = `<h1>节能方案${user.index}</h1><p>保存批次${batch}。${'比较相同条件下的用电量，并保留真实测量证据。'.repeat(100)}</p>`;
  const result = await action(user, { type: 'UPSERT_SUBMISSION', payload: { courseId: instanceId, expectedSubmissionVersion: user.version,
    submission: { id: user.submissionId, courseId: instanceId, studentId: user.id, studentName: `学生${user.index}`, stageKey: 'make', type: 'document', title: '节能方案', content,
      status: 'draft', version: user.version + 1, createdAt: now, updatedAt: now } } }, `${batch.split('-')[0]}-draft`);
  assert.equal(result.submissionVersion, user.version + 1);
  user.version = result.submissionVersion;
}
async function heartbeat(user, scene, mode) {
  const id = randomUUID();
  const result = await request(user, 'POST', '/api/learning-events', { courseId: instanceId, studentId: user.id,
    events: [{ id, idempotencyKey: id, courseId: instanceId, studentId: user.id, stageKey: mode === 'draft' ? 'make' : 'ai-learning', sceneId: scene.id,
      type: 'heartbeat', occurredAt: new Date().toISOString(), durationMs: 1000, visible: true }] }, `${mode}-heartbeat`);
  assert.ok(result.acceptedIds.includes(id));
}
try {
  const scenes = await seed();
  await allFinished(users.map(connect));
  monitorRunning = true;
  const monitor = (async () => {
    while (monitorRunning) {
      const [sample] = await db.$queryRaw`SELECT count(*) FILTER (WHERE NOT granted AND locktype='advisory')::int AS "advisoryWaiters",
        count(*) FILTER (WHERE NOT granted AND locktype IN ('tuple','transactionid'))::int AS "rowWaiters" FROM pg_locks`;
      report.databaseWaitSamples.push({ at: new Date().toISOString(), ...sample });
      await delay(100);
    }
  })();
  try {
    for (const mode of modes) {
      await action(users[0], { type: 'SET_STAGE', payload: { id: instanceId, index: mode === 'draft' ? 2 : 1 } });
      for (let round = 0; round < rounds; round++) {
      const scene = scenes[round];
      const start = performance.now();
      const requests = users.slice(2).flatMap(user => [save(user, `${mode}-${round}`),
        ...(includeState ? [request(user, 'GET', `/api/courses/${instanceId}/state`, undefined, `${mode}-state`)] : []),
        ...(heartbeats ? [heartbeat(user, scene, mode)] : []),
        ...(mode === 'mixed' ? [
          request(user, 'POST', '/api/knowledge-lecture', { action: 'record-attempt', courseId: instanceId, studentId: user.id, sectionId: scene.lectureSectionId,
            quizOutlineId: scene.id, runtimeSceneId: scene.id, answers: { q1: 'A' } }, `${mode}-quiz`),
          request(user, 'POST', '/api/openmaic/progress', { requestId: randomUUID(), courseId: instanceId, studentId: user.id, classroomId, currentSceneIndex: round,
            totalScenes: scenes.length, completedScenes: scenes.slice(0, round + 1).map(value => value.id), completionModelVersion: 2 }, `${mode}-progress`),
        ] : [])]);
      let delivery;
      const projectionOffsetMs = 90 + (round * 173) % 900;
      requests.push((async () => { await delay(projectionOffsetMs); delivery = await projection(scene, mode); })());
      await allFinished(requests);
      const batch = { mode, round, projectionOffsetMs, durationMs: performance.now() - start, projection: delivery };
      report.batches.push(batch);
      console.log(JSON.stringify(batch));
      // Keep each student's writes below the real per-minute rate limit even
      // if admission makes a batch very quick. All work inside a batch remains simultaneous.
      await delay(Math.max(200, 1000 - (performance.now() - start)));
      }
      report.metrics = Object.fromEntries([...metrics].map(([key, values]) => [key, stats(values)]));
      report.lastCompletedMode = mode;
      await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ checkpoint: mode, metrics: Object.fromEntries(Object.entries(report.metrics).filter(([key]) => key.startsWith(`${mode}-`))) }));
    }
  } finally { monitorRunning = false; await monitor; }
  const submissions = await db.classroomSubmission.findMany({ where: { participation: { instanceId }, stageKey: 'make:document' } });
  assert.equal(submissions.length, 40);
  for (const user of users.slice(2)) {
    const row = submissions.find(value => value.payload?.view?.studentId === user.id);
    assert.equal(row?.payload?.view?.version, rounds * modes.length);
  }
  if (heartbeats) assert.equal(await db.learningEvent.count({ where: { classroomInstanceId: instanceId } }), 40 * rounds * modes.length);
  report.outcome = 'measured';
} catch (error) {
  report.outcome = 'failed'; report.errors.push(String(error)); process.exitCode = 1;
} finally {
  monitorRunning = false;
  for (const socket of sockets) socket.close();
  await delay(100);
  for (const socket of sockets) if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  await db.$disconnect();
  report.metrics = Object.fromEntries([...metrics].map(([key, values]) => [key, stats(values)]));
  report.finishedAt = new Date().toISOString();
  report.maxAdvisoryWaiters = Math.max(0, ...report.databaseWaitSamples.map(value => value.advisoryWaiters));
  report.projectionRequests = stats(report.batches.map(value => value.projection.httpMs));
  report.projectionLastReceivers = stats(report.batches.map(value => value.projection.websocket.maxMs));
  report.byMode = Object.fromEntries(modes.map(mode => [mode, { projection: stats(report.batches.filter(value => value.mode === mode).map(value => value.projection.httpMs)), lastReceiver: stats(report.batches.filter(value => value.mode === mode).map(value => value.projection.websocket.maxMs)) }]));
  report.acceptance = { projectionP95Under500ms: report.projectionRequests.p95Ms <= 500, lastReceiverP95Under500ms: report.projectionLastReceivers.p95Ms <= 500, practiceSaveP95Under2000ms: report.metrics['draft-draft']?.p95Ms <= 2000 };
  if (includeState && modes.includes('draft')) report.acceptance.practiceReadP95Under1000ms = report.metrics['draft-state']?.p95Ms <= 1000;
  if (report.outcome === 'measured' && Object.values(report.acceptance).some(value => !value)) { report.outcome = 'latency-failed'; process.exitCode = 1; }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, outcome: report.outcome, projection: report.projectionRequests, delivery: report.projectionLastReceivers, maxAdvisoryWaiters: report.maxAdvisoryWaiters, errors: report.errors }));
}
