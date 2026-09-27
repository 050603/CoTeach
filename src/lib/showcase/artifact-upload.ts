import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { lockCourseMutation } from '@/lib/db/course-mutation-lock';
import { runMutationTransaction } from '@/lib/db/transaction-retry';
import { encodeEventCursor } from '@/lib/realtime/event-cursor';
import { getStagesForSystemMode } from '@/lib/system-mode';

export class ArtifactUploadError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}
export interface ArtifactUploadInput {
  courseId: string; studentId: string; requestId: string; title: string;
  originalName: string; mimeType: string; size: number; sha256: string; kind: 'pdf' | 'file';
}
export interface ArtifactUploadResponse {
  ok: true; versionId: string; sequence: number; submittedAt: string; uploadId: string;
  kind: 'pdf' | 'file'; mimeType: string; requestId: string;
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const receiptKey = (input: ArtifactUploadInput) => `file-artifact:${input.courseId}:${input.studentId}:${input.requestId}`;
const fingerprint = (input: ArtifactUploadInput) => createHash('sha256').update(JSON.stringify([
  input.title, input.originalName, input.mimeType, input.size, input.sha256, input.kind,
])).digest('hex');
function conflict(): never { throw new ArtifactUploadError('ARTIFACT_REQUEST_CONFLICT', '此提交编号已用于其他成果内容，请重新选择文件提交。', 409); }

/** Caller authenticates and authorizes course read access before consulting an owned receipt. */
export async function readArtifactUploadReceipt(input: ArtifactUploadInput, db: Prisma.TransactionClient = prisma): Promise<ArtifactUploadResponse | null> {
  const receipt = await db.domainEvent.findUnique({ where: { idempotencyKey: receiptKey(input) } });
  if (!receipt) return null;
  const detail = object(receipt.payload);
  if (receipt.actorId !== input.studentId || receipt.classroomInstanceId !== input.courseId) conflict();
  if (typeof detail.fingerprint === 'string' && detail.fingerprint !== fingerprint(input)) conflict();
  const version = await db.artifactVersion.findUnique({ where: { id: String(detail.versionId) }, include: {
    fileAsset: true, artifact: { select: { title: true, type: true, participation: { select: { instanceId: true, enrollment: { select: { userId: true } } } } } },
  } });
  if (!version?.fileAsset || version.artifact.participation.instanceId !== input.courseId
    || version.artifact.participation.enrollment.userId !== input.studentId) conflict();
  const file = version.fileAsset;
  // Historical receipts did not save a fingerprint. Existing immutable file facts
  // must prove equality; never report a different/new file as an old success.
  if (typeof detail.fingerprint !== 'string' && (
    (version.sha256 ?? file.sha256) !== input.sha256 || Number(version.size ?? file.size) !== input.size
    || file.originalName !== input.originalName || file.mimeType !== input.mimeType
    || version.artifact.title !== input.title || (version.artifact.type === 'PDF_ARCHIVE' ? 'pdf' : 'file') !== input.kind
  )) conflict();
  return { ok: true, versionId: version.id, sequence: version.sequence, submittedAt: (version.submittedAt ?? version.createdAt).toISOString(),
    uploadId: file.id, kind: version.artifact.type === 'PDF_ARCHIVE' ? 'pdf' : 'file', mimeType: file.mimeType, requestId: input.requestId };
}

export async function persistArtifactUpload(input: ArtifactUploadInput & { uploadId: string; versionId: string; storageKey: string }) {
  return runMutationTransaction(async tx => {
    await lockCourseMutation(tx, input.courseId);
    await tx.$queryRaw`SELECT id FROM "ClassroomInstance" WHERE id = ${input.courseId} FOR UPDATE`;
    const previous = await readArtifactUploadReceipt(input, tx);
    if (previous) return { response: previous, duplicate: true };
    const instance = await tx.classroomInstance.findUnique({ where: { id: input.courseId }, select: {
      status: true, runtimeConfig: true, templateVersionId: true,
      activity: { select: { archivedAt: true, chapter: { select: { offeringId: true, offering: { select: { status: true } } } } } },
    } });
    if (!instance) throw new ArtifactUploadError('COURSE_NOT_FOUND', '课程不存在。', 404);
    const config = object(instance.runtimeConfig);
    let stages: unknown = config.stages;
    if (!Array.isArray(stages)) {
      const rows = await tx.$queryRaw<Array<{ stages: unknown }>>`SELECT "snapshot" #> '{design,stages}' AS stages
        FROM "ClassroomTemplateVersion" WHERE id = ${instance.templateVersionId}`;
      stages = Array.isArray(rows[0]?.stages) ? rows[0].stages : getStagesForSystemMode();
    }
    const keys = Array.isArray(stages) ? stages.map(stage => object(stage).key) : [];
    if (instance.status !== 'TEACHING' || instance.activity.archivedAt || instance.activity.chapter.offering.status !== 'OPEN'
      || keys.join(',') !== 'launch,ai-learning,make,showcase,reflection'
      || !['make', 'showcase'].includes(String(keys[Number(config.currentStageIndex ?? 0)]))) {
      throw new ArtifactUploadError('ARTIFACT_SUBMISSION_INACTIVE', '只能在项目实践或成果汇报阶段上传项目材料。', 409);
    }
    const participation = await tx.classroomParticipation.findFirst({ where: { instanceId: input.courseId,
      enrollment: { userId: input.studentId, offeringId: instance.activity.chapter.offeringId, status: 'ACTIVE' } },
      select: { id: true, enrollment: { select: { offeringId: true, researchKey: true } } } });
    if (!participation) throw new ArtifactUploadError('STUDENT_NOT_FOUND', '学生尚未加入项目空间。', 404);
    const member = await tx.groupMember.findFirst({ where: { userId: input.studentId, leftAt: null,
      group: { offeringId: participation.enrollment.offeringId, status: 'ACTIVE' } }, select: { groupId: true }, orderBy: [{ joinedAt: 'desc' }, { id: 'asc' }] });
    if (!member) throw new ArtifactUploadError('GROUP_NOT_FOUND', '项目空间所属小组不存在。', 409);
    const latest = await tx.artifactVersion.aggregate({ where: { artifact: { participationId: participation.id,
      type: { in: ['PDF_ARCHIVE', 'FILE_ARCHIVE'] } } }, _max: { sequence: true } });
    await tx.fileAsset.create({ data: { id: input.uploadId, originalName: input.originalName, storageKey: input.storageKey,
      offeringId: participation.enrollment.offeringId, uploadedById: input.studentId, size: BigInt(input.size), mimeType: input.mimeType, sha256: input.sha256 } });
    const artifact = await tx.artifact.create({ data: { participationId: participation.id, groupId: member.groupId, title: input.title,
      type: input.kind === 'pdf' ? 'PDF_ARCHIVE' : 'FILE_ARCHIVE', status: 'SUBMITTED' } });
    const submittedAt = new Date();
    const version = await tx.artifactVersion.create({ data: { id: input.versionId, artifactId: artifact.id, sequence: (latest._max.sequence ?? 0) + 1,
      fileAssetId: input.uploadId, mimeType: input.mimeType, sha256: input.sha256, size: BigInt(input.size), status: 'SUBMITTED', submittedAt } });
    const courseVersion = Number(config.version ?? 1) + 1;
    await tx.classroomInstance.update({ where: { id: input.courseId }, data: { runtimeConfig: { ...config, version: courseVersion } as Prisma.InputJsonObject } });
    const event = await tx.domainEvent.create({ data: { classroomInstanceId: input.courseId, offeringId: participation.enrollment.offeringId,
      participationId: participation.id, actorId: input.studentId, researchKey: participation.enrollment.researchKey, idempotencyKey: receiptKey(input),
      eventType: 'file_artifact_submitted', payload: { versionId: version.id, requestId: input.requestId, fingerprint: fingerprint(input), studentId: input.studentId,
        scope: 'student', kind: input.kind, title: input.title, courseVersion } } });
    const response: ArtifactUploadResponse = { ok: true, versionId: version.id, sequence: version.sequence, submittedAt: submittedAt.toISOString(),
      uploadId: input.uploadId, kind: input.kind, mimeType: input.mimeType, requestId: input.requestId };
    return { response, duplicate: false, courseVersion, eventCursor: encodeEventCursor(event) };
  });
}
