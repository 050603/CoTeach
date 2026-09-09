import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  verifyPassword: vi.fn(),
  hashPassword: vi.fn(),
  signTeacherToken: vi.fn(),
}));

vi.mock("@/lib/auth/request-guards", () => ({ requireSameOrigin: () => null, authenticateRequest: mocks.authenticate }));
vi.mock("@/lib/db/client", () => ({ prisma: { user: { findFirst: mocks.findFirst, update: mocks.update } } }));
vi.mock("@/lib/auth/password", () => ({ verifyPassword: mocks.verifyPassword, hashPassword: mocks.hashPassword }));
vi.mock("@/lib/auth/session", () => ({
  TEACHER_COOKIE_NAME: "openpbl_teacher",
  getAuthCookieOptions: (maxAge: number) => ({ path: "/", maxAge, sameSite: "lax", secure: false }),
  signTeacherToken: mocks.signTeacherToken,
}));

import { PATCH } from "./route";

const user = { id: "teacher-1", username: "teacher.li", displayName: "李老师", passwordHash: "old-hash", sessionVersion: 3 };

function request(body: unknown) {
  return new Request("http://localhost/api/platform/auth/teacher-profile", { method: "PATCH", headers: { "Content-Type": "application/json", Origin: "http://localhost" }, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticate.mockResolvedValue({ claims: { sub: user.id, role: "teacher", username: user.username, displayName: user.displayName, sv: 3 } });
  mocks.findFirst.mockResolvedValue(user);
  mocks.update.mockResolvedValue(user);
  mocks.verifyPassword.mockResolvedValue(true);
  mocks.hashPassword.mockResolvedValue("new-hash");
  mocks.signTeacherToken.mockResolvedValue({ token: "new-token", maxAge: 3600 });
});

describe("teacher profile", () => {
  it("updates the display name and refreshes the teacher cookie", async () => {
    mocks.update.mockResolvedValue({ ...user, displayName: "李明老师" });
    const response = await PATCH(request({ displayName: "李明老师" }));
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: user.id }, data: { displayName: "李明老师" } });
    await expect(response.json()).resolves.toMatchObject({ user: { username: user.username, displayName: "李明老师" } });
    expect(response.headers.get("set-cookie")).toContain("openpbl_teacher=new-token");
  });

  it("verifies the current password and rotates the session version", async () => {
    mocks.update.mockResolvedValue({ ...user, passwordHash: "new-hash", sessionVersion: 4 });
    const response = await PATCH(request({ currentPassword: "current-password", newPassword: "new-password-123", confirmPassword: "new-password-123" }));
    expect(response.status).toBe(200);
    expect(mocks.verifyPassword).toHaveBeenCalledWith("current-password", "old-hash");
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: user.id }, data: { passwordHash: "new-hash", sessionVersion: { increment: 1 } } });
    expect(mocks.signTeacherToken).toHaveBeenCalledWith(expect.objectContaining({ sessionVersion: 4 }));
  });

  it("rejects an incorrect current password without changing the account", async () => {
    mocks.verifyPassword.mockResolvedValue(false);
    const response = await PATCH(request({ currentPassword: "wrong-password", newPassword: "new-password-123", confirmPassword: "new-password-123" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "CURRENT_PASSWORD_INVALID" });
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
