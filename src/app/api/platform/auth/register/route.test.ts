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
vi.mock("@/lib/redis/client", () => ({ getRedisClient: async () => null }));
vi.mock("@/lib/platform/http", () => ({
  jsonError: (_request: Request, code: string, message: string, status: number, details?: unknown) =>
    Response.json({ code, message, details }, { status }),
  studentCookieHeader: vi.fn(),
}));

import { POST } from "./route";
import { __resetDistributedRateLimitsForTests } from "@/lib/auth/distributed-rate-limit";

function request(body: unknown) {
  return new Request("http://localhost/api/platform/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetDistributedRateLimitsForTests();
});

describe("student registration route", () => {
  it("allows 40 students behind the same IP to register concurrently", async () => {
    mocks.registerStudent.mockImplementation(async (input) => ({
      user: { id: input.username, username: input.username, displayName: input.displayName, sessionVersion: 1 },
      enrollment: { id: `enrollment-${input.username}`, offeringId: "course-1" },
      offering: { id: "course-1" },
    }));

    const responses = await Promise.all(Array.from({ length: 40 }, (_, index) => POST(request({
      invitationCode: "ABC123",
      username: `2026${String(index).padStart(4, "0")}`,
      displayName: `学生${index}`,
      password: "student-pass",
      confirmPassword: "student-pass",
    }))));

    expect(responses.map((response) => response.status)).toEqual(Array(40).fill(201));
    expect(mocks.registerStudent).toHaveBeenCalledTimes(40);
  });

  it("still limits repeated attempts for the same normalized student number", async () => {
    mocks.registerStudent.mockRejectedValue(new Error("Unique constraint failed"));
    const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => POST(request({
      invitationCode: "ABC123",
      username: index % 2 ? " ＳＴＵＤＥＮＴ１ " : "student1",
      displayName: "学生",
      password: "student-pass",
      confirmPassword: "student-pass",
    }))));

    expect(responses.map((response) => response.status)).toEqual([409, 409, 409, 409, 409, 429]);
    expect(responses[5].headers.get("Retry-After")).toBeTruthy();
    expect(mocks.registerStudent).toHaveBeenCalledTimes(5);
  });

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
