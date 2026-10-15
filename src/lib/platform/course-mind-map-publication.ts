import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { runMutationTransaction } from '@/lib/db/transaction-retry';
import { hashJson } from '@/lib/course-quality-review/audio-publication';
import { validateCourseMindMap } from '@/lib/course-mind-map/generation';
import { resolveCourseMindMapBindings } from '@/lib/course-mind-map/bindings';
import { computeCourseMindMapBindingFingerprint, computeCourseMindMapSourceFingerprint } from '@/lib/course-mind-map/source';
import { isValidClassroomId, normalizePersistedClassroom, readClassroom, type PersistedClassroomData } from '@/lib/openmaic/server/classroom-storage';
import { createPblTemplateCourse, decodePblTemplate, type PblTemplateSnapshot } from './pbl-template';
import { PlatformError } from './repository';

export type CourseMindMapPublicationSource = {
  courseId: string;
  sourceVersion: number;
  sourceVersionId: string;
  sourceSnapshotFingerprint: string;
  expectedCourseUpdatedAt: string;
  sourceClassroomFingerprint: string;
  sourceClassroom: PersistedClassroomData;
  snapshot: PblTemplateSnapshot;
};

export type PublishCourseMindMapInput = CourseMindMapPublicationSource;

export type CourseMindMapPublicationResult = {
  version: number;
  versionId: string;
  classroomId: string;
  courseVersion: number;
  reused: boolean;
};

function fixedSnapshot(snapshot: PblTemplateSnapshot): PblTemplateSnapshot {
  const fixed = JSON.parse(JSON.stringify(snapshot)) as PblTemplateSnapshot;
  delete fixed.design.content.courseMindMap;
  return fixed;
}

/** Capture the latest immutable publication and the normalized classroom used by readers. */
export async function readCourseMindMapPublicationSource(
  courseId: string,
  sourceVersion: number,
  db: PrismaClient = prisma,
): Promise<CourseMindMapPublicationSource> {
  const template = await db.classroomTemplate.findUnique({ where: { id: courseId }, include: {
    versions: { orderBy: { version: 'desc' }, take: 1 },
  } });
  if (!template || template.status.toUpperCase() === 'DELETED') throw new PlatformError('NOT_FOUND', '课程不存在。', 404);
  if (template.status.toUpperCase() === 'ARCHIVED') throw new PlatformError('TEMPLATE_ARCHIVED', '归档课程不能更新思维导图。', 409);
  const version = template.versions[0];
  if (!version || version.version !== sourceVersion || version.status.toUpperCase() !== 'PUBLISHED') {
    throw new PlatformError('VERSION_CONFLICT', '指定来源必须是当前最新发布版。', 409);
  }
  const design = decodePblTemplate(version.snapshot);
  const classroomId = design?.aiLearningClassroomId || design?.content._openmaicClassroomId;
  if (!design || !classroomId || !isValidClassroomId(classroomId)) {
    throw new PlatformError('INVALID_VERSION', '来源课程没有可读取的课堂。', 409);
  }
  const stored = await readClassroom(classroomId);
  if (!stored || stored.assetGeneration?.status === 'running') {
    throw new PlatformError('CLASSROOM_NOT_READY', '来源课堂缺失或仍在生成，请保留当前版本。', 409);
  }
  const classroom = normalizePersistedClassroom(stored);
  return {
    courseId, sourceVersion, sourceVersionId: version.id,
    sourceSnapshotFingerprint: hashJson(version.snapshot), expectedCourseUpdatedAt: template.updatedAt.toISOString(),
    sourceClassroomFingerprint: hashJson(classroom), sourceClassroom: classroom,
    snapshot: JSON.parse(JSON.stringify(version.snapshot)) as PblTemplateSnapshot,
  };
}

