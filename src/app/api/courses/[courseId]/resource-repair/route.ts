import { type NextRequest } from "next/server";
import { authorizeTemplateRequest } from "@/lib/platform/template-access";
import { getCourse, updateCourse } from "@/lib/session/server-store";
import { readClassroom, updatePersistedClassroomScenes } from "@/lib/openmaic/server/classroom-storage";
import {
  generateClassroomAssets,
} from "@/lib/openmaic/server/classroom-asset-generation";
import {
  generateTTSForClassroom,
  findUnresolvedClassroomMedia,
  resolveServerTtsTimingSelection,
} from "@/lib/openmaic/server/classroom-media-generation";
import {
  findMissingTtsResources,
  repairMissingTeachingToolResources,
} from "@/lib/course-generation/resource-readiness";
import { auditCourseGeneratedResources } from "@/lib/course-generation/resource-audit-server";
import { generateAdaptiveBranchResource } from "@/lib/course-generation/job-runner";
import { mapWithConcurrency } from "@openmaic/lib/utils/concurrency";
import type { SceneOutline } from "@/lib/openmaic/types/generation";
import { resolveDurableCourseSceneOutlines } from "@/lib/course-generation/course-resource-outlines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


export async function GET(
  request: NextRequest,
  context: { params: Promise<{ courseId: string }> },
) {
  const { courseId } = await context.params;
  const auth = await authorizeTemplateRequest(request, courseId);
  if (auth instanceof Response) return auth;
  return Response.json(await auditCourseGeneratedResources(courseId));
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ courseId: string }> },
) {
  const { courseId } = await context.params;
  const auth = await authorizeTemplateRequest(request, courseId);
  if (auth instanceof Response) return auth;
  const course = await getCourse(courseId);
  if (!course) return Response.json({ error: "Course not found" }, { status: 404 });
  const classroomId = course.aiLearningClassroomId || course.content._openmaicClassroomId;
  const classroom = classroomId ? await readClassroom(classroomId) : null;
  const storedOutlines = course.content._openmaicSceneOutlines ?? [];
  const outlines = await resolveDurableCourseSceneOutlines(courseId, storedOutlines);
  if (JSON.stringify(outlines) !== JSON.stringify(storedOutlines)) {
    await updateCourse(courseId, (current) => ({
      ...current,
      content: { ...current.content, _openmaicSceneOutlines: outlines },
    }));
  }

  if (classroom && classroomId) {
    const repairedTools = repairMissingTeachingToolResources(outlines, classroom.scenes);
    const scenes = repairedTools.scenes;
    if (repairedTools.changed) await updatePersistedClassroomScenes(classroomId, scenes);

    const recordedMediaFailures = classroom.assetGeneration?.failures.filter(
      (failure) => failure.type === "image" || failure.type === "video",
    ) ?? [];
    const mediaFailures = Array.from(new Map(
      [...findUnresolvedClassroomMedia(outlines, scenes), ...recordedMediaFailures].map((failure) => [
        `${failure.type}:${failure.elementId}`,
        failure,
      ]),
    ).values());
    if (mediaFailures.length > 0) {
      const missingElementIds = new Set(mediaFailures.map((failure) => failure.elementId));
      const repairOutlines = outlines.flatMap((outline) => {
        const mediaGenerations = (outline.mediaGenerations ?? []).filter((candidate) => {
          if (!candidate || typeof candidate !== "object") return false;
          const elementId = (candidate as { elementId?: unknown }).elementId;
          return typeof elementId === "string" && missingElementIds.has(elementId);
        });
        return mediaGenerations.length > 0 ? [{ ...outline, mediaGenerations }] : [];
      }) as unknown as SceneOutline[];
      try {
        await generateClassroomAssets({
          outlines: repairOutlines,
          baseUrl: process.env.PUBLIC_BASE_URL || new URL(request.url).origin,
          studentClassroomId: classroomId,
          studentScenes: scenes,
          enableImageGeneration: mediaFailures.some((failure) => failure.type === "image"),
          enableVideoGeneration: mediaFailures.some((failure) => failure.type === "video"),
          enableTTS: false,
          isPblCourse: true,
          ttsTimingSelection: resolveServerTtsTimingSelection(),
        });
      } catch {
        // Exact provider failures are persisted by the asset generator and are
        // returned by the final inspection below.
      }
    }

    if (findMissingTtsResources(scenes).length > 0) {
      try {
        await generateTTSForClassroom(
          scenes,
          classroomId,
          process.env.PUBLIC_BASE_URL || new URL(request.url).origin,
          undefined,
          resolveServerTtsTimingSelection(),
        );
      } catch {
        // The TTS generator has already exhausted its bounded retries. Keep
        // the remaining segments in the response instead of aborting repairs
        // for independent adaptive resources.
      } finally {
        await updatePersistedClassroomScenes(classroomId, scenes);
      }
    }
  }

  const plan = course.content.adaptiveLearningPlan;
  const branchIds = plan?.enabled
    ? plan.branches.flatMap((branch) =>
        branch.enabled !== false
        && branch.status === "teacher-confirmed"
        && (branch.preparedResource?.status !== "ready" || !branch.preparedResource.classroomId)
          ? [branch.id]
          : [],
      )
    : [];
  const repairController = new AbortController();
  await mapWithConcurrency(branchIds, 2, async (branchId) => {
    try {
      await generateAdaptiveBranchResource(courseId, branchId, repairController.signal);
    } catch {
      // The branch helper persists its exact failure. Continue repairing other
      // independent resources and return the remaining issue list below.
    }
  });

  return Response.json(await auditCourseGeneratedResources(courseId));
}
