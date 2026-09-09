import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';

export async function resolveCourseEventScope(courseId: string) {
  const instance = await prisma.classroomInstance.findUnique({ where: { id: courseId }, select: {
    runtimeConfig: true, activity: { select: { chapter: { select: { offeringId: true } } } },
  } });
  if (instance) {
    const config = instance.runtimeConfig && typeof instance.runtimeConfig === 'object' && !Array.isArray(instance.runtimeConfig) ? instance.runtimeConfig : {};
    return { where: { classroomInstanceId: courseId } satisfies Prisma.DomainEventWhereInput,
      classroomInstanceId: courseId, offeringId: instance.activity.chapter.offeringId, templateId: undefined,
      version: typeof config.version === 'number' ? config.version : 1 };
  }
  const template = await prisma.classroomTemplate.findUnique({ where: { id: courseId }, select: { updatedAt: true } });
  if (!template) return null;
  return { where: { classroomInstanceId: null, payload: { path: ['templateId'], equals: courseId } } satisfies Prisma.DomainEventWhereInput,
    classroomInstanceId: undefined, offeringId: undefined, templateId: courseId, version: template.updatedAt.getTime() };
}
