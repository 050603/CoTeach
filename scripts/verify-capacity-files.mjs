/** Read-only per-student database/file reconciliation. Never downloads or deletes data. */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { tsImport } from 'tsx/esm/api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ORIGIN = 'https://coteach.cn';
const RUN_ID = /^capacity-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function readOnlyDatabaseUrl(value) {
  const url = new URL(value);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  url.searchParams.set('options', '-c default_transaction_read_only=on -c statement_timeout=30000');
  url.searchParams.set('connection_limit', '1');
  return url.toString();
}

export function safeUploadPath(directory, asset) {
  assert.match(asset.id, UUID, 'Invalid asset ID');
  assert.equal(typeof asset.storageKey, 'string');
  assert.match(asset.storageKey, /^[0-9a-f-]{36}\.[a-zA-Z0-9]+$/, 'Unsafe upload storage key');
  assert.equal(path.parse(asset.storageKey).name, asset.id, 'Filename must identify the same FileAsset');
  const root = path.resolve(directory);
  const target = path.resolve(root, asset.storageKey);
  assert.equal(path.dirname(target), root, 'Upload path escapes the storage directory');
  return target;
}

export function validateUploadUrl(value, assetId) {
  assert.match(assetId, UUID);
  const relative = `/api/uploads/${assetId}`;
  assert.ok([relative, `${relative}?download=1`, ORIGIN + relative, `${ORIGIN}${relative}?download=1`].includes(value),
    'Upload URL must be the exact owned asset path; traversal and other origins are refused');
}

