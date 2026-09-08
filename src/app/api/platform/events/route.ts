import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { appendLearningEvents, PlatformError } from "@/lib/platform/repository";
import { jsonError } from "@/lib/platform/http";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
const eventSchema = z.object({ idempotencyKey: z.string().trim().min(1).max(200), type: z.string().trim().min(1).max(120), occurredAt: z.string().datetime().optional(), offeringId: z.string().optional(), activityId: z.string().optional(), chapterId: z.string().optional(), classroomInstanceId: z.string().optional(), metadata: z.unknown().optional(), source: z.string().max(80).optional() });
const schema = z.object({ events: z.array(eventSchema).min(1).max(100) });
export async function POST(request: Request) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf; const auth = await authenticateRequest(request, "student"); if ("response" in auth) return auth.response;
  const parsed = schema.safeParse(await request.json().catch(() => null)); if (!parsed.success) return jsonError(request, "INVALID_INPUT", "学习事件格式无效", 400);
  try { return Response.json({ acceptedIds: await appendLearningEvents(auth.claims, parsed.data.events) }); } catch (error) { if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status); return jsonError(request, "EVENT_WRITE_FAILED", "无法保存学习事件", 503); }
}
