import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { checkDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";
import { rateLimitedResponse } from "@/lib/auth/rate-limit";
import { isDatabaseConfigured } from "@/lib/db/client";
import {
  executeShowcaseAction,
  getShowcaseData,
  ShowcasePresentationError,
} from "@/lib/showcase/presentation-service";
import type { ShowcaseAction } from "@/lib/showcase/types";
import { canAccessLegacyCourse } from "@/lib/platform/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("assign"),
    groupId: z.string().min(1).max(128).nullable(),
    studentId: z.string().min(1).max(128).nullable().optional(),
  }).strict(),
  z.object({
    action: z.literal("save-queue"),
    orderedStudentIds: z.array(z.string().min(1).max(128)).max(500),
    minutesPerStudent: z.number().finite().int().min(1).max(60),
  }).strict(),
  z.object({
    action: z.literal("request"),
    artifactKind: z.enum(["document", "pdf"]),
    artifactVersionId: z.string().min(1).max(128),
    // Keep the presentation endpoint compatible with clients that predate
    // the explicit PDF mode and with browsers that provide a non-UUID
    // idempotency token. The server still generates a UUID when omitted.
    displayMode: z.preprocess(
      (value) => value === "document" ? "continuous" : value,
      z.enum(["continuous", "slides"]),
    ).default("continuous"),
    requestId: z.string().trim().min(1).max(160).optional(),
  }).strict(),
  z.object({
    action: z.literal("review"),
    presentationId: z.string().uuid(),
    decision: z.enum(["approve", "reject"]),
    reason: z.string().trim().max(1_000).optional(),
  }).strict(),
  z.object({
    action: z.literal("update"),
    presentationId: z.string().uuid(),
    viewState: z.object({
      page: z.number().int().min(1).max(100_000).optional(),
      scrollRatio: z.number().finite().min(0).max(1).optional(),
    }).strict(),
  }).strict().superRefine((value, context) => {
    if (value.viewState.page === undefined && value.viewState.scrollRatio === undefined) {
      context.addIssue({ code: "custom", path: ["viewState"], message: "视图位置不能为空。" });
    }
  }),
  z.object({ action: z.literal("end"), presentationId: z.string().uuid() }).strict(),
  z.object({
    action: z.literal("finish-evaluation"),
    presentationId: z.string().uuid(),
    note: z.string().trim().max(2_000).nullable().optional(),
  }).strict(),
]);

export async function GET(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;
  if (!isDatabaseConfigured()) return Response.json({ code: "DATABASE_REQUIRED", message: "成果汇报需要连接数据库。" }, { status: 503 });
  const { courseId } = await context.params;
  if (!(await canAccessLegacyCourse(auth.claims, courseId, "read"))) return Response.json({ code: "FORBIDDEN", message: "课程当前不可访问。" }, { status: 403 });
  try {
    return Response.json(await getShowcaseData(courseId, auth.claims), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return showcaseError(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;
  if (!isDatabaseConfigured()) return Response.json({ code: "DATABASE_REQUIRED", message: "成果汇报需要连接数据库。" }, { status: 503 });
  const { courseId } = await context.params;
  if (!(await canAccessLegacyCourse(auth.claims, courseId, "write"))) return Response.json({ code: "COURSE_LOCKED", message: "课程当前不允许进行汇报操作。" }, { status: 403 });
  const parsed = ActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({
      code: "INVALID_ACTION",
      message: "汇报操作参数无效。",
      details: parsed.error.flatten(),
    }, { status: 400 });
  }
  const action = parsed.data as ShowcaseAction;
  const rate = await checkDistributedRateLimit({
    namespace: action.action === "update" ? "showcase-view-state" : "showcase-presentation",
    key: `${auth.claims.sub}:${courseId}`,
    limit: action.action === "update" ? 600 : 30,
    windowSeconds: 60,
  });
  if (!rate.allowed) return rateLimitedResponse(rate.retryAfterMs);
  try {
    return Response.json(await executeShowcaseAction(courseId, action, auth.claims), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return showcaseError(error);
  }
}

function showcaseError(error: unknown): Response {
  if (error instanceof ShowcasePresentationError) {
    return Response.json({ code: error.code, message: error.message }, { status: error.status });
  }
  console.error("[showcase/presentation] request failed", error);
  return Response.json({ code: "SHOWCASE_FAILED", message: "汇报操作未完成，请稍后重试。" }, { status: 500 });
}
