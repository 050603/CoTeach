import { z } from "zod";
import { isAuthConfigured, readAuthFromRequest, signTeacherToken, TEACHER_COOKIE_NAME, getAuthCookieOptions } from "@/lib/auth/session";
import { isDatabaseConfigured, prisma } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { requireSameOrigin } from "@/lib/auth/request-guards";
import { jsonError } from "@/lib/platform/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ username: z.string().trim().min(3).max(64), displayName: z.string().trim().min(1).max(64), password: z.string().min(8).max(256), confirmPassword: z.string().min(8).max(256) });

export async function GET(request: Request) {
  if (!isDatabaseConfigured()) return Response.json({ available: false, message: "数据库未配置" }, { status: 503 });
  const count = await prisma.user.count({ where: { role: { in: ["TEACHER", "teacher"] } } });
  const claims = isAuthConfigured() ? await readAuthFromRequest(request, "teacher") : null;
  return Response.json({ available: count === 0 || Boolean(claims), mode: count === 0 ? "bootstrap" : "authenticated" });
}

export async function POST(request: Request) {
  const csrf = requireSameOrigin(request);
  if (csrf) return csrf;
  if (!isDatabaseConfigured() || !isAuthConfigured()) return jsonError(request, "AUTH_UNAVAILABLE", "账号服务尚未配置", 503);
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || parsed.data.password !== parsed.data.confirmPassword) return jsonError(request, "INVALID_INPUT", "请检查账号、姓名和密码", 400);
  const teacherCount = await prisma.user.count({ where: { role: { in: ["TEACHER", "teacher"] } } });
  if (teacherCount > 0) {
    const claims = await readAuthFromRequest(request, "teacher");
    if (!claims) return jsonError(request, "UNAUTHORIZED", "只有已登录教师可以创建教师账号", 401);
  }
  const username = parsed.data.username.normalize("NFKC").trim();
  const usernameKey = username.toLocaleLowerCase("en-US");
  if (await prisma.user.findUnique({ where: { usernameKey } })) return jsonError(request, "USERNAME_TAKEN", "登录账号已存在", 409);
  const user = await prisma.user.create({ data: { username, usernameKey, displayName: parsed.data.displayName.normalize("NFC").trim(), passwordHash: await hashPassword(parsed.data.password), role: "TEACHER", status: "ACTIVE" } });
  const signed = await signTeacherToken({ teacherId: user.id, username: user.username, displayName: user.displayName, sessionVersion: user.sessionVersion });
  const cookie = getAuthCookieOptions(signed.maxAge);
  const cookieValue = `${TEACHER_COOKIE_NAME}=${encodeURIComponent(signed.token)}; Path=${cookie.path}; Max-Age=${cookie.maxAge}; HttpOnly; SameSite=${cookie.sameSite}${cookie.secure ? "; Secure" : ""}`;
  return Response.json({ bootstrap: teacherCount === 0, user: { username: user.username, displayName: user.displayName } }, { status: 201, headers: { "Set-Cookie": cookieValue, "Cache-Control": "no-store" } });
}
