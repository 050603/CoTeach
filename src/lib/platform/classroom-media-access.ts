import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AuthClaims } from '@/lib/auth/session';
import { authenticateRequest } from '@/lib/auth/request-guards';
import { CLASSROOM_MEDIA_ORIGIN_PREFIX } from '@/lib/course-generation/classroom-media-origin';
import { CLASSROOMS_DIR, isValidClassroomId } from '@openmaic/lib/server/classroom-storage';
import { authorizeLegacyClassroomRead, canAccessLegacyCourse, getPlatformUser, preferredMediaAuthRole, type PlatformDb } from './access';

const PREFIX = '/api/openmaic/classroom-media/';
const referenceCache = new Map<string, { fingerprint: string; paths: Set<string> }>();

/** File identity, independent of cache-busting queries and legacy deployment origins. */
export function classroomMediaPath(classroomId: string, parts: readonly string[]): string | null {
  if (!isValidClassroomId(classroomId) || !parts.length
    || parts.some((part) => !part || part === '.' || part === '..' || /[/\\\0]/.test(part))) return null;
  return PREFIX + classroomId + '/' + parts.map(encodeURIComponent).join('/');
}

function mediaPath(value: unknown): string | null {
  if (typeof value !== 'string' || !(value.startsWith(PREFIX) || /^https?:\/\//.test(value))) return null;
  try {
    const url = new URL(value, 'http://classroom-media.local');
    if (!url.pathname.startsWith(PREFIX)) return null;
    const [classroomId, ...parts] = url.pathname.slice(PREFIX.length).split('/').map(decodeURIComponent);
    return classroomMediaPath(classroomId, parts);
  } catch { return null; }
}

function boundClassroomIds(snapshot: unknown): string[] {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return [];
  const design = (snapshot as Record<string, unknown>).design;
  if (!design || typeof design !== 'object' || Array.isArray(design)) return [];
  const record = design as Record<string, unknown>;
  const content = record.content && typeof record.content === 'object'
    ? record.content as Record<string, unknown> : {};
  return [...new Set([record.aiLearningClassroomId, record.teacherClassroomId, content._openmaicClassroomId, content.teacherClassroomId]
    .filter((id): id is string => typeof id === 'string' && isValidClassroomId(id)))];
}

/** Inspect actual media fields, never arbitrary narration text, links or audit logs. */
function collectMediaPaths(value: unknown, paths: Set<string>, depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 32) return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectMediaPaths(item, paths, depth + 1));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'audioUrl' || key === 'src' || key === 'poster') {
      const identity = mediaPath(item);
      if (identity) paths.add(identity);
    }
    if (item && typeof item === 'object') collectMediaPaths(item, paths, depth + 1);
  }
}

async function persistedMediaPaths(classroomId: string): Promise<Set<string>> {
  const file = path.join(CLASSROOMS_DIR, classroomId + '.json');
  try {
    const stat = await fs.stat(file, { bigint: true });
    const fingerprint = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    const cached = referenceCache.get(classroomId);
    if (cached?.fingerprint === fingerprint) return cached.paths;
    const snapshot = JSON.parse(await fs.readFile(file, 'utf8')) as { scenes?: unknown };
    const paths = new Set<string>();
    collectMediaPaths(snapshot.scenes, paths);
    if (referenceCache.size >= 128) referenceCache.delete(referenceCache.keys().next().value!);
    referenceCache.set(classroomId, { fingerprint, paths });
    return paths;
  } catch (error) {
    referenceCache.delete(classroomId);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw error;
  }
}

