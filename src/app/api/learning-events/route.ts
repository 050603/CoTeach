import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { legacyAiError } from "@/lib/ai-collaboration/legacy-scope";
import { ingestClassroomLearningEvents } from "@/lib/learning-analytics/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const auth = await authenticateRequest(request, "student");
  if ("response" in auth) return auth.response;
  let body: unknown;
  try { body = await request.json(); }
  catch { return Response.json({ error: "INVALID_JSON" }, { status: 400 }); }
  try { return Response.json(await ingestClassroomLearningEvents(auth.claims, body)); }
  catch (error) { return legacyAiError(error); }
}
