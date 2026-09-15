import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { canAccessLegacyCourse } from "@/lib/platform/access";
import { getServerASRProviders } from "@openmaic/lib/server/provider-config";
import { getPublicDiscussionSettings, savePublicDiscussionSettings } from "@/lib/public-discussion/settings";
import { isPublicDiscussionEnabled } from "@/lib/public-discussion/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ courseId: string }> }) {
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  if (!isPublicDiscussionEnabled()) return new Response(null, { status: 404 });
  const { courseId } = await context.params;
  if (!(await canAccessLegacyCourse(auth.claims, courseId, "read"))) return new Response(null, { status: 403 });
  return Response.json({ settings: await getPublicDiscussionSettings(), asrProviders: getServerASRProviders() });
}
export async function PUT(request: Request, context: { params: Promise<{ courseId: string }> }) {
  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  if (!isPublicDiscussionEnabled()) return new Response(null, { status: 404 });
  const { courseId } = await context.params;
  if (!(await canAccessLegacyCourse(auth.claims, courseId, "read"))) return new Response(null, { status: 403 });
  return Response.json({ settings: await savePublicDiscussionSettings(await request.json().catch(() => null)) });
}
