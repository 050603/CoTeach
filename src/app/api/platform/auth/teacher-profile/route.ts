import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { getAuthCookieOptions, signTeacherToken, TEACHER_COOKIE_NAME } from "@/lib/auth/session";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { isValidNewPasswordLength, PASSWORD_LENGTH_HINT } from "@/lib/auth/password-policy";
import { prisma } from "@/lib/db/client";
import { jsonError } from "@/lib/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  displayName: z.string().trim().min(1).max(64).optional(),
  currentPassword: z.string().max(256).optional(),
  newPassword: z.string().max(256).optional(),
  confirmPassword: z.string().max(256).optional(),
});

export async function PATCH(request: Request) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher");
  if ("response" in auth) return auth.response;
  if (auth.claims.role !== "teacher" || !auth.claims.sub) return jsonError(request, "UNAUTHORIZED", "登录状态已失效", 401);

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || (!parsed.data.displayName && !parsed.data.newPassword)) return jsonError(request, "INVALID_INPUT", "请填写要更新的个人信息", 400);
  const { displayName, currentPassword, newPassword, confirmPassword } = parsed.data;
  if (newPassword && (!currentPassword || newPassword !== confirmPassword || !isValidNewPasswordLength(newPassword))) {
    return jsonError(request, "INVALID_PASSWORD", `请确认当前密码和新密码；${PASSWORD_LENGTH_HINT}`, 400);
  }

  const user = await prisma.user.findFirst({ where: { id: auth.claims.sub, role: { in: ["TEACHER", "teacher"] }, status: { in: ["ACTIVE", "active"] } } });
  if (!user) return jsonError(request, "UNAUTHORIZED", "教师账号不存在或已停用", 401);
  if (newPassword && !(await verifyPassword(currentPassword!, user.passwordHash))) return jsonError(request, "CURRENT_PASSWORD_INVALID", "当前密码不正确", 400);

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      ...(displayName ? { displayName: displayName.normalize("NFC") } : {}),
      ...(newPassword ? { passwordHash: await hashPassword(newPassword), sessionVersion: { increment: 1 } } : {}),
    },
  });
  const signed = await signTeacherToken({ teacherId: updated.id, username: updated.username, displayName: updated.displayName, sessionVersion: updated.sessionVersion });
  const cookie = getAuthCookieOptions(signed.maxAge);
  const cookieValue = `${TEACHER_COOKIE_NAME}=${encodeURIComponent(signed.token)}; Path=${cookie.path}; Max-Age=${cookie.maxAge}; HttpOnly; SameSite=${cookie.sameSite}${cookie.secure ? "; Secure" : ""}`;
  return Response.json({ user: { username: updated.username, displayName: updated.displayName, role: "teacher" } }, { headers: { "Set-Cookie": cookieValue, "Cache-Control": "no-store" } });
}
