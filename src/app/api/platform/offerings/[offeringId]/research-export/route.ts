import { authenticateRequest } from "@/lib/auth/request-guards";
import { jsonError } from "@/lib/platform/http";
import { exportOfferingResearch } from "@/lib/platform/research-export";
import { PlatformError } from "@/lib/platform/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function noStore(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function GET(request: Request, context: { params: Promise<{ offeringId: string }> }) {
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return noStore(auth.response);
  const { offeringId } = await context.params;
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some((key) => params.getAll(key).length !== 1)) {
      return noStore(jsonError(request, "INVALID_INPUT", "导出参数不可重复", 400));
    }
    const result = await exportOfferingResearch(auth.claims, offeringId, Object.fromEntries(params));
    return noStore(Response.json(result));
  } catch (error) {
    if (error instanceof PlatformError) return noStore(jsonError(request, error.code, error.message, error.status));
    return noStore(jsonError(request, "RESEARCH_EXPORT_FAILED", "无法导出研究数据", 503));
  }
}
