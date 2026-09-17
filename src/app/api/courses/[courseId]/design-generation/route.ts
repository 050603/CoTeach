import { Prisma } from "@prisma/client";
import { after, type NextRequest } from "next/server";
import { designGenerationJobs, resourcePackageJobs } from "@/lib/course-generation/job-storage";
import { isBackgroundCourseGenerationEnabled } from "@/lib/course-generation/capability";
import {
  cancelCourseDesignJob,
  pauseCourseDesignForOutlineReview,
  resumeCourseDesignAfterOutlineReview,
  runCourseDesignJob,
  resumeRecoverableCourseDesignJob,
  initialQuickGenerationEstimateSeconds,
  type QuickDesignRequest,
} from "@/lib/course-design/job-runner";
import { authorizeTemplateRequest } from "@/lib/platform/template-access";
import { loadPblTemplateCourse } from "@/lib/platform/pbl-template-repository";
import { isSameCourseDesignRequest } from "@/lib/course-design/resume-policy";
import { formatFatalCourseDesignError } from "@/lib/course-design/failure-policy";
import type {
  KnowledgeGraph,
  KnowledgePoint,
  LessonOutlineSection,
  OpenMaicSceneOutlineSnapshot,
} from "@/lib/session/types";
import { getCourse } from "@/lib/session/server-store";
import { getOpenPblSystemMode } from "@/lib/system-mode";
import {
  GenerationReferenceError,
  resolveGenerationReferenceMaterials,
} from "@/lib/course-design/generation-references";
import {
  assertRequestedClassroomMediaProviders,
  classroomMediaConfigurationErrorResponse,
} from "@openmaic/lib/server/classroom-media-readiness";
import { ResourcePackageError, resolveConfirmedResourcePackage } from "@/lib/resource-package/server";
import { findServerDefaultModelString } from "@/lib/openmaic/server/provider-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


function responseJob(job: Awaited<ReturnType<typeof designGenerationJobs.findUnique>>) {
  if (!job) return null;
  const request = job.request as unknown as Partial<QuickDesignRequest>;
  const packageDocumentIds = new Set(Object.values(request.resourcePackage?.documents ?? {}).map((document) => document.id));
  return {
    id: job.id,
    status: job.status,
    step: job.step,
    reviewStatus: job.reviewStatus,
    reviewKind: job.step === "knowledgeReview"
      ? "knowledge"
      : job.step === "outlineReview" || job.step === "lessonOutline"
        ? "outline"
        : null,
    reviewAvailableUntil: job.reviewAvailableUntil?.toISOString() ?? null,
    stepIndex: job.stepIndex,
    progress: job.progress,
    message: job.message,
    estimatedRemainingSeconds: job.estimatedRemainingSeconds,
    tokenUsage: {
      totalTokens: job.tokenUsage,
      calls: job.tokenUsageCalls,
      approximate: true,
    },
    currentCall: job.currentCall,
    trace: job.trace,
    qualityReport: job.qualityReport,
    // Never expose model review diagnostics or historical raw worker errors to
    // teachers. Correctable failures are resumed by GET; terminal failures use
    // a safe, actionable system-level message only.
    error: job.status === "failed" && job.error
      ? formatFatalCourseDesignError(new Error(job.error))
      : null,
    startedAt: job.startedAt?.toISOString() ?? null,
    lastHeartbeatAt: job.lastHeartbeatAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    updatedAt: job.updatedAt.toISOString(),
    requestPreview: {
      teacherBrief: typeof request.teacherBrief === "string" ? request.teacherBrief : "",
      resourcePackage: request.resourcePackage ?? null,
      resourcePackageId: request.resourcePackage?.id,
      resourcePackageRevision: request.resourcePackage?.revision,
      supplementalAnswers: request.supplementalAnswers ?? null,
      generationMode: request.generationMode === "deep-interaction"
        ? "deep-interaction"
        : "standard",
      assessmentMode: request.assessmentMode === "adaptive"
        ? "adaptive"
        : "constructed-response",
      options: request.options ?? null,
      referenceMaterials: (request.referenceMaterials ?? []).filter((material) => ![...packageDocumentIds].some((id) => material.id === id || material.id.startsWith(`${id}:part-`))).map((material) => ({
        id: material.id,
        fileName: material.fileName,
        mimeType: material.mimeType,
      })),
    },
  };
}

function persistedJobMode(
  job: NonNullable<Awaited<ReturnType<typeof designGenerationJobs.findUnique>>>,
): "new" {
  void job;
  return "new";
}

