import { z } from "zod";
import { authorizeTemplateRequest } from "@/lib/platform/template-access";
import { getPblTemplateVersionHistory, restorePblTemplateVersion } from "@/lib/platform/pbl-template-repository";
import { PlatformError } from "@/lib/platform/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ courseId: string }> };

const restoreSchema = z.object({
  sourceVersion: z.number().int().positive(),
  expectedCourseVersion: z.number().int().positive(),
}).strict();

function errorResponse(error: unknown): Response {
  if (error instanceof PlatformError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
  console.error("[course-versions] Request failed", error);
  return Response.json({ error: "课程版本暂时无法读取，请稍后重试" }, { status: 500 });
}

export async function GET(request: Request, context: Context) {
  const { courseId } = await context.params;
  const teacher = await authorizeTemplateRequest(request, courseId);
  if (teacher instanceof Response) return teacher;
  const value = new URL(request.url).searchParams.get("version");
  const selectedVersion = value === null ? undefined : Number(value);
  if (selectedVersion !== undefined && (!Number.isSafeInteger(selectedVersion) || selectedVersion < 1)) {
    return Response.json({ error: "版本号无效" }, { status: 400 });
  }
  try {
    return Response.json(await getPblTemplateVersionHistory(courseId, selectedVersion));
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request, context: Context) {
  const { courseId } = await context.params;
  const teacher = await authorizeTemplateRequest(request, courseId);
  if (teacher instanceof Response) return teacher;
  let body: unknown;
  try { body = await request.json(); }
  catch { return Response.json({ error: "请求内容不是有效 JSON" }, { status: 400 }); }
  const input = restoreSchema.safeParse(body);
  if (!input.success) return Response.json({ error: "请选择要恢复的版本并刷新当前课程" }, { status: 400 });
  try {
    return Response.json(await restorePblTemplateVersion(courseId, teacher, input.data.sourceVersion, input.data.expectedCourseVersion));
  } catch (error) { return errorResponse(error); }
}
