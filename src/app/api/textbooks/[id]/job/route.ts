import { z } from "zod";
import { authenticateRequest } from "@/lib/auth/request-guards";
import { textbookApiError } from "@/lib/textbook/http";
import { getTextbookJob } from "@/lib/textbook/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const ParamsSchema = z.object({ id: z.string().uuid() });

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  const params = ParamsSchema.safeParse(await context.params);
  if (!params.success) return new Response(null, { status: 404 });
  try {
    return Response.json({ job: await getTextbookJob(params.data.id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return textbookApiError(request, error, "TEXTBOOK_JOB_FAILED", "暂时无法读取教材任务。 ");
  }
}
