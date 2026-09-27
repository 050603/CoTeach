import { prisma } from '@/lib/db/client';
import { publicResourcePackageSnapshot } from '@/lib/resource-package/privacy';
import { isValidClassroomId, readClassroom } from '@openmaic/lib/server/classroom-storage';
import type { AuthClaims } from '@/lib/auth/session';
import type { FileAsset, Prisma } from '@prisma/client';
/** Resolve transport course IDs to explicit V2 storage ownership. Authorization remains with caller. */
export async function resolveUploadScope(courseId: string) {
  const offering = await prisma.courseOffering.findUnique({ where: { id: courseId }, select: { id: true } });
  if (offering) return { offeringId: offering.id, templateOwnerId: null, templateId: null };
  const instance = await prisma.classroomInstance.findUnique({ where: { id: courseId }, select: { activity: { select: { chapter: { select: { offeringId: true } } } } } });
  if (instance) return { offeringId: instance.activity.chapter.offeringId, templateOwnerId: null, templateId: null };
  const template = await prisma.classroomTemplate.findUnique({ where: { id: courseId }, select: { id: true, ownerId: true } });
  return template ? { offeringId: null, templateOwnerId: template.ownerId, templateId: template.id } : null;
}

/** Fresh student authorization and ownership in one read; null preserves legacy namespace resolution. */
export async function resolveStudentClassroomUploadScope(
  claims: AuthClaims,
  courseId: string,
  db: Pick<Prisma.TransactionClient, '$queryRaw'> = prisma,
): Promise<{ allowed: false } | { allowed: true; scope: { offeringId: string; templateOwnerId: null; templateId: null } } | null> {
  if (claims.role !== 'student' || !claims.sub) return null;
  const rows = await db.$queryRaw<Array<{ offeringId: string; allowed: boolean }>>`
    SELECT ch."offeringId", COALESCE(
      LOWER(u.status) = 'active' AND LOWER(u.role) = 'student'
      AND p.id IS NOT NULL AND UPPER(e.status) = 'ACTIVE'
      AND UPPER(i.status) = 'TEACHING' AND UPPER(o.status) = 'OPEN', false
    ) AS allowed
    FROM "ClassroomInstance" i
    JOIN "Activity" a ON a.id = i."activityId"
    JOIN "Chapter" ch ON ch.id = a."chapterId"
    JOIN "CourseOffering" o ON o.id = ch."offeringId"
    LEFT JOIN "User" u ON u.id = ${claims.sub}
    LEFT JOIN "Enrollment" e ON e."userId" = u.id AND e."offeringId" = ch."offeringId"
      AND e.status IN ('ACTIVE', 'active', 'COMPLETED', 'completed')
    LEFT JOIN "ClassroomParticipation" p ON p."instanceId" = i.id AND p."enrollmentId" = e.id
    WHERE i.id = ${courseId}
      AND NOT EXISTS (SELECT 1 FROM "ClassroomTemplate" t WHERE t.id = ${courseId})
      AND NOT EXISTS (SELECT 1 FROM "CourseOffering" direct WHERE direct.id = ${courseId})
  `;
  const row = rows[0];
  if (!row) return null;
  return row.allowed ? { allowed: true, scope: { offeringId: row.offeringId, templateOwnerId: null, templateId: null } } : { allowed: false };
}

/** A bound classroom grants access only to its published resources and embedded student figures. */
export async function canReadTemplateAsset(
  userId: string,
  asset: Pick<FileAsset, 'id' | 'uploadedById' | 'assetRole' | 'mimeType'>,
): Promise<boolean> {
  const participations = await prisma.classroomParticipation.findMany({
    where: { enrollment: { userId, status: { in: ['ACTIVE', 'COMPLETED'] } } },
    select: { instance: { select: { templateVersion: { select: {
      snapshot: true, mediaRefs: true, template: { select: { ownerId: true } },
    } } } } },
  });
  const expectedUrl = `/api/uploads/${asset.id}`;
  const containsAdoptedAssetUrl = (value: unknown, depth = 0): boolean => {
    if (depth > 16) return false;
    if (typeof value === 'string') return value.split('?')[0] === expectedUrl;
    if (Array.isArray(value)) return value.some((item) => containsAdoptedAssetUrl(item, depth + 1));
    if (!value || typeof value !== 'object') return false;
    return Object.values(value).some((item) => containsAdoptedAssetUrl(item, depth + 1));
  };
  for (const row of participations) {
    const snapshot = row.instance.templateVersion.snapshot;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) continue;
    const design = snapshot.design;
    const resourceMatch = design && typeof design === 'object' && !Array.isArray(design) && Array.isArray(design.resources)
      && design.resources.some((resource) => {
      if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return false;
      return resource.id === asset.id || (typeof resource.url === 'string' && resource.url.split('?')[0] === expectedUrl);
    });
    if (resourceMatch
      || containsAdoptedAssetUrl(publicResourcePackageSnapshot(snapshot))
      || containsAdoptedAssetUrl(row.instance.templateVersion.mediaRefs)) return true;

    // Generated classroom slides can embed extracted textbook figures. The
    // immutable template binds the classroom ID; the persisted slide must
    // contain this exact image URL before a student may read the file.
    if (asset.uploadedById !== row.instance.templateVersion.template.ownerId
      || asset.assetRole !== 'TEXTBOOK_FIGURE' || !asset.mimeType.startsWith('image/')
      || !design || typeof design !== 'object' || Array.isArray(design)) continue;
    const content = design.content && typeof design.content === 'object' && !Array.isArray(design.content)
      ? design.content : {};
    const classroomIds = [...new Set([design.aiLearningClassroomId, content._openmaicClassroomId])]
      .filter((id): id is string => typeof id === 'string' && isValidClassroomId(id));
    for (const classroomId of classroomIds) {
      const classroom = await readClassroom(classroomId);
      if (classroom?.scenes.some((scene) => {
        if (scene.type !== 'slide' || scene.audience !== 'student') return false;
        const elements = (scene.content as { canvas?: { elements?: Array<{ src?: unknown }> } }).canvas?.elements;
        return elements?.some((element) => typeof element.src === 'string'
          && element.src.split('?')[0] === expectedUrl) ?? false;
      })) return true;
    }
  }
  return false;
}
