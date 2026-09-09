import { projectGroupStorageId } from "@/lib/platform/group-identity";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  NodeSqliteWrapper,
  SQLiteSyncStorage,
  TLSocketRoom,
} from "@tldraw/sync-core";
// 使用纯 schema 包而非 tldraw 主包:主包依赖 radix-ui 等 React UI 库,
// 会在生产 standalone 的 react-server 条件下于服务端 instrumentation
// 加载时崩溃(createContext is not a function)
import { createTLSchema, type TLRecord } from "@tldraw/tlschema";
import {
  STUDENT_COOKIE_NAME,
  TEACHER_COOKIE_NAME,
  verifyToken,
  type AuthClaims,
  type AuthRole,
} from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { checkDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";
import { hasCurrentSessionVersion } from "@/lib/auth/session-version";
import { websocketConnectionsActive } from "@/lib/observability/metrics";
import { isAllowedBrowserOrigin } from "@/lib/network/request-origin";
import { canAccessLegacyCourse } from "@/lib/platform/access";

type SessionMeta = { userId: string; role: AuthRole; roomKey: string };
type RoomEntry = {
  database: DatabaseSync;
  room: TLSocketRoom<TLRecord, SessionMeta>;
  closeTimer?: NodeJS.Timeout;
};
type AuthorizedUpgrade = {
  claims: AuthClaims;
  courseId: string;
  groupId: string;
  roomKey: string;
  sessionId: string;
  readonly: boolean;
};

const rooms = new Map<string, RoomEntry>();
const upgrades = new WeakMap<IncomingMessage, AuthorizedUpgrade>();
let server: WebSocketServer | null = null;

export function startTldrawSyncServer(port = 3002): WebSocketServer {
  if (server) return server;
  const instance = new WebSocketServer({
    port,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
    verifyClient: (info, done) => {
      void authorizeUpgrade(info.req)
        .then((authorized) => {
          if (!authorized) return done(false, 403, "Forbidden");
          upgrades.set(info.req, authorized);
          done(true);
        })
        .catch(() => done(false, 503, "Service unavailable"));
    },
  });

  instance.on("connection", (socket, request) => {
    const authorized = upgrades.get(request);
    upgrades.delete(request);
    if (!authorized) return socket.close(4001, "UNAUTHORIZED");
    const entry = getRoom(authorized.roomKey);
    if (entry.closeTimer) {
      clearTimeout(entry.closeTimer);
      entry.closeTimer = undefined;
    }
    entry.room.handleSocketConnect({
      sessionId: authorized.sessionId,
      socket,
      isReadonly: authorized.readonly,
      meta: {
        userId: authorized.claims.sub!,
        role: authorized.claims.role,
        roomKey: authorized.roomKey,
      },
    });
    websocketConnectionsActive.inc();
    // Re-check the course gate for an already established whiteboard socket.
    // A lock, enrollment removal, or class completion must stop writes even
    // when the browser keeps the WebSocket open.
    const accessTimer = setInterval(() => {
      void canAccessLegacyCourse(
        authorized.claims,
        authorized.courseId,
        authorized.claims.role === "student" ? "write" : "read",
      ).then((allowed) => {
        if (!allowed && socket.readyState === WebSocket.OPEN) socket.close(4003, "COURSE_FORBIDDEN");
      }).catch(() => {
        if (socket.readyState === WebSocket.OPEN) socket.close(1011, "ACCESS_CHECK_FAILED");
      });
    }, 30_000);
    accessTimer.unref?.();
    socket.once("close", () => clearInterval(accessTimer));
  });
  instance.on("error", (error) =>
    console.error("[tldraw-sync] WebSocket server error:", error),
  );
  server = instance;
  return instance;
}

async function authorizeUpgrade(
  request: IncomingMessage,
): Promise<AuthorizedUpgrade | null> {
  if (!hasAllowedOrigin(request)) return null;
  const url = new URL(request.url ?? "/", "http://tldraw.internal");
  const courseId = url.searchParams.get("courseId");
  const groupId = url.searchParams.get("groupId");
  const sessionId = url.searchParams.get("sessionId") ?? randomUUID();
  const role = url.searchParams.get("role");
  if (
    !courseId ||
    !/^[0-9a-f-]{36}$/i.test(courseId) ||
    !groupId ||
    groupId.length > 128 ||
    (role !== "teacher" && role !== "student") ||
    sessionId.length > 128
  ) {
    return null;
  }

  const claims = await authenticate(request, role);
  if (!claims) return null;
  const limit = await checkDistributedRateLimit({
    namespace: "tldraw-connect",
    key: claims.sub!,
    limit: 10,
    windowSeconds: 60,
  });
  if (!limit.allowed) return null;

  const instance = await prisma.classroomInstance.findUnique({ where: { id: courseId }, select: { activity: { select: { chapter: { select: { offeringId: true } } } } } });
  if (!instance) return null;
  const storedGroupId = projectGroupStorageId(instance.activity.chapter.offeringId, groupId);
  const group = await prisma.projectGroup.findFirst({
    where: { id: storedGroupId, offering: { chapters: { some: { activities: { some: { classroomInstances: { some: { id: courseId } } } } } } } },
    select: { id: true },
  });
  if (!group) return null;
  if (!(await canAccessLegacyCourse(claims, courseId, claims.role === "student" ? "write" : "read"))) {
    return null;
  }

  if (claims.role === "student") {
    if (!claims.sub) return null;
    const member = await prisma.groupMember.findFirst({ where: { groupId: storedGroupId, userId: claims.sub, leftAt: null }, select: { id: true } });
    if (!member) return null;
  }

  return {
    claims,
    courseId,
    groupId,
    roomKey: `${courseId}:${groupId}`,
    sessionId,
    readonly: claims.role === "teacher",
  };
}

function getRoom(roomKey: string): RoomEntry {
  const existing = rooms.get(roomKey);
  if (existing) return existing;
  const directory =
    process.env.WHITEBOARD_DATA_DIR ??
    path.join(process.cwd(), ".openpbl-data", "whiteboards");
  mkdirSync(directory, { recursive: true });
  const fileName = `${createHash("sha256").update(roomKey).digest("hex")}.sqlite`;
  const database = new DatabaseSync(path.join(directory, fileName));
  database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
  const storage = new SQLiteSyncStorage<TLRecord>({
    sql: new NodeSqliteWrapper(database),
  });
  const entry: RoomEntry = {
    database,
    room: new TLSocketRoom<TLRecord, SessionMeta>({
      schema: createTLSchema(),
      storage,
      clientTimeout: 60_000,
      onSessionRemoved: (room, { numSessionsRemaining }) => {
        websocketConnectionsActive.dec();
        if (numSessionsRemaining !== 0) return;
        const current = rooms.get(roomKey);
        if (!current) return;
        current.closeTimer = setTimeout(() => {
          if (room.getNumActiveSessions() !== 0) return;
          room.close();
          current.database.close();
          rooms.delete(roomKey);
        }, 5 * 60_000);
        current.closeTimer.unref?.();
      },
      log: {
        warn: (...args) => console.warn("[tldraw-sync]", ...args),
        error: (...args) => console.error("[tldraw-sync]", ...args),
      },
    }),
  };
  rooms.set(roomKey, entry);
  return entry;
}

async function authenticate(
  request: IncomingMessage,
  role: AuthRole,
): Promise<AuthClaims | null> {
  const cookieName = role === "teacher" ? TEACHER_COOKIE_NAME : STUDENT_COOKIE_NAME;
  const token = readCookie(request.headers.cookie, cookieName);
  if (!token) return null;
  const claims = await verifyToken(token);
  return claims?.role === role && (await hasCurrentSessionVersion(claims))
    ? claims
    : null;
}

function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function hasAllowedOrigin(request: IncomingMessage): boolean {
  return isAllowedBrowserOrigin({
    origin: request.headers.origin,
    host: request.headers.host,
    forwardedHost: typeof request.headers["x-forwarded-host"] === "string"
      ? request.headers["x-forwarded-host"]
      : undefined,
    forwardedProto: typeof request.headers["x-forwarded-proto"] === "string"
      ? request.headers["x-forwarded-proto"]
      : undefined,
  });
}

export async function closeTldrawSyncServer(): Promise<void> {
  const active = server;
  server = null;
  if (active) {
    for (const client of active.clients) client.close(1001, "SERVER_SHUTDOWN");
    await new Promise<void>((resolve) => active.close(() => resolve()));
  }
  for (const entry of rooms.values()) {
    if (entry.closeTimer) clearTimeout(entry.closeTimer);
    entry.room.close();
    entry.database.close();
  }
  rooms.clear();
}
