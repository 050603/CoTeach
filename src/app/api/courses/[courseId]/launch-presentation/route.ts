import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { authorizeTemplateRequest } from "@/lib/platform/template-access";
import { updateCourse } from "@/lib/session/server-store";
import { PlatformError } from "@/lib/platform/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  uploadId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
}).strict();

class LaunchPresentationError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await context.params;
  const teacherId = await authorizeTemplateRequest(request, courseId);
  if (teacherId instanceof Response) return teacherId;
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ code: "INVALID_INPUT", message: "替换请求无效。" }, { status: 400 });

  const file = await prisma.fileAsset.findFirst({
    where: { id: parsed.data.uploadId, uploadedById: teacherId, offeringId: null, deletedAt: null },
    select: { id: true, originalName: true, size: true, mimeType: true, sha256: true, regenerationRecipe: true },
  });
  const provenance = file?.regenerationRecipe;
  if (!file || file.mimeType !== "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    || !provenance || typeof provenance !== "object" || Array.isArray(provenance)
    || provenance.operation !== "launch-presentation-replacement" || provenance.courseId !== courseId) {
    return Response.json({ code: "INVALID_UPLOAD", message: "请重新上传本课程的 PPTX 课件。" }, { status: 422 });
  }
  const preview = await prisma.fileAsset.findFirst({
    where: { sourceAssetId: file.id, uploadedById: teacherId, offeringId: null, deletedAt: null,
      storageKey: `${file.id}.classroom.pdf`, mimeType: "application/pdf", assetRole: "CLASSROOM_PREVIEW" },
    select: { id: true },
  });
  if (!preview) return Response.json({ code: "PREVIEW_MISSING", message: "PPT 课堂版尚未生成，请重新上传。" }, { status: 422 });

  try {
    const state = await updateCourse(courseId, (course) => {
      if (course.version !== parsed.data.expectedVersion) {
        throw new LaunchPresentationError("课程已在其他页面更新，请刷新后重新上传。", "VERSION_CONFLICT", 409);
      }
      const previousId = course.content.resourcePackage?.launchResourceId
        ?? course.resources?.find((resource) => resource.stageKey === "launch" && resource.type.toUpperCase() === "PPTX")?.id;
      const document = { id: file.id, fileName: file.originalName, url: `/api/uploads/${file.id}`,
        sha256: file.sha256 ?? undefined, format: "pptx" as const };
      const resourcePackage = course.content.resourcePackage;
      return {
        ...course,
        status: "preparing",
        resources: [
          ...(course.resources ?? []).filter((resource) => resource.id !== previousId && resource.id !== file.id),
          { id: file.id, title: file.originalName.replace(/\.pptx$/i, ""), type: "PPTX",
            size: `${(Number(file.size) / 1024 / 1024).toFixed(1)} MB`,
            url: document.url, previewUrl: `/api/uploads/${file.id}?variant=classroom`,
            previewType: "PDF", displayMode: "slides" as const, stageKey: "launch", downloadedBy: [] },
        ],
        content: {
          ...course.content,
          teacherReview: undefined,
          renderReview: undefined,
          qualityReview: undefined,
          ...(resourcePackage ? { resourcePackage: {
            ...resourcePackage,
            revision: resourcePackage.revision + 1,
            documents: { ...resourcePackage.documents, launchPresentation: document },
            classroomPresentation: document,
            launchResourceId: file.id,
            adaptation: undefined,
          } } : {}),
        },
      };
    }, { actor: { id: teacherId, role: "teacher" } });
    const course = state.courses.find((item) => item.id === courseId);
    return Response.json({ course }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof LaunchPresentationError) return Response.json({ code: error.code, message: error.message }, { status: error.status });
    if (error instanceof PlatformError) return Response.json({ code: error.code, message: error.message }, { status: error.status });
    console.error("[launch-presentation] replacement failed", error instanceof Error ? error.message : "unknown");
    return Response.json({ code: "REPLACEMENT_FAILED", message: "替换课件失败，请重试。" }, { status: 503 });
  }
}
