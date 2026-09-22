import { Prisma } from "@prisma/client";
import { after, type NextRequest } from "next/server";
import { contentGenerationJobs } from "@/lib/course-generation/job-storage";
import { isBackgroundCourseGenerationEnabled } from "@/lib/course-generation/capability";
import {
  cancelCourseGeneration,
  estimatePersistedCourseGenerationSeconds,
  requeueCourseGenerationFromCheckpoints,
  resumeRecoverableCourseGenerationJob,
  runQueuedCourseGenerationToCompletion,
  type PersistedCourseGenerationRequest,
} from "@/lib/course-generation/job-runner";
import { formatPersistedCourseGenerationErrorForTeacher } from "@/lib/course-generation/failure-policy";
import { courseGenerationPreviewClassroomId } from "@/lib/course-generation/generation-preview";
import { authorizeTemplateRequest } from "@/lib/platform/template-access";
import { loadPblTemplateCourse } from "@/lib/platform/pbl-template-repository";
import {
  assertRequestedClassroomMediaProviders,
  classroomMediaConfigurationErrorResponse,
} from "@openmaic/lib/server/classroom-media-readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1_800;

function retainRequestBoundGeneration(courseId: string): void {
  after(() => runQueuedCourseGenerationToCompletion(courseId));
}


function responseJob(job: Awaited<ReturnType<typeof contentGenerationJobs.findUnique>>) {
  if (!job) return null;
  const persistedRequest = job.request as unknown as Partial<PersistedCourseGenerationRequest>;
  const testOutlineIds = persistedRequest.generationScope === "test-lesson"
    ? new Set(persistedRequest.testLesson?.sceneOutlineIds ?? [])
    : null;
  const requestOutlines = Array.isArray(persistedRequest.sceneOutlines)
    ? persistedRequest.sceneOutlines.filter((scene) => !testOutlineIds || testOutlineIds.has(scene.id))
    : [];
  return {
    id: job.id,
    status: job.status,
    step: job.step,
    progress: job.progress,
    message: job.message,
    scenesGenerated: job.scenesGenerated,
    totalScenes: job.totalScenes,
    estimatedRemainingSeconds: job.estimatedRemainingSeconds,
    tokenUsage: {
      totalTokens: job.tokenUsage,
      calls: job.tokenUsageCalls,
      approximate: true,
    },
    activePages: job.activePages,
    currentStage: job.currentStage,
    events: job.events,
    result: job.result,
    preview: job.scenesGenerated > 0 && job.status !== "completed"
      ? {
          classroomId: courseGenerationPreviewClassroomId(job.id),
          scenesCount: job.scenesGenerated,
        }
      : null,
    error: job.status === "failed" && job.error
      ? formatPersistedCourseGenerationErrorForTeacher(job.error)
      : null,
    startedAt: job.startedAt?.toISOString() ?? null,
    lastHeartbeatAt: job.lastHeartbeatAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    updatedAt: job.updatedAt.toISOString(),
    requestPreview: {
      courseTitle: persistedRequest.courseTitle,
      generationScope: persistedRequest.generationScope === "test-lesson" ? "test-lesson" : "full-course",
      testLesson: persistedRequest.testLesson,
      fullSceneCount: persistedRequest.fullSceneCount,
      sceneOutlines: requestOutlines.map((scene) => ({
            id: scene.id,
            title: scene.title,
            type: scene.type,
            stageKey: scene.stageKey,
            stageLabel: scene.stageLabel,
            estimatedDuration: scene.estimatedDuration,
          })),
      enableImageGeneration: persistedRequest.enableImageGeneration !== false,
      enableVideoGeneration: persistedRequest.enableVideoGeneration === true,
      enableTTS: persistedRequest.enableTTS !== false,
    },
  };
}

export async function GET(request: NextRequest, context: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await context.params;
  const requestedBy = await authorizeTemplateRequest(request, courseId);
  if (requestedBy instanceof Response) return requestedBy;
  const backgroundEnabled = isBackgroundCourseGenerationEnabled();
  let job = await contentGenerationJobs.findUnique({ where: { courseId } });
  if (job?.status === "failed") {
    job = await resumeRecoverableCourseGenerationJob(courseId);
  }
  return Response.json({ backgroundEnabled, job: responseJob(job) });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await context.params;
  const requestedBy = await authorizeTemplateRequest(request, courseId);
  if (requestedBy instanceof Response) return requestedBy;
  const body = await request.json().catch(() => null) as { action?: unknown } | null;
  if (body?.action !== "start-persisted-job" && body?.action !== "resume-from-checkpoints") {
    return Response.json({ error: "INVALID_GENERATION_ACTION" }, { status: 400 });
  }
  const backgroundEnabled = isBackgroundCourseGenerationEnabled();
  if (body.action === "resume-from-checkpoints") {
    const resumed = await requeueCourseGenerationFromCheckpoints(courseId);
    if (!resumed) return Response.json({ error: "GENERATION_JOB_NOT_FOUND" }, { status: 404 });
    if (!backgroundEnabled) retainRequestBoundGeneration(courseId);
    return Response.json({ backgroundEnabled, job: responseJob(resumed) }, { status: 202 });
  }
  if (!backgroundEnabled) retainRequestBoundGeneration(courseId);
  const job = await contentGenerationJobs.findUnique({ where: { courseId } });
  if (!job) return Response.json({ error: "GENERATION_JOB_NOT_FOUND" }, { status: 404 });
  return Response.json({ backgroundEnabled, job: responseJob(job) }, { status: 202 });
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await context.params;
  const requestedBy = await authorizeTemplateRequest(request, courseId);
  if (requestedBy instanceof Response) return requestedBy;
  const job = await cancelCourseGeneration(courseId);
  if (!job) return Response.json({ error: "GENERATION_JOB_NOT_FOUND" }, { status: 404 });
  return Response.json({
    backgroundEnabled: isBackgroundCourseGenerationEnabled(),
    job: responseJob(job),
  });
}

