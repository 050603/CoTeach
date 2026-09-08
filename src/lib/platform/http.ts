import {
  getAuthCookieOptions,
  signStudentToken,
  STUDENT_COOKIE_NAME,
} from "@/lib/auth/session";

export function studentCookieHeader(input: {
  userId: string;
  studentName: string;
  sessionVersion: number;
}): Promise<string> {
  return signStudentToken({
    userId: input.userId,
    studentName: input.studentName,
    sessionVersion: input.sessionVersion,
  }).then(({ token, maxAge }) => {
    const cookie = getAuthCookieOptions(maxAge);
    return `${STUDENT_COOKIE_NAME}=${encodeURIComponent(token)}; Path=${cookie.path}; Max-Age=${cookie.maxAge}; HttpOnly; SameSite=${cookie.sameSite}${cookie.secure ? "; Secure" : ""}`;
  });
}

export function jsonError(request: Request, code: string, message: string, status: number, details?: unknown): Response {
  return Response.json({ code, message, requestId: request.headers.get("x-request-id") ?? "unknown", ...(details === undefined ? {} : { details }) }, { status });
}