async function structuredResponse(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    const migrationMissing = error instanceof Prisma.PrismaClientKnownRequestError
      && (error.code === "P2021" || error.code === "P2022");
    return Response.json({
      error: migrationMissing ? "FAST_GENERATION_MIGRATION_REQUIRED" : "FAST_GENERATION_UNAVAILABLE",
      detail: migrationMissing
        ? "快速生成所需的数据库迁移尚未应用，请先执行 prisma migrate deploy 后重试。"
        : "快速生成服务暂时不可用，请稍后重试。",
    }, { status: 503 });
  }
}

export async function GET(request: NextRequest, context: { params: Promise<{ courseId: string }> }) {
  return structuredResponse(async () => {
    const { courseId } = await context.params;
  const requestedBy = await authorizeTemplateRequest(request, courseId);
    if (requestedBy instanceof Response) return requestedBy;
    let job = await designGenerationJobs.findUnique({ where: { courseId } });
    const systemMode = getOpenPblSystemMode();
    if (job && persistedJobMode(job) !== systemMode) {
      return Response.json({
        backgroundEnabled: isBackgroundCourseGenerationEnabled(),
        job: null,
        outlinePreview: [],
      });
    }
    if (job?.status === "failed") {
      job = await resumeRecoverableCourseDesignJob(courseId);
    }
    const course = job && ["review_available", "paused"].includes(job.status)
      ? await getCourse(courseId)
      : null;
    return Response.json({
      backgroundEnabled: isBackgroundCourseGenerationEnabled(),
      job: responseJob(job),
      knowledgePreview: course
        ? {
            knowledgePoints: course.content.knowledgePoints,
            knowledgeGraph: course.content.knowledgeGraph ?? { nodes: [], edges: [] },
          }
        : null,
      outlinePreview: course?.content._openmaicSceneOutlines ?? [],
    });
  });
}

