import { z } from "zod";
import { isAuthConfigured, signTeacherToken, TEACHER_COOKIE_NAME, getAuthCookieOptions } from "@/lib/auth/session";
import { isDatabaseConfigured, prisma } from "@/lib/db/client";
import { verifyPassword, hashPassword, passwordNeedsRehash } from "@/lib/auth/password";
import { requireSameOrigin } from "@/lib/auth/request-guards";
import { jsonError } from "@/lib/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(256) });

export async function POST(request: Request) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  if (!isAuthConfigured() || !isDatabaseConfigured()) return jsonError(request, "AUTH_UNAVAILABLE", "账号服务尚未配置", 503);
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(request, "INVALID_INPUT", "请输入用户名和密码", 400);
  const user = await prisma.user.findUnique({ where: { usernameKey: parsed.data.username.normalize("NFKC").trim().toLocaleLowerCase("en-US") } });
  if (!user || user.role.toLowerCase() !== "teacher" || user.status.toLowerCase() !== "active" || !(await verifyPassword(parsed.data.password, user.passwordHash))) return jsonError(request, "INVALID_CREDENTIALS", "用户名或密码错误", 401);
  const upgradedHash = passwordNeedsRehash(user.passwordHash) ? await hashPassword(parsed.data.password) : undefined;
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(), ...(upgradedHash ? { passwordHash: upgradedHash } : {}) } });
  const signed = await signTeacherToken({ teacherId: user.id, username: user.username, displayName: user.displayName, sessionVersion: user.sessionVersion });
  const cookie = getAuthCookieOptions(signed.maxAge);
  const cookieValue = `${TEACHER_COOKIE_NAME}=${encodeURIComponent(signed.token)}; Path=${cookie.path}; Max-Age=${cookie.maxAge}; HttpOnly; SameSite=${cookie.sameSite}${cookie.secure ? "; Secure" : ""}`;
  return Response.json({ user: { id: user.id, username: user.username, displayName: user.displayName, role: "teacher" } }, { headers: { "Set-Cookie": cookieValue, "Cache-Control": "no-store" } });
}