/** Authorized derived-map update only; teaching content, media, reviews and old instances stay bound to their versions. */
export async function publishCourseMindMapVersion(
  input: PublishCourseMindMapInput,
  db: PrismaClient = prisma,
): Promise<CourseMindMapPublicationResult> {
  const sourceClassroom = normalizePersistedClassroom(input.sourceClassroom);
  if (!isValidClassroomId(sourceClassroom.id) || sourceClassroom.assetGeneration?.status === 'running'
    || hashJson(sourceClassroom) !== input.sourceClassroomFingerprint) {
    throw new PlatformError('CLASSROOM_CONFLICT', '已保存的来源课堂不匹配，请重新读取来源。', 409);
  }
  if (!decodePblTemplate(input.snapshot) || !input.snapshot.design.content.courseMindMap) {
    throw new PlatformError('INVALID_MIND_MAP_CANDIDATE', '候选版本缺少可执行的思维导图。', 409);
  }
  const publish = async (tx: Prisma.TransactionClient): Promise<CourseMindMapPublicationResult> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pbl-template:${input.courseId}`}, 0))`;
    await tx.$queryRaw`SELECT "id" FROM "ClassroomTemplate" WHERE "id" = ${input.courseId} FOR UPDATE`;
    const template = await tx.classroomTemplate.findUnique({ where: { id: input.courseId }, include: {
      versions: { orderBy: { version: 'desc' }, take: 1 },
    } });
    if (!template || template.status.toUpperCase() === 'DELETED') throw new PlatformError('NOT_FOUND', '课程不存在。', 404);
    if (template.status.toUpperCase() === 'ARCHIVED') throw new PlatformError('TEMPLATE_ARCHIVED', '归档课程不能更新思维导图。', 409);
    const latest = template.versions[0];
    const source = latest?.id === input.sourceVersionId ? latest : await tx.classroomTemplateVersion.findUnique({
      where: { id: input.sourceVersionId },
    });
    const reused = Boolean(latest && source && latest.id !== source.id && latest.version === source.version + 1
      && hashJson(latest.snapshot) === hashJson(input.snapshot));
    if (!source || !latest || source.id !== input.sourceVersionId || source.templateId !== input.courseId || source.version !== input.sourceVersion
      || source.status.toUpperCase() !== 'PUBLISHED' || latest.status.toUpperCase() !== 'PUBLISHED'
      || !Number.isFinite(Date.parse(input.expectedCourseUpdatedAt))
      || hashJson(source.snapshot) !== input.sourceSnapshotFingerprint
      || (!reused && (latest.id !== source.id || template.updatedAt.getTime() !== Date.parse(input.expectedCourseUpdatedAt)))) {
      throw new PlatformError('VERSION_CONFLICT', '课程来源版本已改变，保留当前版本并重新读取来源。', 409);
    }
    const design = decodePblTemplate(source.snapshot);
    if (!design || (design.aiLearningClassroomId || design.content._openmaicClassroomId) !== sourceClassroom.id) {
      throw new PlatformError('VERSION_CONFLICT', '来源版本没有绑定已锁定的课堂。', 409);
    }
    if (hashJson(fixedSnapshot(input.snapshot)) !== hashJson(fixedSnapshot(source.snapshot as unknown as PblTemplateSnapshot))) {
      throw new PlatformError('MIND_MAP_CONTENT_CHANGED', '思维导图更新只能修改导图，不能改变教学内容、课堂、音频或原有审核证据。', 409);
    }
    const stored = await readClassroom(sourceClassroom.id);
    if (!stored || hashJson(normalizePersistedClassroom(stored)) !== input.sourceClassroomFingerprint) {
      throw new PlatformError('CLASSROOM_CONFLICT', '来源课堂已更新，请保留当前版本并重新生成候选。', 409);
    }
    const course = createPblTemplateCourse(input.courseId, design);
    const map = input.snapshot.design.content.courseMindMap!;
    if (map.sourceFingerprint !== computeCourseMindMapSourceFingerprint(course, sourceClassroom.scenes)) {
      throw new PlatformError('MIND_MAP_SOURCE_CONFLICT', '思维导图没有对应当前教材、页面和讲稿。', 409);
    }
    if (map.bindingFingerprint !== computeCourseMindMapBindingFingerprint(sourceClassroom.scenes)) {
      throw new PlatformError('MIND_MAP_BINDING_CONFLICT', '思维导图播放绑定没有对应当前音频。', 409);
    }
    try {
      if (!Array.isArray(map.diagnostics) || map.diagnostics.some((issue) => typeof issue !== 'string')) {
        throw new Error('候选导图缺少真实质量诊断列表。');
      }
      const { issues } = validateCourseMindMap(map, course, sourceClassroom.scenes);
      if (issues.some((issue) => !map.diagnostics.includes(issue))) {
        throw new Error('候选导图遗漏了当前质量诊断。');
      }
      const resolved = resolveCourseMindMapBindings(map, sourceClassroom.scenes);
      if (hashJson(resolved.bindings) !== hashJson(map.bindings)) throw new Error('播放时间没有来自当前真实音频对齐。');
    } catch (error) {
      throw new PlatformError('INVALID_MIND_MAP_CANDIDATE', error instanceof Error ? error.message : '思维导图结构或页面绑定不可执行。', 409);
    }
    if (reused) return { version: latest.version, versionId: latest.id, classroomId: sourceClassroom.id,
      courseVersion: template.updatedAt.getTime(), reused: true };
    const version = source.version + 1;
    const created = await tx.classroomTemplateVersion.create({ data: {
      templateId: input.courseId, version, status: 'PUBLISHED', snapshot: input.snapshot as unknown as Prisma.InputJsonValue,
      ...(source.mediaRefs !== null && source.mediaRefs !== undefined ? { mediaRefs: source.mediaRefs as Prisma.InputJsonValue } : {}),
    } });
    const updatedAt = new Date(Math.max(Date.now(), template.updatedAt.getTime() + 1));
    await tx.classroomTemplate.update({ where: { id: input.courseId }, data: { updatedAt } });
    return { version, versionId: created.id, classroomId: sourceClassroom.id, courseVersion: updatedAt.getTime(), reused: false };
  };
  return db === prisma ? runMutationTransaction(publish) : db.$transaction(publish, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 10_000,
  });
}
