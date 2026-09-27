import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readOnlyDatabaseUrl, safeUploadPath, validateUploadUrl, verifyAssetFile,
  verifyUploadManifest, verifyExternalArtifactManifest, verifyLectureAudio, verifyLecturePlayback } from './verify-capacity-files.mjs';

const id = '12345678-1234-1234-1234-123456789abc';
const requestId = '12345678-1234-1234-1234-123456789def';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const bytes = Buffer.from('acknowledged classroom evidence\n');

async function fixture(t) {
  const uploadDirectory = await mkdtemp(path.join(tmpdir(), 'capacity-files-'));
  t.after(() => rm(uploadDirectory, { recursive: true, force: true }));
  const asset = { id, storageKey: `${id}.txt`, originalName: 'evidence.txt', uploadedById: 'student', offeringId: 'offering',
    mimeType: 'text/plain', deletedAt: null, sha256: hash(bytes), size: BigInt(bytes.length) };
  await writeFile(path.join(uploadDirectory, asset.storageKey), bytes);
  return { asset, uploadDirectory, userId: 'student', offeringId: 'offering', sha256: asset.sha256, size: bytes.length };
}

test('database connections override writable URL options and restrict the pool', () => {
  const url = new URL(readOnlyDatabaseUrl('postgresql://test:test@localhost/example?options=-c%20default_transaction_read_only%3Doff&connection_limit=8'));
  assert.equal(url.searchParams.get('options'), '-c default_transaction_read_only=on -c statement_timeout=30000');
  assert.equal(url.searchParams.get('connection_limit'), '1');
  assert.throws(() => readOnlyDatabaseUrl('file:///tmp/example'));
});

test('owned file path and URL refuse traversal, normalized aliases, foreign origins and mismatched IDs', () => {
  for (const storageKey of [`../${id}.txt`, `/tmp/${id}.txt`, `nested/${id}.txt`, `..\\${id}.txt`, `${requestId}.txt`, `${id}.txt/..`]) {
    assert.throws(() => safeUploadPath('/tmp/uploads', { id, storageKey }));
  }
  for (const url of [`https://other.example/api/uploads/${id}`, `https://coteach.cn/x/../api/uploads/${id}`,
    `/api/uploads/${id}?download=1&extra=1`, `/api/uploads/%2e%2e/${id}`, `/api/uploads/${requestId}`]) {
    assert.throws(() => validateUploadUrl(url, id));
  }
  validateUploadUrl(`https://coteach.cn/api/uploads/${id}?download=1`, id);
});

test('file verification detects same-size corruption and wrong owners or offerings', async (t) => {
  const input = await fixture(t);
  assert.equal((await verifyAssetFile(input)).verified, true);
  await assert.rejects(verifyAssetFile({ ...input, userId: 'another-student' }), /owner/);
  await assert.rejects(verifyAssetFile({ ...input, offeringId: 'another-classroom' }), /offering/);
  const altered = Buffer.from(bytes); altered[0] ^= 1;
  await writeFile(path.join(input.uploadDirectory, input.asset.storageKey), altered);
  await assert.rejects(verifyAssetFile(input), /SHA-256 mismatch/);
});

test('a symlink cannot make reconciliation inspect a file outside upload storage', async (t) => {
  const input = await fixture(t);
  const filename = path.join(input.uploadDirectory, input.asset.storageKey);
  const target = path.join(input.uploadDirectory, 'outside.txt');
  await writeFile(target, bytes); await rm(filename); await symlink(target, filename);
  await assert.rejects(verifyAssetFile(input), { code: 'ELOOP' });
});

test('attachment manifest requires exact membership and never passes a missing manifest', async (t) => {
  const input = await fixture(t);
  const expectedUploads = [{ id, url: `/api/uploads/${id}`, size: bytes.length, sha256: hash(bytes), requestId }];
  assert.equal((await verifyUploadManifest({ ...input, actualAssets: [input.asset], expectedUploads })).verifiedCount, 1);
  await assert.rejects(verifyUploadManifest({ ...input, actualAssets: [input.asset, { ...input.asset, id: requestId }], expectedUploads }), /count/);
  await assert.rejects(verifyUploadManifest({ ...input, actualAssets: [input.asset], expectedUploads: [expectedUploads[0], expectedUploads[0]] }), /duplicate/);
  const unrecorded = await verifyUploadManifest({ ...input, actualAssets: [input.asset] });
  assert.equal(unrecorded.status, 'not-recorded'); assert.equal(unrecorded.verifiedCount, 0);
});

