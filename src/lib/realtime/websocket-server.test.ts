// @vitest-environment node

import WebSocket from "ws";
import { canAccessLegacyCourse } from "@/lib/platform/access";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signStudentToken } from "@/lib/auth/session";
import {
  __resetEventBusForTests,
  publishCourseEvent,
} from "./event-bus";
import {
  closeWebSocketServer,
  startWebSocketServer,
} from "./websocket-server";

vi.mock("@/lib/auth/session-version", () => ({
  hasCurrentSessionVersion: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/platform/access", () => ({
  canAccessLegacyCourse: vi.fn(async (_claims: unknown, courseId: string) => ["course-allowed", "course-large-class"].includes(courseId)),
}));

const JWT_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";

describe("realtime WebSocket authorization", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    __resetEventBusForTests();
  });

  afterEach(async () => {
    await closeWebSocketServer();
    delete process.env.JWT_SECRET;
  });

  it("delivers invalidations for the signed student course and rejects another course", async () => {
    const server = startWebSocketServer(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing WebSocket port");

    const { token, cookieName } = await signStudentToken({
      courseId: "course-allowed",
      studentId: "student-1",
      studentName: "Student",
      sessionVersion: 1,
    });
    const headers = { Cookie: `${cookieName}=${encodeURIComponent(token)}` };

    const allowed = new WebSocket(
      `ws://127.0.0.1:${address.port}/ws?role=student`,
      { headers },
    );
    await new Promise<void>((resolve, reject) => {
      allowed.once("open", resolve);
      allowed.once("error", reject);
    });
    const subscribed = waitForMessage(allowed, "subscribed");
    allowed.send(JSON.stringify({ type: "subscribe", courseId: "course-allowed" }));
    await subscribed;

    const courseEvent = waitForMessage(allowed, "course-event");
    await publishCourseEvent("course-allowed", {
      type: "course-updated",
      courseId: "course-allowed",
      at: "2026-07-23T00:00:00.000Z",
    });
    expect(await courseEvent).toMatchObject({
      courseId: "course-allowed",
      event: {
        type: "course-updated",
        at: "2026-07-23T00:00:00.000Z",
      },
    });
    allowed.close();

    const forbidden = new WebSocket(
      `ws://127.0.0.1:${address.port}/ws?role=student`,
      { headers },
    );
    await new Promise<void>((resolve, reject) => {
      forbidden.once("open", resolve);
      forbidden.once("error", reject);
    });
    const forbiddenError = waitForMessage(forbidden, "error");
    forbidden.send(JSON.stringify({ type: "subscribe", courseId: "course-other" }));
    expect(await forbiddenError).toMatchObject({
      code: "COURSE_FORBIDDEN",
    });
  });

  it("closes cleanly when the V2 permission database is unavailable", async () => {
    const server = startWebSocketServer(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing WebSocket port");
    const { token, cookieName } = await signStudentToken({ userId: "student-1", studentName: "Student", sessionVersion: 1 });
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws?role=student`, { headers: { Cookie: `${cookieName}=${encodeURIComponent(token)}` } });
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    vi.mocked(canAccessLegacyCourse).mockRejectedValueOnce(new Error("database unavailable"));
    const response = waitForMessage(socket, "error");
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    socket.send(JSON.stringify({ type: "subscribe", courseId: "course-allowed" }));
    expect(await response).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(await closed).toBe(1011);
  });

  it("fans one projection control event out to more than 30 students within two seconds", async () => {
    const server = startWebSocketServer(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing WebSocket port");

    const sockets = await Promise.all(Array.from({ length: 36 }, async (_, index) => {
      const { token, cookieName } = await signStudentToken({
        courseId: "course-large-class",
        studentId: `student-${index + 1}`,
        studentName: `Student ${index + 1}`,
        sessionVersion: 1,
      });
      const socket = new WebSocket(
        `ws://127.0.0.1:${address.port}/ws?role=student`,
        { headers: { Cookie: `${cookieName}=${encodeURIComponent(token)}` } },
      );
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      const subscribed = waitForMessage(socket, "subscribed");
      socket.send(JSON.stringify({ type: "subscribe", courseId: "course-large-class" }));
      await subscribed;
      return socket;
    }));

    const deliveries = sockets.map((socket) => waitForMessage(socket, "course-event"));
    const startedAt = performance.now();
    await publishCourseEvent("course-large-class", {
      type: "projection-changed",
      courseId: "course-large-class",
      at: "2026-09-07T08:00:00.000Z",
      payload: {
        actionType: "SET_UI_STATE",
        resourceProjection: {
          resourceId: "video-1",
          stageKey: "launch",
          title: "Video",
          startedAt: "2026-09-07T08:00:00.000Z",
          viewState: { mediaTime: 12, mediaPlaying: true, revision: 2 },
        },
      },
    });
    const received = await Promise.all(deliveries);
    const elapsedMs = performance.now() - startedAt;

    expect(received).toHaveLength(36);
    expect(received.every((message) => (
      message.event as { type?: string } | undefined
    )?.type === "projection-changed")).toBe(true);
    expect(elapsedMs).toBeLessThan(2_000);
    for (const socket of sockets) socket.close();
  }, 10_000);
});

function waitForMessage(
  socket: WebSocket,
  type: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 2_000);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type !== type) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}
