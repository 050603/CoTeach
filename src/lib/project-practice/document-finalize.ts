import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { AuthClaims } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { hasCourseMutationAdmission } from "@/lib/db/transaction-retry";
import { lockProjectedCourse } from "@/lib/db/session-repository";
import { PlatformError } from "@/lib/platform/repository";

const MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Authentication has checked the JWT/session; authorize only this student's owned participation. */
export async function authorizeDocumentArchiveScope(claims: AuthClaims, courseId: string, studentId?: string) {
  if (!claims.sub || claims.role !== "student") throw new PlatformError("UNAUTHENTICATED", "请重新登录", 401);
  if (studentId && studentId !== claims.sub) throw new PlatformError("STUDENT_SCOPE_MISMATCH", "无权访问其他学生", 403);
  const [scope] = await prisma.$queryRaw<Array<{
    participationId: string | null; offeringId: string; userStatus: string; userRole: string; sessionVersion: number;
  }>>`SELECT p.id AS "participationId", o.id AS "offeringId", u.status AS "userStatus", u.role AS "userRole", u."sessionVersion"
    FROM "ClassroomInstance" ci JOIN "Activity" a ON a.id = ci."activityId"
    JOIN "Chapter" c ON c.id = a."chapterId" JOIN "CourseOffering" o ON o.id = c."offeringId"
    JOIN "User" u ON u.id = ${claims.sub}
    LEFT JOIN "Enrollment" e ON e."userId" = u.id AND e."offeringId" = o.id AND upper(e.status) IN ('ACTIVE', 'COMPLETED')
    LEFT JOIN "ClassroomParticipation" p ON p."enrollmentId" = e.id AND p."instanceId" = ci.id
    WHERE ci.id = ${courseId}`;
  if (!scope) throw new PlatformError("COURSE_NOT_FOUND", "课堂不存在", 404);
  if (scope.userStatus.toUpperCase() !== "ACTIVE" || scope.userRole.toUpperCase() !== "STUDENT" || scope.sessionVersion !== claims.sv) throw new PlatformError("UNAUTHENTICATED", "请重新登录", 401);
  if (!scope.participationId) throw new PlatformError("STUDENT_SCOPE_MISMATCH", "未加入该课堂", 403);
  return { user: { id: claims.sub }, offering: { id: scope.offeringId }, participation: { id: scope.participationId } };
}

export interface DocumentArchiveCommit {
  courseId: string; studentId: string; participationId: string; offeringId: string; sessionVersion: number;
  submissionId: string; submissionViewId: string; originalPayload: unknown;
  expectedVersion: number; receiptKey: string; fingerprint: string; requestId: string;
  title: string; uploadId: string; storageKey: string; size: number; sha256: string; sourceHtml: string;
}

function prepareDocumentArchiveWrite(input: DocumentArchiveCommit, sequence?: number) {
  const now = new Date();
  const versionId = randomUUID();
  const payload = { fingerprint: input.fingerprint, requestId: input.requestId, submissionId: input.submissionViewId,
    sourceVersion: input.expectedVersion, submissionVersion: input.expectedVersion + 1, title: input.title,
    versionId, sequence, docxUploadId: input.uploadId, sha256: input.sha256, size: input.size,
    submittedAt: now.toISOString(), stageKey: "make" };
  const original = object(input.originalPayload);
  const draft = { ...object(original.view ?? original), version: input.expectedVersion + 1, status: "submitted", submittedAt: now.toISOString() };
  const nextPayload = JSON.stringify(original.view ? { ...original, view: draft } : draft);
  return { now, versionId, payload, nextPayload };
}

const commitErrors: Record<string, { message: string; status: number }> = {
  STUDENT_SCOPE_MISMATCH: { message: "未加入该课堂或文档归属已变化", status: 403 },
  UNAUTHENTICATED: { message: "账户或会话状态已变化，请重新登录", status: 401 },
  IDEMPOTENCY_CONFLICT: { message: "请求标识已用于其他提交", status: 409 },
  DRAFT_VERSION_CONFLICT: { message: "归档期间文档已变化，请重新提交", status: 409 },
  COURSE_LOCKED: { message: "课堂已结束，无法提交", status: 409 },
};

