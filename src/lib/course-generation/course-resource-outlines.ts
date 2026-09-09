import { loadGenerationCheckpoints } from "./checkpoint-storage";
import { contentGenerationJobs } from "@/lib/course-generation/job-storage";
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
  const job = await contentGenerationJobs.findUnique({
    where: { courseId },
    select: { preparedOutlines: true },
  });
  const checkpoint = job ? await loadGenerationCheckpoints(job.id) : null;
  const prepared = Array.isArray(checkpoint?.preparedOutlines)
    ? checkpoint.preparedOutlines as unknown as OpenMaicSceneOutlineSnapshot[]
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
