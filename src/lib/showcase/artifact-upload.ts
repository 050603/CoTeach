import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { lockCourseMutation } from '@/lib/db/course-mutation-lock';
import { hasCourseMutationAdmission, runMutationTransaction } from '@/lib/db/transaction-retry';
import { encodeEventCursor } from '@/lib/realtime/event-cursor';
import { getStagesForSystemMode } from '@/lib/system-mode';

export class ArtifactUploadError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}
export interface ArtifactUploadInput {
  courseId: string; studentId: string; sessionVersion: number; requestId: string; title: string;
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

// Both joined callers bind p/e to this artifact's classroom participation.
// Preserve the legacy template > offering > classroom namespace precedence.
const readNamespaceAllowed = (input: ArtifactUploadInput) => Prisma.sql`
  NOT EXISTS (SELECT 1 FROM "ClassroomTemplate" t WHERE t.id = ${input.courseId})
  AND CASE WHEN EXISTS (SELECT 1 FROM "CourseOffering" named WHERE named.id = ${input.courseId}) THEN
    EXISTS (SELECT 1 FROM "Enrollment" named_enrollment WHERE named_enrollment."userId" = ${input.studentId}
      AND named_enrollment."offeringId" = ${input.courseId}
      AND named_enrollment.status IN ('ACTIVE', 'active', 'COMPLETED', 'completed'))
    ELSE p.id IS NOT NULL AND e."offeringId" = c."offeringId"
      AND e.status IN ('ACTIVE', 'active', 'COMPLETED', 'completed') END`;
type CurrentReadScope = { userStatus: string | null; userRole: string | null; sessionVersion: number | null; readAllowed: boolean };
function assertCurrentRead(input: ArtifactUploadInput, scope: CurrentReadScope) {
  if (scope.userStatus?.toLowerCase() !== 'active' || scope.userRole?.toLowerCase() !== 'student'
    || scope.sessionVersion !== input.sessionVersion || !scope.readAllowed) {
    throw new ArtifactUploadError('FORBIDDEN', '账户、登录会话或选课权限已变化，请重新登录或检查课堂权限。', 403);
  }
}

/** Student-only equivalent of canAccessLegacyCourse(..., 'read'). The caller
 * first validates the JWT/session and student role. Accepted receipts still
 * require current read access, including COMPLETED enrollments after closure.
 */
export async function canReadArtifactCourse(studentId: string, courseId: string, db: Prisma.TransactionClient = prisma): Promise<boolean> {
  const [scope] = await db.$queryRaw<Array<{ allowed: boolean }>>`SELECT EXISTS (
    SELECT 1 FROM "User" u WHERE u.id = ${studentId} AND lower(u.status) = 'active' AND lower(u.role) = 'student'
      AND NOT EXISTS (SELECT 1 FROM "ClassroomTemplate" t WHERE t.id = ${courseId})
      AND CASE WHEN EXISTS (SELECT 1 FROM "CourseOffering" o WHERE o.id = ${courseId}) THEN
        EXISTS (SELECT 1 FROM "Enrollment" e WHERE e."userId" = u.id AND e."offeringId" = ${courseId}
          AND e.status IN ('ACTIVE', 'active', 'COMPLETED', 'completed'))
      ELSE EXISTS (
        SELECT 1 FROM "ClassroomInstance" ci JOIN "Activity" a ON a.id = ci."activityId"
          JOIN "Chapter" c ON c.id = a."chapterId" JOIN "Enrollment" e ON e."offeringId" = c."offeringId" AND e."userId" = u.id
          JOIN "ClassroomParticipation" p ON p."enrollmentId" = e.id AND p."instanceId" = ci.id
        WHERE ci.id = ${courseId} AND e.status IN ('ACTIVE', 'active', 'COMPLETED', 'completed')
      ) END
    ) AS allowed`;
  return scope?.allowed === true;
}

/** Caller authenticates and authorizes course read access before consulting an owned receipt. */
export async function readArtifactUploadReceipt(input: ArtifactUploadInput, db: Prisma.TransactionClient = prisma): Promise<ArtifactUploadResponse | null> {
  const receipt = await db.domainEvent.findUnique({ where: { idempotencyKey: receiptKey(input) }, select: { actorId: true, classroomInstanceId: true, payload: true } });
  if (!receipt) return null;
  const detail = object(receipt.payload);
  if (receipt.actorId !== input.studentId || receipt.classroomInstanceId !== input.courseId) conflict();
  if (typeof detail.fingerprint === 'string' && detail.fingerprint !== fingerprint(input)) conflict();
  // Keep the event/fingerprint early rejection, then verify immutable ownership
  // with one narrow read. No sourceHtml, classroom snapshot or current-stage
  // restrictions belong in a previously committed receipt replay.
  const [version] = await db.$queryRaw<Array<CurrentReadScope & {
    id: string; sequence: number; submittedAt: Date | null; createdAt: Date;
    sha256: string | null; size: bigint | null; fileSha256: string | null; fileSize: bigint;
    uploadId: string; originalName: string; mimeType: string; title: string; type: string;
    instanceId: string; userId: string;
  }>>`SELECT v.id, v.sequence, v."submittedAt", v."createdAt", v.sha256, v.size,
      f.id AS "uploadId", f.sha256 AS "fileSha256", f.size AS "fileSize", f."originalName", f."mimeType",
      a.title, a.type, p."instanceId", e."userId", u.status AS "userStatus", u.role AS "userRole", u."sessionVersion",
      (${readNamespaceAllowed(input)}) AS "readAllowed"
    FROM "ArtifactVersion" v JOIN "FileAsset" f ON f.id = v."fileAssetId"
      JOIN "Artifact" a ON a.id = v."artifactId"
      JOIN "ClassroomParticipation" p ON p.id = a."participationId"
      JOIN "Enrollment" e ON e.id = p."enrollmentId"
      JOIN "User" u ON u.id = e."userId"
      JOIN "ClassroomInstance" ci ON ci.id = p."instanceId"
      JOIN "Activity" activity ON activity.id = ci."activityId" JOIN "Chapter" c ON c.id = activity."chapterId"
    WHERE v.id = ${String(detail.versionId)}`;
  if (!version || version.instanceId !== input.courseId || version.userId !== input.studentId) conflict();
  assertCurrentRead(input, version);
  // Historical receipts did not save a fingerprint. Existing immutable file facts
  // must prove equality; never report a different/new file as an old success.
  if (typeof detail.fingerprint !== 'string' && (
    (version.sha256 ?? version.fileSha256) !== input.sha256 || Number(version.size ?? version.fileSize) !== input.size
    || version.originalName !== input.originalName || version.mimeType !== input.mimeType
    || version.title !== input.title || (version.type === 'PDF_ARCHIVE' ? 'pdf' : 'file') !== input.kind
  )) conflict();
  return { ok: true, versionId: version.id, sequence: version.sequence, submittedAt: (version.submittedAt ?? version.createdAt).toISOString(),
    uploadId: version.uploadId, kind: version.type === 'PDF_ARCHIVE' ? 'pdf' : 'file', mimeType: version.mimeType, requestId: input.requestId };
}

type ArtifactUploadScope = CurrentReadScope & {
      status: string; runtimeStages: unknown; currentStageIndex: unknown; runtimeVersion: unknown;
      templateStages: unknown; archivedAt: Date | null; enrollmentStatus: string | null;
      offeringId: string; offeringStatus: string; participationId: string | null;
      researchKey: string | null; groupId: string | null; sequence: number; hasReceipt: boolean;
    };

export async function persistArtifactUpload(input: ArtifactUploadInput & { uploadId: string; versionId: string; storageKey: string }) {
  return runMutationTransaction(async tx => {
    const admitted = hasCourseMutationAdmission(tx, input.courseId);
    let scopes: ArtifactUploadScope[];
    if (admitted) {
      // VOLATILE function uses separate SPI statements: row lock, then a fresh
      // READ COMMITTED snapshot. Never replace it with one materialized CTE.
      scopes = await tx.$queryRaw<ArtifactUploadScope[]>`SELECT * FROM public.openpbl_external_artifact_scope_v1(
        ${input.courseId}, ${input.studentId}, ${receiptKey(input)})`;
    } else {
      await lockCourseMutation(tx, input.courseId);
      await tx.$queryRaw`SELECT id FROM "ClassroomInstance" WHERE id = ${input.courseId} FOR UPDATE`;
      scopes = await tx.$queryRaw<ArtifactUploadScope[]>`SELECT ci.status, ci."runtimeConfig" -> 'stages' AS "runtimeStages",
        ci."runtimeConfig" -> 'currentStageIndex' AS "currentStageIndex", ci."runtimeConfig" -> 'version' AS "runtimeVersion",
        a."archivedAt", o.id AS "offeringId", o.status AS "offeringStatus",
        CASE WHEN jsonb_typeof(ci."runtimeConfig"->'stages') = 'array' THEN NULL
          ELSE tv.snapshot #> '{design,stages}' END AS "templateStages",
        p.id AS "participationId", e."researchKey", e.status AS "enrollmentStatus", member."groupId",
        u.status AS "userStatus", u.role AS "userRole", u."sessionVersion", (${readNamespaceAllowed(input)}) AS "readAllowed",
        COALESCE((SELECT max(v.sequence) FROM "ArtifactVersion" v JOIN "Artifact" ar ON ar.id = v."artifactId"
          WHERE ar."participationId" = p.id AND ar.type IN ('PDF_ARCHIVE', 'FILE_ARCHIVE')), 0) + 1 AS sequence,
        EXISTS (SELECT 1 FROM "DomainEvent" d WHERE d."idempotencyKey" = ${receiptKey(input)}) AS "hasReceipt"
      FROM "ClassroomInstance" ci JOIN "Activity" a ON a.id = ci."activityId"
      JOIN "Chapter" c ON c.id = a."chapterId" JOIN "CourseOffering" o ON o.id = c."offeringId"
      JOIN "ClassroomTemplateVersion" tv ON tv.id = ci."templateVersionId"
      LEFT JOIN "User" u ON u.id = ${input.studentId}
      LEFT JOIN "Enrollment" e ON e."userId" = u.id AND e."offeringId" = o.id
      LEFT JOIN "ClassroomParticipation" p ON p."enrollmentId" = e.id AND p."instanceId" = ci.id
      LEFT JOIN LATERAL (SELECT m."groupId" FROM "GroupMember" m JOIN "ProjectGroup" g ON g.id = m."groupId"
        WHERE m."userId" = ${input.studentId} AND m."leftAt" IS NULL AND g."offeringId" = o.id AND g.status = 'ACTIVE'
        ORDER BY m."joinedAt" DESC, m.id ASC LIMIT 1) member ON true
      WHERE ci.id = ${input.courseId}`;
    }
    const [scope] = scopes;
    if (!scope) throw new ArtifactUploadError('COURSE_NOT_FOUND', '课程不存在。', 404);
    assertCurrentRead(input, scope);
    // Accepted receipts remain replayable for current ACTIVE/COMPLETED read
    // membership after closure, but never bypass fresh account/session access.
    // Preserve the original fingerprint AND immutable owner/file verification.
    if (scope.hasReceipt) {
      const previous = await readArtifactUploadReceipt(input, tx);
      if (!previous) throw new Error('Artifact receipt disappeared under the course lock');
      return { response: previous, duplicate: true };
    }
    const stages = Array.isArray(scope.runtimeStages) ? scope.runtimeStages
      : Array.isArray(scope.templateStages) ? scope.templateStages : getStagesForSystemMode();
    const keys = Array.isArray(stages) ? stages.map(stage => object(stage).key) : [];
    if (scope.status !== 'TEACHING' || scope.archivedAt || scope.offeringStatus !== 'OPEN'
      || keys.join(',') !== 'launch,ai-learning,make,showcase,reflection'
      || !['make', 'showcase'].includes(String(keys[Number(scope.currentStageIndex ?? 0)]))) {
      throw new ArtifactUploadError('ARTIFACT_SUBMISSION_INACTIVE', '只能在项目实践或成果汇报阶段上传项目材料。', 409);
    }
    if (!scope.participationId || scope.enrollmentStatus !== 'ACTIVE') throw new ArtifactUploadError('STUDENT_NOT_FOUND', '学生尚未加入项目空间。', 404);
    if (!scope.groupId) throw new ArtifactUploadError('GROUP_NOT_FOUND', '项目空间所属小组不存在。', 409);
    const submittedAt = new Date();
    const courseVersion = Number(scope.runtimeVersion ?? 1) + 1;
    const payload = { versionId: input.versionId, requestId: input.requestId, fingerprint: fingerprint(input), studentId: input.studentId,
      scope: 'student', kind: input.kind, title: input.title, courseVersion };
    // All durable facts commit together. Explicit CTE dependencies preserve the
    // file/artifact/version foreign keys and never acknowledge a partial write.
    const [event] = await tx.$queryRaw<Array<{ id: string; createdAt: Date }>>`WITH asset AS (
        INSERT INTO "FileAsset" (id, "originalName", "storageKey", "offeringId", "uploadedById", size, "mimeType", sha256, "updatedAt")
        VALUES (${input.uploadId}, ${input.originalName}, ${input.storageKey}, ${scope.offeringId}, ${input.studentId},
          ${BigInt(input.size)}, ${input.mimeType}, ${input.sha256}, ${submittedAt}) RETURNING id
      ), artifact AS (
        INSERT INTO "Artifact" (id, "participationId", "groupId", title, type, status, "updatedAt")
        SELECT ${randomUUID()}, ${scope.participationId}, ${scope.groupId}, ${input.title},
          ${input.kind === 'pdf' ? 'PDF_ARCHIVE' : 'FILE_ARCHIVE'}, 'SUBMITTED', ${submittedAt} FROM asset RETURNING id
      ), version AS (
        INSERT INTO "ArtifactVersion" (id, "artifactId", sequence, "fileAssetId", "mimeType", sha256, size, status, "submittedAt")
        SELECT ${input.versionId}, artifact.id, ${scope.sequence}, asset.id, ${input.mimeType}, ${input.sha256},
          ${BigInt(input.size)}, 'SUBMITTED', ${submittedAt} FROM artifact CROSS JOIN asset RETURNING id
      ), course AS (
        UPDATE "ClassroomInstance" SET "runtimeConfig" = jsonb_set(
          CASE WHEN jsonb_typeof("runtimeConfig") = 'object' THEN "runtimeConfig" ELSE '{}'::jsonb END,
          '{version}', ${JSON.stringify(courseVersion)}::jsonb, true), "updatedAt" = ${submittedAt}
        WHERE id = ${input.courseId} AND EXISTS (SELECT 1 FROM version) RETURNING id
      ) INSERT INTO "DomainEvent" (id, "classroomInstanceId", "offeringId", "participationId", "actorId", "researchKey", "idempotencyKey", "eventType", payload)
        SELECT ${randomUUID()}, course.id, ${scope.offeringId}, ${scope.participationId}, ${input.studentId}, ${scope.researchKey},
          ${receiptKey(input)}, 'file_artifact_submitted', ${JSON.stringify(payload)}::jsonb FROM course CROSS JOIN version
        RETURNING id, "createdAt"`;
    if (!event) throw new Error('Artifact transaction did not produce a durable receipt');
    const response: ArtifactUploadResponse = { ok: true, versionId: input.versionId, sequence: scope.sequence, submittedAt: submittedAt.toISOString(),
      uploadId: input.uploadId, kind: input.kind, mimeType: input.mimeType, requestId: input.requestId };
    return { response, duplicate: false, courseVersion, eventCursor: encodeEventCursor(event) };
  }, { lowPriorityCourseId: input.courseId,
    admissionTimeoutError: () => new ArtifactUploadError('COURSE_BUSY', '课堂保存繁忙，请稍后重试。', 503) });
}