/** Render/write the file before entering this short transaction. All durable facts commit together. */
export async function commitDocumentArchive(tx: Prisma.TransactionClient, input: DocumentArchiveCommit, mark?: (phase: "lock" | "scope" | "lock_scope" | "lock_scope_write" | "write") => void) {
  const artifactId = `document:${input.submissionId}`;
  type ArchiveScope = {
    researchKey: string; instanceStatus: string; offeringStatus: string; enrollmentStatus: string;
    archivedAt: Date | null; unchanged: boolean; receipt: unknown; sequence: number;
    userStatus: string; userRole: string; sessionVersion: number;
  };
  let scopes: ArchiveScope[];
  if (hasCourseMutationAdmission(tx, input.courseId)) {
    const prepared = prepareDocumentArchiveWrite(input);
    const context = {
      courseId: input.courseId, studentId: input.studentId, participationId: input.participationId,
      offeringId: input.offeringId, sessionVersion: input.sessionVersion, submissionId: input.submissionId,
      receiptKey: input.receiptKey, title: input.title, uploadId: input.uploadId, storageKey: input.storageKey,
      size: input.size, sha256: input.sha256, sourceHtml: input.sourceHtml,
      filename: `${input.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 96)}.docx`,
      submittedAt: prepared.now.toISOString(), receiptId: randomUUID(), auditId: randomUUID(),
    };
    // The nested VOLATILE scope helper retains a fresh snapshot after the row
    // wait. Authorization, replay, CAS and the entire atomic write stay in DB.
    const [result] = await tx.$queryRaw<Array<{ payload: unknown; reused: boolean; error_code: string | null }>>`
      SELECT * FROM public.openpbl_document_archive_commit_v1(
        ${JSON.stringify(context)}::jsonb, ${JSON.stringify(input.originalPayload)}::jsonb,
        ${prepared.nextPayload}::jsonb, ${JSON.stringify(prepared.payload)}::jsonb)`;
    mark?.("lock_scope_write");
    if (!result) throw new Error("Document archive commit returned no result");
    if (result.error_code !== null) {
      const mapped = Object.hasOwn(commitErrors, result.error_code) ? commitErrors[result.error_code] : undefined;
      if (!mapped) throw new Error("Document archive commit returned an unknown error code");
      throw new PlatformError(result.error_code, mapped.message, mapped.status);
    }
    if (!result.payload || typeof result.payload !== "object" || Array.isArray(result.payload) || typeof result.reused !== "boolean") {
      throw new Error("Document archive commit returned an invalid receipt");
    }
    return { payload: result.payload as Record<string, unknown>, reused: result.reused };
  } else {
    // Internal callers without admission retain advisory -> row -> fresh read.
    await lockProjectedCourse(tx, input.courseId);
    mark?.("lock");
    scopes = await tx.$queryRaw<ArchiveScope[]>`SELECT e."researchKey", ci.status AS "instanceStatus", o.status AS "offeringStatus",
      e.status AS "enrollmentStatus", a."archivedAt", u.status AS "userStatus", u.role AS "userRole", u."sessionVersion",
      s.payload IS NOT DISTINCT FROM ${JSON.stringify(input.originalPayload)}::jsonb AS unchanged,
      (SELECT d.payload FROM "DomainEvent" d WHERE d."idempotencyKey" = ${input.receiptKey}) AS receipt,
      COALESCE((SELECT max(v.sequence) FROM "ArtifactVersion" v WHERE v."artifactId" = ${artifactId}), 0) + 1 AS sequence
    FROM "ClassroomParticipation" p JOIN "Enrollment" e ON e.id = p."enrollmentId"
    JOIN "User" u ON u.id = e."userId"
    JOIN "ClassroomInstance" ci ON ci.id = p."instanceId"
    JOIN "Activity" a ON a.id = ci."activityId" JOIN "Chapter" c ON c.id = a."chapterId"
    JOIN "CourseOffering" o ON o.id = c."offeringId"
    JOIN "ClassroomSubmission" s ON s."participationId" = p.id AND s.id = ${input.submissionId}
    WHERE p.id = ${input.participationId} AND ci.id = ${input.courseId}
      AND e."userId" = ${input.studentId} AND e."offeringId" = o.id AND o.id = ${input.offeringId}
    FOR UPDATE OF p`;
    mark?.("scope");
  }
  const [scope] = scopes;
  if (!scope) throw new PlatformError("STUDENT_SCOPE_MISMATCH", "未加入该课堂或文档归属已变化", 403);
  // Recheck current identity after queueing/rendering, including receipt replays.
  if (scope.userStatus.toUpperCase() !== "ACTIVE" || scope.userRole.toUpperCase() !== "STUDENT" || scope.sessionVersion !== input.sessionVersion) {
    throw new PlatformError("UNAUTHENTICATED", "账户或会话状态已变化，请重新登录", 401);
  }
  if (!["ACTIVE", "COMPLETED"].includes(scope.enrollmentStatus.toUpperCase())) throw new PlatformError("STUDENT_SCOPE_MISMATCH", "未加入该课堂", 403);
  if (scope.receipt) {
    const payload = object(scope.receipt);
    if (payload.fingerprint !== input.fingerprint) throw new PlatformError("IDEMPOTENCY_CONFLICT", "请求标识已用于其他提交", 409);
    return { payload, reused: true };
  }
  if (!scope.unchanged) throw new PlatformError("DRAFT_VERSION_CONFLICT", "归档期间文档已变化，请重新提交", 409);
  if (scope.instanceStatus.toUpperCase() !== "TEACHING" || scope.offeringStatus.toUpperCase() !== "OPEN"
    || scope.enrollmentStatus.toUpperCase() !== "ACTIVE" || scope.archivedAt) {
    throw new PlatformError("COURSE_LOCKED", "课堂已结束，无法提交", 409);
  }
  const { now, versionId, payload, nextPayload } = prepareDocumentArchiveWrite(input, scope.sequence);
  const auditPayload = JSON.stringify({ legacy: { stageKey: "make", source: "submission", actorId: input.studentId }, detail: payload, schemaVersion: 1 });
  // One parameterized statement avoids holding the shared course lock through
  // eight ORM round trips. CTE dependencies preserve artifact/file foreign keys;
  // a failure in any receipt rolls back every row, including the draft version.
  await tx.$queryRaw`WITH artifact AS (
      INSERT INTO "Artifact" (id, "participationId", title, type, status, "updatedAt")
      VALUES (${artifactId}, ${input.participationId}, ${input.title}, 'DOCUMENT_ARCHIVE', 'SUBMITTED', ${now})
      ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, status = EXCLUDED.status, "updatedAt" = EXCLUDED."updatedAt"
      RETURNING id
    ), asset AS (
      INSERT INTO "FileAsset" (id, "originalName", "storageKey", "offeringId", "uploadedById", size, "mimeType", sha256, "updatedAt")
      VALUES (${input.uploadId}, ${`${input.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 96)}.docx`}, ${input.storageKey},
        ${input.offeringId}, ${input.studentId}, ${BigInt(input.size)}, ${MIME}, ${input.sha256}, ${now}) RETURNING id
    ), version AS (
      INSERT INTO "ArtifactVersion" (id, "artifactId", sequence, "sourceHtml", "fileAssetId", "mimeType", sha256, size, status, "submittedAt")
      SELECT ${versionId}, artifact.id, ${scope.sequence}, ${input.sourceHtml}, asset.id, ${MIME}, ${input.sha256}, ${BigInt(input.size)}, 'SUBMITTED', ${now}
      FROM artifact CROSS JOIN asset RETURNING id
    ), submission AS (
      UPDATE "ClassroomSubmission" SET status = 'SUBMITTED', "submittedAt" = ${now}, "updatedAt" = ${now}, payload = ${nextPayload}::jsonb
      WHERE id = ${input.submissionId} RETURNING id
    ), receipt AS (
      INSERT INTO "DomainEvent" (id, "idempotencyKey", "actorId", "offeringId", "classroomInstanceId", "participationId", "researchKey", "eventType", payload)
      VALUES (${randomUUID()}, ${input.receiptKey}, ${input.studentId}, ${input.offeringId}, ${input.courseId}, ${input.participationId},
        ${scope.researchKey}, 'document_version_submitted', ${JSON.stringify(payload)}::jsonb) RETURNING id
    ), audit AS (
      INSERT INTO "AiInteractionEvent" (id, "idempotencyKey", "userId", "offeringId", "participationId", "researchKey", "eventType", actor, "requestId", content, payload)
      VALUES (${randomUUID()}, ${`ai:${input.receiptKey}`}, ${input.studentId}, ${input.offeringId}, ${input.participationId}, ${scope.researchKey},
        'submit', 'student', ${input.requestId}, ${`提交项目实践文档第 ${scope.sequence} 版`}, ${auditPayload}::jsonb) RETURNING id
    ), course AS (
      UPDATE "ClassroomInstance" SET "runtimeConfig" = jsonb_set(
        CASE WHEN jsonb_typeof("runtimeConfig") = 'object' THEN "runtimeConfig" ELSE '{}'::jsonb END, '{version}',
        to_jsonb(COALESCE(("runtimeConfig"->>'version')::numeric, 1) + 1)), "updatedAt" = ${now}
      WHERE id = ${input.courseId} RETURNING id
    ) SELECT version.id FROM version CROSS JOIN submission CROSS JOIN receipt CROSS JOIN audit CROSS JOIN course`;
  mark?.("write");
  return { payload, reused: false };
}
