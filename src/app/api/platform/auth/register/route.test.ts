import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  registerStudent: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ isAuthConfigured: () => true }));
vi.mock("@/lib/db/client", () => ({ isDatabaseConfigured: () => true }));
vi.mock("@/lib/auth/request-guards", () => ({ requireSameOrigin: () => null }));
vi.mock("@/lib/platform/repository", () => ({
  PlatformError: class PlatformError extends Error {},
  registerStudent: mocks.registerStudent,
}));
vi.mock("@/lib/auth/distributed-rate-limit", () => ({
  checkDistributedRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  resetDistributedRateLimit: vi.fn(),
}));
vi.mock("@/lib/auth/rate-limit", () => ({
  getClientIp: () => "127.0.0.1",
  rateLimitedResponse: vi.fn(),
}));
vi.mock("@/lib/platform/http", () => ({
  jsonError: (_request: Request, code: string, message: string, status: number, details?: unknown) =>
    Response.json({ code, message, details }, { status }),
  studentCookieHeader: vi.fn(),
}));

import { POST } from "./route";

function request(body: unknown) {
  return new Request("http://localhost/api/platform/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("student registration route", () => {
  it("rejects mismatched password confirmation before creating the account", async () => {
    const response = await POST(request({
      invitationCode: "ABC123",
      username: "20260001",
      displayName: "王同学",
      password: "student-pass",
      confirmPassword: "different-pass",
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "INVALID_REGISTRATION",
      details: {
        fieldErrors: {
          confirmPassword: ["两次输入的密码不一致"],
        },
      },
    });
    expect(mocks.registerStudent).not.toHaveBeenCalled();
  });
});
