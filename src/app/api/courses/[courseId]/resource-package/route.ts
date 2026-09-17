import { after } from "next/server";
import { z } from "zod";
import { authorizeTemplateRequest } from "@/lib/platform/template-access";
import { resourcePackageJobs } from "@/lib/course-generation/job-storage";
import { isBackgroundCourseGenerationEnabled } from "@/lib/course-generation/capability";
import { runResourcePackageJob, startResourcePackageWorker } from "@/lib/resource-package/job-runner";
import { resourcePackageDraftSchema, resourcePackageSelectionsSchema } from "@/lib/resource-package/parser";
import { authorizeResourcePackageAdaptation, confirmResourcePackage, loadResourcePackageJob, packageResult, resourcePackageSnapshot, ResourcePackageError, retryResourcePackage, submitResourcePackage } from "@/lib/resource-package/server";
import { resourcePackageFeedback } from "@/lib/resource-package/compatibility";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ courseId: string }> };
const postSchema = z.object({ uploadId: z.string().uuid(), selections: resourcePackageSelectionsSchema.optional() }).strict();
const patchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm"), revision: z.number().int().positive(), draft: resourcePackageDraftSchema,
    acknowledgement: z.object({ issueVersion: z.string().min(1).max(100), issueIds: z.array(z.string().min(1).max(200)).max(100) }).optional() }).strict(),
  z.object({ action: z.literal("retry"), selections: resourcePackageSelectionsSchema.optional() }).strict(),
  z.object({ action: z.literal("adapt"), revision: z.number().int().positive(), conflictVersion: z.string().min(1).max(100), draft: resourcePackageDraftSchema }).strict(),
]);
async function guarded(request: Request, context: Context, work: (courseId: string, userId: string) => Promise<Response>): Promise<Response> {
  const { courseId } = await context.params;
  const userId = await authorizeTemplateRequest(request, courseId);
  if (userId instanceof Response) return userId;
  try { return await work(courseId, userId); }
  catch (error) {
    if (error instanceof ResourcePackageError) return Response.json({ error: error.code, code: error.code, message: error.message }, { status: error.status });
    if (error instanceof Error && error.message === "GENERATION_JOB_NOT_FOUND") return Response.json({ error: "RESOURCE_PACKAGE_REVISION_CONFLICT", message: "资源包状态已更新，请刷新后重试。" }, { status: 409 });
    console.error("[resource-package] Request failed", { operation: request.method });
    return Response.json({ error: "RESOURCE_PACKAGE_UNAVAILABLE", message: "资源包服务暂时不可用，请稍后重试。" }, { status: 503 });
  }
}
async function dispatch(jobId: string) {
  if (isBackgroundCourseGenerationEnabled()) await startResourcePackageWorker();
  else after(() => runResourcePackageJob(jobId));
}
export async function GET(request: Request, context: Context) {
  return guarded(request, context, async (courseId) => {
    let job = await loadResourcePackageJob(courseId);
    if (new URL(request.url).searchParams.get("download") === "feedback") {
      const pack = job ? packageResult(job).package : null;
      if (!pack) throw new ResourcePackageError("暂无资源包反馈。", "RESOURCE_PACKAGE_NOT_FOUND", 404);
      return new Response(resourcePackageFeedback(pack), { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": "attachment; filename=resource-package-feedback.md" } });
    }
    if (job?.status === "running" && (!job.lastHeartbeatAt || job.lastHeartbeatAt.getTime() < Date.now() - 120000)) {
      await resourcePackageJobs.updateMany({ where: { id: job.id, status: "running", OR: [{ lastHeartbeatAt: null }, { lastHeartbeatAt: { lt: new Date(Date.now() - 120000) } }] }, data: { status: "queued", message: "服务恢复后继续处理资源包" } });
      job = await resourcePackageJobs.findUnique({ where: { courseId } });
    }
    if (job?.status === "queued") await dispatch(job.id);
    return Response.json({ job: resourcePackageSnapshot(job) });
  });
}
export async function POST(request: Request, context: Context) {
  return guarded(request, context, async (courseId, userId) => {
    const parsed = postSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ResourcePackageError("请提供有效的资源包文件及候选选择。");
    const job = await submitResourcePackage(courseId, userId, parsed.data.uploadId, parsed.data.selections);
    await dispatch(job.id);
    return Response.json({ job: resourcePackageSnapshot(job) }, { status: 202 });
  });
}
export async function PATCH(request: Request, context: Context) {
  return guarded(request, context, async (courseId, userId) => {
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ResourcePackageError("资源包编辑信息格式无效，请检查后重试。");
    const input = parsed.data;
    const job = input.action === "confirm" ? await confirmResourcePackage(courseId, userId, input.revision, input.draft, input.acknowledgement)
      : input.action === "adapt" ? await authorizeResourcePackageAdaptation(courseId, userId, input.revision, input.conflictVersion, input.draft)
      : await retryResourcePackage(courseId, userId, input.selections);
    if (job.status === "queued") await dispatch(job.id);
    return Response.json({ job: resourcePackageSnapshot(job) });
  });
}