test('external artifacts reconcile committed receipts, immutable filenames and content independently of document archives', async (t) => {
  const input = await fixture(t);
  const version = { id: 'version', artifact: { title: 'local work', participationId: 'participation', type: 'FILE_ARCHIVE', status: 'SUBMITTED' },
    fileAssetId: id, fileAsset: input.asset, sequence: 1, status: 'SUBMITTED', sha256: input.sha256,
    size: input.asset.size, mimeType: input.asset.mimeType, submittedAt: new Date() };
  const receipt = { offeringId: 'offering', classroomInstanceId: 'instance', participationId: 'participation', actorId: 'student',
    idempotencyKey: `file-artifact:instance:student:${requestId}`, payload: { versionId: 'version', requestId, studentId: 'student',
      kind: 'file', title: 'local work', fingerprint: hash(JSON.stringify(['local work', 'evidence.txt', 'text/plain', bytes.length, hash(bytes), 'file'])) } };
  const expectedArtifacts = [{ versionId: 'version', uploadId: id, requestId, sequence: 1,
    sha256: input.sha256, size: bytes.length, url: `/api/uploads/${id}` }];
  const options = { ...input, instanceId: 'instance', participationId: 'participation', versions: [version], receipts: [receipt], expectedArtifacts };
  assert.equal((await verifyExternalArtifactManifest(options))[0].type, 'FILE_ARCHIVE');
  await assert.rejects(verifyExternalArtifactManifest({ ...options, receipts: [receipt, receipt] }), /receipt count/);
  await assert.rejects(verifyExternalArtifactManifest({ ...options, versions: [{ ...version,
    artifact: { ...version.artifact, type: 'DOCUMENT_ARCHIVE' } }] }), /FILE_ARCHIVE/);
  await assert.rejects(verifyExternalArtifactManifest({ ...options, versions: [{ ...version,
    fileAsset: { ...input.asset, originalName: 'silently-renamed.txt' } }] }), /filename\/content fingerprint/);
  await assert.rejects(verifyExternalArtifactManifest({ ...options, receipts: [{ ...receipt, actorId: 'other-student' }] }));
  await assert.rejects(verifyExternalArtifactManifest({ ...options, receipts: [{ ...receipt,
    payload: { ...receipt.payload, requestId: id } }] }));
  assert.deepEqual(await verifyExternalArtifactManifest({ ...options, expectedArtifacts: undefined, versions: [], receipts: [] }), []);
});

test('lecture audio verifies the teacher-owned asset and receipt separately from student manifests', async (t) => {
  const input = await fixture(t);
  const teacherId = '12345678-1234-1234-1234-123456789123';
  const runId = `capacity-${id}`;
  const asset = { ...input.asset, uploadedById: teacherId, mimeType: 'audio/wav' };
  const expected = { id, userId: teacherId, requestId, url: `/api/uploads/${id}`, size: input.size, sha256: input.sha256 };
  const report = { runId, fixture: { userIds: [teacherId], offeringId: 'offering', lectureAudio: expected } };
  let role = 'TEACHER';
  const receipts = [{ actorId: teacherId, offeringId: 'offering',
    idempotencyKey: `upload-receipt:${hash(JSON.stringify([teacherId, requestId]))}`,
    payload: { response: { id, url: expected.url, sizeBytes: expected.size, requestId } } }];
  const db = { user: { findUniqueOrThrow: async () => ({ username: `${runId}-0`, role }) },
    fileAsset: { findUniqueOrThrow: async () => asset }, domainEvent: { findMany: async () => receipts } };
  const options = { db, report, uploadDirectory: input.uploadDirectory };
  assert.equal((await verifyLectureAudio(options)).receiptVerified, true);
  role = 'STUDENT';
  await assert.rejects(verifyLectureAudio(options), /teacher/);
  role = 'TEACHER'; receipts[0].payload.response.id = requestId;
  await assert.rejects(verifyLectureAudio(options));
  assert.equal(await verifyLectureAudio({ ...options, report: { ...report, fixture: { ...report.fixture, lectureAudio: undefined } } }), undefined);
});