function unique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} contains duplicate identifiers`);
}

export async function verifyAssetFile({ asset, userId, offeringId, sha256, size, uploadDirectory }) {
  assert.ok(asset, 'Expected FileAsset is missing');
  assert.equal(asset.uploadedById, userId, 'FileAsset owner differs from the acknowledged student');
  assert.equal(asset.offeringId, offeringId, 'FileAsset belongs to another offering');
  assert.equal(asset.deletedAt, null, 'Acknowledged file was deleted');
  assert.match(sha256, DIGEST, 'Expected SHA-256 is missing');
  assert.equal(asset.sha256, sha256, 'Database SHA-256 differs from the manifest');
  const databaseSize = Number(asset.size);
  assert.ok(Number.isSafeInteger(databaseSize) && databaseSize > 0);
  if (size !== undefined) assert.equal(databaseSize, size, 'Database size differs from the manifest');
  const handle = await open(safeUploadPath(uploadDirectory, asset), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    assert.ok(before.isFile(), 'Upload path must be a regular file');
    assert.equal(before.size, databaseSize, 'Stored file size differs from the database');
    const hash = createHash('sha256');
    for await (const block of handle.createReadStream({ autoClose: false })) hash.update(block);
    assert.equal(hash.digest('hex'), sha256, 'Stored file SHA-256 mismatch');
    const after = await handle.stat();
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs, 'File changed during reconciliation');
    return { assetId: asset.id, storageKey: asset.storageKey, size: databaseSize, sha256, verified: true };
  } finally { await handle.close(); }
}

export async function verifyUploadManifest({ actualAssets, expectedUploads, userId, offeringId, uploadDirectory }) {
  if (expectedUploads === undefined) return {
    status: 'not-recorded', observedCount: actualAssets.length, verifiedCount: 0, files: [],
    limitation: 'The runner did not record uploaded attachments; exact attachment reconciliation is unavailable.',
  };
  assert.ok(Array.isArray(expectedUploads), 'uploads must be an array');
  unique(expectedUploads.map((item) => item.id), 'Upload manifest');
  assert.equal(actualAssets.length, expectedUploads.length, 'Unexpected or missing non-archive FileAsset count');
  const files = [];
  for (const expected of expectedUploads) {
    validateUploadUrl(expected.url, expected.id);
    assert.ok(Number.isSafeInteger(expected.size) && expected.size > 0, 'Upload manifest size is missing');
    const asset = actualAssets.find((item) => item.id === expected.id);
    files.push(await verifyAssetFile({ asset, userId, offeringId, sha256: expected.sha256,
      size: expected.size, uploadDirectory }));
  }
  return { status: 'passed', observedCount: actualAssets.length, verifiedCount: files.length, files };
}

export async function verifyExternalArtifactManifest({ versions, receipts, expectedArtifacts = [], userId,
  offeringId, instanceId, participationId, uploadDirectory }) {
  assert.ok(Array.isArray(expectedArtifacts), 'externalArtifacts must be an array');
  unique(expectedArtifacts.map((item) => item.versionId), 'External artifact manifest');
  unique(expectedArtifacts.map((item) => item.uploadId), 'External artifact files');
  unique(expectedArtifacts.map((item) => item.requestId), 'External artifact request IDs');
  assert.equal(versions.length, expectedArtifacts.length, 'Unexpected or missing external ArtifactVersion count');
  assert.equal(receipts.length, expectedArtifacts.length, 'External artifact receipt count differs');
  const results = [];
  for (const expected of expectedArtifacts) {
    assert.match(expected.requestId, UUID, 'External artifact request ID is missing');
    assert.ok(Number.isSafeInteger(expected.size) && expected.size > 0, 'External artifact size is missing');
    validateUploadUrl(expected.url, expected.uploadId);
    const version = versions.find((item) => item.id === expected.versionId);
    assert.ok(version, 'External artifact version is missing');
    assert.equal(version.artifact.participationId, participationId);
    assert.equal(version.artifact.type, 'FILE_ARCHIVE', 'Local artifact must use FILE_ARCHIVE');
    assert.equal(version.artifact.status, 'SUBMITTED');
    assert.equal(version.fileAssetId, expected.uploadId);
    assert.equal(version.sequence, expected.sequence); assert.equal(version.status, 'SUBMITTED');
    assert.equal(version.sha256, expected.sha256); assert.equal(version.size, version.fileAsset?.size);
    assert.equal(version.mimeType, version.fileAsset?.mimeType);
    assert.ok(version.submittedAt instanceof Date, 'External artifact submission time is missing');
    const matching = receipts.filter((item) => item.payload?.versionId === expected.versionId);
    assert.equal(matching.length, 1, 'External artifact has missing or duplicated receipt');
    const receipt = matching[0];
    assert.equal(receipt.offeringId, offeringId); assert.equal(receipt.classroomInstanceId, instanceId);
    assert.equal(receipt.participationId, participationId); assert.equal(receipt.actorId, userId);
    assert.equal(receipt.idempotencyKey, `file-artifact:${instanceId}:${userId}:${expected.requestId}`);
    assert.equal(receipt.payload.requestId, expected.requestId); assert.equal(receipt.payload.studentId, userId);
    assert.equal(receipt.payload.kind, 'file'); assert.equal(receipt.payload.title, version.artifact.title);
    const fingerprint = createHash('sha256').update(JSON.stringify([version.artifact.title,
      version.fileAsset?.originalName, version.mimeType, expected.size, expected.sha256, 'file'])).digest('hex');
    assert.equal(receipt.payload.fingerprint, fingerprint, 'External artifact immutable filename/content fingerprint differs');
    results.push({ versionId: version.id, sequence: version.sequence, requestId: expected.requestId, type: version.artifact.type,
      ...await verifyAssetFile({ asset: version.fileAsset, userId, offeringId,
        sha256: expected.sha256, size: expected.size, uploadDirectory }) });
  }
  assert.deepEqual(results.map((item) => item.sequence).sort((a, b) => a - b),
    Array.from({ length: expectedArtifacts.length }, (_, i) => i + 1), 'External artifact sequences have a gap or duplicate');
  return results;
}

async function verifyUploadReceipt(db, expected, userId, offeringId) {
  assert.match(expected.requestId, UUID, 'Upload request ID is missing');
  const key = `upload-receipt:${createHash('sha256').update(JSON.stringify([userId, expected.requestId])).digest('hex')}`;
  const receipts = await db.domainEvent.findMany({ where: {
    actorId: userId, eventType: 'UPLOAD_RECEIPT', payload: { path: ['requestId'], equals: expected.requestId },
  } });
  assert.equal(receipts.length, 1, 'Upload request must have exactly one committed receipt');
  const receipt = receipts[0];
  assert.equal(receipt.actorId, userId); assert.equal(receipt.idempotencyKey, key);
  assert.equal(receipt.offeringId, offeringId);
  assert.equal(receipt.payload.response.id, expected.id); assert.equal(receipt.payload.response.url, expected.url);
  assert.equal(receipt.payload.response.sizeBytes, expected.size);
  assert.equal(receipt.payload.response.requestId, expected.requestId);
}

/** Linux dirfd traversal prevents a replaced/symlinked intermediate directory
 * from redirecting a report-driven read outside the trusted classroom root. */
async function readClassroomFile(directory, segments, limit = 64 * 1024 * 1024) {
  assert.ok(segments.every(segment => typeof segment === 'string' && /^[a-zA-Z0-9._-]+$/.test(segment)
    && segment !== '.' && segment !== '..'), 'Unsafe classroom media path');
  const handles = [];
  try {
    handles.push(await open(path.resolve(directory), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    for (const segment of segments.slice(0, -1)) handles.push(await open(`/proc/self/fd/${handles.at(-1).fd}/${segment}`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    const file = await open(`/proc/self/fd/${handles.at(-1).fd}/${segments.at(-1)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    handles.push(file);
    const before = await file.stat();
    assert.ok(before.isFile() && before.size > 0 && before.size <= limit, 'Classroom artifact must be a bounded regular file');
    const bytes = await file.readFile();
    const after = await file.stat();
    assert.equal(after.size, before.size); assert.equal(bytes.length, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs, 'Classroom artifact changed during reconciliation');
    return bytes;
  } finally { for (const handle of handles.reverse()) await handle.close(); }
}

