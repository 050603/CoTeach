import { authenticateRequest } from "@/lib/auth/request-guards";
import { listClassroomParticipants } from "@/lib/platform/classroom";
import { PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ instanceId: string }> }) {
  const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  try { return Response.json(await listClassroomParticipants(auth.claims, (await context.params).instanceId), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    return jsonError(request, "CLASSROOM_FAILED", "无法读取课堂", 503);
  }
}
