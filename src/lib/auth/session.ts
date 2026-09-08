// JWT-based session management (httpOnly cookie).
// Uses `jose` library for Edge-compatible JWT sign/verify.
// Teacher JWT: 7-day expiry, payload { sub, role: "teacher", username, displayName }
// Student JWT: 1-day expiry, payload { sub, role: "student", courseId, studentId, studentName }

import { SignJWT, jwtVerify, type JWTPayload } from "jose";

const TEACHER_COOKIE = "openpbl_teacher";
const STUDENT_COOKIE = "openpbl_student";
const TEACHER_TTL_SECONDS = 7 * 24 * 60 * 60;
const STUDENT_TTL_SECONDS = 24 * 60 * 60;
const ISSUER = "openpbl";
const AUDIENCE = "openpbl-app";
const ALGORITHM = "HS256";
const SESSION_VERSION_CLAIM = "sv";

export type AuthRole = "teacher" | "student";

export interface TeacherClaims extends JWTPayload {
  role: "teacher";
  username: string;
  displayName: string;
  sv: number;
}

export interface StudentClaims extends JWTPayload {
  role: "student";
  /** Unified platform user id. Legacy sessions omit it and use sub. */
  userId?: string;
  courseId: string;
  studentId: string;
  studentName: string;
  sv: number;
}

export type AuthClaims = TeacherClaims | StudentClaims;

function getSecret(): Uint8Array {
  const raw = process.env.JWT_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error(
      "JWT_SECRET is not configured or too short (need >= 32 chars). Set JWT_SECRET env variable.",
    );
  }
  return new TextEncoder().encode(raw);
}

export function isAuthConfigured(): boolean {
  const raw = process.env.JWT_SECRET;
  return !!raw && raw.length >= 32;
}

export async function signTeacherToken(payload: {
  teacherId: string;
  username: string;
  displayName: string;
  sessionVersion: number;
}): Promise<{ token: string; cookieName: string; maxAge: number }> {
  const token = await new SignJWT({
    role: "teacher",
    username: payload.username,
    displayName: payload.displayName,
    [SESSION_VERSION_CLAIM]: payload.sessionVersion,
  })
    .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
    .setSubject(payload.teacherId)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(`${TEACHER_TTL_SECONDS}s`)
    .sign(getSecret());
  return { token, cookieName: TEACHER_COOKIE, maxAge: TEACHER_TTL_SECONDS };
}

export async function signStudentToken(payload: {
  userId?: string;
  courseId: string;
  studentId: string;
  studentName: string;
  sessionVersion: number;
}): Promise<{ token: string; cookieName: string; maxAge: number }> {
  const unifiedIdentity = payload.userId ? { userId: payload.userId } : {};
  const token = await new SignJWT({
    role: "student",
    ...unifiedIdentity,
    courseId: payload.courseId,
    studentId: payload.studentId,
    studentName: payload.studentName,
    [SESSION_VERSION_CLAIM]: payload.sessionVersion,
  })
    .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
    .setSubject(payload.studentId)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(`${STUDENT_TTL_SECONDS}s`)
    .sign(getSecret());
  return { token, cookieName: STUDENT_COOKIE, maxAge: STUDENT_TTL_SECONDS };
}

export async function verifyToken(token: string): Promise<AuthClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      algorithms: [ALGORITHM],
      issuer: ISSUER,
      audience: AUDIENCE,
      clockTolerance: 5,
    });
    if (payload.role !== "teacher" && payload.role !== "student") return null;
    if (
      typeof payload.sub !== "string" ||
      !Number.isSafeInteger(payload[SESSION_VERSION_CLAIM]) ||
      Number(payload[SESSION_VERSION_CLAIM]) < 1
    ) {
      return null;
    }
    if (
      payload.role === "teacher" &&
      (typeof payload.username !== "string" || typeof payload.displayName !== "string")
    ) {
      return null;
    }
    if (
      payload.role === "student" &&
      (typeof payload.courseId !== "string" ||
        typeof payload.studentId !== "string" ||
        payload.studentId !== payload.sub ||
        typeof payload.studentName !== "string")
    ) {
      return null;
    }
    if (payload.role === "student" && payload.userId !== undefined && typeof payload.userId !== "string") {
      return null;
    }
    return payload as AuthClaims;
  } catch {
    return null;
  }
}

export const TEACHER_COOKIE_NAME = TEACHER_COOKIE;
export const STUDENT_COOKIE_NAME = STUDENT_COOKIE;

export function clearAuthCookies(role?: AuthRole): Array<{ name: string; value: string; maxAge: number; path: string; httpOnly: boolean; sameSite: "lax" | "strict" | "none"; secure: boolean }> {
  const cookieNames = role
    ? [role === "teacher" ? TEACHER_COOKIE : STUDENT_COOKIE]
    : [TEACHER_COOKIE, STUDENT_COOKIE];
  return cookieNames.map((name) => ({
    name,
    value: "",
    maxAge: 0,
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isSecureCookieDeployment(),
  }));
}

export interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "strict" | "none";
  path: string;
  maxAge: number;
}

export function getAuthCookieOptions(maxAge: number): CookieOptions {
  return {
    httpOnly: true,
    secure: isSecureCookieDeployment(),
    sameSite: "lax",
    path: "/",
    maxAge,
  };
}

// Secure cookie 仅在 HTTPS 部署下启用:浏览器不会在明文 HTTP 连接上保存
// 带 Secure 标志的 cookie,内网 IP 直访(如 http://172.16.x.x)会导致登录
// 成功但会话丢失。判断依据 PUBLIC_BASE_URL 协议而非 NODE_ENV。
function isSecureCookieDeployment(): boolean {
  if (process.env.NODE_ENV !== "production") return false;
  const base = process.env.PUBLIC_BASE_URL?.trim();
  return !base || base.startsWith("https://");
}

/**
 * Read auth claims from a Request's cookies. Returns null if not configured
 * (demo mode) or token missing/invalid.
 */
export async function readAuthFromRequest(
  req: Request,
  preferredRole?: AuthRole,
): Promise<AuthClaims | null> {
  if (!isAuthConfigured()) return null;
  const cookieHeader = req.headers.get("cookie") ?? "";
  // A role selected by the route is a security boundary, not a preference.
  // Teacher and student cookies may legitimately coexist in one browser.
  const roles: AuthRole[] = preferredRole
    ? [preferredRole]
    : ["teacher", "student"];

  for (const role of roles) {
    const cookieName = role === "teacher" ? TEACHER_COOKIE : STUDENT_COOKIE;
    const token = readCookie(cookieHeader, cookieName);
    if (!token) continue;
    const claims = await verifyToken(token);
    if (claims?.role === role) return claims;
  }
  return null;
}

export function getRequestedAuthRole(req: Request): AuthRole | undefined {
  const requested = req.headers.get("x-openpbl-role");
  return requested === "teacher" || requested === "student"
    ? requested
    : undefined;
}

function readCookie(cookieHeader: string, name: string): string | null {
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}
