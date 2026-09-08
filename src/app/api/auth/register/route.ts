// @ts-nocheck
import { Prisma } from "@prisma/client";
import { prisma, isDatabaseConfigured } from "@/lib/db/client";
import {
  getAuthCookieOptions,
  isAuthConfigured,
  readAuthFromRequest,
  signTeacherToken,
  TEACHER_COOKIE_NAME,
} from "@/lib/auth/session";
import { hasCurrentSessionVersion } from "@/lib/auth/session-version";
import { hashPassword } from "@/lib/auth/password";
import { requireSameOrigin } from "@/lib/auth/request-guards";
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
} from "@/lib/auth/distributed-rate-limit";
import { getClientIp, rateLimitedResponse } from "@/lib/auth/rate-limit";
import { TeacherRegistrationSchema } from "@/lib/auth/teacher-registration";
import { runMutationTransaction } from "@/lib/db/transaction-retry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BOOTSTRAP_LOCK_ID = 733_173_301;

export async function GET(request: Request) {
  if (!isAuthConfigured() || !isDatabaseConfigured()) {
    return response(
      {
        available: false,
        code: "TEACHER_REGISTRATION_UNAVAILABLE",
        message: "请先配置数据库和 JWT_SECRET。",
      },
      503,
    );
  }
  try {
    const teacherCount = await prisma.teacher.count();
    if (teacherCount === 0) {
      return response({ available: true, mode: "bootstrap" });
    }
    const claims = await readAuthorizedTeacher(request);
    if (claims) {
      return response({ available: true, mode: "authenticated" });
    }
    return response({
      available: false,
      requiresAuthentication: true,
      code: "TEACHER_AUTH_REQUIRED",
      message: "已有教师账号，请先登录后再创建其他教师。",
    });
  } catch (error) {
    console.error("[auth/register] unable to read registration status", {
      requestId: request.headers.get("x-request-id") ?? "unknown",
      error: error instanceof Error ? error.message : String(error),
    });
    return response(
      {
        available: false,
        code: "TEACHER_REGISTRATION_UNAVAILABLE",
        message: "暂时无法检查注册状态。",
      },
      503,
    );
  }
}

export async function POST(request: Request) {
  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;
  if (!isAuthConfigured() || !isDatabaseConfigured()) {
    return apiError(
      request,
      "TEACHER_REGISTRATION_UNAVAILABLE",
      "请先配置数据库和 JWT_SECRET。",
      503,
    );
  }

  const clientIp = getClientIp(request);
  const limit = await checkDistributedRateLimit({
    namespace: "teacher-register",
    key: clientIp,
    limit: 5,
    windowSeconds: 10 * 60,
  });
  if (!limit.allowed) return rateLimitedResponse(limit.retryAfterMs);

  const parsed = TeacherRegistrationSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return apiError(
      request,
      "INVALID_REGISTRATION",
      "请检查注册信息。",
      400,
      parsed.error.flatten(),
    );
  }

  try {
    const authorizingTeacher = await readAuthorizedTeacher(request);
    const passwordHash = await hashPassword(parsed.data.password);
    const result = await runMutationTransaction(
      async (tx) => {
        // Advisory locks return PostgreSQL's `void` type. `$queryRaw` attempts
        // to deserialize that value and Prisma rejects it; `$executeRaw`
        // intentionally discards the result set while keeping the lock scoped
        // to this transaction.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_ID})`;
        const bootstrap = (await tx.teacher.count()) === 0;
        if (!bootstrap && !authorizingTeacher) {
          throw new TeacherAuthenticationRequiredError();
        }
        const teacher = await tx.teacher.create({
          data: {
            username: parsed.data.username,
            displayName: parsed.data.displayName,
            passwordHash,
          },
          select: {
            id: true,
            username: true,
            displayName: true,
            sessionVersion: true,
          },
        });
        return { bootstrap, teacher };
      },
    );

    await resetDistributedRateLimit("teacher-register", clientIp);
    const headers = new Headers({ "Cache-Control": "no-store" });
    if (result.bootstrap) {
      const { token, maxAge } = await signTeacherToken({
        teacherId: result.teacher.id,
        username: result.teacher.username,
        displayName: result.teacher.displayName,
        sessionVersion: result.teacher.sessionVersion,
      });
      const cookie = getAuthCookieOptions(maxAge);
      headers.set(
        "Set-Cookie",
        `${TEACHER_COOKIE_NAME}=${encodeURIComponent(token)}; Path=${cookie.path}; Max-Age=${cookie.maxAge}; HttpOnly; SameSite=${cookie.sameSite}${cookie.secure ? "; Secure" : ""}`,
      );
    }

    return Response.json(
      {
        bootstrap: result.bootstrap,
        user: {
          id: result.teacher.id,
          username: result.teacher.username,
          displayName: result.teacher.displayName,
          role: "teacher",
        },
      },
      {
        status: 201,
        headers,
      },
    );
  } catch (error) {
    if (error instanceof TeacherAuthenticationRequiredError) {
      return apiError(
        request,
        "TEACHER_AUTH_REQUIRED",
        "已有教师账号，请先登录后再创建其他教师。",
        401,
      );
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return apiError(
        request,
        "TEACHER_USERNAME_TAKEN",
        "该教师账号已存在，请更换账号名称。",
        409,
      );
    }
    console.error("[auth/register] unable to create initial teacher", {
      requestId: request.headers.get("x-request-id") ?? "unknown",
      error: error instanceof Error ? error.message : String(error),
    });
    return apiError(
      request,
      "TEACHER_REGISTRATION_FAILED",
      "暂时无法创建教师账号，请稍后重试。",
      503,
    );
  }
}

class TeacherAuthenticationRequiredError extends Error {}

async function readAuthorizedTeacher(request: Request) {
  const claims = await readAuthFromRequest(request, "teacher");
  if (!claims || claims.role !== "teacher") return null;
  return (await hasCurrentSessionVersion(claims)) ? claims : null;
}

function response(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function apiError(
  request: Request,
  code: string,
  message: string,
  status: number,
  details?: unknown,
): Response {
  return response(
    {
      code,
      message,
      requestId: request.headers.get("x-request-id") ?? "unknown",
      ...(details === undefined ? {} : { details }),
    },
    status,
  );
}
