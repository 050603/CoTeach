// @ts-nocheck
// Teacher login endpoint. Validates credentials against the Teacher table.
// On success, sets an httpOnly cookie with a signed JWT (7-day expiry).

import { prisma } from "@/lib/db/client";
import { isDatabaseConfigured } from "@/lib/db/client";
import {
  hashPassword,
  passwordNeedsRehash,
  verifyPassword,
} from "@/lib/auth/password";
import {
  isAuthConfigured,
  signTeacherToken,
  TEACHER_COOKIE_NAME,
  getAuthCookieOptions,
} from "@/lib/auth/session";
import { getClientIp, rateLimitedResponse } from "@/lib/auth/rate-limit";
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
} from "@/lib/auth/distributed-rate-limit";
import { z } from "zod";
import { requireSameOrigin } from "@/lib/auth/request-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LoginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

export async function POST(req: Request) {
  const csrfError = requireSameOrigin(req);
  if (csrfError) return csrfError;
  if (!isAuthConfigured()) {
    return Response.json(
      { error: "AUTH_NOT_CONFIGURED", message: "未配置 JWT_SECRET,鉴权未启用" },
      { status: 503 },
    );
  }

  const ip = getClientIp(req);
  let parsed: z.infer<typeof LoginSchema>;
  try {
    parsed = LoginSchema.parse(await req.json());
  } catch {
    return Response.json(
      { error: "INVALID_INPUT", message: "请输入用户名与密码" },
      { status: 400 },
    );
  }

  const limitKey = `${ip}:${parsed.username}`;
  const rl = await checkDistributedRateLimit({
    namespace: "login",
    key: limitKey,
    limit: 10,
    windowSeconds: 60,
  });
  if (!rl.allowed) return rateLimitedResponse(rl.retryAfterMs);

  if (!isDatabaseConfigured()) {
    return Response.json(
      { error: "DB_NOT_CONFIGURED", message: "数据库未配置,无法验证用户" },
      { status: 503 },
    );
  }

  const teacher = await prisma.teacher.findUnique({
    where: { username: parsed.username },
  });

  if (!teacher || !(await verifyPassword(parsed.password, teacher.passwordHash))) {
    return Response.json(
      { error: "INVALID_CREDENTIALS", message: "用户名或密码错误" },
      { status: 401 },
    );
  }

  await resetDistributedRateLimit("login", limitKey);

  const upgradedHash = passwordNeedsRehash(teacher.passwordHash)
    ? await hashPassword(parsed.password)
    : undefined;
  await prisma.teacher.update({
    where: { id: teacher.id },
    data: { lastLoginAt: new Date(), ...(upgradedHash ? { passwordHash: upgradedHash } : {}) },
  });

  const { token, cookieName, maxAge } = await signTeacherToken({
    teacherId: teacher.id,
    username: teacher.username,
    displayName: teacher.displayName,
    sessionVersion: teacher.sessionVersion,
  });
  if (cookieName !== TEACHER_COOKIE_NAME) {
    // Defensive — should never happen
    return Response.json(
      { error: "INTERNAL_ERROR", message: "Cookie 名称不一致" },
      { status: 500 },
    );
  }

  const cookieOpts = getAuthCookieOptions(maxAge);
  const cookieValue = `${TEACHER_COOKIE_NAME}=${encodeURIComponent(token)}; Path=${cookieOpts.path}; Max-Age=${cookieOpts.maxAge}; HttpOnly; SameSite=${cookieOpts.sameSite}${cookieOpts.secure ? "; Secure" : ""}`;

  return Response.json(
    {
      user: {
        id: teacher.id,
        username: teacher.username,
        displayName: teacher.displayName,
        role: "teacher",
      },
    },
    {
      status: 200,
      headers: { "Set-Cookie": cookieValue, "Content-Type": "application/json; charset=utf-8" },
    },
  );
}