export async function verifyLecturePlayback({ report, classroomsDirectory, asset }) {
  const expected = report.fixture.lectureAudio;
  if (expected?.playbackUrl === undefined) return { status: 'not-recorded', verified: false };
  assert.match(report.runId ?? '', RUN_ID);
  const classroomId = `${report.runId}-lesson`;
  const sceneId = `${report.runId}-student-lecture`;
  assert.equal(report.fixture.classroomId, classroomId, 'Lecture classroom must be owned by this run');
  assert.equal(report.fixture.lectureSceneId, sceneId, 'Lecture scene must be owned by this run');
  const prefix = `/api/openmaic/classroom-media/${classroomId}/audio/lecture.`;
  assert.ok(typeof expected.playbackUrl === 'string' && expected.playbackUrl.startsWith(prefix), 'Unexpected classroom playback URL');
  const format = expected.playbackUrl.slice(prefix.length);
  assert.ok(['wav', 'wave', 'x-wav', 'mp3', 'mpeg'].includes(format), 'Playback URL contains an unsafe path or unsupported format');
  assert.match(expected.servedSha256 ?? '', DIGEST, 'Downloaded classroom media SHA-256 is missing');
  assert.ok(Number.isFinite(expected.durationSec) && expected.durationSec > 0, 'Lecture duration is missing');
  const classroomBytes = await readClassroomFile(classroomsDirectory, [`${classroomId}.json`]);
  const classroom = JSON.parse(classroomBytes.toString('utf8'));
  assert.equal(classroom.id, classroomId);
  assert.ok(Array.isArray(classroom.scenes));
  const scenes = classroom.scenes.filter(scene => scene.id === sceneId);
  assert.equal(scenes.length, 1, 'Lecture scene is missing or duplicated');
  assert.ok(Array.isArray(scenes[0].actions));
  const speeches = scenes[0].actions.filter(action => action.type === 'speech');
  assert.ok(speeches.length > 0, 'Lecture scene has no speech actions');
  for (const speech of speeches) {
    assert.ok(typeof speech.audioUrl === 'string', 'Speech action lacks its classroom audio URL');
    if (speech.audioUrl !== expected.playbackUrl) {
      const queryPrefix = `${expected.playbackUrl}?capacityClip=`;
      assert.ok(speech.audioUrl.startsWith(queryPrefix), 'Speech action points to another media file');
      assert.match(speech.audioUrl.slice(queryPrefix.length), /^(0|[1-9][0-9]*)$/, 'Speech media query must contain only capacityClip');
    }
    assert.equal(speech.audioDurationSec, expected.durationSec, 'Speech action duration differs from the manifest');
  }
  unique(speeches.map(speech => speech.audioUrl), 'Speech clip URLs');
  const relativePath = [classroomId, 'audio', `lecture.${format}`];
  const bytes = await readClassroomFile(classroomsDirectory, relativePath);
  const rawSha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(bytes.length, asset.size, 'Classroom audio size differs from the acknowledged teacher upload');
  assert.equal(rawSha256, asset.sha256, 'Classroom audio SHA-256 differs from the acknowledged teacher upload');
  const [wavModule, durationModule] = await Promise.all([
    tsImport('../src/lib/openmaic/audio/wav-container.ts', { parentURL: import.meta.url, tsconfig: false }),
    tsImport('../src/lib/openmaic/audio/audio-duration.ts', { parentURL: import.meta.url, tsconfig: false }),
  ]);
  const { normalizePlayableWav } = wavModule.default ?? wavModule;
  const { audioDurationSec } = durationModule.default ?? durationModule;
  // Match classroom-media GET: WAV headers may be repaired without changing
  // the stored source file. Its served digest need not equal the raw digest.
  const served = format === 'wav' ? normalizePlayableWav(bytes) : bytes;
  const servedSha256 = createHash('sha256').update(served).digest('hex');
  assert.equal(servedSha256, expected.servedSha256, 'Downloaded classroom media SHA-256 differs from route-normalized bytes');
  const durationSec = audioDurationSec(served, format);
  assert.ok(durationSec && Math.abs(durationSec - expected.durationSec) <= 0.001, 'Decoded playable audio duration differs from the classroom');
  return { status: 'passed', verified: true, relativePath: relativePath.join('/'), playbackUrl: expected.playbackUrl,
    sourceSize: bytes.length, sourceSha256: rawSha256, servedSize: served.byteLength, servedSha256,
    durationSec, speechActionsVerified: speeches.length, classroomJsonSha256: createHash('sha256').update(classroomBytes).digest('hex') };
}