async function lectureFixture(t) {
  const classroomsDirectory = await mkdtemp(path.join(tmpdir(), 'capacity-lecture-files-'));
  t.after(() => rm(classroomsDirectory, { recursive: true, force: true }));
  const runId = `capacity-${id}`;
  const classroomId = `${runId}-lesson`; const lectureSceneId = `${runId}-student-lecture`;
  const playbackUrl = `/api/openmaic/classroom-media/${classroomId}/audio/lecture.wav`;
  const audio = Buffer.alloc(44 + 4800);
  audio.write('RIFF', 0); audio.writeUInt32LE(0x7fffffff, 4); audio.write('WAVE', 8);
  audio.write('fmt ', 12); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(24000, 24); audio.writeUInt32LE(48000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(0x7fffffff, 40);
  const served = Buffer.from(audio); served.writeUInt32LE(served.length - 8, 4); served.writeUInt32LE(served.length - 44, 40);
  const report = { runId, fixture: { classroomId, lectureSceneId, lectureAudio: {
    playbackUrl, durationSec: 0.1, servedSha256: hash(served), size: audio.length, sha256: hash(audio),
  } } };
  const classroom = { id: classroomId, scenes: [{ id: lectureSceneId, actions: [
    { type: 'speech', audioUrl: `${playbackUrl}?capacityClip=0`, audioDurationSec: 0.1 },
    { type: 'speech', audioUrl: `${playbackUrl}?capacityClip=1`, audioDurationSec: 0.1 },
  ] }] };
  const mediaDirectory = path.join(classroomsDirectory, classroomId, 'audio');
  await mkdir(mediaDirectory, { recursive: true });
  const mediaFile = path.join(mediaDirectory, 'lecture.wav');
  const jsonFile = path.join(classroomsDirectory, `${classroomId}.json`);
  await writeFile(mediaFile, audio); await writeFile(jsonFile, JSON.stringify(classroom));
  return { report, classroomsDirectory, asset: { size: audio.length, sha256: hash(audio) }, audio, classroom, mediaFile, jsonFile, mediaDirectory };
}

test('classroom playback reconciles every speech URL, raw upload bytes, normalized download SHA and duration', async (t) => {
  const input = await lectureFixture(t);
  const result = await verifyLecturePlayback(input);
  assert.equal(result.verified, true); assert.equal(result.speechActionsVerified, 2);
  assert.equal(result.sourceSha256, input.asset.sha256);
  assert.notEqual(result.sourceSha256, result.servedSha256, 'Streaming WAV sentinel headers are normalized by the media route');
  assert.equal(result.classroomJsonSha256, hash(await readFile(input.jsonFile)));
  const damaged = Buffer.from(input.audio); damaged[damaged.length - 1] ^= 1;
  await writeFile(input.mediaFile, damaged);
  await assert.rejects(verifyLecturePlayback(input), /differs from the acknowledged teacher upload/);
});

test('playback rejects foreign run IDs, path traversal, URL aliases and missing/extra query data before reading media', async (t) => {
  const input = await lectureFixture(t);
  const original = input.report.fixture.lectureAudio.playbackUrl;
  for (const playbackUrl of [`${original}/../secret.wav`, original.replace('/audio/', '/audio/%2e%2e/'),
    `${original}?capacityClip=0`, `https://coteach.cn${original}`, original.replace('/audio/', '\\audio\\')]) {
    await assert.rejects(verifyLecturePlayback({ ...input, report: { ...input.report,
      fixture: { ...input.report.fixture, lectureAudio: { ...input.report.fixture.lectureAudio, playbackUrl } } } }));
  }
  await assert.rejects(verifyLecturePlayback({ ...input, report: { ...input.report,
    fixture: { ...input.report.fixture, classroomId: 'another-classroom' } } }), /owned by this run/);
  input.classroom.scenes[0].actions[1].audioUrl = `${original}?capacityClip=1&file=secret`;
  await writeFile(input.jsonFile, JSON.stringify(input.classroom));
  await assert.rejects(verifyLecturePlayback(input), /only capacityClip/);
});

test('playback detects duplicated clips, incorrect served hashes and incorrect classroom duration', async (t) => {
  const input = await lectureFixture(t);
  input.report.fixture.lectureAudio.servedSha256 = input.asset.sha256;
  await assert.rejects(verifyLecturePlayback(input), /route-normalized bytes/);
  input.report.fixture.lectureAudio.servedSha256 = (await lectureFixture(t)).report.fixture.lectureAudio.servedSha256;
  input.classroom.scenes[0].actions[1].audioDurationSec = 3;
  await writeFile(input.jsonFile, JSON.stringify(input.classroom));
  await assert.rejects(verifyLecturePlayback(input), /duration differs/);
  input.classroom.scenes[0].actions[1] = { ...input.classroom.scenes[0].actions[0] };
  await writeFile(input.jsonFile, JSON.stringify(input.classroom));
  await assert.rejects(verifyLecturePlayback(input), /duplicate/);
});

test('playback refuses symlinks at the JSON, media file and intermediate directory, while old reports remain explicit', async (t) => {
  const input = await lectureFixture(t);
  const originalMedia = `${input.mediaFile}.original`;
  await rename(input.mediaFile, originalMedia); await symlink(originalMedia, input.mediaFile);
  await assert.rejects(verifyLecturePlayback(input));
  await rm(input.mediaFile); await rename(originalMedia, input.mediaFile);
  const originalDirectory = `${input.mediaDirectory}-original`;
  await rename(input.mediaDirectory, originalDirectory); await symlink(originalDirectory, input.mediaDirectory);
  await assert.rejects(verifyLecturePlayback(input));
  await rm(input.mediaDirectory); await rename(originalDirectory, input.mediaDirectory);
  const originalJson = `${input.jsonFile}.original`;
  await rename(input.jsonFile, originalJson); await symlink(originalJson, input.jsonFile);
  await assert.rejects(verifyLecturePlayback(input));
  assert.deepEqual(await verifyLecturePlayback({ ...input, report: { fixture: { lectureAudio: { sha256: hash(bytes) } } } }),
    { status: 'not-recorded', verified: false });
});
