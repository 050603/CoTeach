import { prisma } from '@/lib/db/client';
/** Resolve transport course IDs to explicit V2 storage ownership. Authorization remains with caller. */
export async function resolveUploadScope(courseId: string) {
  const offering = await prisma.courseOffering.findUnique({ where: { id: courseId }, select: { id: true } });
  if (offering) return { offeringId: offering.id, templateOwnerId: null, templateId: null };
  const instance = await prisma.classroomInstance.findUnique({ where: { id: courseId }, select: { activity: { select: { chapter: { select: { offeringId: true } } } } } });
  if (instance) return { offeringId: instance.activity.chapter.offeringId, templateOwnerId: null, templateId: null };
  const template = await prisma.classroomTemplate.findUnique({ where: { id: courseId }, select: { id: true, ownerId: true } });
  return template ? { offeringId: null, templateOwnerId: template.ownerId, templateId: template.id } : null;
}

/** A bound classroom snapshot grants access only to the assets it explicitly references. */
export async function canReadTemplateAsset(userId: string, assetId: string): Promise<boolean> {
  const participations = await prisma.classroomParticipation.findMany({
    where: { enrollment: { userId, status: { in: ['ACTIVE', 'COMPLETED'] } } },
    select: { instance: { select: { templateVersion: { select: { snapshot: true } } } } },
  });
  return participations.some((row) => {
    const snapshot = row.instance.templateVersion.snapshot;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
    const design = snapshot.design;
    if (!design || typeof design !== 'object' || Array.isArray(design) || !Array.isArray(design.resources)) return false;
    return design.resources.some((resource) => {
      if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return false;
      return resource.id === assetId || (typeof resource.url === 'string' && resource.url.split('?')[0] === `/api/uploads/${assetId}`);
    });
  });
}
