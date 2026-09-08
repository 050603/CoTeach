import type { JWTPayload } from "jose";

type ProxyAuthClaims = JWTPayload & {
  role: "teacher" | "student";
  sv: number;
};

/**
 * Proxy performs an optimistic JWT-shape check before protected pages load.
 * Database-backed session-version validation remains in Route Handlers, but
 * legacy tokens without the session-version claim must be rejected here so a
 * page cannot render successfully while all of its APIs return 401.
 */
export function hasValidProxyAuthClaims(
  payload: JWTPayload,
): payload is ProxyAuthClaims {
  if (
    (payload.role !== "teacher" && payload.role !== "student") ||
    typeof payload.sub !== "string" ||
    !Number.isSafeInteger(payload.sv) ||
    Number(payload.sv) < 1
  ) {
    return false;
  }
  if (payload.role === "teacher") {
    return (
      typeof payload.username === "string" &&
      typeof payload.displayName === "string"
    );
  }
  return typeof payload.userId === "string" && payload.userId === payload.sub && typeof payload.studentName === "string";
}
