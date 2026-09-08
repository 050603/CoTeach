import { z } from "zod";
import { isAuthConfigured } from "@/lib/auth/session";
import { isDatabaseConfigured } from "@/lib/db/client";
import { requireSameOrigin } from "@/lib/auth/request-guards";
import { loginStudent, PlatformError } from "@/lib/platform/repository";
import { jsonError, studentCookieHeader } from "@/lib/platform/http";
import { checkDistributedRateLimit, resetDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";
import { getClientIp, rateLimitedResponse } from "@/lib/auth/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(256) });

export async function POST(request: Request) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  if (!isAuthConfigured() || !isDatabaseConfigured()) return jsonError(request, "AUTH_UNAVAILABLE", "账号服务尚未配置", 503);
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(request, "INVALID_INPUT", "请输入用户名和密码", 400);
  const limitKey = `${getClientIp(request)}:${parsed.data.username.normalize("NFKC").trim().toLocaleLowerCase("en-US")}`;
  const limit = await checkDistributedRateLimit({ namespace: "platform-login", key: limitKey, limit: 10, windowSeconds: 60 });
  if (!limit.allowed) return rateLimitedResponse(limit.retryAfterMs);
  try {
    const account = await loginStudent(parsed.data.username, parsed.data.password);
    await resetDistributedRateLimit("platform-login", limitKey);
    const firstLegacyCourseId = account.enrollments.find((item) => item.offering.legacyCourseId)?.offering.legacyCourseId ?? "";
    return Response.json({ user: { id: account.id, username: account.username, displayName: account.displayName, role: account.role }, enrollments: account.enrollments.map((item) => ({ id: item.id, offeringId: item.offeringId })) }, { headers: { "Set-Cookie": await studentCookieHeader({ userId: account.id, studentName: account.displayName, courseId: firstLegacyCourseId, sessionVersion: account.sessionVersion }), "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status);
    console.error("[platform/student-login] failed", error);
    return jsonError(request, "LOGIN_FAILED", "暂时无法登录", 503);
  }
}
