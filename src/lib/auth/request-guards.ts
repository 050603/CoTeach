import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  clearAuthCookies,
  readAuthFromRequest,
  getRequestedAuthRole,
  type AuthClaims,
  type AuthRole,
} from "@/lib/auth/session";
import { hasCurrentSessionVersion } from "@/lib/auth/session-version";
import { isAllowedBrowserOrigin } from "@/lib/network/request-origin";

export async function authenticateRequest(
  request: Request,
  role?: AuthRole,
): Promise<{ claims: AuthClaims } | { response: Response }> {
  const requestedRole = role ?? getRequestedAuthRole(request);
  const claims = await readAuthFromRequest(
    request,
    requestedRole,
  );
  if (!claims || !(await hasCurrentSessionVersion(claims))) {
    const headers = new Headers({ "Cache-Control": "no-store" });
    if (requestedRole) {
      for (const cookie of clearAuthCookies(requestedRole)) {
        headers.append(
          "Set-Cookie",
          `${cookie.name}=; Path=${cookie.path}; Max-Age=0; HttpOnly; SameSite=${cookie.sameSite}${cookie.secure ? "; Secure" : ""}`,
        );
      }
    }
    return {
      response: Response.json(
        { code: "UNAUTHORIZED", message: "登录状态已失效，请重新登录。", requestId: requestId(request) },
        { status: 401, headers },
      ),
    };
  }
  return { claims };
}

export function requireSameOrigin(request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (!origin) {
    // Non-browser clients must explicitly opt in with a same-origin Referer or
    // use the load-test token accepted by the dedicated test-data API.
    const referer = request.headers.get("referer");
    if (!referer) return forbidden(request, "Missing Origin header.");
    try {
      if (isAllowedRequestOrigin(request, new URL(referer).origin)) return null;
    } catch {
      // fall through
    }
    return forbidden(request, "Cross-origin request rejected.");
  }
  try {
    if (isAllowedRequestOrigin(request, new URL(origin).origin)) return null;
  } catch {
    // fall through
  }
  return forbidden(request, "Cross-origin request rejected.");
}

export function authorizeInternalMonitor(request: Request): Response | null {
  const expected = process.env.INTERNAL_MONITOR_TOKEN;
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !provided || !safeEqual(expected, provided)) {
    return new Response(null, { status: 404 });
  }
  return null;
}

function isAllowedRequestOrigin(request: Request, origin: string): boolean {
  return isAllowedBrowserOrigin({
    origin,
    host: request.headers.get("host") ?? new URL(request.url).host,
    forwardedHost: request.headers.get("x-forwarded-host"),
    forwardedProto: request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", ""),
  });
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function forbidden(request: Request, message: string): Response {
  return Response.json(
    { code: "CSRF_REJECTED", message, requestId: requestId(request) },
    { status: 403 },
  );
}

function requestId(request: Request): string {
  return request.headers.get("x-request-id") ?? randomUUID();
}