export async function POST(request: NextRequest, context: { params: Promise<{ courseId: string }> }) {
  return structuredResponse(async () => {
    const { courseId } = await context.params;
  const requestedBy = await authorizeTemplateRequest(request, courseId);
    if (requestedBy instanceof Response) return requestedBy;
    const course = await loadPblTemplateCourse(courseId);
    if (!course) return Response.json({ error: "Course not found" }, { status: 404 });
    const body = await request.json().catch(() => null) as {
      teacherBrief?: unknown;
      supplementalAnswers?: unknown;
      resourcePackageId?: unknown;
      resourcePackageRevision?: unknown;
      generationMode?: unknown;
      assessmentMode?: unknown;
      options?: Partial<NonNullable<QuickDesignRequest["options"]>>;
      referenceIds?: unknown;
    } | null;
    const answers = body?.supplementalAnswers && typeof body.supplementalAnswers === "object"
      ? body.supplementalAnswers as Record<string, unknown> : {};
    const supplementalBrief = typeof answers.brief === "string" ? answers.brief.trim().slice(0, 4_000) : "";
    const teacherBrief = typeof body?.teacherBrief === "string" ? body.teacherBrief.trim().slice(0, 4_000) : supplementalBrief;
    if (body?.assessmentMode !== undefined
      && body.assessmentMode !== "adaptive"
      && body.assessmentMode !== "constructed-response") {
      return Response.json({ error: "INVALID_ASSESSMENT_MODE", detail: "小节测验模式无效，请刷新页面后重试。" }, { status: 400 });
    }
    let job = await designGenerationJobs.findUnique({ where: { courseId } });
    const previousRequest = job?.request as unknown as QuickDesignRequest | undefined;
    const hasPackageIdentifier = body?.resourcePackageId !== undefined || body?.resourcePackageRevision !== undefined;
    const hasStartedPackageImport = !hasPackageIdentifier && Boolean(await resourcePackageJobs.findUnique({ where: { courseId } }));
    if (!hasPackageIdentifier && (!previousRequest || previousRequest.resourcePackage || course.content?.resourcePackage || hasStartedPackageImport)) {
      return Response.json({ error: "RESOURCE_PACKAGE_REQUIRED", detail: "请先上传资源包、补充关键问题并确认教案，再开始生成课堂。" }, { status: 400 });
    }
    const referenceIds = Array.isArray(body?.referenceIds)
      ? body.referenceIds.filter((id): id is string => typeof id === "string").slice(0, 4)
      : [];
    let referenceMaterials: QuickDesignRequest["referenceMaterials"] = [];
    let resourcePackage: QuickDesignRequest["resourcePackage"];
    try {
      const extraReferences = await resolveGenerationReferenceMaterials({
        courseId,
        uploadIds: referenceIds,
        uploadedById: requestedBy || null,
      });
      referenceMaterials = extraReferences;
      if (hasPackageIdentifier) {
        if (typeof body?.resourcePackageId !== "string" || !body.resourcePackageId.trim()
          || typeof body.resourcePackageRevision !== "number" || !Number.isInteger(body.resourcePackageRevision) || body.resourcePackageRevision < 1) {
          return Response.json({ error: "INVALID_RESOURCE_PACKAGE", detail: "资源包标识或版本无效，请重新确认资源包。" }, { status: 400 });
        }
        const confirmed = await resolveConfirmedResourcePackage(courseId, body.resourcePackageId, body.resourcePackageRevision, requestedBy);
        resourcePackage = confirmed.resourcePackage;
        referenceMaterials = [...confirmed.referenceMaterials, ...extraReferences];
      }
    } catch (error) {
      if (error instanceof GenerationReferenceError || error instanceof ResourcePackageError) {
        return Response.json({ error: error.code, detail: error.message }, { status: error.status });
      }
      throw error;
    }
    const quickRequest: QuickDesignRequest = {
      courseId,
      generationModelString: findServerDefaultModelString(),
      systemMode: getOpenPblSystemMode(),
      teacherBrief,
      ...(resourcePackage ? { resourcePackage, supplementalAnswers: { brief: supplementalBrief || teacherBrief } } : {}),
      referenceMaterials,
      generationMode: body?.generationMode === "deep-interaction"
        ? "deep-interaction"
        : "standard",
      ...(resourcePackage
        ? {
            generationContractVersion: 2 as const,
            assessmentMode: body?.assessmentMode === "constructed-response"
              ? "constructed-response" as const
              : "adaptive" as const,
          }
        : {
            ...(previousRequest?.generationContractVersion
              ? { generationContractVersion: previousRequest.generationContractVersion }
              : {}),
            ...(previousRequest?.assessmentMode
              ? { assessmentMode: previousRequest.assessmentMode }
              : {}),
          }),
      options: {
        enableImageGeneration: body?.options?.enableImageGeneration !== false,
        enableTTS: body?.options?.enableTTS !== false,
        enableVideoGeneration: body?.options?.enableVideoGeneration === true,
      },
    };
    if (!resourcePackage && !isSameCourseDesignRequest(previousRequest, quickRequest)) {
      return Response.json({ error: "RESOURCE_PACKAGE_REQUIRED", detail: "历史无资源包任务仅支持按原参数恢复；新建或修改生成要求请先上传资源包。" }, { status: 400 });
    }
    if (job && ["queued", "running", "review_available", "paused", "cancelling"].includes(job.status)
      && !isSameCourseDesignRequest(job.request, quickRequest)) {
      return Response.json({ error: "GENERATION_REQUEST_CONFLICT", detail: "当前生成仍在使用已提交的资源包，请先中断当前任务后再应用新包或新要求。" }, { status: 409 });
    }
    try {
      assertRequestedClassroomMediaProviders(quickRequest.options ?? {});
    } catch (error) {
      const configurationError = classroomMediaConfigurationErrorResponse(error);
      if (!configurationError) throw error;
      return Response.json({
        error: configurationError.code,
        detail: configurationError.message,
      }, { status: 409 });
    }
    const requestJson = quickRequest as unknown as Prisma.InputJsonValue;
    const estimate = initialQuickGenerationEstimateSeconds(
      quickRequest.options,
      quickRequest.systemMode,
    );
    if (
      job
      && persistedJobMode(job) !== quickRequest.systemMode
      && ["queued", "running", "review_available", "paused", "cancelling"].includes(job.status)
    ) {
      return Response.json({
        error: "OTHER_SYSTEM_GENERATION_RUNNING",
        detail: "该课程正在由另一套启动模式生成，请等待当前任务结束后再切换生成。",
      }, { status: 409 });
    }

    if (!job) {
      job = await designGenerationJobs.create({
        data: { courseId, requestedBy: requestedBy || null, request: requestJson, estimatedRemainingSeconds: estimate },
      });
    } else if (
      job.status === "failed"
      || job.status === "cancelled"
      || (job.status === "completed" && !isSameCourseDesignRequest(job.request, quickRequest))
    ) {
      const preserveValidatedStages = isSameCourseDesignRequest(job.request, quickRequest);
      job = await designGenerationJobs.update({
        where: { id: job.id },
        data: {
          status: "queued",
          step: "queued",
          reviewStatus: "unavailable",
          reviewAvailableUntil: null,
          stepIndex: 0,
          progress: 0,
          message: "快速生成任务已重新提交",
          currentCall: null,
          estimatedRemainingSeconds: estimate,
          tokenUsage: preserveValidatedStages ? job.tokenUsage : 0,
          tokenUsageCalls: preserveValidatedStages ? job.tokenUsageCalls : 0,
          request: requestJson,
          trace: preserveValidatedStages
            ? job.trace as Prisma.InputJsonValue
            : [],
          qualityReport: Prisma.JsonNull,
          error: null,
          startedAt: null,
          completedAt: null,
          lastHeartbeatAt: null,
          retryAt: null,
          version: { increment: 1 },
        },
      });
    }

    const backgroundEnabled = isBackgroundCourseGenerationEnabled();
    if (!backgroundEnabled && job.status === "queued") {
      const startedAt = new Date();
      const claimed = await designGenerationJobs.update({
        where: { id: job.id },
        data: {
          status: "running",
          step: "base",
          message: "正在分析课程信息",
          startedAt,
          lastHeartbeatAt: startedAt,
          attempt: { increment: 1 },
          version: { increment: 1 },
        },
      });
      job = claimed;
      after(() => runCourseDesignJob(claimed));
    }

    return Response.json({ backgroundEnabled, job: responseJob(job) }, { status: 202 });
  });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ courseId: string }> }) {
  return structuredResponse(async () => {
    const { courseId } = await context.params;
  const requestedBy = await authorizeTemplateRequest(request, courseId);
    if (requestedBy instanceof Response) return requestedBy;
    const body = await request.json().catch(() => null) as {
      action?: unknown;
      reviewKind?: unknown;
      knowledgePoints?: unknown;
      knowledgeGraph?: unknown;
      lessonOutline?: unknown;
      sceneOutlines?: unknown;
    } | null;
    if (body?.action !== "pause" && body?.action !== "resume") {
      return Response.json({ error: "INVALID_REVIEW_ACTION" }, { status: 400 });
    }

    let job = body.action === "pause"
      ? await pauseCourseDesignForOutlineReview(courseId)
      : await resumeCourseDesignAfterOutlineReview(courseId, {
          reviewKind: body.reviewKind === "knowledge" ? "knowledge" : "outline",
          knowledgePoints: Array.isArray(body.knowledgePoints)
            ? body.knowledgePoints.slice(0, 120) as KnowledgePoint[]
            : undefined,
          knowledgeGraph: body.knowledgeGraph && typeof body.knowledgeGraph === "object"
            ? body.knowledgeGraph as KnowledgeGraph
            : undefined,
          lessonOutline: Array.isArray(body.lessonOutline)
            ? body.lessonOutline.slice(0, 240) as LessonOutlineSection[]
            : undefined,
          sceneOutlines: Array.isArray(body.sceneOutlines)
            ? body.sceneOutlines.slice(0, 240) as OpenMaicSceneOutlineSnapshot[]
            : undefined,
        });
    if (!job) return Response.json({ error: "FAST_GENERATION_NOT_FOUND" }, { status: 404 });

    const backgroundEnabled = isBackgroundCourseGenerationEnabled();
    if (body.action === "resume" && !backgroundEnabled && job.status === "queued") {
      const startedAt = new Date();
      job = await designGenerationJobs.update({
        where: { id: job.id },
        data: {
          status: "running",
          message: "正在按教师确认的大纲继续生成",
          startedAt: job.startedAt ?? startedAt,
          lastHeartbeatAt: startedAt,
          attempt: { increment: 1 },
          version: { increment: 1 },
        },
      });
      const retainedJob = job;
      after(() => runCourseDesignJob(retainedJob));
    }

    const course = ["review_available", "paused"].includes(job.status)
      ? await getCourse(courseId)
      : null;
    return Response.json({
      backgroundEnabled,
      job: responseJob(job),
      knowledgePreview: course
        ? {
            knowledgePoints: course.content.knowledgePoints,
            knowledgeGraph: course.content.knowledgeGraph ?? { nodes: [], edges: [] },
          }
        : null,
      outlinePreview: course?.content._openmaicSceneOutlines ?? [],
    });
  });
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ courseId: string }> }) {
  return structuredResponse(async () => {
    const { courseId } = await context.params;
  const requestedBy = await authorizeTemplateRequest(request, courseId);
    if (requestedBy instanceof Response) return requestedBy;
    const job = await cancelCourseDesignJob(courseId);
    return Response.json({
      backgroundEnabled: isBackgroundCourseGenerationEnabled(),
      job: responseJob(job),
    });
  });
}
