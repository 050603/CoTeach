/** Real V2 classroom workload. Run with pnpm exec tsx; fixtures are UUID owned.
 * Credentials are read locally and never written to the public report.
 * The retired HTTP fixture API remains disabled. */
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, statfs } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { freemem, loadavg } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { WebSocket } from 'ws';
import { chromium } from 'playwright';
import { configureCapacityNetwork } from './capacity-network.mjs';
import { recoverCapacityAiRequest } from './capacity-retry.mjs';
import { evaluateCapacityAiGates } from './capacity-ai-gates.mjs';
import { retainLearningAcknowledgement, verifyLearningEventRecord } from './verify-capacity-learning-records.mjs';
import { ensureCapacityPersonalGroups, uploadCapacityExternalArtifacts } from './verify-capacity-external-artifacts.mjs';
import { capacityCommentTarget, verifyCapacityDocumentComments } from './verify-capacity-document-comments.mjs';
import { verifyCapacityDocumentBrowsers } from './verify-capacity-document-browser.mjs';
import { progressReplaySnapshot, verifyBrowserReviewRecords, verifyProgressReceipt } from './verify-capacity-browser-records.mjs';
import { seedCapacityLectureScene, verifyCapacityLectureBrowsers } from './verify-capacity-lecture-browsers.mjs';
import { captureCapacityBrowserEvents, seedCapacityProjectionScene, verifyCapacityProjectionBrowser } from './verify-capacity-projection-browser.mjs';
import { capacityExperimentConfig, prepareStudentAssessment, verifyExtendedClassroom, seedCapacitySubjectiveQuiz, verifySubjectiveGrading } from './verify-capacity-extensions.mjs';
import passwordModule from '../src/lib/auth/password.ts';
const { hashPassword } = passwordModule;
import templateModule from '../src/lib/platform/pbl-template.ts';
const { createPblTemplateCourse, encodePblTemplate } = templateModule;
import audioDurationModule from '../src/lib/openmaic/audio/audio-duration.ts';
const { audioDurationSec } = audioDurationModule;