export async function POST(request: NextRequest, context: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await context.params;
  const requestedBy = await authorizeTemplateRequest(request, courseId);
  if (requestedBy instanceof Response) return requestedBy;
  const backgroundEnabled = isBackgroundCourseGenerationEnabled();
  if (!backgroundEnabled) return Response.json({ backgroundEnabled, job: null });

  const course = await loadPblTemplateCourse(courseId);
  if (!course) return Response.json({ error: "Course not found" }, { status: 404 });

  const body = await request.json() as PersistedCourseGenerationRequest;
  if (body.courseId !== courseId || typeof body.requirement !== "string" || !body.requirement.trim()) {
    return Response.json({ error: "Invalid generation request" }, { status: 400 });
  }
  if (body.generationScope !== undefined
    && body.generationScope !== "full-course"
    && body.generationScope !== "test-lesson") {
    return Response.json({ error: "INVALID_GENERATION_SCOPE" }, { status: 400 });
  }
  if (body.generationScope === "test-lesson" && (
    !body.testLesson
    || !Array.isArray(body.testLesson.sceneOutlineIds)
    || body.testLesson.sceneOutlineIds.length === 0
    || !Number.isInteger(body.fullSceneCount)
    || (body.fullSceneCount ?? 0) < body.testLesson.sceneOutlineIds.length
  )) {
    return Response.json({ error: "INVALID_TEST_LESSON_TARGET" }, { status: 400 });
  }
  try {
    assertRequestedClassroomMediaProviders(body);
  } catch (error) {
    const configurationError = classroomMediaConfigurationErrorResponse(error);
    if (!configurationError) throw error;
    return Response.json({
      error: configurationError.code,
      detail: configurationError.message,
    }, { status: 409 });
  }
  const totalScenes = Array.isArray(body.sceneOutlines) ? body.sceneOutlines.length : 0;
  const adaptiveBranchCount = Math.max(0, Math.round(body.adaptiveBranchCount ?? 0));
  const initialEstimate = estimatePersistedCourseGenerationSeconds({
    totalScenes,
    adaptiveBranchCount,
    enableImageGeneration: body.enableImageGeneration,
    enableVideoGeneration: body.enableVideoGeneration,
    enableTTS: body.enableTTS,
  });
  const requestJson = body as unknown as Prisma.InputJsonValue;
  let job = await contentGenerationJobs.findUnique({ where: { courseId } });

  if (!job) {
    try {
      job = await contentGenerationJobs.create({
        data: {
          courseId,
          requestedBy: requestedBy || null,
          request: requestJson,
          totalScenes,
          estimatedRemainingSeconds: initialEstimate,
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      job = await contentGenerationJobs.findUnique({ where: { courseId } });
    }
  } else if (job.status === "failed") {
    // A newly submitted request must never reuse pages prepared for the old
    // request. Worker restarts keep checkpoints; explicit retries reset them.
    try {
      job = await contentGenerationJobs.replace({
        where: { id: job.id, version: job.version, status: "failed" },
        checkpointPolicy: "all",
        data: {
          status: "queued",
          step: "queued",
          progress: 0,
          message: "课程生成任务已重新提交",
          scenesGenerated: 0,
          totalScenes,
          estimatedRemainingSeconds: initialEstimate,
          tokenUsage: 0,
          tokenUsageCalls: 0,
          request: requestJson,
          result: Prisma.JsonNull,
          events: [],
          error: null,
          startedAt: null,
          completedAt: null,
          lastHeartbeatAt: null,
          executionId: null,
          executionOwner: null,
          leaseExpiresAt: null,
          version: { increment: 1 },
        },
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "GENERATION_JOB_NOT_FOUND") throw error;
      return Response.json({ error: "GENERATION_JOB_CONFLICT" }, { status: 409 });
    }
  }

  return Response.json({ backgroundEnabled, job: responseJob(job) }, { status: 202 });
}
