// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { signTeacherToken } from "@/lib/auth/session";
import { proxy } from "@/proxy";
import { ACTION_PROXY_STARTED_HEADER, ACTION_PROXY_ENDED_HEADER, actionEntryTimings, isActionTimingRequest } from "./action-entry-timing";
vi.mock("./metrics", () => ({ httpRequestsTotal: { labels: () => ({ inc: vi.fn() }) }, httpRequestDurationSeconds: { labels: () => ({ observe: vi.fn() }) } }));
vi.mock("./logger", () => ({ logger: { info: vi.fn() } }));
import { withHttpMetrics } from "./http";
const secret = process.env.JWT_SECRET;
afterEach(() => { vi.useRealTimers(); if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret; });

describe("action entry timing without auth bypass", () => {
  it("only instruments POST action routes", () => {
    expect(isActionTimingRequest("POST", "/api/courses/course/actions")).toBe(true);
    expect(isActionTimingRequest("GET", "/api/courses/course/actions")).toBe(false);
    expect(isActionTimingRequest("POST", "/api/uploads")).toBe(false);
    expect(isActionTimingRequest("POST", "/api/courses/course/actions/extra")).toBe(false);
  });
  it("overwrites forged clocks and preserves authentication, request headers and CSP", async () => {
    process.env.JWT_SECRET = "action-timing-unit-secret-with-at-least-32-characters";
    const signed = await signTeacherToken({ teacherId: "teacher", username: "teacher", displayName: "Teacher", sessionVersion: 1 });
    const headers = { cookie: `${signed.cookieName}=${signed.token}`, "content-type": "application/json", "x-openpbl-role": "teacher", [ACTION_PROXY_STARTED_HEADER]: "1", [ACTION_PROXY_ENDED_HEADER]: "9999999999999" };
    const request = new NextRequest("http://localhost/api/courses/course/actions", { method: "POST", headers, body: "{}" });
    const before = Date.now(); const response = await proxy(request); const after = Date.now();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    const started = Number(response.headers.get(`x-middleware-request-${ACTION_PROXY_STARTED_HEADER}`));
    const ended = Number(response.headers.get(`x-middleware-request-${ACTION_PROXY_ENDED_HEADER}`));
    expect(started).toBeGreaterThanOrEqual(before); expect(ended).toBeGreaterThanOrEqual(started); expect(ended).toBeLessThanOrEqual(after);
    expect(response.headers.get("x-middleware-request-content-type")).toBe("application/json");
    expect(response.headers.get("x-middleware-request-cookie")).toBe(headers.cookie);
    expect(response.headers.get("Content-Security-Policy")).toContain("connect-src");
    const denied = await proxy(new NextRequest(request.url, { method: "POST", headers: { [ACTION_PROXY_STARTED_HEADER]: "1", [ACTION_PROXY_ENDED_HEADER]: "2" } }));
    expect(denied.status).toBe(401); expect(denied.headers.get("x-middleware-next")).toBeNull();
  });
  it("appends paired outer durations without replacing existing phase, cache or response headers", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const wrapped = withHttpMetrics("POST", "/api/courses/:courseId/actions", async () => Response.json({ ok: true }, { headers: { "Server-Timing": "write;dur=5", "Cache-Control": "no-store", "X-Test": "preserved" } }));
    const response = await wrapped(new Request("http://localhost/api/courses/course/actions", { method: "POST", headers: { [ACTION_PROXY_STARTED_HEADER]: "9900", [ACTION_PROXY_ENDED_HEADER]: "9920" } }));
    expect(response.headers.get("Server-Timing")).toMatch(/^write;dur=5, proxy;dur=20\.00, dispatch;dur=80\.00, handler;dur=/);
    expect(response.headers.get("Cache-Control")).toBe("no-store"); expect(response.headers.get("X-Test")).toBe("preserved");
    expect(await response.json()).toEqual({ ok: true });
  });
  it("does not fabricate missing, reversed or implausibly old clock measurements", () => {
    expect(actionEntryTimings(new Headers(), 1000)).toEqual([]);
    expect(actionEntryTimings(new Headers({ [ACTION_PROXY_STARTED_HEADER]: "200", [ACTION_PROXY_ENDED_HEADER]: "100" }), 1000)).toEqual([]);
    expect(actionEntryTimings(new Headers({ [ACTION_PROXY_STARTED_HEADER]: "100", [ACTION_PROXY_ENDED_HEADER]: "200" }), 200000)).toEqual([]);
  });
});
