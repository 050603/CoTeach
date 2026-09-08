import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import {
  STUDENT_COOKIE_NAME,
  TEACHER_COOKIE_NAME,
  verifyToken,
  type AuthClaims,
  type AuthRole,
} from "@/lib/auth/session";
import {
  subscribeCourseEvents,
  unsubscribeCourseEvents,
  type RealtimeEvent,
  type RealtimeEventHandler,
} from "./event-bus";
import { checkDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";
import { hasCurrentSessionVersion } from "@/lib/auth/session-version";
import { websocketConnectionsActive } from "@/lib/observability/metrics";
import { shouldDeliverMutationToStudent } from "./event-visibility";
import { isAllowedBrowserOrigin } from "@/lib/network/request-origin";
import { canAccessLegacyCourse } from "@/lib/platform/access";

const PING_INTERVAL_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 90_000;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_CONNECTIONS_PER_IP = 150;
const MAX_CONNECTIONS_PER_IDENTITY = 3;
let serverInstance: WebSocketServer | null = null;
const upgradeClaims = new WeakMap<IncomingMessage, AuthClaims>();
const connectionCounts = new Map<string, number>();
const identityConnectionCounts = new Map<string, number>();

interface ClientState {
  claims: AuthClaims;
  courseId?: string;
  handler?: RealtimeEventHandler;
  lastPongAt: number;
}

function readCookie(headerValue: string | undefined, name: string): string | null {
  for (const part of (headerValue ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function requestedRole(req: IncomingMessage): AuthRole | null {
  const url = new URL(req.url ?? "/", "http://websocket.internal");
  const role = url.searchParams.get("role");
  return role === "teacher" || role === "student" ? role : null;
}

async function authenticate(req: IncomingMessage): Promise<AuthClaims | null> {
  const role = requestedRole(req);
  if (!role) return null;
  const cookieName = role === "teacher" ? TEACHER_COOKIE_NAME : STUDENT_COOKIE_NAME;
  const token = readCookie(req.headers.cookie, cookieName);
  if (!token) return null;
  const claims = await verifyToken(token);
  return claims?.role === role && (await hasCurrentSessionVersion(claims))
    ? claims
    : null;
}

async function authorizeUpgrade(req: IncomingMessage): Promise<AuthClaims | null> {
  if (!hasAllowedOrigin(req)) return null;
  const claims = await authenticate(req);
  if (!claims) return null;
  const ip = clientIp(req);
  if ((connectionCounts.get(ip) ?? 0) >= MAX_CONNECTIONS_PER_IP) return null;
  if ((identityConnectionCounts.get(claims.sub!) ?? 0) >= MAX_CONNECTIONS_PER_IDENTITY) {
    return null;
  }
  const limit = await checkDistributedRateLimit({
    namespace: "websocket-connect",
    key: `${ip}:${claims.sub}`,
    limit: 20,
    windowSeconds: 60,
  });
  return limit.allowed ? claims : null;
}

function sendJson(ws: WebSocket, message: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function parseCourseId(raw: WebSocket.RawData): string | null {
  try {
    const message = JSON.parse(raw.toString("utf8")) as {
      type?: unknown;
      courseId?: unknown;
    };
    return message.type === "subscribe" &&
      typeof message.courseId === "string" &&
      message.courseId.length > 0
      ? message.courseId
      : null;
  } catch {
    return null;
  }
}

async function canSubscribe(claims: AuthClaims, courseId: string): Promise<boolean> {
  // Use the same offering, chapter and activity gate as HTTP/SSE. This also
  // lets the ping loop revoke an already subscribed socket when a teacher
  // locks an activity, removes an enrollment, or ends the teaching class.
  return canAccessLegacyCourse(claims, courseId, "read");
}

function unsubscribe(state: ClientState): void {
  if (state.courseId && state.handler) {
    unsubscribeCourseEvents(state.courseId, state.handler);
  }
  state.courseId = undefined;
  state.handler = undefined;
}

function attachClient(ws: WebSocket, claims: AuthClaims, ip: string): void {
  const state: ClientState = { claims, lastPongAt: Date.now() };
  connectionCounts.set(ip, (connectionCounts.get(ip) ?? 0) + 1);
  websocketConnectionsActive.inc();
  identityConnectionCounts.set(
    claims.sub!,
    (identityConnectionCounts.get(claims.sub!) ?? 0) + 1,
  );

  ws.on("message", async (raw) => {
    const courseId = parseCourseId(raw);
    if (!courseId) {
      sendJson(ws, { type: "error", code: "INVALID_MESSAGE" });
      return;
    }
    if (!(await canSubscribe(state.claims, courseId))) {
      sendJson(ws, { type: "error", code: "COURSE_FORBIDDEN" });
      ws.close(4003, "COURSE_FORBIDDEN");
      return;
    }

    unsubscribe(state);
    state.courseId = courseId;
    state.handler = (event: RealtimeEvent) => {
      if (
        state.claims.role === "student"
        && !shouldDeliverMutationToStudent({
          actionType: event.payload?.actionType,
          scope: event.payload?.scope === "student" ? "student" : "course",
          targetStudentId: typeof event.payload?.studentId === "string"
            ? event.payload.studentId
            : undefined,
        }, state.claims.studentId)
      ) {
        return;
      }
      sendJson(ws, {
        type: "course-event",
        courseId,
        event,
      });
    };
    subscribeCourseEvents(courseId, state.handler);
    sendJson(ws, { type: "subscribed", courseId });
  });

  ws.on("pong", () => {
    state.lastPongAt = Date.now();
  });
  ws.on("close", () => {
    websocketConnectionsActive.dec();
    unsubscribe(state);
    const remaining = Math.max(0, (connectionCounts.get(ip) ?? 1) - 1);
    if (remaining === 0) connectionCounts.delete(ip);
    else connectionCounts.set(ip, remaining);
    const identityRemaining = Math.max(
      0,
      (identityConnectionCounts.get(claims.sub!) ?? 1) - 1,
    );
    if (identityRemaining === 0) identityConnectionCounts.delete(claims.sub!);
    else identityConnectionCounts.set(claims.sub!, identityRemaining);
  });
  ws.on("error", (error) => console.error("[websocket-server] client error:", error));

  const pingTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    void Promise.all([
      hasCurrentSessionVersion(state.claims),
      state.courseId ? canSubscribe(state.claims, state.courseId) : Promise.resolve(true),
    ]).then(([validSession, allowedCourse]) => {
      if (!validSession && ws.readyState === WebSocket.OPEN) {
        ws.close(4001, "SESSION_REVOKED");
      } else if (!allowedCourse && ws.readyState === WebSocket.OPEN) {
        ws.close(4003, "COURSE_FORBIDDEN");
      }
    });
    if (Date.now() - state.lastPongAt > CONNECTION_TIMEOUT_MS) {
      ws.terminate();
      return;
    }
    ws.ping();
  }, PING_INTERVAL_MS);
  pingTimer.unref?.();
  ws.once("close", () => clearInterval(pingTimer));
}

export function startWebSocketServer(port = 3001): WebSocketServer {
  if (serverInstance) return serverInstance;
  const server = new WebSocketServer({
    port,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
    verifyClient: (info, done) => {
      void authorizeUpgrade(info.req)
        .then((claims) => {
          if (!claims) {
            done(false, 401, "Unauthorized");
            return;
          }
          upgradeClaims.set(info.req, claims);
          done(true);
        })
        .catch(() => done(false, 503, "Service unavailable"));
    },
  });
  server.on("connection", (ws, req) => {
    const claims = upgradeClaims.get(req);
    upgradeClaims.delete(req);
    if (!claims) {
      ws.close(4001, "UNAUTHORIZED");
      return;
    }
    attachClient(ws, claims, clientIp(req));
  });
  server.on("error", (error) => console.error("[websocket-server] server error:", error));
  server.on("listening", () =>
    console.info(`[websocket-server] listening on port ${port}`),
  );
  serverInstance = server;
  return server;
}

function hasAllowedOrigin(req: IncomingMessage): boolean {
  return isAllowedBrowserOrigin({
    origin: req.headers.origin,
    host: req.headers.host,
    forwardedHost: typeof req.headers["x-forwarded-host"] === "string"
      ? req.headers["x-forwarded-host"]
      : undefined,
    forwardedProto: typeof req.headers["x-forwarded-proto"] === "string"
      ? req.headers["x-forwarded-proto"]
      : undefined,
  });
}

function clientIp(req: IncomingMessage): string {
  if (process.env.TRUST_PROXY_HEADERS === "true") {
    const forwarded = typeof req.headers["x-real-ip"] === "string"
      ? req.headers["x-real-ip"].trim()
      : "";
    if (isIP(forwarded)) return forwarded;
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function getWebSocketServer(): WebSocketServer | null {
  return serverInstance;
}

export async function closeWebSocketServer(): Promise<void> {
  const server = serverInstance;
  serverInstance = null;
  if (!server) return;
  for (const client of server.clients) client.close(1001, "SERVER_SHUTDOWN");
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
