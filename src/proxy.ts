// Next.js Proxy — optimistic auth gate for protected routes.
//
// When JWT_SECRET is not configured (demo mode), middleware is a no-op
// and all routes pass through (preserving backward compatibility).
//
// When configured:
//   - /teacher/* requires a valid teacher JWT, else redirect to /teacher/login
//   - /student/* requires a valid student JWT, else redirect to / (home with join form)
//   - teacher APIs, upload writes, and course actions
//     require proper role; unauthenticated → 401
//   - /api/openmaic/provider-config POST/DELETE requires teacher role
//
// Edge runtime: must use only Edge-compatible APIs (jose works on Edge).

import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { hasValidProxyAuthClaims } from "@/lib/auth/proxy-claims";

export const config = {
  matcher: [
    // 裸路径必须单独列出——Next.js 16 中 `:path*` 不匹配无子路径的裸路径
    "/teacher",
    "/teacher/:path*",
    // /student 裸路径是公开入口页（输入邀请码），不经过 middleware；
    // 仅 /student/* 子路径（classroom、ai-learning）需要认证。
    "/student/:path*",
    // Upload route handlers perform their own same-origin and role checks.
    // Keep them out of Proxy: Next.js buffers matched request bodies and
    // truncates them at 10 MiB by default, which corrupts streamed videos.
    "/api/((?!uploads).*)",
    "/api/courses",
    "/api/courses/:path*",
    "/api/teacher-directives",
    "/api/teacher-directives/:path*",
    "/api/learning-events",
    "/api/learning-events/:path*",
    "/api/openmaic/provider-config",
    "/api/openmaic/provider-config/:path*",
  ],
};

const TEACHER_COOKIE = "openpbl_teacher";
const STUDENT_COOKIE = "openpbl_student";
const LOGIN_PATH = "/teacher/login";

function getSecret(): Uint8Array | null {
  const raw = process.env.JWT_SECRET;
  if (!raw || raw.length < 32) return null;
  return new TextEncoder().encode(raw);
}

async function verifyCookie(
  token: string | undefined,
  secret: Uint8Array,
): Promise<{ role: "teacher" | "student"; [k: string]: unknown } | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
      issuer: "openpbl",
      audience: "openpbl-app",
    });
    if (!hasValidProxyAuthClaims(payload)) return null;
    return payload as { role: "teacher" | "student"; [k: string]: unknown };
  } catch {
    return null;
  }
}

function readCookie(req: NextRequest, name: string): string | undefined {
  const cookie = req.cookies.get(name);
  return cookie?.value;
}

