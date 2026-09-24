/** Real content acceptance with an isolated, explicitly seeded design fixture.
 * prepare is read-only; test creates the fixture and calls the normal generation API.
 * node scripts/verify-test-lesson-promotion.mjs prepare|test|inspect|promote|resume|inject-alignment|inject-audio
 * inspect snapshots checkpoints and verifies every audio URL through authenticated HTTP.
 * No source template, published version, classroom content or provider output is modified.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';

const command = process.argv[2] ?? 'prepare';
assert.ok(['prepare', 'test', 'inspect', 'promote', 'resume', 'cancel', 'inject-alignment', 'inject-audio'].includes(command));
const arg = (name) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const output = path.resolve(arg('--output') ?? '.openpbl-runtime/course-upgrade-20260923/test-promotion');
const input = path.resolve(arg('--input') ?? '.openpbl-runtime/course-upgrade-20260923/managed/course-2');
const baseUrl = arg('--base-url') ?? 'http://127.0.0.1:3000';
const sourceId = '836c48ed-728c-41c4-8625-cd32ba8daf9f';
const db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL ?? (await readFile('deploy/secrets/database_url.txt', 'utf8')).trim() });
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const save = async (name, value) => writeFile(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`);
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)])) : value;
const fingerprint = (value) => createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');
await mkdir(output, { recursive: true });
try {
  const source = await db.classroomTemplate.findUniqueOrThrow({ where: { id: sourceId }, include: { owner: true, versions: { orderBy: { version: 'desc' } } } });
  const sourceSnapshot = source.versions[0].snapshot;
  const sourceJobs = await db.generationJob.findMany({ where: { targetId: sourceId }, orderBy: { createdAt: 'desc' } });
  const sourceJob = (kind) => { const row = sourceJobs.find((job) => job.jobType === kind); assert.ok(row, `Missing ${kind}`); return row; };
  const blueprint = await json(path.join(input, 'blueprint.json'));
  const outlines = await json(path.join(input, 'outlines.json'));
  assert.ok(outlines.length > 4 && outlines.every((item) => item.teachingBrief), 'Requires authoritative compiled outlines');
  const firstSection = outlines.find((item) => item.lectureSectionId)?.lectureSectionId;
  const testOutlines = outlines.filter((item) => item.lectureSectionId === firstSection);
  assert.ok(testOutlines.some((item) => item.type === 'quiz') && testOutlines.some((item) => item.type !== 'quiz'));
  const testLesson = { sectionId: firstSection, sectionTitle: testOutlines[0].lectureSectionTitle, sceneOutlineIds: [...new Set(testOutlines.map((item) => item.spatialParentId ?? item.id))], durationSeconds: testOutlines.reduce((sum, item) => sum + (item.targetDurationSec ?? item.estimatedDuration ?? 0), 0) };
  let run = await json(path.join(output, 'run.json')).catch(() => null);
  if (!run) {
    assert.ok(['prepare', 'test'].includes(command), 'Run prepare first');
    run = { courseId: randomUUID(), sourceId, sourceSnapshotFingerprint: createHash('sha256').update(JSON.stringify(sourceSnapshot)).digest('hex'), sourceVersionId: source.versions[0].id, blueprintFingerprint: createHash('sha256').update(JSON.stringify(blueprint)).digest('hex'), outlinesFingerprint: createHash('sha256').update(JSON.stringify(outlines)).digest('hex'), createdAt: new Date().toISOString(), testLesson, fixtureSetup: 'Isolated DRAFT cloned from the source teacher course. An independently generated authoritative blueprint and outlines replace its design. A completed COURSE_DESIGN fixture and READY resource package are seeded using only source-course resources; these are not counted as real generation. All test, promotion and recovery content operations use normal authenticated production APIs.', operations: [] };
    await save('run.json', run);
  }
  assert.equal(run.sourceId, sourceId);
  assert.notEqual(run.courseId, sourceId);
  assert.equal(run.blueprintFingerprint, createHash('sha256').update(JSON.stringify(blueprint)).digest('hex'));
  assert.equal(run.outlinesFingerprint, createHash('sha256').update(JSON.stringify(outlines)).digest('hex'));
  const currentSourceHash = createHash('sha256').update(JSON.stringify(sourceSnapshot)).digest('hex');
  if (run.sourceSnapshotFingerprint !== currentSourceHash) {
    assert.ok(!['prepare', 'test'].includes(command), 'Source changed; cannot create a new fixture from an unreviewed input');
    // The root explicitly restored the source draft while this independent fixture was paused.
    // Accept only that recorded CAS reversal, never an arbitrary changed source snapshot.
    const rollback = await json('.openpbl-runtime/course-upgrade-20260923/source-rollback-result.json');
    assert.equal(rollback.applied, true);
    assert.equal(rollback.targetId, run.sourceId);
    assert.equal(rollback.draftId, run.sourceVersionId);
    assert.equal(source.versions[0].id, rollback.draftId);
    assert.equal(rollback.expectedSnapshotHash, run.sourceSnapshotFingerprint);
    assert.equal(rollback.rollbackSnapshotHash, currentSourceHash);
    assert.equal(new Date(source.updatedAt).toISOString(), rollback.updatedAt);
    const isolated = await db.classroomTemplate.findUniqueOrThrow({ where: { id: run.courseId }, include: { versions: true } });
    assert.equal(isolated.ownerId, source.ownerId);
    assert.ok(isolated.versions.some((version) => version.status === 'DRAFT'));
    const currentJob = await db.generationJob.findFirstOrThrow({ where: { targetId: run.courseId, jobType: 'COURSE_CONTENT' }, orderBy: { createdAt: 'desc' } });
    const savedRequest = await json(path.join(output, run.promotedAt ? 'promoted-request.json' : 'test-normal-request.json'));
    const inputDifferences = [...new Set([...Object.keys(currentJob.request), ...Object.keys(savedRequest)])].filter((key) => key !== 'managedRecoveryCount' && fingerprint(currentJob.request[key]) !== fingerprint(savedRequest[key]));
    assert.deepEqual(inputDifferences, [], 'Independent fixture input changed while source was restored');
    await save('source-rollback-continuation-audit.json', { at: new Date().toISOString(), command, sourceId: run.sourceId, isolatedCourseId: run.courseId, originalSourceHash: run.sourceSnapshotFingerprint, currentSourceHash, matchedRollbackAt: rollback.completedAt, ownerUnchanged: true, fixtureInputUnchanged: true, sourceWrittenByThisScript: false });
  }
  const owner = source.owner;
  const secret = process.env.JWT_SECRET ?? (await readFile('deploy/secrets/jwt_secret.txt', 'utf8')).trim();
  const token = await new SignJWT({ role: 'teacher', sv: owner.sessionVersion, username: owner.username, displayName: owner.displayName }).setSubject(owner.id).setProtectedHeader({ alg: 'HS256' }).setIssuer('openpbl').setAudience('openpbl-app').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  const api = async (suffix, method = 'GET', body) => {
    const response = await fetch(`${baseUrl}/api/courses/${run.courseId}/${suffix}`, { method, headers: { Cookie: `openpbl_teacher=${token}`, Origin: baseUrl, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(90_000) });
    const data = await response.json();
    assert.ok(response.ok, `${method} ${suffix} ${response.status}: ${JSON.stringify(data)}`);
    return data;
  };
  if (command === 'prepare') {
    assert.equal(sourceJob('COURSE_RESOURCE_PACKAGE').status, 'READY');
    await save('fixture-plan.json', { ...run, fullSceneCount: new Set(outlines.map((item) => item.spatialParentId ?? item.id)).size, sourcePackageId: sourceSnapshot.design.content.resourcePackage.id, testPages: testOutlines.map((item) => ({ id: item.id, type: item.type, seconds: item.targetDurationSec })) });
    console.log(JSON.stringify({ prepared: true, courseId: run.courseId, testLesson, output }));
  } else if (command === 'test') {
    assert.ok(!run.testRequestedAt, 'Test already requested; inspect or resume instead');
    const exists = await db.classroomTemplate.findUnique({ where: { id: run.courseId } });
    if (!exists) {
      const snapshot = structuredClone(sourceSnapshot);
      const design = snapshot.design;
      for (const key of ['aiLearningClassroomId', 'teacherClassroomId']) delete design[key];
      for (const key of ['_openmaicClassroomId', '_openmaicScenesCount', 'teacherClassroomId', 'classroomGenerationRun', 'qualityReview', 'teacherReview', 'teacherReviewItems', 'teacherReviewSummary', 'teacherReviewVersion', 'renderReview', 'teachingTimingAudit', 'teachingRevisionState', 'designWorkspaceRevision', 'knowledgeLectureSections', 'adaptiveLearningPlan']) delete design.content[key];
      design.content.teachingBlueprint = blueprint;
      design.content._openmaicSceneOutlines = outlines;
      design.content.lessonOutline = outlines.map((item) => ({ id: item.id, title: item.title, stageKey: item.stageKey, durationMin: Math.max(1, Math.round((item.targetDurationSec ?? item.estimatedDuration) / 60)), targetDurationSec: item.targetDurationSec, objectives: item.keyPoints, activities: [item.description], resourceTypes: item.resourceTypes, detailKind: item.detailKind, knowledgePointIds: item.knowledgePointIds, parentActivityId: item.parentActivityId, ttsPolicy: item.ttsPolicy, narrationMode: item.narrationMode }));
      const designSeed = sourceJob('COURSE_DESIGN');
      const packageSeed = sourceJob('COURSE_RESOURCE_PACKAGE');
      await db.$transaction(async (tx) => {
        await tx.classroomTemplate.create({ data: { id: run.courseId, ownerId: source.ownerId, title: `${source.title}（独立测试继续生成验收）`, description: 'Isolated generation acceptance fixture; never published.', status: 'ACTIVE', versions: { create: { version: 1, status: 'DRAFT', snapshot } } } });
        for (const seed of [designSeed, packageSeed]) {
          await tx.generationJob.create({ data: { targetType: 'CLASSROOM_TEMPLATE', targetId: run.courseId, jobType: seed.jobType, status: seed.status, step: seed.step, progress: 100, request: { ...seed.request, courseId: run.courseId, ...(seed.jobType === 'COURSE_DESIGN' ? { generationScope: 'test-lesson' } : {}) }, ...(seed.result ? { result: seed.result } : {}), trace: { schemaVersion: 1, entries: [], state: { requestedBy: source.ownerId, message: 'Acceptance fixture setup using authoritative blueprint and existing source package', version: 0 } }, startedAt: new Date(), completedAt: new Date(), heartbeatAt: new Date() } });
        }
      });
      run.fixtureCreatedAt = new Date().toISOString();
      await save('run.json', run);
    }
    const request = await json(path.join(output, 'test-normal-request.json'));
    assert.equal(request.courseId, run.courseId, 'Prepare the current normal builder request for this fixture first');
    run.testLesson = request.testLesson;
    delete request.updateTarget;
    await save('test-request.json', request);
    const result = await api('generation', 'POST', request);
    assert.ok(result.job, 'API did not create a background job');
    run.testRequestedAt = new Date().toISOString();
    run.testJobId = result.job.id;
    run.operations.push({ action: 'test', at: run.testRequestedAt, jobId: result.job.id });
    await save('run.json', run);
    await save('test-start.json', result);
    console.log(JSON.stringify({ courseId: run.courseId, jobId: result.job.id, status: result.job.status, output }));
  } else if (command === 'cancel') {
    const result = await api('generation', 'DELETE');
    run.operations.push({ action: command, at: new Date().toISOString(), status: result.job?.status, reason: 'Teacher clarified that the first-stage introduction must not be AI-generated' });
    await save('run.json', run);
    console.log(JSON.stringify({ courseId: run.courseId, action: command, status: result.job?.status }));
  } else if (command.startsWith('inject-')) {
    assert.ok(run.promotedAt, 'Inject failures only into the isolated promoted course');
    const job = await db.generationJob.findFirstOrThrow({ where: { targetId: run.courseId, jobType: 'COURSE_CONTENT' }, orderBy: { createdAt: 'desc' } });
    assert.equal(job.status, 'COMPLETED', 'Only inject into a completed, idle job');
    const course = (await api('state')).course;
    const classroomId = course.aiLearningClassroomId ?? course.content?._openmaicClassroomId;
    assert.ok(classroomId && classroomId !== run.testClassroomId, 'Injection requires a distinct isolated full classroom');
    const file = path.resolve(process.env.CLASSROOM_DATA_DIR ?? '.openpbl-data/classrooms', `${classroomId}.json`);
    const classroom = await json(file);
    const baseline = await json(path.join(output, 'test-audio.json'));
    const oldIds = new Set(baseline.audio.map((item) => item.id));
    const action = classroom.scenes.flatMap((scene) => scene.actions ?? []).findLast((item) => item.type === 'speech' && item.audioUrl && !oldIds.has(item.id));
    assert.ok(action, 'No full-only speech found');
    const at = new Date().toISOString();
    await save(`${command}-backup-${Date.now()}.json`, { classroom, job });
    const before = { id: action.id, audioUrl: action.audioUrl, speechAlignment: action.speechAlignment };
    delete action.speechAlignment;
    if (command === 'inject-audio') {
      // Change only this generated classroom reference. Never delete shared audio files.
      action.audioUrl = `/api/openmaic/classroom-media/${classroomId}/audio/acceptance-missing-${randomUUID()}.wav`;
      action.audioInvalidated = true;
    }
    await writeFile(file, `${JSON.stringify(classroom, null, 2)}\n`);
    const trace = structuredClone(job.trace ?? { schemaVersion: 1, entries: [], state: {} });
    trace.state = { ...trace.state, executionId: null, executionOwner: null, leaseExpiresAt: null, version: (trace.state?.version ?? 0) + 1 };
    await db.generationJob.update({ where: { id: job.id }, data: { status: 'FAILED', step: 'generating_assets', error: `Acceptance fixture: ${command} with existing assetsCompletedAt retained`, completedAt: null, retryAt: null, trace } });
    run.operations.push({ action: command, at, classroomId, before, injectedAudioUrl: action.audioUrl, callsBefore: job.trace?.state?.tokenUsageCalls ?? 0, audioBefore: classroom.scenes.flatMap((scene) => scene.actions ?? []).filter((item) => item.type === 'speech' && item.audioUrl).map((item) => ({ id: item.id, audioUrl: item.id === before.id ? before.audioUrl : item.audioUrl })) });
    await save('run.json', run);
    console.log(JSON.stringify({ injected: command, courseId: run.courseId, classroomId, actionId: action.id, recoveryAction: 'resume' }));
  } else if (command === 'promote' || command === 'resume') {
    if (command === 'promote') {
      assert.ok(run.testSnapshotAt, 'Inspect the completed test and save audio baseline before promotion');
      assert.ok(!run.promotedAt, 'Already promoted');
    }
    const result = command === 'promote' ? await api('design-generation', 'PATCH', { action: 'promote-test-lesson' }) : await api('generation', 'PATCH', { action: 'resume-from-checkpoints' });
    const at = new Date().toISOString();
    run.operations.push({ action: command, at, status: result.job?.status });
    if (command === 'promote') run.promotedAt = at;
    await save('run.json', run);
    await save(`${command}-${Date.now()}.json`, result);
    if (command === 'promote') {
      const persisted = await db.generationJob.findFirstOrThrow({ where: { targetId: run.courseId, jobType: 'COURSE_CONTENT' }, orderBy: { createdAt: 'desc' } });
      const expected = await json(path.join(output, 'full-normal-request.json'));
      const difference = [...new Set([...Object.keys(expected), ...Object.keys(persisted.request)])].filter((key) => fingerprint(expected[key]) !== fingerprint(persisted.request[key]));
      const audit = { at, differences: difference, semanticDifferences: difference.filter((key) => key !== 'sceneOutlines'), expectedRootCount: expected.fullSceneCount, actualRootCount: persisted.request.fullSceneCount };
      await save('promoted-request.json', persisted.request);
      await save('promoted-request-audit.json', audit);
      assert.deepEqual(audit.semanticDifferences, [], 'Normal promotion changed unexpected teaching input fields');
    }
    await save('run.json', run);
    await save(`${command}-${Date.now()}.json`, result);
    console.log(JSON.stringify({ courseId: run.courseId, action: command, status: result.job?.status }));
  } else {
    const status = await api('generation');
    const job = await db.generationJob.findFirstOrThrow({ where: { targetId: run.courseId, jobType: 'COURSE_CONTENT' }, orderBy: { createdAt: 'desc' }, include: { checkpoints: true } });
    const course = (await api('state')).course;
    const classroomId = course.aiLearningClassroomId ?? course.content?._openmaicClassroomId;
    const phase = job.request.generationScope === 'full-course' ? 'full' : 'test';
    const report = { at: new Date().toISOString(), phase, courseId: run.courseId, jobId: job.id, status: job.status, step: job.step, progress: job.progress, calls: status.job?.tokenUsage, startedAt: job.startedAt, completedAt: job.completedAt, elapsedMs: job.startedAt ? (job.completedAt?.getTime() ?? Date.now()) - job.startedAt.getTime() : null, error: job.error, attempt: job.attempt, classroomId, checkpointCount: job.checkpoints.length, checkpointStages: job.checkpoints.map((item) => ({ step: item.step, status: item.state?.status })), operations: run.operations };
    await save(`${phase}-job.json`, status);
    await save(`${phase}-checkpoints.json`, job.checkpoints);
    if (classroomId && job.status === 'COMPLETED') {
      const response = await fetch(`${baseUrl}/api/openmaic/classroom?id=${encodeURIComponent(classroomId)}`, { headers: { Cookie: `openpbl_teacher=${token}` } });
      assert.ok(response.ok, `Classroom HTTP ${response.status}`);
      const classroom = (await response.json()).classroom;
      await save(`${phase}-classroom.json`, classroom);
      const audio = classroom.scenes.flatMap((scene) => (scene.actions ?? []).filter((action) => action.type === 'speech' && action.text?.trim()).map((action) => ({ sceneId: scene.id, outlineId: scene.outlineId ?? scene.id, id: action.id, text: action.text, audioUrl: action.audioUrl, alignment: action.speechAlignment, invalidated: action.audioInvalidated })));
      const urls = [...new Set(audio.flatMap((item) => item.audioUrl ? [item.audioUrl] : []))];
      const media = [];
      for (const url of urls) {
        const res = await fetch(new URL(url, baseUrl), { headers: { Cookie: `openpbl_teacher=${token}`, Referer: `${baseUrl}/teacher/prepare/${run.courseId}/preview` }, signal: AbortSignal.timeout(30_000) });
        media.push({ url, status: res.status, bytes: (await res.arrayBuffer()).byteLength });
      }
      report.scenes = classroom.scenes.length;
      report.speechCount = audio.length;
      report.missingAudio = audio.filter((item) => !item.audioUrl || item.invalidated).length;
      report.missingAlignment = audio.filter((item) => item.alignment?.status !== 'aligned' || !item.alignment.spans?.length).length;
      report.cues = classroom.scenes.flatMap((scene) => scene.actions ?? []).filter((action) => ['laser', 'spotlight'].includes(action.type) || action.type.startsWith('wb_')).length;
      report.mediaFailures = media.filter((item) => item.status !== 200 || item.bytes === 0);
      report.assetGeneration = classroom.assetGeneration;
      await save(`${phase}-audio.json`, { audio, media });
      if (phase === 'test') { run.testSnapshotAt = report.at; run.testClassroomId = classroomId; await save('run.json', run); }
      else {
        const baseline = await json(path.join(output, 'test-audio.json'));
        const testClassroom = await json(path.join(output, 'test-classroom.json'));
        report.testSceneReuse = { expected: testClassroom.scenes.length, unchangedIds: testClassroom.scenes.filter((old) => classroom.scenes.some((current) => current.id === old.id)).length, unchangedContent: testClassroom.scenes.filter((old) => classroom.scenes.some((current) => current.id === old.id && fingerprint(current.content) === fingerprint(old.content))).length };
        const oldClassroom = await fetch(`${baseUrl}/api/openmaic/classroom?id=${encodeURIComponent(run.testClassroomId)}`, { headers: { Cookie: `openpbl_teacher=${token}` } });
        report.detachedTestClassroomStatus = oldClassroom.status;
        const matched = baseline.audio.map((old) => ({ old, current: audio.find((item) => item.sceneId === old.sceneId && item.id === old.id && item.text === old.text) }));
        report.testAudioReuse = { expected: matched.length, unchanged: matched.filter(({ old, current }) => current?.audioUrl === old.audioUrl).length, missing: matched.filter(({ current }) => !current).length, changed: matched.filter(({ old, current }) => current && current.audioUrl !== old.audioUrl).map(({ old, current }) => ({ id: old.id, before: old.audioUrl, after: current.audioUrl })) };
      }
      const injection = run.operations.findLast((item) => item.action.startsWith('inject-'));
      if (injection && phase === 'full') {
        const changed = injection.audioBefore.filter((old) => audio.find((item) => item.id === old.id)?.audioUrl !== old.audioUrl);
        report.recovery = { injection: injection.action, actionId: injection.before.id, elapsedMs: Date.now() - Date.parse(injection.at), additionalLlmCalls: (status.job?.tokenUsage?.calls ?? 0) - injection.callsBefore, changedAudioIds: changed.map((item) => item.id), maximumAllowedAudioChanges: injection.action === 'inject-audio' ? 1 : 0 };
        report.recovery.restoredTarget = audio.find((item) => item.id === injection.before.id)?.audioUrl;
        report.recovery.passed = report.recovery.additionalLlmCalls === 0 && (injection.action === 'inject-alignment' ? changed.length === 0 : changed.every((item) => item.id === injection.before.id) && Boolean(report.recovery.restoredTarget) && report.recovery.restoredTarget !== injection.injectedAudioUrl);
      }
      report.passed = (!report.recovery || report.recovery.passed) && report.missingAudio === 0 && report.missingAlignment === 0 && report.mediaFailures.length === 0 && report.cues > 0 && (phase === 'test' || (report.testAudioReuse.unchanged === report.testAudioReuse.expected && report.testSceneReuse.unchangedIds === report.testSceneReuse.expected && report.testSceneReuse.unchangedContent === report.testSceneReuse.expected));
    }
    await save(`${phase}-report.json`, report);
    await save(`${phase}-report-${Date.now()}.json`, report);
    console.log(JSON.stringify(report));
  }
} finally { await db.$disconnect(); }
