import { authenticateRequest } from "@/lib/auth/request-guards";
import { listStudentOfferings, PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await authenticateRequest(request, "student");
  if ("response" in auth) return auth.response;
  try {
    return Response.json(
      {
        courses: await listStudentOfferings(auth.claims),
        viewer: { id: auth.claims.sub, displayName: auth.claims.studentName },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "COURSES_UNAVAILABLE", "无法加载课程", 503);
  }
}
