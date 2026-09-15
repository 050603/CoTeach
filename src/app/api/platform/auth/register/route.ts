import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_LENGTH_HINT } from "@/lib/auth/password-policy";
import { z } from "zod";
import { isAuthConfigured } from "@/lib/auth/session";
import { isDatabaseConfigured } from "@/lib/db/client";
import { requireSameOrigin } from "@/lib/auth/request-guards";
import { registerStudent, PlatformError } from "@/lib/platform/repository";
import { jsonError, studentCookieHeader } from "@/lib/platform/http";
import { checkDistributedRateLimit, resetDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";
import { getClientIp, rateLimitedResponse } from "@/lib/auth/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z
  .object({
    invitationCode: z.string().trim().min(4).max(32),
    username: z.string().trim().min(3).max(64),
    displayName: z.string().trim().min(1).max(64),
    password: z.string().min(PASSWORD_MIN_LENGTH, PASSWORD_LENGTH_HINT).max(PASSWORD_MAX_LENGTH, PASSWORD_LENGTH_HINT),
    confirmPassword: z.string().min(PASSWORD_MIN_LENGTH, PASSWORD_LENGTH_HINT).max(PASSWORD_MAX_LENGTH, PASSWORD_LENGTH_HINT),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "两次输入的密码不一致",
    path: ["confirmPassword"],
  });

export async function POST(request: Request) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  if (!isAuthConfigured() || !isDatabaseConfigured()) return jsonError(request, "AUTH_UNAVAILABLE", "账号服务尚未配置", 503);
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(request, "INVALID_REGISTRATION", `请检查注册信息；${PASSWORD_LENGTH_HINT}`, 400, parsed.error.flatten());
  // A classroom shares one public IP. Keep retries bounded per student so
  // classmates registering simultaneously do not exhaust one shared bucket.
  const limitKey = `${getClientIp(request)}:${parsed.data.username.normalize("NFKC").trim().toLocaleLowerCase("en-US")}`;
  const limit = await checkDistributedRateLimit({ namespace: "platform-register", key: limitKey, limit: 5, windowSeconds: 10 * 60 });
  if (!limit.allowed) return rateLimitedResponse(limit.retryAfterMs);
  try {
    const result = await registerStudent(parsed.data);
    await resetDistributedRateLimit("platform-register", limitKey);
    return Response.json({ user: { id: result.user.id, username: result.user.username, displayName: result.user.displayName, role: "student" }, enrollment: { id: result.enrollment.id, offeringId: result.enrollment.offeringId }, offeringId: result.offering.id }, { status: 201, headers: { "Set-Cookie": await studentCookieHeader({ userId: result.user.id, studentName: result.user.displayName, sessionVersion: result.user.sessionVersion }), "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PlatformError) return jsonError(request, error.code, error.message, error.status, error.details);
    if (error instanceof Error && error.message.includes("Unique constraint")) return jsonError(request, "USERNAME_TAKEN", "学号已存在", 409);
    console.error("[platform/student-register] failed", error);
    return jsonError(request, "REGISTRATION_FAILED", "暂时无法完成注册", 503);
  }
}
