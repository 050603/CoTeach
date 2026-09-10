import { authenticateRequest } from "@/lib/auth/request-guards";
import { listOfferingStudents, PlatformError } from "@/lib/platform/repository";
import { getOfferingStudentsSummary } from "@/lib/platform/student-records";
import { jsonError } from "@/lib/platform/http";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ offeringId: string }> }) {
  const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  try {
    const offeringId = (await context.params).offeringId;
    const data = new URL(request.url).searchParams.get("view") === "summary"
      ? await getOfferingStudentsSummary(auth.claims, offeringId)
      : { students: await listOfferingStudents(auth.claims, offeringId) };
    return Response.json(data, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "STUDENTS_UNAVAILABLE", "无法加载学生名单", 503);
  }
}
