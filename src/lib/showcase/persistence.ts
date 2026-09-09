import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { lockCourseMutation } from '@/lib/db/course-mutation-lock';
import { createPblTemplateCourse, decodePblTemplate } from '@/lib/platform/pbl-template';
import { listProjectDocumentVersions } from '@/lib/project-practice/versions';
import { projectGroupViewId, resolveProjectGroupId } from '@/lib/platform/group-identity';
import { PlatformError } from '@/lib/platform/repository';

type Row = Record<string, unknown>;
type Query = { where?: Row; orderBy?: Row | Row[]; select?: Row; data?: Row };
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const str = (value: unknown): string => typeof value === 'string' ? value : '';
function match(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    const filter = object(value);
    if (Array.isArray(filter.in)) return filter.in.includes(row[key]);
    if ('not' in filter) return row[key] !== filter.not;
    return row[key] === value;
  });
}
function selectRows<T extends object>(rows: T[], query: Query): T[] {
  const selected = rows.filter((row) => match(row as Row, query.where));
  const sorts = Array.isArray(query.orderBy) ? query.orderBy : query.orderBy ? [query.orderBy] : [];
  return selected.sort((leftRow, rightRow) => { const a = leftRow as Row; const b = rightRow as Row; for (const sort of sorts) for (const [key, direction] of Object.entries(sort)) {
    const left = a[key] instanceof Date ? a[key].getTime() : a[key];
    const right = b[key] instanceof Date ? b[key].getTime() : b[key];
    if (left == null || right == null || left === right) continue;
    const comparison = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right));
    if (comparison) return direction === 'desc' ? -comparison : comparison;
  } return 0; });
}