export async function verifyLectureAudio({ db, report, uploadDirectory,
  classroomsDirectory = path.resolve(uploadDirectory, '../classrooms') }) {
  const expected = report.fixture.lectureAudio;
  if (expected === undefined) return undefined;
  assert.match(expected.userId, UUID);
  assert.ok(report.fixture.userIds.includes(expected.userId), 'Lecture audio teacher is outside fixture ownership');
  const owner = await db.user.findUniqueOrThrow({ where: { id: expected.userId }, select: { username: true, role: true } });
  assert.match(owner.username, new RegExp(`^${report.runId}-[0-9]+$`));
  assert.equal(owner.role, 'TEACHER', 'Lecture audio must belong to a teacher');
  validateUploadUrl(expected.url, expected.id);
  assert.ok(Number.isSafeInteger(expected.size) && expected.size > 0);
  const asset = await db.fileAsset.findUniqueOrThrow({ where: { id: expected.id } });
  assert.match(asset.mimeType, /^audio\//, 'Lecture media must be audio');
  const file = await verifyAssetFile({ asset, userId: expected.userId, offeringId: report.fixture.offeringId,
    sha256: expected.sha256, size: expected.size, uploadDirectory });
  await verifyUploadReceipt(db, expected, expected.userId, report.fixture.offeringId);
  const playback = await verifyLecturePlayback({ report, classroomsDirectory, asset: file });
  return { userId: expected.userId, requestId: expected.requestId, receiptVerified: true, ...file, playback };
}

export async function verifyCapacityFiles({ db, report, uploadDirectory,
  classroomsDirectory = path.resolve(uploadDirectory, '../classrooms') }) {
  assert.match(report.runId ?? '', /^capacity-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(['passed', 'partial', 'failed'].includes(report.outcome), 'Only stopped runs may be reconciled');
  const { fixture, studentCount } = report;
  assert.ok(fixture?.instanceId && fixture.offeringId && Array.isArray(fixture.userIds));
  assert.ok(Number.isInteger(studentCount) && studentCount > 0 && studentCount <= 40);
  const entries = Object.entries(report.expected ?? {});
  assert.equal(entries.length, studentCount, 'Every student must have an expected record');
  const offering = await db.courseOffering.findUniqueOrThrow({ where: { id: fixture.offeringId } });
  assert.equal(offering.description, report.runId, 'Only this capacity run may be inspected');
  const instance = await db.classroomInstance.findUniqueOrThrow({ where: { id: fixture.instanceId },
    include: { activity: { include: { chapter: true } } } });
  assert.equal(instance.activity.chapter.offeringId, fixture.offeringId);
  const lectureAudio = await verifyLectureAudio({ db, report, uploadDirectory, classroomsDirectory });
  const results = [];
  const limitations = [];
  for (const [userId, state] of entries) {
    assert.match(userId, UUID);
    assert.ok(fixture.userIds.includes(userId), 'Student is outside fixture ownership');
    const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { username: true, role: true } });
    assert.match(user.username, new RegExp(`^${report.runId}-[0-9]+$`));
    assert.equal(user.role, 'STUDENT');
    const participations = await db.classroomParticipation.findMany({
      where: { instanceId: fixture.instanceId, enrollment: { userId, offeringId: fixture.offeringId } },
      include: { enrollment: true },
    });
    assert.equal(participations.length, 1, 'Student must own exactly one classroom participation');
    const participation = participations[0];
    const submissions = await db.classroomSubmission.findMany({ where: {
      participationId: participation.id, OR: [{ id: state.submissionId }, { payload: { path: ['view', 'id'], equals: state.submissionId } }],
    } });
    assert.equal(submissions.length, 1, 'Expected personal draft is missing or duplicated');
    const submission = submissions[0];
    const view = submission.payload?.view ?? submission.payload;
    const expectedVersion = state.version ?? state.saves;
    assert.ok(Number.isInteger(expectedVersion) && expectedVersion > 0);
    assert.equal(view.studentId, userId); assert.equal(view.courseId, fixture.instanceId);
    assert.equal(view.content, state.content, 'Last acknowledged document content differs');
    assert.equal(view.version, expectedVersion, 'Last acknowledged document version differs');
    const saves = await db.domainEvent.findMany({ where: {
      actorId: userId, classroomInstanceId: fixture.instanceId, eventType: 'COURSE_ACTION',
      payload: { path: ['action', 'type'], equals: 'UPSERT_SUBMISSION' },
    } });
    assert.equal(saves.length, state.saves, 'Save receipt count differs from acknowledged saves');
    const committedVersions = [];
    for (const save of saves) {
      assert.equal(save.participationId, participation.id); assert.equal(save.offeringId, fixture.offeringId);
      assert.equal(save.payload.action.payload.submission.studentId, userId);
      assert.equal(save.payload.action.payload.submission.id, state.submissionId);
      assert.equal(save.idempotencyKey, `course-action:${userId}:${save.payload.ack.requestId}`);
      committedVersions.push(save.payload.ack.submissionVersion);
    }
    unique(saves.map((item) => item.payload.ack.requestId), 'Save receipts');
    assert.deepEqual(saves.find((item) => item.payload.ack.requestId === state.lastRequestId)?.payload.ack, state.lastAck,
      'Latest save receipt does not match the report');

    assert.ok(Array.isArray(state.archives), 'Archive manifest is missing');
    const externalArtifacts = state.externalArtifacts ?? [];
    assert.ok(Array.isArray(externalArtifacts), 'externalArtifacts must be an array');
    unique([...state.archives, ...externalArtifacts].map((item) => item.versionId), 'Artifact manifest');
    const versions = await db.artifactVersion.findMany({ where: { artifact: { participationId: participation.id } },
      include: { artifact: true, fileAsset: true } });
    assert.equal(versions.length, state.archives.length + externalArtifacts.length, 'Unexpected or missing ArtifactVersion count');
    unique(versions.map((item) => item.fileAssetId), 'Archive files');
    const archiveReceipts = await db.domainEvent.findMany({ where: {
      actorId: userId, participationId: participation.id, classroomInstanceId: fixture.instanceId, eventType: 'document_version_submitted',
    } });
    assert.equal(archiveReceipts.length, state.archives.length, 'Archive receipt count differs');
    const archiveResults = [];
    for (const expected of state.archives) {
      validateUploadUrl(expected.downloadUrl, expected.docxUploadId);
      const version = versions.find((item) => item.id === expected.versionId);
      assert.ok(version, 'Archive version is missing');
      assert.equal(version.artifactId, `document:${submission.id}`);
      assert.equal(version.artifact.type, 'DOCUMENT_ARCHIVE');
      assert.equal(version.artifact.participationId, participation.id);
      assert.equal(version.fileAssetId, expected.docxUploadId);
      assert.equal(version.sequence, expected.sequence); assert.equal(version.status, 'SUBMITTED');
      assert.equal(version.sha256, expected.sha256); assert.equal(version.size, version.fileAsset?.size);
      assert.equal(version.fileAsset?.storageKey, `${expected.docxUploadId}.docx`);
      assert.equal(version.submittedAt?.toISOString(), expected.submittedAt);
      const matchingReceipts = archiveReceipts.filter((item) => item.payload?.versionId === expected.versionId);
      assert.equal(matchingReceipts.length, 1, 'Archive has missing or duplicated receipt');
      const receipt = matchingReceipts[0];
      assert.equal(receipt.offeringId, fixture.offeringId);
      assert.equal(receipt.payload.submissionId, state.submissionId);
      assert.equal(receipt.payload.docxUploadId, expected.docxUploadId);
      assert.equal(receipt.payload.sha256, expected.sha256);
      assert.equal(receipt.payload.sequence, expected.sequence);
      assert.equal(receipt.payload.submissionVersion, expected.submissionVersion);
      assert.equal(receipt.payload.sourceVersion + 1, expected.submissionVersion);
      assert.ok(saves.some((save) => save.payload.ack.submissionVersion === receipt.payload.sourceVersion), 'Archive source version lacks an acknowledged save');
      assert.equal(version.fileAsset.originalName, `${receipt.payload.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 96)}.docx`);
      committedVersions.push(expected.submissionVersion);
      archiveResults.push({ versionId: version.id, sequence: version.sequence, submissionVersion: expected.submissionVersion,
        ...await verifyAssetFile({ asset: version.fileAsset, userId, offeringId: fixture.offeringId,
          sha256: expected.sha256, size: receipt.payload.size, uploadDirectory }) });
    }
    unique(committedVersions, 'Committed draft versions');
    assert.deepEqual(committedVersions.sort((a, b) => a - b), Array.from({ length: expectedVersion }, (_, i) => i + 1),
      'Acknowledged save/archive version chain has a gap or duplicate');

    const externalReceipts = await db.domainEvent.findMany({ where: {
      actorId: userId, participationId: participation.id, classroomInstanceId: fixture.instanceId, eventType: 'file_artifact_submitted',
    } });
    const docxVersionIds = new Set(state.archives.map((item) => item.versionId));
    const externalResults = await verifyExternalArtifactManifest({
      versions: versions.filter((item) => !docxVersionIds.has(item.id)), receipts: externalReceipts, expectedArtifacts: externalArtifacts,
      userId, offeringId: fixture.offeringId, instanceId: fixture.instanceId, participationId: participation.id, uploadDirectory,
    });
    const assets = await db.fileAsset.findMany({ where: { uploadedById: userId } });
    if (Array.isArray(state.uploads)) assert.equal(assets.length, state.uploads.length + state.archives.length + externalArtifacts.length,
      'Total FileAsset count differs from attachment, document archive and external artifact manifests');
    const archiveAssetIds = new Set(versions.map((item) => item.fileAssetId));
    const uploads = await verifyUploadManifest({ actualAssets: assets.filter((item) => !archiveAssetIds.has(item.id)),
      expectedUploads: state.uploads, userId, offeringId: fixture.offeringId, uploadDirectory });
    if (uploads.status !== 'passed') limitations.push({ userId, check: 'upload-manifest-not-recorded' });
    let uploadReceipts = 0;
    for (const expected of state.uploads ?? []) {
      if (!expected.requestId) { limitations.push({ userId, assetId: expected.id, check: 'upload-request-id-not-recorded' }); continue; }
      await verifyUploadReceipt(db, expected, userId, fixture.offeringId);
      uploadReceipts++;
    }
    results.push({ userId, participationId: participation.id, savesVerified: saves.length,
      currentVersion: expectedVersion, versionChainComplete: true, uploads, uploadReceiptsVerified: uploadReceipts,
      archivesVerified: archiveResults.length, archives: archiveResults,
      externalArtifactsVerified: externalResults.length, externalArtifacts: externalResults, totalFileAssets: assets.length });
  }
  return { outcome: limitations.length ? 'partial' : 'passed', checkedAt: new Date().toISOString(),
    studentsVerified: results.length, uploadsVerified: results.reduce((sum, item) => sum + item.uploads.verifiedCount, 0),
    archivesVerified: results.reduce((sum, item) => sum + item.archivesVerified, 0),
    externalArtifactsVerified: results.reduce((sum, item) => sum + item.externalArtifactsVerified, 0),
    lectureAudioVerified: lectureAudio ? 1 : 0, lecturePlaybackVerified: lectureAudio?.playback.verified ? 1 : 0,
    ...(lectureAudio ? { lectureAudio } : {}), limitations, results };
}

