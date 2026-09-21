import { after, type NextRequest } from "next/server";
import { authorizeTemplateRequest } from "@/lib/platform/template-access";
import { getCourse } from "@/lib/session/server-store";
import { auditCourseGeneratedResources } from "@/lib/course-generation/resource-audit-server";
import {
  getCourseResourceRepairStatus,
  startCourseResourceRepair,
} from "@/lib/course-generation/resource-repair-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1_800;


export async function GET(
  request: NextRequest,
  context: { params: Promise<{ courseId: string }> },
) {
  const { courseId } = await context.params;
  const auth = await authorizeTemplateRequest(request, courseId);
  if (auth instanceof Response) return auth;
  return Response.json({
    ...await auditCourseGeneratedResources(courseId),
    repair: getCourseResourceRepairStatus(courseId),
  });
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
  const job = startCourseResourceRepair(
    courseId,
    process.env.PUBLIC_BASE_URL || new URL(request.url).origin,
  );
  after(() => job.completion);
  return Response.json({
    ...await auditCourseGeneratedResources(courseId),
    repair: job.status,
  }, { status: 202 });
}