export async function proxy(req: NextRequest) {
  // Authentication moved to V2. Teaching APIs retain their URLs with V2 persistence.
  const retiredAuth = ["/api/auth/login", "/api/auth/register", "/api/auth/join"];
  if (retiredAuth.includes(req.nextUrl.pathname)) {
    return NextResponse.json({ code: "V2_AUTH_REQUIRED", message: "请使用课程平台登录与注册入口" }, { status: 410 });
  }
  const secret = getSecret();
  // Demo mode: skip auth
  if (!secret) return NextResponse.next();

  const { pathname } = req.nextUrl;

  // ---------- Page guards ----------
  // A teacher session is persisted across browser restarts. When the teacher
  // returns through the role switch, skip the login form while the JWT is
  // still valid. A known-expired session must keep showing the login page to
  // avoid redirect loops when the server-side session version has changed.
  if (pathname === LOGIN_PATH && !req.nextUrl.searchParams.has("reason")) {
    const token = readCookie(req, TEACHER_COOKIE);
    const claims = await verifyCookie(token ?? "", secret);
    if (claims?.role === "teacher") {
      const url = req.nextUrl.clone();
      url.pathname = "/teacher";
      url.search = "";
      return NextResponse.redirect(url);
    }
  }

  // 注意：pathname.startsWith("/teacher/") 不匹配裸路径 "/teacher"，
  // 需要显式检查裸路径。
  if (
    (pathname === "/teacher" || pathname.startsWith("/teacher/")) &&
    pathname !== LOGIN_PATH &&
    pathname !== "/teacher/register"
  ) {
    const token = readCookie(req, TEACHER_COOKIE);
    const claims = await verifyCookie(token ?? "", secret);
    if (!claims || claims.role !== "teacher") {
      const url = req.nextUrl.clone();
      url.pathname = LOGIN_PATH;
      url.searchParams.set("redirect", pathname);
      return NextResponse.redirect(url);
    }
  }

  // /student 裸路径是学生入口页（输入邀请码），公开访问；
  // 仅 /student/* 子路径（classroom、ai-learning）需要学生身份。
  if (pathname.startsWith("/student/")) {
    if (
      pathname === "/student/register" ||
      pathname === "/student/login" ||
      pathname === "/student/reset-password"
    ) {
      return NextResponse.next();
    }
    const token = readCookie(req, STUDENT_COOKIE);
    const claims = await verifyCookie(token ?? "", secret);
    if (!claims || claims.role !== "student") {
      const url = req.nextUrl.clone();
      url.pathname = "/student/login";
      url.searchParams.set("redirect", pathname);
      return NextResponse.redirect(url);
    }
  }

  // ---------- API guards ----------
  if (pathname.startsWith("/api/")) {
    const teacherToken = readCookie(req, TEACHER_COOKIE);
    const studentToken = readCookie(req, STUDENT_COOKIE);
    const teacherClaims = await verifyCookie(teacherToken ?? "", secret);
    const studentClaims = await verifyCookie(studentToken ?? "", secret);

    const isTeacher = !!teacherClaims && teacherClaims.role === "teacher";
    const isStudent = !!studentClaims && studentClaims.role === "student";
    const publicApi =
      pathname === "/api/auth/login" ||
      pathname === "/api/auth/join" ||
      pathname === "/api/auth/logout" ||
      pathname === "/api/auth/me" ||
      pathname === "/api/auth/register" ||
      pathname === "/api/platform/auth/invite" ||
      pathname === "/api/platform/auth/register" ||
      pathname === "/api/platform/auth/login" ||
      pathname === "/api/platform/auth/teacher-login" ||
      pathname === "/api/platform/auth/teacher-register" ||
      pathname === "/api/platform/auth/reset-password" ||
      pathname === "/api/health/live" ||
      // Sandboxed srcdoc iframes have an opaque origin and cannot reliably
      // attach the teacher/student cookie to runtime subresource requests.
      // This endpoint exposes only allowlisted, version-pinned static assets.
      pathname.startsWith("/api/openmaic/interactive-runtime/");
    const internallyProtectedApi =
      pathname === "/api/health/ready" ||
      pathname === "/api/metrics" ||
      pathname.startsWith("/api/load-test/");
    if (!publicApi && !internallyProtectedApi && !isTeacher && !isStudent) {
      return NextResponse.json(
        { code: "UNAUTHORIZED", message: "Authentication required." },
        { status: 401 },
      );
    }

    // Teacher-only APIs
    if (
      pathname.startsWith("/api/teacher-directives") ||
      pathname.startsWith("/api/openmaic/provider-config")
    ) {
      if (!isTeacher) {
        return NextResponse.json(
          { error: "UNAUTHORIZED", message: "需要教师身份" },
          { status: 401 },
        );
      }
    }

    // Course APIs allow either authenticated role. Route handlers enforce the
    // course, group, and resource-level authorization boundaries.
    if (pathname === "/api/courses" || pathname.startsWith("/api/courses/")) {
      if (!isTeacher && !isStudent) {
        return NextResponse.json(
          { error: "UNAUTHORIZED", message: "请先登录" },
          { status: 401 },
        );
      }
    }

    // Learning events require a known teacher or student identity.
    if (pathname.startsWith("/api/learning-events")) {
      if (!isTeacher && !isStudent) {
        return NextResponse.json(
          { error: "UNAUTHORIZED", message: "请先登录" },
          { status: 401 },
        );
      }
    }

    // Uploads: POST requires auth, GET (download) allowed for sharing
    if (pathname.startsWith("/api/uploads") && req.method !== "GET") {
      if (!isTeacher && !isStudent) {
        return NextResponse.json(
          { error: "UNAUTHORIZED", message: "请先登录" },
          { status: 401 },
        );
      }
    }
  }

  return NextResponse.next();
}