async function main() {
  const filename = process.argv[2];
  if (!filename || filename === '--help') { console.log('node scripts/verify-capacity-files.mjs <capacity-report.json>'); return; }
  const reportPath = path.resolve(filename);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const url = readOnlyDatabaseUrl(process.env.CAPACITY_DATABASE_URL || (await readFile(path.join(root, 'deploy/secrets/database_url.txt'), 'utf8')).trim());
  const db = new PrismaClient({ datasourceUrl: url });
  let result;
  const evidenceScope = { network: 'local-database-and-files-only', sourceRunNetwork: report.network ?? { scope: 'not-recorded' },
    plannedAcceptanceNetwork: { scope: 'campus-intranet', origin: ORIGIN, fixedAddress: '172.16.185.157' },
    fileVerification: 'local-read-only-sha256', httpDownloadsPerformed: false, databaseReadOnly: true };
  try {
    result = await db.$transaction(async (tx) => {
      const setting = await tx.$queryRawUnsafe("SELECT current_setting('default_transaction_read_only') AS default_ro, current_setting('transaction_read_only') AS transaction_ro");
      assert.equal(setting[0].default_ro, 'on'); assert.equal(setting[0].transaction_ro, 'on');
      return { runId: report.runId, scope: evidenceScope,
        ...await verifyCapacityFiles({ db: tx, report, uploadDirectory: path.join(root, '.openpbl-data/uploads') }) };
    }, { isolationLevel: 'RepeatableRead', timeout: 180000 });
  } catch (error) {
    result = { runId: report.runId, scope: evidenceScope, outcome: 'failed', checkedAt: new Date().toISOString(),
      // A concise assertion reason avoids exporting document text or credentials.
      error: error instanceof assert.AssertionError ? error.message.split('\n')[0] : error?.code ?? error?.name ?? 'VerificationError' };
    process.exitCode = 1;
  } finally { await db.$disconnect(); }
  const output = path.join(path.dirname(reportPath), 'files-reconciliation.json');
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(`${result.outcome}: ${output}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
