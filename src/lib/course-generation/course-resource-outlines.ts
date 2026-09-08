// @ts-nocheck
import { prisma } from "@/lib/db/client";
import type { OpenMaicSceneOutlineSnapshot } from "@/lib/session/types";

function hasMediaPlan(outline: OpenMaicSceneOutlineSnapshot): boolean {
  return Array.isArray(outline.mediaGenerations) && outline.mediaGenerations.length > 0;
}

/**
 * Restore media plans from the durable generation checkpoint when an older
 * course link saved only the pre-generation outline snapshot.
 *
 * These are the exact model-produced plans used for the generated pages. No
 * prompts or replacement assets are synthesized here.
 */
export async function resolveDurableCourseSceneOutlines(
  courseId: string,
  current: OpenMaicSceneOutlineSnapshot[],
): Promise<OpenMaicSceneOutlineSnapshot[]> {
  const job = await prisma.courseGenerationJob.findUnique({
    where: { courseId },
    select: { preparedOutlines: true },
  });
  const prepared = Array.isArray(job?.preparedOutlines)
    ? job.preparedOutlines as unknown as OpenMaicSceneOutlineSnapshot[]
    : [];
  if (prepared.length === 0) return current;
  if (current.length === 0) return prepared;

  const preparedById = new Map(prepared.map((outline) => [outline.id, outline]));
  return current.map((outline) => {
    if (hasMediaPlan(outline)) return outline;
    const durable = preparedById.get(outline.id);
    return durable && hasMediaPlan(durable)
      ? { ...outline, mediaGenerations: durable.mediaGenerations }
      : outline;
  });
}
