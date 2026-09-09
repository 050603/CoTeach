import { z } from "zod";
import { appendAiInteractionEvents, listAiInteractionEvents } from "@/lib/ai-collaboration/audit-store";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { authorizeLegacyAiScope, legacyAiError } from "@/lib/ai-collaboration/legacy-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  courseId: z.string().min(1).max(128),
  studentId: z.string().min(1).max(128).optional(),
  stageKey: z.string().min(1).max(64).default("make"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().max(512).optional(),
}).strict();

const EventSchema = z.object({
  courseId: z.string().min(1).max(128),
  studentId: z.string().min(1).max(128).optional(),
  stageKey: z.string().min(1).max(64),
  conversationId: z.string().max(160).optional(),
  source: z.enum(["sidebar", "selection", "proactive-comment", "submission", "system"]),
  eventType: z.enum(["request", "response", "policy", "proposal", "decision", "undo", "comment", "submit", "error"]),
  actorRole: z.literal("student"),
  content: z.string().max(12_000).optional(),
  payload: z.record(z.string(), z.unknown()).refine(value => JSON.stringify(value).length <= 32768).optional(),
  workspaceKind: z.enum(["document", "external-artifact"]).optional(),
  requestId: z.string().max(160).optional(),
}).strict();

export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;
  const parsed = QuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: "INVALID_REQUEST", message: "查询参数无效。" }, { status: 400 });
  const query = parsed.data;
  try { await authorizeLegacyAiScope(auth.claims, query.courseId, query.studentId); }
  catch (error) { return legacyAiError(error); }
  try {
  const result = await listAiInteractionEvents({
    courseId: query.courseId,
    studentId: auth.claims.role === "student" ? auth.claims.sub : query.studentId,
    stageKey: query.stageKey,
    limit: query.limit,
    cursor: query.cursor,
  });
  if (auth.claims.role === "student") result.events = result.events.filter(event => event.payload?.visibility !== "teacher-only");
  return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return legacyAiError(error); }
}

export async function POST(request: Request) {
  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;
  const auth = await authenticateRequest(request, "student");
  if ("response" in auth) return auth.response;
  if (auth.claims.role !== "student") return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  const parsed = EventSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "INVALID_REQUEST", message: "事件参数无效。" }, { status: 400 });
  const event = parsed.data;
  try { await authorizeLegacyAiScope(auth.claims, event.courseId, event.studentId, true); }
  catch (error) { return legacyAiError(error); }
  const { workspaceKind, ...eventData } = event;
  try {
  const [created] = await appendAiInteractionEvents([{
    ...eventData,
    studentId: auth.claims.sub!,
    actorId: auth.claims.sub!,
    payload: { ...(event.payload ?? {}), workspaceKind: workspaceKind ?? "document" },
    requestId: event.requestId ?? request.headers.get("x-request-id") ?? undefined,
  }]);
  return Response.json({ ok: true, event: created });
  } catch (error) { return legacyAiError(error); }
}
