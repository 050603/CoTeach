// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readAuth: vi.fn(),
  currentVersion: vi.fn(),
}));

vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return { ...actual, readAuthFromRequest: mocks.readAuth };
});
vi.mock("@/lib/auth/session-version", () => ({
  hasCurrentSessionVersion: mocks.currentVersion,
}));

import { authenticateRequest } from "./request-guards";

describe("platform authentication failure", () => {
  beforeEach(() => {
    mocks.readAuth.mockReset();
    mocks.currentVersion.mockReset();
  });

  it("clears a stale role cookie so the page guard cannot loop", async () => {
    mocks.readAuth.mockResolvedValue({ sub: "removed-teacher", role: "teacher", sv: 1 });
    mocks.currentVersion.mockResolvedValue(false);

    const result = await authenticateRequest(new Request("http://localhost/api/platform/offerings"), "teacher");

    expect("response" in result).toBe(true);
    if (!("response" in result)) return;
    expect(result.response.status).toBe(401);
    expect(result.response.headers.get("set-cookie")).toContain("openpbl_teacher=");
    expect(result.response.headers.get("set-cookie")).toContain("Max-Age=0");
    await expect(result.response.json()).resolves.toMatchObject({
      code: "UNAUTHORIZED",
      message: "登录状态已失效，请重新登录。",
    });
  });
});