/** Explicit storage projection for the established showcase lifecycle; every query uses V2 entities. */
export function createShowcaseStore(db: Prisma.TransactionClient = prisma) {
  const loadCourse = async (query: Query) => {
    const instance = await db.classroomInstance.findUnique({ where: { id: str(query.where?.id) }, include: { templateVersion: true } });
    if (!instance) return null;
    const config = object(instance.runtimeConfig);
    const snapshot = createPblTemplateCourse(instance.id, decodePblTemplate(instance.templateVersion.snapshot) ?? {});
    return { ...snapshot, ...config, id: instance.id, status: instance.status.toLowerCase(), currentStageIndex: Number(config.currentStageIndex ?? 0),
      version: Number(config.version ?? 1), name: snapshot.name, stages: config.stages ?? snapshot.stages, uiState: config.uiState ?? snapshot.uiState ?? {},
      presentingGroupId: typeof config.presentingGroupId === "string" ? config.presentingGroupId : null, presentingStudentId: typeof config.presentingStudentId === "string" ? config.presentingStudentId : null };
  };
  const listStudents = async (query: Query) => {
    const rows = await db.classroomParticipation.findMany({ where: { instanceId: str(query.where?.courseId) }, include: { enrollment: { include: { user: true } } } });
    return selectRows(rows.map((row) => ({ id: row.enrollment.userId, name: row.enrollment.user.displayName, courseId: row.instanceId, createdAt: row.enrollment.joinedAt })), query);
  };
  const listMembers = async (query: Query) => {
    const instance = await db.classroomInstance.findUnique({ where: { id: str(query.where?.courseId) }, select: { activity: { select: { chapter: { select: { offeringId: true } } } } } });
    if (!instance) return [];
    const rows = await db.groupMember.findMany({ where: { group: { offeringId: instance.activity.chapter.offeringId }, leftAt: null,
      user: { enrollments: { some: { participations: { some: { instanceId: str(query.where?.courseId) } } } } } }, include: { user: true } });
    return selectRows(rows.map((row) => ({ id: row.id, courseId: query.where?.courseId, groupId: projectGroupViewId(instance.activity.chapter.offeringId, row.groupId), studentId: row.userId, studentName: row.user.displayName, joinedAt: row.joinedAt })), query);
  };
  const listDocuments = async (query: Query) => {
    const rows = await listProjectDocumentVersions({ courseId: str(query.where?.courseId), studentId: typeof query.where?.studentId === 'string' ? query.where.studentId : undefined }, db);
    return selectRows(rows.map((row) => ({ ...row, submittedAt: row.submittedAt ? new Date(row.submittedAt) : null, createdAt: new Date(row.createdAt) })), query);
  };
  const listFiles = async (query: Query) => {
    const rows = await db.artifactVersion.findMany({ where: { fileAssetId: { not: null }, artifact: { type: { in: ['PDF_ARCHIVE', 'FILE_ARCHIVE'] }, participation: { instanceId: str(query.where?.courseId) } } }, include: { artifact: { include: { participation: { include: { enrollment: true } } } }, fileAsset: true } });
    return selectRows(rows.map((row) => ({ id: row.id, courseId: row.artifact.participation.instanceId, studentId: row.artifact.participation.enrollment.userId,
      groupId: row.artifact.groupId ? projectGroupViewId(row.artifact.participation.enrollment.offeringId, row.artifact.groupId) : null, stageKey: 'make', sequence: row.sequence, title: row.artifact.title, uploadId: row.fileAssetId!,
      kind: row.artifact.type === 'PDF_ARCHIVE' ? 'pdf' : 'file', mimeType: row.mimeType ?? row.fileAsset?.mimeType ?? "application/octet-stream", requestId: undefined as string | undefined,
      sha256: row.sha256, size: row.size == null ? null : Number(row.size), status: row.status.toLowerCase(), submittedAt: row.submittedAt ?? row.createdAt, createdAt: row.createdAt })), query);
  };
  const toPresentation = (row: Prisma.ShowcasePresentationGetPayload<{ include: { participation: { include: { enrollment: true } } } }>) => {
    const content = object(row.content);
    const date = (key: string) => typeof content[key] === 'string' ? new Date(content[key]) : null;
    return { ...content, id: row.id, courseId: row.participation.instanceId, studentId: row.participation.enrollment.userId,
      groupId: row.groupId ? projectGroupViewId(row.participation.enrollment.offeringId, row.groupId) : '', artifactVersionId: row.artifactVersionId ?? '', status: row.status.toLowerCase(), revision: Number(content.revision ?? 1),
      artifactKind: str(content.artifactKind), artifactTitle: str(content.artifactTitle), displayMode: str(content.displayMode),
      rejectionReason: typeof content.rejectionReason === 'string' ? content.rejectionReason : null,
      reviewedBy: typeof content.reviewedBy === 'string' ? content.reviewedBy : null,
      evaluationNote: typeof content.evaluationNote === 'string' ? content.evaluationNote : null,
      evaluatedBy: typeof content.evaluatedBy === 'string' ? content.evaluatedBy : null,
      updatedAt: row.updatedAt, requestedAt: row.createdAt, viewState: (content.viewState ?? null) as Prisma.JsonValue | null,
      reviewedAt: date('reviewedAt'), startedAt: date('startedAt'), endedAt: date('endedAt'), evaluatedAt: date('evaluatedAt') };
  };
  const listPresentations = async (query: Query) => {
    const rows = await db.showcasePresentation.findMany({ where: { ...(query.where?.courseId ? { participation: { instanceId: str(query.where.courseId) } } : {}), ...(query.where?.id ? { id: str(query.where.id) } : {}) }, include: { participation: { include: { enrollment: true } } } });
    return selectRows(rows.map(toPresentation), query);
  };
  const recordChange = async (instanceId: string, studentId?: string) => {
    const instance = await db.classroomInstance.findUniqueOrThrow({ where: { id: instanceId }, include: { activity: { include: { chapter: true } } } });
    const config = object(instance.runtimeConfig); const version = Number(config.version ?? 1) + 1;
    await db.classroomInstance.update({ where: { id: instanceId }, data: { runtimeConfig: json({ ...config, version }) } });
    await db.domainEvent.create({ data: { classroomInstanceId: instanceId, offeringId: instance.activity.chapter.offeringId,
      idempotencyKey: randomUUID(), eventType: 'SHOWCASE_CHANGED', payload: { courseVersion: version, scope: studentId ? 'student' : 'course', ...(studentId ? { studentId } : {}) } } });
  };
  const updatePresentation = async (query: Query) => {
    const current = await db.showcasePresentation.findUniqueOrThrow({ where: { id: str(query.where?.id) } });
    const content = object(current.content);
    const changes = { ...query.data };
    if (object(changes.revision).increment) changes.revision = Number(content.revision ?? 1) + Number(object(changes.revision).increment);
    const row = await db.showcasePresentation.update({ where: { id: current.id }, data: { status: typeof changes.status === 'string' ? changes.status.toUpperCase() : undefined,
      presentedAt: changes.startedAt instanceof Date ? changes.startedAt : undefined, content: json({ ...content, ...changes }) }, include: { participation: { include: { enrollment: true } } } });
    await recordChange(row.participation.instanceId, ['PENDING', 'REJECTED', 'CANCELLED'].includes(row.status) ? row.participation.enrollment.userId : undefined);
    return toPresentation(row);
  };
  return {
    lock: (courseId: string) => lockCourseMutation(db, courseId), loadCourse, listStudents, listMembers, listDocuments, listFiles, listPresentations,
    findStudent: async (q: Query) => (await listStudents(q))[0] ?? null,
    findMember: async (q: Query) => (await listMembers(q))[0] ?? null,
    findDocument: async (q: Query) => (await listDocuments(q))[0] ?? null,
    findFile: async (q: Query) => (await listFiles(q))[0] ?? null,
    findPresentation: async (q: Query) => (await listPresentations(q))[0] ?? null,
    findGroup: async (q: Query) => (await listMembers({ where: { courseId: q.where?.courseId, groupId: q.where?.id } })).length ? { id: q.where?.id } : null,
    findParticipation: (courseId: string, studentId: string) => db.classroomParticipation.findFirst({ where: { instanceId: courseId, enrollment: { userId: studentId } } }),
    updateCourse: async (query: Query) => {
      const instance = await db.classroomInstance.findUniqueOrThrow({ where: { id: str(query.where?.id) } });
      const config = object(instance.runtimeConfig); const data = { ...query.data };
      if (object(data.version).increment) data.version = Number(config.version ?? 1) + Number(object(data.version).increment);
      await db.classroomInstance.update({ where: { id: instance.id }, data: { runtimeConfig: json({ ...config, ...data }) } });
      await recordChange(instance.id);
      return loadCourse({ where: { id: instance.id } });
    },
    createPresentation: async (query: Query) => {
      const data = query.data ?? {};
      const version = await db.artifactVersion.findFirstOrThrow({ where: { id: str(data.artifactVersionId), artifact: { participation: { instanceId: str(data.courseId), enrollment: { userId: str(data.studentId) } } } }, include: { artifact: { include: { participation: { include: { enrollment: true } } } } } });
      const requestedGroupId = str(data.groupId);
      const groupId = requestedGroupId ? await resolveProjectGroupId(db, version.artifact.participation.enrollment.offeringId, requestedGroupId) : null;
      if (requestedGroupId && !groupId) throw new PlatformError("GROUP_SCOPE_MISMATCH", "展示小组不属于该教学班", 409);
      const row = await db.showcasePresentation.create({ data: { id: str(data.id), artifactId: version.artifactId, artifactVersionId: version.id,
        participationId: version.artifact.participationId, groupId, status: str(data.status).toUpperCase(), content: json(data) }, include: { participation: { include: { enrollment: true } } } });
      await recordChange(row.participation.instanceId, row.participation.enrollment.userId);
      return toPresentation(row);
    },
    updatePresentation,
    updatePresentations: async (query: Query) => { const rows = await listPresentations(query); for (const row of rows) await updatePresentation({ where: { id: row.id }, data: query.data }); return { count: rows.length }; },
  };
}
export const showcaseStore = { ...createShowcaseStore(), transaction: <T>(operation: (store: ReturnType<typeof createShowcaseStore>) => Promise<T>) => prisma.$transaction((tx) => operation(createShowcaseStore(tx)), { timeout: 15_000 }) };