if (process.argv.includes('--help')) { console.log('CAPACITY_MINUTES=120 CAPACITY_STUDENTS=40 CAPACITY_REAL_AI=1 pnpm exec tsx scripts/verify-classroom-capacity.mjs'); process.exit(0); }
const root = path.resolve(import.meta.dirname, '..');
const runId = `capacity-${randomUUID()}`;
const origin = new URL(process.env.CAPACITY_BASE_URL || 'https://coteach.cn').origin;
const network = configureCapacityNetwork(origin);
const durationMinutes = Number(process.env.CAPACITY_MINUTES || 120);
const studentCount = Number(process.env.CAPACITY_STUDENTS || 40);
const documentRepeats = Number(process.env.CAPACITY_DOCUMENT_REPEATS || 120);
assert.ok(Number.isFinite(durationMinutes) && durationMinutes >= 0 && durationMinutes <= 240);
assert.ok(Number.isInteger(studentCount) && studentCount >= 2 && studentCount <= 40);
assert.ok(Number.isInteger(documentRepeats) && documentRepeats >= 30 && documentRepeats <= 1000);
const output = path.resolve(process.env.CAPACITY_OUTPUT_DIR || `test-results/capacity/${runId}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const databaseUrl = process.env.CAPACITY_DATABASE_URL || (await readFile(path.join(root, 'deploy/secrets/database_url.txt'), 'utf8')).trim();
const db = new PrismaClient({ datasourceUrl: databaseUrl });
const password = randomBytes(24).toString('base64url');
const startedAt = new Date();
const users = [];
const sockets = [];
const checks = [];
const metrics = new Map();
const expected = new Map();
const sentProjection = new Map();
const projectionLatencies = [];
const projectionReceivers = new Map();
let fixture;
let browser;
let stopped = false;
let failedRequests = 0;
let totalRequests = 0;
const report = { runId, origin, startedAt: startedAt.toISOString(), durationMinutes, studentCount,
  workload: 'real-v2-http-websocket', documentRepeats, network: { scope: 'internal', connectAddress: network.address }, checks, outcome: 'running', metrics: {}, fixture: null };
const record = (name, status, detail) => {
  checks.push({ name, status, ...(detail ? { detail } : {}) });
  console.log(`${status} ${name}${detail ? ` ${JSON.stringify(detail)}` : ''}`);
};
const percentile = (values, quantile) => values.length ? [...values].sort((a,b) => a-b)[Math.ceil(values.length*quantile)-1] : null;
async function allCompleted(work) {
  const results = await Promise.allSettled(work);
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), String(failures[0].reason));
  return results.map(result => result.value);
}
async function flushReport() {
  let monitoringFailure;
  report.metrics = Object.fromEntries([...metrics].map(([key, value]) => [key, {
    count: value.times.length, errors: value.errors, p95Ms: percentile(value.times, .95), p99Ms: percentile(value.times, .99), firstResponseP95Ms: percentile(value.operationTimes ?? value.firstResponseTimes ?? [], .95),
    ...(value.operationTimes ? { operationP95Ms: percentile(value.operationTimes, .95), operationCount: value.operationTimes.length, attemptFirstResponseP95Ms: percentile(value.firstResponseTimes ?? [], .95) } : {}),
  }]));
  report.projection = { samples: projectionLatencies.length, p95Ms: percentile(projectionLatencies, .95), p99Ms: percentile(projectionLatencies, .99) };
  report.expected = Object.fromEntries(expected);
  report.projectionDelivery = [...projectionReceivers].map(([marker, receivers]) => ({ marker, delivered: receivers.size, expected: users.length }));
  report.totalRequests = totalRequests;
  report.failedRequests = failedRequests;
  report.updatedAt = new Date().toISOString();
  if (!report.healthSnapshots?.length || Date.now() - Date.parse(report.healthSnapshots.at(-1).at) >= 55000) {
    const disk = await statfs(root);
    const snapshot = { at: report.updatedAt, availableMemoryBytes: freemem(), availableDiskBytes: disk.bavail * disk.bsize, loadAverage: loadavg() };
    try {
      const token = (await readFile(path.join(root, 'deploy/secrets/monitor_token.txt'), 'utf8')).trim();
      const response = await fetch('http://127.0.0.1:3000/api/metrics', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      snapshot.application = Object.fromEntries((await response.text()).split('\n').filter(line => /^(process_resident_memory_bytes|nodejs_eventloop_lag_p99_seconds|openpbl_(postgres_|course_admission_|classroom_ai_|ai_audit_outbox_|local_backup_))/.test(line)).map(line => { const [key, value] = line.split(' '); return [key, Number(value)]; }));
    } catch (error) { snapshot.metricsError = String(error); }
    report.healthSnapshots ??= []; report.healthSnapshots.push(snapshot);
    const required = ['openpbl_postgres_connections', 'openpbl_postgres_connection_limit', 'openpbl_postgres_lock_waiters', 'openpbl_classroom_ai_active', 'openpbl_classroom_ai_pending', 'openpbl_ai_audit_outbox_pending', 'openpbl_ai_audit_outbox_quarantined', 'openpbl_local_backup_checkpoint_timestamp_seconds'];
    const unavailable = required.filter(key => !Number.isFinite(snapshot.application?.[key]));
    const checkpoint = snapshot.application?.openpbl_local_backup_checkpoint_timestamp_seconds ?? 0;
    if (snapshot.metricsError || unavailable.length) monitoringFailure = `Monitoring unavailable: ${snapshot.metricsError || unavailable.join(', ')}`;
    else if (Date.now()/1000 - checkpoint > 900) monitoringFailure = 'Local backup checkpoint is older than the 15-minute recovery target';
    else if (snapshot.application.openpbl_ai_audit_outbox_quarantined > 0) monitoringFailure = 'Quarantined audit records require investigation before continuing the workload';
    if (snapshot.availableMemoryBytes < 1024 ** 3 || snapshot.availableDiskBytes < 5 * 1024 ** 3) monitoringFailure = 'Host memory or disk safety threshold reached';
    if (monitoringFailure) { stopped = true; snapshot.stopReason = monitoringFailure; }
  }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (monitoringFailure && report.outcome === 'running') throw new Error(`Stopping workload: ${monitoringFailure}`);
}
async function request(actor, method, endpoint, body, { expectedStatus = 200, category = method === 'GET' ? 'read' : 'write', raw = false, timeout = 30000, headers = {} } = {}) {
  const started = performance.now();
  const metric = metrics.get(category) ?? { times: [], errors: 0 };
  metrics.set(category, metric);
  totalRequests++;
  try {
    const response = await fetch(`${origin}${endpoint}`, {
      method, headers: { Origin: origin, ...(actor?.cookie ? { Cookie: actor.cookie } : {}), ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), 'X-OpenPBL-Role': actor?.role ?? 'student', ...headers },
      ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeout),
    });
    const cookies = response.headers.getSetCookie();
    if (actor && cookies.length) actor.cookie = cookies.map(item => item.split(';')[0]).join('; ');
    metric.firstResponseTimes ??= []; metric.firstResponseTimes.push(performance.now() - started);
    const payload = raw ? Buffer.from(await response.arrayBuffer()) : await response.json().catch(() => null);
    if (response.status !== expectedStatus) throw Object.assign(new Error(`${method} ${endpoint}: ${response.status} ${JSON.stringify(payload).slice(0, 400)}`), { status: response.status, payload });
    return payload;
  } catch (error) {
    metric.errors++; failedRequests++;
    throw error;
  } finally {
    const elapsed = performance.now() - started;
    metric.times.push(elapsed);
    if (method === 'GET' && !raw) {
      const reads = metrics.get('ordinary-reads') ?? { times: [], errors: 0 };
      reads.times.push(elapsed); metrics.set('ordinary-reads', reads);
    }
  }
}
const coursePath = (suffix) => `/api/courses/${fixture.instanceId}/${suffix}`;
async function action(actor, actionValue, options = {}) {
  const requestId = options.requestId ?? randomUUID();
  return request(actor, 'POST', coursePath('actions'), { requestId, action: actionValue }, options);
}
async function setStage(index) {
  await action(users[0], { type: 'SET_STAGE', payload: { id: fixture.instanceId, index } });
}
async function seed() {
  const passwordHash = await hashPassword(password);
  for (let index = 0; index < studentCount + 2; index++) {
    const role = index < 2 ? 'teacher' : 'student';
    const username = `${runId}-${index}`;
    const user = await db.user.create({ data: { username, usernameKey: username, displayName: `并发验收${role}${index}`, role: role.toUpperCase(), passwordHash } });
    users.push({ id: user.id, username, role, index, cursor: '0' });
  }
  const design = createPblTemplateCourse(randomUUID(), { name: `并发验收 ${runId}`, subject: '科学', grade: '七年级',
    drivingQuestion: '如何依据测量证据改进教室节能方案？' });
  const classroomId = `${runId}-lesson`;
  const quizId = `${runId}-quiz`;
  const sectionId = `${runId}-section`;
  design.aiLearningClassroomId = classroomId;
  design.content.knowledgePoints = [{ id: 'energy', name: '节能证据', description: '用测量数据支持改进方案' }];
  design.content.knowledgeLectureSections = [{ id: sectionId, title: '证据与结论', quizOutlineId: quizId, knowledgePointIds: ['energy'], sceneOutlineIds: [quizId], order: 0 }];
  const subjective = process.env.CAPACITY_REAL_AI === '1' ? seedCapacitySubjectiveQuiz({ runId }) : null;
  const lecture = process.env.CAPACITY_REAL_AI === '1' ? seedCapacityLectureScene({ runId, sectionId, audioUrl: '', speechText: '请在相同条件下比较改进前后的用电量。', repeatCount: 120 }) : null;
  if (lecture) design.content.knowledgeLectureSections[0].sceneOutlineIds.unshift(lecture.sceneId);
  if (subjective) design.content.knowledgeLectureSections.push(subjective.section);
  const projection = seedCapacityProjectionScene({ runId });
  design.content._openmaicSceneOutlines = [...(design.content._openmaicSceneOutlines ?? []), ...(lecture ? [lecture.outline] : []), projection.outline];
  design.pblConfig.makeArtifactMode = 'document';
  const template = await db.classroomTemplate.create({ data: { id: design.id, ownerId: users[0].id, title: design.name, status: 'PUBLISHED',
    versions: { create: { version: 1, status: 'PUBLISHED', snapshot: encodePblTemplate(design) } } }, include: { versions: true } });
  const offering = await db.courseOffering.create({ data: { name: design.name, description: runId, status: 'OPEN', teachers: { create: users.slice(0,2).map(u => ({ userId: u.id })) } } });
  const chapter = await db.chapter.create({ data: { offeringId: offering.id, title: '验收专用', position: 0, isOpen: true } });
  const activity = await db.activity.create({ data: { chapterId: chapter.id, title: design.name, type: 'CLASSROOM', position: 0, isOpen: true, config: { schemaVersion: 1, experiment: capacityExperimentConfig } } });
  const instance = await db.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: template.versions[0].id, status: 'SCHEDULED', runtimeConfig: { version: 1, classConfig: { groupMode: 'solo', totalStudents: studentCount, perGroup: 1, crossClass: false } } } });
  const survey = await db.activity.create({ data: { chapterId: chapter.id, title: '验收课前问卷', type: 'FORM', position: 1, isOpen: true,
    config: { schemaVersion: 1, questions: [{ id: 'evidence', title: '你会记录哪些证据？', type: 'short-text', required: true, options: [] }] } } });
  for (const user of users.slice(2)) {
    const enrollment = await db.enrollment.create({ data: { offeringId: offering.id, userId: user.id } });
    user.enrollmentId = enrollment.id;
  }
  const classroom = { id: classroomId, createdAt: new Date().toISOString(), revision: 1,
    stage: { id: classroomId, name: design.name, description: design.drivingQuestion, mode: 'playback', createdAt: Date.now(), updatedAt: Date.now() },
    scenes: [{ id: quizId, outlineId: quizId, lectureSectionId: sectionId, type: 'quiz', title: '证据测验', order: 0,
      stageKey: 'ai-learning', audience: 'student', generationPurpose: 'knowledge-teaching', knowledgePointIds: ['energy'], actions: [],
      content: { type: 'quiz', questions: [{ id: 'q1', type: 'single', question: '哪一种做法能支持节能结论？', options: [{ label: '比较改进前后的用电量', value: 'A' }, { label: '只凭感觉判断', value: 'B' }], answer: ['A'], points: 4, explanation: '在相同条件下比较用电量。', score: 4, knowledgePointIds: ['energy'] }] } }],
  };
  if (subjective) classroom.scenes.push(subjective.scene);
  if (lecture) classroom.scenes.unshift(lecture.scene);
  classroom.scenes.push(projection.scene);
  const classroomDir = path.join(root, '.openpbl-data/classrooms');
  await mkdir(classroomDir, { recursive: true });
  await writeFile(path.join(classroomDir, `${classroomId}.json`), JSON.stringify(classroom));
  fixture = { offeringId: offering.id, templateId: template.id, instanceId: instance.id, activityId: activity.id, surveyId: survey.id, chapterId: chapter.id, classroomId, quizId, sectionId, projectionSceneId: projection.sceneId, ...(subjective ? { subjectiveQuizId: subjective.quizId, subjectiveSectionId: subjective.sectionId } : {}), ...(lecture ? { lectureSceneId: lecture.sceneId } : {}), userIds: users.map(u=>u.id) };
  report.fixture = fixture;
  fixture.modelOutputEvidenceVersion = 1;
  await flushReport();
  record('isolated-fixtures', '通过', { teachers: 2, students: studentCount });
}
async function loginAndEnter() {
  await allCompleted(users.map(async user => {
    await request(user, 'POST', `/api/platform/auth/${user.role === 'teacher' ? 'teacher-login' : 'login'}`, { username: user.username, password }, { category: 'login' });
  }));
  await request(users[0], 'POST', `/api/platform/classroom-instances/${fixture.instanceId}/start`, {});
  await allCompleted(users.slice(2).map(async user => {
    await prepareStudentAssessment({ user, fixture, request });
    user.participationId = (await request(user, 'POST', `/api/platform/classroom-instances/${fixture.instanceId}/enter`, {})).participation.id;
    await request(user, 'POST', `/api/platform/activities/${fixture.surveyId}/submit`, { answers: { evidence: `验收学生${user.index}：用电量和测量时间` } });
    expected.set(user.id, { saves: 0, version: 0, events: [], archives: [] });
  }));
  record('concurrent-login-entry-survey', '通过');
}
async function connect(actor) {
  const url = new URL(`/ws?role=${actor.role}`, origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url, { headers: { Cookie: actor.cookie, Origin: origin }, handshakeTimeout: 10000, lookup: network.lookup });
  sockets.push(socket); actor.socket = socket;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket subscribe timeout')), 10000);
    socket.once('error', reject);
    socket.once('open', () => {
      const address = socket._socket?.remoteAddress?.replace(/^::ffff:/, '');
      if (address !== network.address) { clearTimeout(timer); reject(new Error(`WebSocket used unexpected address: ${address}`)); socket.close(); return; }
      socket.send(JSON.stringify({ type: 'subscribe', courseId: fixture.instanceId }));
    });
    socket.on('message', data => {
      let item; try { item = JSON.parse(data.toString()); } catch { return; }
      if (item.type === 'subscribed') { clearTimeout(timer); resolve(); }
      const marker = item.event?.payload?.teacherResourceProjection?.title;
      if (marker && sentProjection.has(marker) && !projectionReceivers.get(marker).has(actor.id)) { projectionReceivers.get(marker).add(actor.id); projectionLatencies.push(performance.now() - sentProjection.get(marker)); }
    });
  });
}
async function project(stageKey = 'ai-learning') {
  const marker = `${runId}-${randomUUID()}`;
  sentProjection.set(marker, performance.now());
  projectionReceivers.set(marker, new Set());
  return action(users[0], { type: 'SET_UI_STATE', payload: { courseId: fixture.instanceId,
    projectionControl: { clientId: runId }, patch: { teacherResourceProjection: { classroomId: fixture.classroomId, sceneId: fixture.quizId, sceneType: 'quiz', stageKey, title: marker, startedAt: new Date().toISOString() } } } }, { category: 'projection-write' });
}
async function saveStudent(user) {
  const state = expected.get(user.id);
  const time = new Date().toISOString();
  const content = `<h1>节能方案 ${user.index}</h1><p>验收轮次 ${state.saves+1}，${'使用测量证据比较改进前后的用电量。'.repeat(documentRepeats)}</p><p>${capacityCommentTarget}</p>`;
  report.maxProtocolDocumentBytes = Math.max(report.maxProtocolDocumentBytes ?? 0, Buffer.byteLength(content));
  state.submissionId ??= randomUUID();
  const requestId = randomUUID();
  const value = { type: 'UPSERT_SUBMISSION', payload: { courseId: fixture.instanceId, expectedSubmissionVersion: state.version,
    submission: { id: state.submissionId, courseId: fixture.instanceId, studentId: user.id, studentName: `验收学生${user.index}`, ...(state.groupId ? { groupId: state.groupId } : {}), stageKey: 'make', type: 'document', title: '项目节能方案', content, version: state.version+1, status: 'draft', createdAt: time, updatedAt: time } } };
  const ack = await action(user, value, { requestId, category: 'draft-save' });
  state.receipts ??= []; state.receipts.push({ requestId, version: ack.submissionVersion, contentSha256: createHash('sha256').update(content).digest('hex') });
  state.saves++; state.version = ack.submissionVersion ?? state.version+1; state.content = content; state.lastAction = value; state.lastRequestId = requestId; state.lastAck = ack;
}
async function lesson() {
  await setStage(1);
  await allCompleted(users.slice(2).map(async user => {
    const attempt = await request(user, 'POST', '/api/knowledge-lecture', { action: 'record-attempt', courseId: fixture.instanceId, studentId: user.id, sectionId: fixture.sectionId, quizOutlineId: fixture.quizId, runtimeSceneId: fixture.quizId, answers: { q1: 'A' } }, { category: 'quiz' });
    expected.get(user.id).attemptId = attempt.attempt.id;
    const completedScenes = [fixture.lectureSceneId, fixture.quizId].filter(Boolean);
    const state = expected.get(user.id);
    state.progressRequestId = randomUUID();
    state.progressBody = { requestId: state.progressRequestId, courseId: fixture.instanceId, studentId: user.id, classroomId: fixture.classroomId,
      currentSceneIndex: completedScenes.length - 1, totalScenes: completedScenes.length, completedScenes, completionModelVersion: 2 };
    state.progressAck = await request(user, 'POST', '/api/openmaic/progress', state.progressBody, { category: 'progress' });
    assert.deepEqual(await request(user, 'POST', '/api/openmaic/progress', state.progressBody, { category: 'progress-replay' }), state.progressAck);
  }));
  record('concurrent-quiz-and-progress', '通过');
}
async function observeAiQueue(label, work) {
  const token = (await readFile(path.join(root, 'deploy/secrets/monitor_token.txt'), 'utf8')).trim();
  let observing = true;
  const samples = [];
  const monitor = (async () => {
    while (observing) {
      try {
        const response = await fetch('http://127.0.0.1:3000/api/metrics', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 200);
        const values = Object.fromEntries((await response.text()).split('\n').filter(line => /^openpbl_classroom_ai_(active|pending|limit) /.test(line)).map(line => { const [key, value] = line.split(' '); return [key, Number(value)]; }));
        samples.push({ at: new Date().toISOString(), ...values });
      } catch (error) { samples.push({ at: new Date().toISOString(), error: String(error) }); }
      if (observing) await delay(1000);
    }
  })();
  try { return await work(); }
  finally {
    observing = false; await monitor;
    report.aiQueueSamples ??= []; report.aiQueueSamples.push({ label, samples });
  }
}
async function realAi() {
  if (process.env.CAPACITY_REAL_AI !== '1') { record('real-ai', '未验证', 'CAPACITY_REAL_AI=1 enables real provider requests'); return; }
  await setStage(1);
  await verifySubjectiveGrading({ users, fixture, db, request, record, expected });
  await observeAiQueue('learning-tutor', () => allCompleted(users.slice(2).map(async user => {
    const state = expected.get(user.id);
    state.tutorRequestId = randomUUID();
    const operation = { kind: 'learning', requestId: state.tutorRequestId, status: 'started', firstAttemptFailed: false };
    state.aiOperations ??= []; state.aiOperations.push(operation);
    const started = performance.now();
    try {
    const result = await request(user, 'POST', '/api/knowledge-lecture', { action: 'tutor-message', courseId: fixture.instanceId, studentId: user.id, attemptId: state.attemptId, questionId: 'q1', requestId: state.tutorRequestId, message: '为什么需要在相同条件下比较用电量？请用两句话解释。' }, { category: 'real-ai-learning', timeout: 180000 });
    assert.ok(result.thread?.messages?.some(message=> message.role === 'ai' || message.role === 'assistant'), 'Tutor returned no answer');
      operation.status = 'completed';
    } catch (error) { operation.status = 'failed'; operation.firstAttemptFailed = true; throw error; }
    finally { operation.elapsedMs = performance.now() - started; }
  })));
  record('real-ai-learning-burst', '通过', { students: studentCount });
  await setStage(2);
  await realDocumentAi(false);
}
async function realDocumentAi(afterLearning) {
  let documentAiFinished = false;
  let overlappingSaveBatches = 0;
  const documentAi = allCompleted(users.slice(2).map(async user => {
    const state = expected.get(user.id);
    const requestId = randomUUID();
    if (afterLearning) { state.followupDocumentRequests ??= []; state.followupDocumentRequests.push(requestId); }
    else state.documentRequestId = requestId;
    const category = afterLearning ? 'real-ai-document-after-learning' : 'real-ai-document';
    const body = { courseId: fixture.instanceId, studentId: user.id, stageKey: 'make', intent: 'discuss', requestId, message: '如何记录一次节能测量的条件？请简短提示。', documentHtml: state.content ?? '<p>我们打算比较改进前后的用电量。</p>', workspaceKind: 'document' };
    const operation = { kind: 'document', requestId, status: 'started', firstAttemptFailed: false };
    state.aiOperations ??= []; state.aiOperations.push(operation);
    const operationStarted = performance.now();
    try {
    const recovered = await recoverCapacityAiRequest(timeout => request(user, 'POST', '/api/ai-collaboration/document', body, { category, timeout }), {
      onRetry: failure => {
        operation.firstAttemptFailed = true;
        state.aiFailures ??= []; state.aiFailures.push({ requestId, ...failure });
        record('ai-request-retry-after-explicit-failure', '未通过', { requestId, ...failure });
      },
    });
    const result = recovered.value;
    // This endpoint is non-streaming: first usable answer includes any failed
    // attempt and retry wait. Preserve per-attempt failures in request metrics.
    const metric = metrics.get(category); metric.operationTimes ??= []; metric.operationTimes.push(recovered.elapsedMs);
    assert.ok(result.result?.message, 'Document assistant returned no answer');
    operation.status = 'completed'; operation.attempts = recovered.attempts;
    } catch (error) { operation.status = 'failed'; operation.firstAttemptFailed = true; throw error; }
    finally { operation.elapsedMs = performance.now() - operationStarted; }
  })).finally(() => { documentAiFinished = true; });
  const concurrentSaves = (async () => {
    do {
      const started = Date.now();
      const saves = users.slice(2).map(async user => {
        await saveStudent(user);
        await request(user, 'GET', coursePath('state'), undefined, { category: 'document-ai-overlap-state' });
      });
      if (afterLearning) saves.push(delay(90).then(() => project('make')));
      await allCompleted(saves);
      overlappingSaveBatches++;
      if (!documentAiFinished) await delay(Math.max(0, 5000 - (Date.now() - started)));
    } while (!documentAiFinished);
  })();
  await observeAiQueue(afterLearning ? 'document-after-learning' : 'document-initial', () => allCompleted([documentAi, concurrentSaves]));
  record('real-ai-document-burst-with-concurrent-autosave', '通过', { students: studentCount, overlappingSaveBatches, afterLearning });
}
async function speechSmoke() {
  if (process.env.CAPACITY_REAL_AI !== '1') return;
  const teacher = users[0];
  const config = await request(teacher, 'GET', '/api/openmaic/provider-config?section=tts');
  const candidate = Object.entries(config.providers ?? {}).find(([, value]) => value.enabled !== false && value.hasApiKey);
  assert.ok(candidate, 'No enabled speech provider with credentials');
  const [providerId, provider] = candidate;
  const result = await request(teacher, 'POST', '/api/openmaic/generate/tts', {
    audioId: randomUUID(), text: '请在相同条件下比较改进前后的用电量。', ttsProviderId: providerId,
    ttsVoice: provider.defaultVoice || provider.scenarioConfigs?.['realtime-interaction']?.voiceId,
    ttsModelId: provider.defaultModel || provider.models?.[0],
  }, { category: 'speech', timeout: 90000 });
  const bytes = Buffer.from(result.base64 || result.data?.base64 || '', 'base64');
  assert.ok(bytes.length > 500, 'TTS did not return playable audio');
  record('real-speech-synthesis', '通过', { providerId, bytes: bytes.length });
  const asr = await request(teacher, 'GET', '/api/openmaic/provider-config?section=asr');
  const recognizer = Object.entries(asr.providers ?? {}).find(([, value]) => value.enabled !== false && value.hasApiKey);
  assert.ok(recognizer, 'No enabled speech recognition provider');
  const format = String(result.format || result.data?.format || 'wav');
  const form = new FormData();
  form.set('audio', new Blob([bytes], { type: format === 'mp3' ? 'audio/mpeg' : `audio/${format}` }), `speech.${format}`);
  form.set('providerId', recognizer[0]); form.set('language', 'zh');
  const model = recognizer[1].defaultModel || recognizer[1].models?.[0];
  if (model) form.set('modelId', model);
  const transcription = await request(teacher, 'POST', '/api/openmaic/transcription', form, { category: 'speech', timeout: 90000 });
  assert.ok(transcription.text || transcription.data?.text, 'ASR did not return recognized text');
  record('real-speech-recognition', '通过', { providerId: recognizer[0] });
  const media = new FormData(); media.set('courseId', fixture.instanceId);
  media.set('bindAsCourseResource', 'true'); media.set('stageKey', 'ai-learning');
  media.set('file', new Blob([bytes], { type: format === 'mp3' ? 'audio/mpeg' : `audio/${format}` }), `lecture.${format}`);
  const requestId = randomUUID();
  const upload = await request(teacher, 'POST', '/api/uploads', media, { expectedStatus: 201, category: 'lecture-audio-upload', headers: { 'Idempotency-Key': requestId } });
  fixture.lectureAudio = { id: upload.id, url: upload.url, requestId, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), userId: teacher.id };
  const downloaded = await request(teacher, 'GET', upload.url, undefined, { raw: true, category: 'lecture-audio-download' });
  assert.equal(createHash('sha256').update(downloaded).digest('hex'), fixture.lectureAudio.sha256);
  const filename = path.join(root, '.openpbl-data/classrooms', `${fixture.classroomId}.json`);
  const classroom = JSON.parse(await readFile(filename, 'utf8'));
  const scene = classroom.scenes.find(scene => scene.id === fixture.lectureSceneId);
  assert.ok(scene);
  const duration = audioDurationSec(bytes, format);
  assert.ok(duration > 0, 'Real speech duration must be decoded from its bytes');
  const mediaDirectory = path.join(root, '.openpbl-data/classrooms', fixture.classroomId, 'audio');
  await mkdir(mediaDirectory, { recursive: true });
  await writeFile(path.join(mediaDirectory, `lecture.${format}`), bytes, { flag: 'wx', mode: 0o600 });
  fixture.lectureAudio.playbackUrl = `/api/openmaic/classroom-media/${fixture.classroomId}/audio/lecture.${format}`;
  fixture.lectureAudio.durationSec = duration;
  for (const [index, speech] of scene.actions.entries()) if (speech.type === 'speech') {
    speech.audioUrl = `${fixture.lectureAudio.playbackUrl}?capacityClip=${index}`;
    speech.audioDurationSec = duration;
  }
  classroom.revision++;
  await writeFile(filename, JSON.stringify(classroom));
  const servedMedia = await request(users[2], 'GET', fixture.lectureAudio.playbackUrl, undefined, { raw: true, category: 'lecture-media-download' });
  fixture.lectureAudio.servedSha256 = createHash('sha256').update(servedMedia).digest('hex');
  record('ai-lecture-playable-audio-prepared', '通过', { bytes: bytes.length, durationSec: duration, actions: scene.actions.length, mediaEndpoint: 'classroom-media' });
}
async function archiveAndUpload(round) {
  await allCompleted(users.slice(2).map(async user => {
    const state = expected.get(user.id);
    const requestId = randomUUID();
    const body = { courseId: fixture.instanceId, submissionId: state.submissionId, studentId: user.id, stageKey: 'make', expectedVersion: state.version, requestId };
    const result = await request(user, 'POST', '/api/project-practice/submissions/finalize', body, { category: 'archive', timeout: 60000 });
    state.archives.push(result);
    if (result.submissionVersion) state.version = result.submissionVersion;
    const replay = await request(user, 'POST', '/api/project-practice/submissions/finalize', body, { category: 'replay' });
    assert.equal(result.versionId, replay.versionId);
    const bytes = await request(user, 'GET', result.downloadUrl, undefined, { raw: true, category: 'download' });
    assert.equal(createHash('sha256').update(bytes).digest('hex'), result.sha256);
    const uploadBytes = Buffer.from(`验收作品 ${runId} ${user.id} ${round}\n${'测量证据：保持条件相同，记录用电量。\n'.repeat(30000)}`);
    const form = new FormData(); form.set('courseId', fixture.instanceId); form.set('file', new Blob([uploadBytes], { type: 'text/plain' }), 'evidence.txt');
    const uploadRequestId = randomUUID();
    const uploadOptions = { expectedStatus: 201, category: 'upload', timeout: 60000, headers: { 'Idempotency-Key': uploadRequestId } };
    const upload = await request(user, 'POST', '/api/uploads', form, uploadOptions);
    const sha256 = createHash('sha256').update(uploadBytes).digest('hex');
    state.uploads ??= []; state.uploads.push({ requestId: uploadRequestId, id: upload.id, url: upload.url, size: uploadBytes.length, sha256 });
    const uploadReplay = await request(user, 'POST', '/api/uploads', form, { ...uploadOptions, category: 'upload-replay' });
    assert.equal(upload.id, uploadReplay.id, 'Upload retry must return the committed asset');
    assert.equal(upload.url, uploadReplay.url);
    assert.equal(upload.requestId, uploadRequestId);
    const downloaded = await request(user, 'GET', upload.url, undefined, { raw: true, category: 'download' });
    assert.equal(createHash('sha256').update(downloaded).digest('hex'), sha256);
  }));
  record(`simultaneous-archive-upload-${round}`, '通过');
}
async function browserSmoke() {
  browser = await chromium.launch({ headless: true, args: network.browserArgs, env: network.browserEnv });
  for (const user of [users[0], users[1], users[2]]) {
    const context = await browser.newContext();
    await context.addCookies(user.cookie.split('; ').map(item => { const i = item.indexOf('='); return { name: item.slice(0,i), value: item.slice(i+1), url: origin }; }));
    const page = await context.newPage();
    const errors = [];
    const networkFailures = [];
    const drainBrowserEvents = captureCapacityBrowserEvents(page, { user, fixture, expected });
    page.on('requestfailed', req => networkFailures.push({ url: new URL(req.url()).pathname, error: req.failure()?.errorText }));
    page.on('response', res => { if (res.status() >= 400) networkFailures.push({ url: new URL(res.url()).pathname, status: res.status() }); });
    page.on('pageerror', error => errors.push(error.message));
    const route = user.role === 'teacher' ? `/teacher/teach/${fixture.instanceId}/classroom` : `/student/classroom/${fixture.instanceId}`;
    const response = await page.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    assert.equal(response.status(), 200);
    const connected = await response.serverAddr();
    assert.equal(connected?.ipAddress.replace(/^::ffff:/, ''), network.address, 'Browser must use the internal address');
    const expectedRoute = user.role === 'student' ? `/student/ai-collaboration/${fixture.instanceId}` : route;
    await page.waitForURL(url => url.pathname === expectedRoute, { timeout: 45000 });
    await delay(2500);
    assert.equal(new URL(page.url()).pathname, expectedRoute);
    await writeFile(path.join(output, `browser-${user.index}-network.json`), JSON.stringify(networkFailures, null, 2));
    assert.deepEqual(errors, [], JSON.stringify(networkFailures).slice(0,1200));
    await page.screenshot({ path: path.join(output, `browser-${user.index}.png`) }).catch(error => record('browser-screenshot-artifact', '未验证', { role: user.role, message: error.message }));
    await context.close();
    await drainBrowserEvents();
  }
  await browser.close(); browser = null;
  record('three-real-browser-roles', '通过');
}
async function soak() {
  const start = Date.now();
  const end = start + durationMinutes * 60000;
  assert.ok(users.every(user => user.socket?.readyState === WebSocket.OPEN));
  await setStage(1);
  let practiceStarted = false;
  const phaseMetrics = { aiLearning: { ticks: 0, startedAt: new Date().toISOString() }, documentPractice: { ticks: 0 } };
  report.phases = phaseMetrics;
  let round = 0;
  while (!stopped && Date.now() < end) {
    const tick = Date.now();
    if (!practiceStarted && tick >= start + durationMinutes * 30000) {
      await setStage(2); practiceStarted = true;
      phaseMetrics.aiLearning.completedAt = new Date().toISOString();
      phaseMetrics.documentPractice.startedAt = new Date().toISOString();
      record('sustained-workload-switch-to-document-practice', '通过', { students: studentCount });
      if (process.env.CAPACITY_REAL_AI === '1') await realDocumentAi(true);
    }
    phaseMetrics[practiceStarted ? 'documentPractice' : 'aiLearning'].ticks++;
    const requests = users.map(async user => {
      const events = await request(user, 'GET', coursePath(`events?after=${encodeURIComponent(user.cursor)}`), undefined, { category: 'event-poll' });
      user.cursor = events.nextCursor ?? events.cursor ?? user.cursor;
      if (round % 3 === 0) await request(user, 'GET', coursePath('projection'), undefined, { category: 'projection-read' });
      if (round % 2 === 0) await request(user, 'PUT', coursePath('presence'), {}, { category: 'presence' });
      if (user.role === 'student') {
        if (!practiceStarted && fixture.lectureAudio?.playbackUrl) {
          // Match the measured clip duration throughout the hour of teaching,
          // rather than checking media only during the initial browser run.
          const clipMs = fixture.lectureAudio.durationSec * 1000;
          const firstClip = Math.floor(round * 5000 / clipMs);
          const afterClip = Math.floor((round + 1) * 5000 / clipMs);
          for (let clip = firstClip; clip < afterClip; clip++) {
            const bytes = await request(user, 'GET', `${fixture.lectureAudio.playbackUrl}?capacityClip=${clip}`,
              undefined, { raw: true, category: 'lecture-media-stream' });
            assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.lectureAudio.servedSha256);
          }
        }
        if (practiceStarted) await saveStudent(user);
        else if (round % 3 === 0) await request(user, 'GET', `/api/openmaic/progress?courseId=${fixture.instanceId}&studentId=${user.id}`, undefined, { category: 'ai-lesson-read' });
        if (round % (practiceStarted ? 12 : 2) === 0) {
          const state = expected.get(user.id);
          const id = randomUUID();
          const event = { id, idempotencyKey: id, courseId: fixture.instanceId, studentId: user.id,
            stageKey: practiceStarted ? 'make' : 'ai-learning', type: practiceStarted ? 'artifact-change' : round === 0 ? 'scene-enter' : 'heartbeat',
            ...(!practiceStarted ? { sceneId: fixture.lectureSceneId ?? fixture.quizId } : {}), durationMs: practiceStarted ? 60000 : 10000,
            visible: true, occurredAt: new Date().toISOString() };
          const ack = await request(user, 'POST', '/api/learning-events', { courseId: fixture.instanceId, studentId: user.id, events: [event] }, { category: 'learning-events' });
          retainLearningAcknowledgement(state, event, ack);
          state.events.push(id);
        }
      }
      // Real pages refresh after their own save/telemetry invalidation; teachers
      // coalesce the class burst. A once-per-minute snapshot undercounts that load.
      if (practiceStarted || round % 2 === 0) {
        const state = await request(user, 'GET', coursePath('state'), undefined, { category: 'classroom-state' });
        user.cursor = state.eventCursor ?? user.cursor;
      }
      if (round % 12 === 0 && user.role === 'student' && !practiceStarted) {
        await request(user, 'GET', `/api/openmaic/classroom?id=${encodeURIComponent(fixture.classroomId)}`, undefined, { category: 'ai-classroom-read' });
      }
    });
    // Measure teacher projection while student traffic is in flight, including
    // different points of the read/presence/save/telemetry cycle.
    if (round % 3 === 0) requests.push(delay((Math.floor(round / 3) * 997) % 5000).then(() => project(practiceStarted ? 'make' : 'ai-learning')));
    await allCompleted(requests);
    assert.ok(users.every(user => user.socket?.readyState === WebSocket.OPEN), 'A classroom socket disconnected during the workload');
    if (round % 12 === 0) { await flushReport(); console.log(`soak ${Math.round((Date.now()-start)/60000)}/${durationMinutes} minutes; requests=${totalRequests}; failures=${failedRequests}`); }
    round++;
    await delay(Math.max(0, 5000 - (Date.now()-tick)));
  }
  await delay(1000);
  for (const [marker, receivers] of projectionReceivers) assert.equal(receivers.size, users.length, `Projection ${marker} did not reach every signed-in user`);
  report.actualSoakSeconds = (Date.now() - start)/1000;
  phaseMetrics.documentPractice.completedAt = new Date().toISOString();
  if (!practiceStarted) await setStage(2);
  record('sustained-target-workload', stopped ? '未通过' : '通过', { seconds: report.actualSoakSeconds });
  assert.equal(stopped, false, 'Workload was interrupted; preserve the fixture for investigation');
  assert.ok(report.actualSoakSeconds >= durationMinutes * 60, 'Workload duration was incomplete');
}
async function restartRecovery() {
  if (process.env.CAPACITY_RESTART_SERVICE !== '1') { record('application-restart-recovery', '未验证', 'Enable CAPACITY_RESTART_SERVICE=1 during the maintenance window'); return; }
  sockets.forEach(socket => socket.terminate());
  const start = performance.now();
  await promisify(execFile)('systemctl', ['--user', 'restart', 'openpbl.service'], { timeout: 60000 });
  let healthy = false;
  while (performance.now() - start < 60000) {
    try { const response = await fetch(`${origin}/api/health/live`, { signal: AbortSignal.timeout(1000) }); if (response.ok) { healthy = true; break; } } catch { /* planned fault window */ }
    await delay(500);
  }
  assert.ok(healthy, 'Application did not recover within 60 seconds');
  const downtimeMs = performance.now() - start;
  await allCompleted(users.map(user => connect(user)));
  await allCompleted(users.slice(2).map(async user => {
    const state = expected.get(user.id);
    const replay = await action(user, state.lastAction, { requestId: state.lastRequestId, category: 'restart-replay' });
    assert.deepEqual(replay, state.lastAck, 'Restart must preserve committed request receipts');
  }));
  const beforeProgressReplay = await progressReplaySnapshot({ db, fixture, users: users.slice(2) });
  await allCompleted(users.slice(2).map(async user => {
    const state = expected.get(user.id);
    assert.deepEqual(await request(user, 'POST', '/api/openmaic/progress', state.progressBody, { category: 'restart-progress-replay' }), state.progressAck);
  }));
  assert.deepEqual(await progressReplaySnapshot({ db, fixture, users: users.slice(2) }), beforeProgressReplay, 'Restart receipt replay must not mutate any learner workspace, course version or progress fact count');
  await reconcile();
  await allCompleted(users.slice(2).map(saveStudent));
  record('application-restart-recovery', '通过', { downtimeMs, reconnectedUsers: users.length });
}
async function reconcile() {
  for (const user of users.slice(2)) {
    const state = expected.get(user.id);
    const participation = await db.classroomParticipation.findUniqueOrThrow({ where: { id: user.participationId }, include: { enrollment: true } });
    const progressReceipts = await db.domainEvent.findMany({ where: { actorId: user.id, classroomInstanceId: fixture.instanceId,
      eventType: 'UPDATE_STUDENT_PROGRESS', payload: { path: ['requestId'], equals: state.progressRequestId } } });
    assert.equal(progressReceipts.length, 1, 'Lost acknowledgements and restarts must not duplicate progress facts');
    verifyProgressReceipt({ row: progressReceipts[0], user, fixture, participation, body: state.progressBody, ack: state.progressAck });
    for (const receipt of state.browserInteractionEvents ?? []) {
      const facts = await db.aiInteractionEvent.findMany({ where: { requestId: receipt.requestId, userId: user.id } });
      assert.equal(facts.length, 1, 'A replayed browser interaction must retain exactly one process fact');
      const fact = facts[0];
      assert.equal(fact.id, receipt.eventId); assert.equal(fact.participationId, user.participationId);
      assert.equal(fact.offeringId, fixture.offeringId); assert.equal(fact.actor, 'student');
      assert.equal(fact.researchKey, participation.enrollment.researchKey);
      assert.equal(fact.payload.legacy.stageKey, receipt.body.stageKey);
      assert.equal(fact.payload.legacy.source, receipt.body.source);
      assert.equal(fact.payload.legacy.actorId, user.id);
      assert.equal(fact.payload.legacy.conversationId, receipt.body.conversationId ?? null);
      assert.equal(fact.eventType, receipt.body.eventType); assert.equal(fact.content ?? undefined, receipt.body.content);
      assert.deepEqual(fact.payload.detail, { ...(receipt.body.payload ?? {}), workspaceKind: receipt.body.workspaceKind ?? 'document' });
    }
    for (const review of state.browserReviewRequests ?? []) {
      await verifyBrowserReviewRecords({ db, user, fixture, review, participation });
    }
    const submission = await db.classroomSubmission.findFirstOrThrow({ where: { participationId: user.participationId, OR: [{ id: state.submissionId }, { payload: { path: ['view','id'], equals: state.submissionId } }] } });
    const view = submission.payload.view ?? submission.payload;
    assert.equal(view.content, state.content);
    assert.equal(view.version, state.version);
    const versions = await db.artifactVersion.findMany({ where: { artifact: { participationId: user.participationId } } });
    const expectedVersions = [...state.archives, ...(state.externalArtifacts ?? [])];
    assert.equal(versions.length, expectedVersions.length);
    for (const version of versions) assert.ok(expectedVersions.some(item => item.versionId === version.id && item.sha256 === version.sha256));
    const receipts = await db.domainEvent.findMany({ where: { actorId: user.id, classroomInstanceId: fixture.instanceId, eventType: 'COURSE_ACTION' }, select: { payload: true, participationId: true, idempotencyKey: true } });
    const byRequest = new Map(receipts.map(row => [row.payload.ack?.requestId, row]));
    assert.equal(state.receipts.length, state.saves);
    for (const acknowledged of state.receipts) {
      const row = byRequest.get(acknowledged.requestId);
      assert.ok(row, 'Every acknowledged save must have its durable receipt');
      assert.equal(row.participationId, user.participationId);
      assert.equal(row.idempotencyKey, `course-action:${user.id}:${acknowledged.requestId}`);
      assert.equal(row.payload.ack.submissionVersion, acknowledged.version);
      assert.equal(row.payload.action.payload.submission.version, acknowledged.version);
      assert.equal(createHash('sha256').update(row.payload.action.payload.submission.content).digest('hex'), acknowledged.contentSha256);
    }
    const events = await db.learningEvent.findMany({ where: { userId: user.id, classroomInstanceId: fixture.instanceId, source: 'legacy-classroom' } });
    const ids = events.map(event => event.metadata?.legacy?.id);
    assert.ok(ids.every(id => typeof id === 'string' && id.length > 0));
    assert.equal(new Set(ids).size, ids.length, 'Retries must not duplicate learning events');
    const eventRows = new Map(events.map(event => [event.metadata.legacy.id, event]));
    for (const event of [...(state.eventReceipts ?? []), ...(state.browserEventReceipts ?? [])]) {
      const row = eventRows.get(event.id); assert.ok(row);
      verifyLearningEventRecord({ row, event, user, fixture, participation });
    }
    assert.equal((state.eventReceipts ?? []).length, state.events.length, 'Every protocol ACK needs its original event body');
    assert.equal((state.browserEventReceipts ?? []).length, (state.browserEvents ?? []).length, 'Every observed browser ACK needs its original event body');
    const acknowledgedEvents = new Set([...state.events, ...(state.browserEvents ?? [])]);
    for (const id of acknowledgedEvents) assert.ok(ids.includes(id), 'Every acknowledged API and browser learning event must be retained');
    state.reconciledLearningEvents = { total: ids.length, acknowledged: acknowledgedEvents.size, additionalBrowserEvents: ids.filter(id => !acknowledgedEvents.has(id)).length };
    const course = (await request(user, 'GET', coursePath('state'))).course;
    assert.equal(course.aiLearningProgress[user.id].masteryLevel, 'completed');
    assert.equal(course.aiLearningProgress[user.id].knowledgeLectureAttempts.length, fixture.subjectiveQuizId ? 2 : 1);
    assert.equal(course.students.find(item=>item.id===user.id).stageProgress['ai-learning'], 100);
  }
  record('per-student-database-file-reconciliation', '通过', { students: studentCount });
}
process.on('SIGTERM', () => { stopped = true; });
process.on('SIGINT', () => { stopped = true; });
try {
  report.commit = execFileSync('git', ['rev-parse','HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  report.buildId = await readFile(path.join(root, '.next-build/BUILD_ID'), 'utf8').then(value=>value.trim()).catch(()=> 'build-in-progress');
  await seed(); await loginAndEnter();
  await allCompleted(users.map(user => connect(user)));
  record('all-websockets-subscribed-before-learning', '通过', users.length);
  await setStage(1);
  await speechSmoke();
  if (process.env.CAPACITY_REAL_AI === '1') await verifyCapacityLectureBrowsers({ users, fixture, origin, request, record, expected, browserArgs: network.browserArgs, connectAddress: network.address, observeMs: studentCount === 40 ? 180000 : 10000 });
  await lesson();
  await setStage(2);
  const personalGroups = await ensureCapacityPersonalGroups({ users, fixture, request, record });
  for (const user of users.slice(2)) expected.get(user.id).groupId = personalGroups.find(group => group.members.some(member => member.studentId === user.id)).id;
  await allCompleted(users.slice(2).map(saveStudent));
  await realAi();
  if (process.env.CAPACITY_REAL_AI === '1') report.documentCommentReview = await verifyCapacityDocumentComments({ users, fixture, request, record, expected, db });
  await archiveAndUpload(1);
  await uploadCapacityExternalArtifacts({ users, fixture, request, record, expected, round: 1 });
  if (process.env.CAPACITY_REAL_AI === '1') await verifyCapacityDocumentBrowsers({ users, fixture, origin, request, record, expected, browserArgs: network.browserArgs, connectAddress: network.address });
  await browserSmoke();
  await verifyCapacityProjectionBrowser({ users, fixture, origin, request, record, expected, browserArgs: network.browserArgs, connectAddress: network.address });
  await soak();
  await allCompleted(users.slice(2).map(saveStudent)); await archiveAndUpload(2);
  await uploadCapacityExternalArtifacts({ users, fixture, request, record, expected, round: 2 });
  await reconcile();
  await restartRecovery();
  await verifyExtendedClassroom({ users, fixture, db, request, record, expected });
  await request(users[0], 'POST', `/api/platform/classroom-instances/${fixture.instanceId}/finish`, {});
  await allCompleted(users.slice(2).map(async user => {
    const state = expected.get(user.id);
    const result = await action(user, { ...state.lastAction, payload: { ...state.lastAction.payload, expectedSubmissionVersion: state.version } }, { category: 'closed-classroom-write', expectedStatus: 409 });
    assert.equal(result.code, 'CLASSROOM_READ_ONLY');
    const entry = await request(user, 'POST', `/api/platform/classroom-instances/${fixture.instanceId}/enter`, {}, { category: 'closed-classroom-reentry' });
    assert.equal(entry.participation.id, user.participationId);
  }));
  const beforeClosedReplay = await progressReplaySnapshot({ db, fixture, users: users.slice(2) });
  await allCompleted(users.slice(2).map(async user => {
    const state = expected.get(user.id);
    assert.deepEqual(await request(user, 'POST', '/api/openmaic/progress', state.progressBody, { category: 'closed-progress-replay' }), state.progressAck);
    await request(user, 'POST', '/api/openmaic/progress', { ...state.progressBody, requestId: randomUUID() }, { category: 'closed-progress-write', expectedStatus: 409 });
  }));
  assert.deepEqual(await progressReplaySnapshot({ db, fixture, users: users.slice(2) }), beforeClosedReplay, 'Closed receipt replay and rejected new writes must leave persisted state unchanged');
  record('closed-classroom-rejects-writes-and-restores-history', '通过');
  await reconcile();
  const failures = [];
  for (const category of ['ordinary-reads', 'draft-save', 'progress', 'pretest', 'posttest-draft', 'posttest-submit', 'archive', 'quiz']) {
    const p95 = percentile(metrics.get(category)?.times ?? [], .95);
    const budget = category === 'ordinary-reads' ? 1000 : 2000;
    if (p95 === null || p95 > budget) failures.push(`${category} P95=${p95} exceeds ${budget}ms`);
  }
  if (durationMinutes > 0) for (const category of ['event-poll', 'projection-read', 'classroom-state', 'ai-lesson-read', 'ai-classroom-read']) {
    const p95 = percentile(metrics.get(category)?.times ?? [], .95);
    if (p95 === null || p95 > 1000) failures.push(`${category} P95=${p95} exceeds 1000ms`);
  }
  if (durationMinutes > 0) {
    const eventP95 = percentile(metrics.get('learning-events')?.times ?? [], .95);
    if (eventP95 === null || eventP95 > 2000) failures.push(`learning-events P95=${eventP95} exceeds 2000ms`);
    if (process.env.CAPACITY_REAL_AI === '1') {
      const mediaP95 = percentile(metrics.get('lecture-media-stream')?.times ?? [], .95);
      if (mediaP95 === null || mediaP95 > 1000) failures.push(`lecture-media-stream P95=${mediaP95} exceeds 1000ms`);
    }
  }
  if (durationMinutes > 0 && (!projectionLatencies.length || percentile(projectionLatencies, .95) > 500)) failures.push('Projection receipt P95 is missing or exceeds 500ms');
  const gradingBusinessFailures = [...expected.values()].reduce((sum, state) => sum + (state.subjectiveGradingAttempts ?? []).filter(attempt => attempt.status !== 'graded').length, 0);
  report.businessFailures = { subjectiveGrading: gradingBusinessFailures };
  if ((failedRequests + gradingBusinessFailures) / Math.max(1,totalRequests) >= .005) failures.push('HTTP or business request failure rate exceeds 0.5%');
  for (const category of ['real-ai-learning', 'real-ai-document', ...(durationMinutes > 0 ? ['real-ai-document-after-learning'] : [])]) {
    const p95 = percentile(metrics.get(category)?.operationTimes ?? metrics.get(category)?.times ?? [], .95);
    if (process.env.CAPACITY_REAL_AI === '1' && (p95 === null || p95 > 60000)) failures.push(`${category} P95=${p95} exceeds 60000ms`);
    const first = percentile(metrics.get(category)?.operationTimes ?? metrics.get(category)?.firstResponseTimes ?? [], .95);
    if (process.env.CAPACITY_REAL_AI === '1' && (first === null || first > 10000)) failures.push(`${category} first response P95=${first} exceeds 10000ms`);
  }
  if (process.env.CAPACITY_REAL_AI === '1') {
    const aiGate = evaluateCapacityAiGates({ expected, studentCount, afterLearning: durationMinutes > 0 });
    report.aiOperationReliability = aiGate.summary; failures.push(...aiGate.failures);
  }
  record('performance-gates', failures.length ? '未通过' : '通过', failures);
  const qualityFailures = report.documentCommentReview?.qualityFailures ?? [];
  record('document-comment-quality-gate', qualityFailures.length ? '未通过' : '通过', qualityFailures);
  failures.push(...qualityFailures.map(item => `Document review quality: ${JSON.stringify(item)}`));
  assert.deepEqual(failures, []);
  report.outcome = durationMinutes >= 120 && report.actualSoakSeconds >= 7200 && studentCount === 40 && process.env.CAPACITY_REAL_AI === '1' && process.env.CAPACITY_RESTART_SERVICE === '1' ? 'passed' : 'partial';
} catch (error) {
  report.outcome = 'failed'; record('fatal', '未通过', String(error?.stack ?? error).slice(0,1500)); process.exitCode = 1;
} finally {
  sockets.forEach(socket => socket.terminate());
  await browser?.close().catch(()=>{});
  await flushReport();
  // Preserve UUID-owned evidence on failure. A separate explicit cleanup command
  // verifies the manifest and reports before deleting only this run's records.
  await db.$disconnect();
  console.log(`Report: ${path.join(output, 'report.json')}`);
}
