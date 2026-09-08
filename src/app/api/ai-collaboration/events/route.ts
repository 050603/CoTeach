// @ts-nocheck
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { appendAiInteractionEvents, listAiInteractionEvents } from "@/lib/ai-collaboration/audit-store";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { canAccessLegacyCourse } from "@/lib/platform/access";

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
  payload: z.record(z.string(), z.unknown()).optional(),
  workspaceKind: z.enum(["document", "external-artifact"]).optional(),
  requestId: z.string().max(160).optional(),
}).strict();

export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;
  const parsed = QuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: "INVALID_REQUEST", message: "查询参数无效。" }, { status: 400 });
  const query = parsed.data;
  if (auth.claims.role === "student" && auth.claims.courseId !== query.courseId) {
    return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  }
  if (!(await canAccessLegacyCourse(auth.claims, query.courseId, "read"))) {
    return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  }
  const result = await listAiInteractionEvents({
    courseId: query.courseId,
    studentId: auth.claims.role === "student" ? auth.claims.studentId : query.studentId,
    stageKey: query.stageKey,
    limit: query.limit,
    cursor: query.cursor,
  });
  return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
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
  if (event.courseId !== auth.claims.courseId || (event.studentId && event.studentId !== auth.claims.studentId)) {
    return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  }
  if (!(await canAccessLegacyCourse(auth.claims, event.courseId, "write"))) {
    return Response.json({ error: "COURSE_LOCKED" }, { status: 403 });
  }
  const { workspaceKind, ...eventData } = event;
  const [created] = await appendAiInteractionEvents([{
    ...eventData,
    studentId: auth.claims.studentId,
    actorId: auth.claims.studentId,
    payload: { ...(event.payload ?? {}), workspaceKind: workspaceKind ?? "document" },
    id: randomUUID(),
    requestId: event.requestId ?? request.headers.get("x-request-id") ?? undefined,
  }]);
  return Response.json({ ok: true, event: created });
}