/** Only server-written generation output proves origin; editable snapshots/requests do not. */
async function generatedMediaOwners(classroomId: string, database: PlatformDb): Promise<Set<string>> {
  const jobs = await database.generationJob.findMany({
    where: {
      targetType: 'CLASSROOM_TEMPLATE',
      jobType: 'COURSE_CONTENT',
      OR: [
        { result: { path: ['id'], equals: classroomId } },
        { result: { path: ['teacherClassroomId'], equals: classroomId } },
        { checkpoints: { some: {
          step: CLASSROOM_MEDIA_ORIGIN_PREFIX + classroomId,
          state: { path: ['classroomId'], equals: classroomId },
        } } },
        { checkpoints: { some: {
          step: 'course-finalization',
          OR: [
            { state: { path: ['split', 'studentClassroomId'], equals: classroomId } },
            { state: { path: ['split', 'teacherClassroomId'], equals: classroomId } },
          ],
        } } },
      ],
    },
    select: { targetId: true },
  });
  if (!jobs.length) return new Set();
  const templates = await database.classroomTemplate.findMany({
    where: { id: { in: [...new Set(jobs.map((job) => job.targetId))] } },
    select: { ownerId: true },
  });
  return new Set(templates.map((template) => template.ownerId));
}

/** Exact reusable-media capability; this does not authorize the originating classroom. */
export async function canReadReferencedClassroomMedia(
  claims: AuthClaims,
  expectedPath: string,
  db?: PlatformDb,
): Promise<boolean> {
  if (mediaPath(expectedPath) !== expectedPath) return false;
  const database = db ?? (await import('@/lib/db/client')).prisma;
  const user = await getPlatformUser(claims, database);
  if (!user) return false;
  const sourceClassroomId = expectedPath.slice(PREFIX.length).split('/')[0];
  const sourceOwners = await generatedMediaOwners(sourceClassroomId, database);
  if (!sourceOwners.size) return false;
  const [templates, instances] = await Promise.all([
    user.role === 'teacher' ? database.classroomTemplate.findMany({
      where: { ownerId: user.id, status: { in: ['ACTIVE', 'active'] } },
      select: { versions: { orderBy: { version: 'desc' }, take: 1, select: { snapshot: true } } },
    }) : Promise.resolve([]),
    database.classroomInstance.findMany({
      where: user.role === 'teacher'
        ? { activity: { chapter: { offering: { teachers: { some: { userId: user.id } } } } } }
        : { participations: { some: { enrollment: { userId: user.id, status: { in: ['ACTIVE', 'active', 'COMPLETED', 'completed'] } } } } },
      select: { id: true, templateVersion: { select: { snapshot: true, template: { select: { ownerId: true } } } } },
    }),
  ]);
  // Knowing a foreign URL and inserting it into one's own classroom must never grant access.
  const classroomIds = new Set(sourceOwners.has(user.id)
    ? templates.flatMap((template) => template.versions.flatMap((version) => boundClassroomIds(version.snapshot)))
    : []);
  for (const instance of instances) {
    // Keep the exact existing course access semantics, including matching the enrollment's offering.
    if (sourceOwners.has(instance.templateVersion.template.ownerId)
      && await canAccessLegacyCourse(claims, instance.id, 'read', database)) {
      boundClassroomIds(instance.templateVersion.snapshot).forEach((id) => classroomIds.add(id));
    }
  }
  for (const classroomId of classroomIds) {
    if ((await persistedMediaPaths(classroomId)).has(expectedPath)) return true;
  }
  return false;
}

/** Keep direct source access, then allow only a media file explicitly adopted by an accessible classroom. */
export async function authorizeClassroomMediaRead(request: Request, classroomId: string, parts: readonly string[]): Promise<Response | null> {
  const expectedPath = classroomMediaPath(classroomId, parts);
  if (!expectedPath) return new Response('Invalid classroom media path', { status: 400 });
  const direct = await authorizeLegacyClassroomRead(request, classroomId);
  if (!direct || direct.status !== 403) return direct;
  const auth = await authenticateRequest(request, preferredMediaAuthRole(request));
  if ('response' in auth) return auth.response;
  return await canReadReferencedClassroomMedia(auth.claims, expectedPath) ? null : direct;
}
