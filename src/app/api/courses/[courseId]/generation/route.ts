// @ts-nocheck
import { Prisma } from "@prisma/client";
import { after, type NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { isBackgroundCourseGenerationEnabled } from "@/lib/course-generation/capability";
import {
  cancelCourseGeneration,
  estimatePersistedCourseGenerationSeconds,
  requeueCourseGenerationFromCheckpoints,
  resumeRecoverableCourseGenerationJob,
  resetCourseGenerationCheckpoints,
  runQueuedCourseGenerationToCompletion,
  type PersistedCourseGenerationRequest,
} from "@/lib/course-generation/job-runner";
import { formatPersistedCourseGenerationErrorForTeacher } from "@/lib/course-generation/failure-policy";
import { isAuthConfigured, readAuthFromRequest } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1_800;

function retainRequestBoundGeneration(courseId: string): void {
  after(() => runQueuedCourseGenerationToCompletion(courseId));
}

async function authorize(request: NextRequest): Promise<string | null> {
  if (!isAuthConfigured()) return null;
  const claims = await readAuthFromRequest(request, "teacher");
  return claims?.role === "teacher" ? (claims.sub ?? "") : "";
}

function responseJob(job: Awaited<ReturnType<typeof prisma.courseGenerationJob.findUnique>>) {
  if (!job) return null;
  const persistedRequest = job.request as unknown as Partial<PersistedCourseGenerationRequest>;
  return {
    id: job.id,
    status: job.status,
    step: job.step,
    progress: job.progress,
    message: job.message,
    scenesGenerated: job.scenesGenerated,
    totalScenes: job.totalScenes,
    estimatedRemainingSeconds: job.estimatedRemainingSeconds,
    events: job.events,
    result: job.result,
    error: job.status === "failed" && job.error
      ? formatPersistedCourseGenerationErrorForTeacher(job.error)
      : null,
    startedAt: job.startedAt?.toISOString() ?? null,
    lastHeartbeatAt: job.lastHeartbeatAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    updatedAt: job.updatedAt.toISOString(),
    requestPreview: {
      courseTitle: persistedRequest.courseTitle,
      sceneOutlines: Array.isArray(persistedRequest.sceneOutlines)
        ? persistedRequest.sceneOutlines.map((scene) => ({
            id: scene.id,
            title: scene.title,
            type: scene.type,
            stageKey: scene.stageKey,
            stageLabel: scene.stageLabel,
            estimatedDuration: scene.estimatedDuration,
          }))
        : [],
      enableImageGeneration: persistedRequest.enableImageGeneration !== false,
      enableVideoGeneration: persistedRequest.enableVideoGeneration === true,
      enableTTS: persistedRequest.enableTTS !== false,
    },
  };
}

export async function GET(request: NextRequest, context: { params: Promise<{ courseId: string }> }) {
  const requestedBy = await authorize(request);
  if (requestedBy === "") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const backgroundEnabled = isBackgroundCourseGenerationEnabled();
  const { courseId } = await context.params;
  let job = await prisma.courseGenerationJob.findUnique({ where: { courseId } });
  if (job?.status === "failed") {
    job = await resumeRecoverableCourseGenerationJob(courseId);
  }
  return Response.json({ backgroundEnabled, job: responseJob(job) });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ courseId: string }> }) {
  const requestedBy = await authorize(request);
  if (requestedBy === "") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null) as { action?: unknown } | null;
  if (body?.action !== "start-persisted-job" && body?.action !== "resume-from-checkpoints") {
    return Response.json({ error: "INVALID_GENERATION_ACTION" }, { status: 400 });
  }
  const backgroundEnabled = isBackgroundCourseGenerationEnabled();
  const { courseId } = await context.params;
  if (body.action === "resume-from-checkpoints") {
    const resumed = await requeueCourseGenerationFromCheckpoints(courseId);
    if (!resumed) return Response.json({ error: "GENERATION_JOB_NOT_FOUND" }, { status: 404 });
    if (!backgroundEnabled) retainRequestBoundGeneration(courseId);
    return Response.json({ backgroundEnabled, job: responseJob(resumed) }, { status: 202 });
  }
  if (!backgroundEnabled) retainRequestBoundGeneration(courseId);
  const job = await prisma.courseGenerationJob.findUnique({ where: { courseId } });
  if (!job) return Response.json({ error: "GENERATION_JOB_NOT_FOUND" }, { status: 404 });
  return Response.json({ backgroundEnabled, job: responseJob(job) }, { status: 202 });
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ courseId: string }> }) {
  const requestedBy = await authorize(request);
  if (requestedBy === "") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { courseId } = await context.params;
  const job = await cancelCourseGeneration(courseId);
  if (!job) return Response.json({ error: "GENERATION_JOB_NOT_FOUND" }, { status: 404 });
  return Response.json({
    backgroundEnabled: isBackgroundCourseGenerationEnabled(),
    job: responseJob(job),
  });
}

export async function POST(request: NextRequest, context: { params: Promise<{ courseId: string }> }) {
  const requestedBy = await authorize(request);
  if (requestedBy === "") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const backgroundEnabled = isBackgroundCourseGenerationEnabled();
  if (!backgroundEnabled) return Response.json({ backgroundEnabled, job: null });

  const { courseId } = await context.params;
  const course = await prisma.course.findUnique({ where: { id: courseId }, select: { id: true } });
  if (!course) return Response.json({ error: "Course not found" }, { status: 404 });

  const body = await request.json() as PersistedCourseGenerationRequest;
  if (body.courseId !== courseId || typeof body.requirement !== "string" || !body.requirement.trim()) {
    return Response.json({ error: "Invalid generation request" }, { status: 400 });
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
  let job = await prisma.courseGenerationJob.findUnique({ where: { courseId } });

  if (!job) {
    try {
      job = await prisma.courseGenerationJob.create({
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
      job = await prisma.courseGenerationJob.findUnique({ where: { courseId } });
    }
  } else if (job.status === "failed") {
    // A newly submitted request must never reuse pages prepared for the old
    // request. Worker restarts keep checkpoints; explicit retries reset them.
    await resetCourseGenerationCheckpoints(job.id);
    job = await prisma.courseGenerationJob.update({
      where: { id: job.id },
      data: {
        status: "queued",
        step: "queued",
        progress: 0,
        message: "课程生成任务已重新提交",
        scenesGenerated: 0,
        totalScenes,
        estimatedRemainingSeconds: initialEstimate,
        request: requestJson,
        result: Prisma.JsonNull,
        events: [],
        error: null,
        startedAt: null,
        completedAt: null,
        lastHeartbeatAt: null,
        version: { increment: 1 },
      },
    });
  }

  return Response.json({ backgroundEnabled, job: responseJob(job) }, { status: 202 });
}
