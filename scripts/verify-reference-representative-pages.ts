/** Four visual first-pass cases from the user's authoritative classroom.
 * Preparation has no database writes or model calls:
 * NODE_OPTIONS=--conditions=import pnpm exec tsx scripts/verify-reference-representative-pages.ts prepare
 * Run only after the current DSL/renderer packages are built:
 * NODE_OPTIONS=--conditions=import pnpm exec tsx scripts/verify-reference-representative-pages.ts generate
 * Explicit correction/resume (add --prepare-only to validate without any models or database writes):
 * NODE_OPTIONS=--conditions=import pnpm exec tsx scripts/verify-reference-representative-pages.ts resume --output .openpbl-runtime/course-upgrade-20260923/reference-native-representatives/resume-attempt-2 --regenerate-outline teaching-section-1-page-1
 * Prior attempts and rejected content are preserved, and all calls counted cumulatively.
 * Keeps the original 25-page plan and all quizzes; selects four existing slide IDs.
 * Existing diagram/image plans are explicit fixtures, not newly model-planned evidence.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { format } from 'node:util';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { SceneOutline } from '../src/lib/openmaic/types/generation';
import type { GenerateClassroomInput } from '../src/lib/openmaic/server/classroom-generation';
import { fingerprintSceneOutline, restoreSceneStageCheckpoint } from '../src/lib/course-generation/page-checkpoints';

const arg = (name: string) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const command = process.argv[2] ?? 'prepare';
const resumeSource = command === 'resume' ? path.resolve(arg('--resume-from') ?? '.openpbl-runtime/course-upgrade-20260923/reference-native-representatives') : undefined;
const regenerateIds = process.argv.flatMap((value, index) => value === '--regenerate-outline' ? [process.argv[index + 1]!] : []);
const root = '.openpbl-runtime/course-upgrade-20260923';
const output = path.resolve(arg('--output') ?? `${root}/reference-native-representatives`);
const selectedIds = ['teaching-section-1-page-1', 'teaching-section-2-page-1', 'teaching-section-2-page-4', 'teaching-section-6-page-1'];
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)])) : value;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
let canWriteOutput = false;
const save = async (name: string, data: unknown) => writeFile(path.join(output, name), `${JSON.stringify(data, null, 2)}\n`);
const protectedPage = (outline: SceneOutline) => ({ id: outline.id, type: outline.type, title: outline.title, description: outline.description, keyPoints: outline.keyPoints, teachingBrief: outline.teachingBrief, lectureSectionId: outline.lectureSectionId, lectureSectionTitle: outline.lectureSectionTitle, parentActivityId: outline.parentActivityId, knowledgePointIds: outline.knowledgePointIds, teachingObjective: outline.teachingObjective, targetDurationSec: outline.targetDurationSec });

async function main() {
  assert.ok(['prepare', 'generate', 'resume'].includes(command));
  assert.ok(!resumeSource || (arg('--output') && output !== resumeSource), 'Resume requires an explicit new --output directory, separate from --resume-from');
  assert.ok(regenerateIds.every((id) => selectedIds.includes(id)), 'Only one of the four selected original outline IDs may be regenerated');
  assert.ok(resumeSource || regenerateIds.length === 0, '--regenerate-outline requires resume');
  assert.ok(!await json(path.join(output, 'run-started.json')).catch(() => null) && !await json(path.join(output, 'stage-attempts.json')).catch(() => null), 'Output already contains a generation attempt; use a new resume directory to preserve evidence');
  canWriteOutput = true;
  await mkdir(output, { recursive: true });
  const reference = await json(`${root}/user-reference-46bb.json`);
  const jobs = await json(`${root}/user-reference-46bb-jobs.json`);
  const referenceJob = jobs.find((job: { jobType: string }) => job.jobType === 'COURSE_CONTENT');
  const snapshot = reference.versions[0].snapshot;
  const adopted: SceneOutline[] = snapshot.design.content._openmaicSceneOutlines;
  const originalRequest: SceneOutline[] = referenceJob.request.sceneOutlines;
  assert.equal(reference.id, '46bb9e37-414e-4df5-9803-73c0b1a5c16e');
  assert.equal(snapshot.design.aiLearningClassroomId, 'We8xHlvHQ6');
  assert.equal(adopted.length, 25);
  assert.equal(adopted.filter((outline) => outline.type === 'quiz').length, 7);
  assert.equal(new Set(adopted.map((outline) => outline.id)).size, adopted.length);
  const basis = arg('--outline-source') === 'request-v12' ? originalRequest : adopted;
  const outlines = structuredClone(basis);
  const donors: SceneOutline[] = await json(`${root}/managed/course-2/outlines.json`);
  const fixtures = [
    { target: selectedIds[1], source: 'teaching-section-2-page-1', fields: ['visualIntent', 'mediaGenerations'] as const },
    { target: selectedIds[2], source: 'teaching-section-2-page-4', fields: ['visualIntent'] as const },
  ];
  const fixtureEvidence = [];
  for (const fixture of fixtures) {
    const target = outlines.find((outline) => outline.id === fixture.target);
    const source = donors.find((outline) => outline.id === fixture.source);
    assert.ok(target && source);
    for (const field of fixture.fields) {
      assert.ok(source[field], `Missing inherited fixture ${fixture.source}.${field}`);
      Object.assign(target, { [field]: structuredClone(source[field]) });
    }
    fixtureEvidence.push({ targetOutlineId: fixture.target, sourceFile: `${root}/managed/course-2/outlines.json`, sourceOutlineId: fixture.source, fields: fixture.fields, sourceFingerprint: hash(source), provenance: 'Previously planned diagram/image fixture, explicitly supplied for layout acceptance; no new planning call and no target teaching-brief rewrite.' });
  }
  // Explicit/implicit task teaching keeps its own adopted two-channel brief.
  // A donor's four-step sequence would change its teaching scope, so none is injected.
  for (const [index, outline] of outlines.entries()) assert.deepEqual(protectedPage(outline), protectedPage(basis[index]!), `Teaching input changed: ${outline.id}`);
  assert.deepEqual(outlines.filter((outline) => outline.type === 'quiz'), basis.filter((outline) => outline.type === 'quiz'));
  assert.ok(selectedIds.every((id) => outlines.some((outline) => outline.id === id && outline.type === 'slide')));
  const { hasCurrentTeachingBrief, hasCompleteTeachingBrief } = await import('../src/lib/openmaic/generation/teaching-enhancement');
  const selected = outlines.filter((outline) => selectedIds.includes(outline.id));
  const preflight = selected.map((outline) => ({ id: outline.id, title: outline.title, version: outline.teachingBrief?.designVersion, complete: hasCompleteTeachingBrief(outline), compatible: hasCurrentTeachingBrief(outline) }));
  const sourceManifest = resumeSource ? await json(path.join(resumeSource, 'manifest.json')) : null;
  const priorAttempts: Array<{ outlineId: string; stage: string; attemptsStarted: number }> = resumeSource ? await json(path.join(resumeSource, 'stage-attempts.json')) : [];
  const priorOutlines: SceneOutline[] = resumeSource ? await json(path.join(resumeSource, 'prepared-outlines.json')).catch(() => json(path.join(resumeSource, 'outlines.json'))) : [];
  const priorSummary = resumeSource ? await json(path.join(resumeSource, 'attempt-summary.json')).catch(() => null) : null;
  const previousTotalCalls = priorSummary?.cumulativeModelCalls ?? priorAttempts.length;
  let manifest = await json(path.join(output, 'manifest.json')).catch(() => sourceManifest ? structuredClone(sourceManifest) : null);
  if (!manifest) manifest = { isolatedTemplateId: randomUUID(), referenceTemplateId: reference.id, referenceClassroomId: 'We8xHlvHQ6', sourceSnapshotHash: hash(snapshot), basis: arg('--outline-source') === 'request-v12' ? 'request-v12' : 'adopted-v19', createdAt: new Date().toISOString() };
  assert.equal(manifest.sourceSnapshotHash, hash(snapshot));
  assert.equal(manifest.basis, arg('--outline-source') === 'request-v12' ? 'request-v12' : 'adopted-v19');
  Object.assign(manifest, { selectedIds, selectedPages: preflight, fullOutlineCount: 25, originalQuizCount: 7, fixtureEvidence, originalRequestHash: hash(originalRequest), adoptedPlanHash: hash(adopted), effectivePlanHash: hash(outlines), changedTeachingFields: [], blueprintCalls: 0, planningCalls: 0, retryPolicy: 'One invocation only; normal production bounded retries are retained and every stage attempt is recorded, with no candidate selection or manual rerun.', scope: 'Visual generation acceptance only; original template and published classroom are never changed. Native generator controls layout. No flow layout is injected or forced. TTS disabled for this visual sample.' });
  const input = { ...referenceJob.request, courseId: manifest.isolatedTemplateId, sceneOutlines: outlines, enableWebSearch: false, enableImageGeneration: true, enableVideoGeneration: false, enableTTS: false };
  for (const key of ['generationScope', 'testLesson', 'updateTarget', 'managedRecoveryCount']) delete input[key];
  if (resumeSource) {
    assert.equal(sourceManifest.effectivePlanHash, hash(outlines), 'Resume may not silently change any adopted teaching or fixture input');
    assert.deepEqual(input, await json(path.join(resumeSource, 'generation-input.json')), 'Resume input differs from the recorded first-pass input');
    await mkdir(path.join(output, 'excluded-checkpoints'), { recursive: true });
    const excludedCheckpoints = [];
    for (const id of regenerateIds) {
      const file = `checkpoint-${id}-content.json`;
      const checkpoint = await json(path.join(resumeSource, file));
      await copyFile(path.join(resumeSource, file), path.join(output, 'excluded-checkpoints', file));
      excludedCheckpoints.push({ outlineId: id, source: path.join(resumeSource, file), checkpointHash: hash(checkpoint), reason: 'Explicitly rejected in visual/semantic review; do not reuse or claim first-pass success.' });
    }
    Object.assign(manifest, { resumeSource, resumedAt: new Date().toISOString(), regenerateIds, excludedCheckpoints, previousTotalCalls, retryPolicy: 'Explicit correction attempt after retained first-pass failure; exact-fingerprint completed stages reused through production callbacks. New bounded transport budget for missing/rejected stages; all previous and current calls counted cumulatively.' });
    await save('prior-stage-attempts.json', priorAttempts);
  }
  await save('manifest.json', manifest);
  await save('original-request-outlines.json', originalRequest);
  await save('adopted-outlines.json', adopted);
  await save('outlines.json', outlines);
  await save('generation-input.json', input);
  await save('quiz-baseline.json', basis.filter((outline) => outline.type === 'quiz'));
  console.log(JSON.stringify({ command, output, templateId: manifest.isolatedTemplateId, preflight, inheritedResourceFixtures: fixtureEvidence.length, sourceTeachingInputsUnchanged: true }));
  if (command === 'prepare' || process.argv.includes('--prepare-only')) return;
  assert.ok(!await json(path.join(output, 'run-started.json')).catch(() => null), 'This attempt directory has already run; use another explicit resume directory without overwriting evidence');
  for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => { appendFileSync(path.join(output, 'generation.log'), `${format(...args)}\n`); original(...args); };
  }
  await save('run-started.json', { at: new Date().toISOString(), command, resumeSource, regenerateIds });
  assert.ok(preflight.every((page) => page.compatible), 'Adopted plan is not compatible; do not silently enhance/replan it');
  assert.ok(!await json(path.join(output, 'classroom-before-media.json')).catch(() => null), 'This first-pass run already generated content; use a new output directory instead of hiding retries');
  for (const [key, filename] of [['DATABASE_URL', 'database_url.txt'], ['PROVIDER_ENCRYPTION_KEY', 'provider_encryption_key.txt']]) process.env[key!] ??= (await readFile(`deploy/secrets/${filename}`, 'utf8')).trim();
  process.env.CLASSROOM_DATA_DIR ??= '.openpbl-data/classrooms';
  process.env.OPENPBL_OUTBOUND_PROXY ??= 'http://127.0.0.1:19999';
  const db = new PrismaClient();
  const began = Date.now();
  const attempts: unknown[] = [];
  const restoredStages: unknown[] = [];
  const saveSummary = async (status: string) => save('attempt-summary.json', { status, elapsedMs: Date.now() - began, previousTotalCalls, currentModelCalls: attempts.length, cumulativeModelCalls: previousTotalCalls + attempts.length, attempts, restoredStages, regenerateIds, imageCallsIncludedInModelCount: false, scope: 'Model counts are classroom text stage transports; image generation is separately recorded by media logs.', sourceTeachingInputsUnchanged: true });
  try {
    const source = await db.classroomTemplateVersion.findUniqueOrThrow({ where: { id: reference.versions[0].id } });
    assert.equal(hash(source.snapshot), manifest.sourceSnapshotHash, 'Authoritative source changed since capture; refresh the evidence explicitly');
    const { initializeServerProviderConfig } = await import('../src/lib/openmaic/server/provider-config');
    await initializeServerProviderConfig();
    const { generateClassroom } = await import('../src/lib/openmaic/server/classroom-generation');
    const { generateClassroomAssets } = await import('../src/lib/openmaic/server/classroom-asset-generation');
    const { readClassroom } = await import('../src/lib/openmaic/server/classroom-storage');
    const generated = await generateClassroom(input as GenerateClassroomInput, {
      preparedOutlines: outlines,
      generationOutlineIds: selectedIds,
      loadSceneStageCheckpoint: resumeSource ? async (outline, stage, model, fingerprint) => {
        if (regenerateIds.includes(outline.id)) return null;
        const checkpoint = await json(path.join(resumeSource, `checkpoint-${outline.id}-${stage}.json`)).catch(() => null);
        if (!checkpoint) return null;
        assert.equal(checkpoint.outlineId, outline.id);
        assert.equal(checkpoint.stage, stage);
        assert.equal(checkpoint.model, model, `Saved ${outline.id}/${stage} model changed; refuse unrequested regeneration`);
        assert.equal(checkpoint.fingerprint, fingerprint, `Saved ${outline.id}/${stage} input changed; refuse unrequested regeneration`);
        const priorOutline = priorOutlines.find((candidate) => candidate.id === outline.id);
        assert.ok(priorOutline, `Missing recorded outline for ${outline.id}`);
        const outlineFingerprint = checkpoint.outlineFingerprint ?? fingerprintSceneOutline(priorOutline);
        const payload = restoreSceneStageCheckpoint({ outline, stage, modelFingerprint: model, inputFingerprint: fingerprint, checkpoint: { schemaVersion: 1, pageKey: checkpoint.outlineId, stage: checkpoint.stage, outlineFingerprint, modelFingerprint: checkpoint.model, inputFingerprint: checkpoint.fingerprint, payload: checkpoint.payload } });
        assert.ok(payload, `Saved ${outline.id}/${stage} outline changed; refuse stale restore or unrequested regeneration`);
        restoredStages.push({ outlineId: outline.id, stage, at: new Date().toISOString(), fingerprint, source: resumeSource });
        await save('restored-stages.json', restoredStages);
        // Carry validated stages forward so a later explicit resume need not search ancestors.
        await save(`checkpoint-${outline.id}-${stage}.json`, checkpoint);
        return payload;
      } : undefined,
      onOutlinesPrepared: async (prepared) => {
        const byId = new Map(prepared.map((outline) => [outline.id, outline]));
        for (const outline of basis) assert.deepEqual(protectedPage(byId.get(outline.id)!), protectedPage(outline), `Pipeline rewrote adopted teaching input: ${outline.id}`);
        assert.deepEqual(prepared.filter((outline) => outline.type === 'quiz'), basis.filter((outline) => outline.type === 'quiz'));
        await save('prepared-outlines.json', prepared);
      },
      onSceneStageAttempt: async (outline, stage, count, model, fingerprint) => { attempts.push({ outlineId: outline.id, stage, attemptsStarted: count, model, fingerprint, at: new Date().toISOString() }); await save('stage-attempts.json', attempts); await saveSummary('running'); },
      onSceneStageCompleted: async (outline, stage, payload, model, fingerprint) => { await save(`checkpoint-${outline.id}-${stage}.json`, { outlineId: outline.id, stage, payload, model, fingerprint, outlineFingerprint: fingerprintSceneOutline(outline) }); },
      onProgress: (progress) => { console.log(JSON.stringify({ step: progress.step, progress: progress.progress, message: progress.message })); },
    });
    await save('classroom-before-media.json', generated);
    assert.equal(generated.scenes.length, selectedIds.length, 'Representative authoring unexpectedly changed the selected page count');
    assert.deepEqual(new Set(generated.scenes.map((scene) => scene.outlineId)), new Set(selectedIds));
    // Bind only the new artifact to a new private draft, enabling real authorized image reads.
    const isolatedSnapshot = structuredClone(snapshot);
    delete isolatedSnapshot.design.teacherClassroomId;
    isolatedSnapshot.design.aiLearningClassroomId = generated.id;
    isolatedSnapshot.design.content = { ...isolatedSnapshot.design.content, _openmaicClassroomId: generated.id, _openmaicScenesCount: generated.scenes.length, _openmaicSceneOutlines: outlines };
    delete isolatedSnapshot.design.content.teacherClassroomId;
    await db.classroomTemplate.create({ data: { id: manifest.isolatedTemplateId, ownerId: reference.ownerId, title: `${reference.title}（权威基准四页视觉验收）`, description: 'Isolated first-pass visual sample; complete adopted teaching plan and quizzes preserved; never published.', status: 'ACTIVE', versions: { create: { version: 1, status: 'DRAFT', snapshot: isolatedSnapshot } } } });
    Object.assign(manifest, { classroomId: generated.id, generationStartedAt: new Date(began).toISOString() });
    await save('manifest.json', manifest);
    try {
      await generateClassroomAssets({ ...generated.assetContext, baseUrl: 'http://127.0.0.1:3000', studentClassroomId: generated.id, studentScenes: generated.scenes });
    } finally {
      await save('classroom.json', { ...generated, ...await readClassroom(generated.id) });
      await save('metrics.json', { elapsedMs: Date.now() - began, attempts, sourceTeachingInputsUnchanged: true, selectedPages: selectedIds.length, blueprintCalls: 0, planningCalls: 0 });
    }
    assert.equal(hash((await db.classroomTemplateVersion.findUniqueOrThrow({ where: { id: reference.versions[0].id } })).snapshot), manifest.sourceSnapshotHash);
    await saveSummary('completed');
    console.log(JSON.stringify({ completed: true, classroomId: generated.id, isolatedTemplateId: manifest.isolatedTemplateId, output }));
  } catch (error) {
    await saveSummary('failed');
    throw error;
  } finally { await db.$disconnect(); }
}
main().catch(async (error: unknown) => {
  if (canWriteOutput) {
    await mkdir(output, { recursive: true });
    await save('failure.json', { at: new Date().toISOString(), message: error instanceof Error ? error.message : String(error) });
  }
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
});
