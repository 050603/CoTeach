import { after } from "next/server";
import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { textbookApiError } from "@/lib/textbook/http";
import { retryTextbookIngest } from "@/lib/textbook/service";
import { runTextbookIngestJob } from "@/lib/textbook/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1_800;
const ParamsSchema = z.object({ id: z.string().uuid() });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  const params = ParamsSchema.safeParse(await context.params);
  if (!params.success) return new Response(null, { status: 404 });
  try {
    const result = await retryTextbookIngest(params.data.id, auth.claims.sub!);
    after(() => runTextbookIngestJob(result.revisionId));
    return Response.json({ job: result.job }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return textbookApiError(request, error, "TEXTBOOK_RETRY_FAILED", "暂时无法重试教材解析。 ");
  }
}
