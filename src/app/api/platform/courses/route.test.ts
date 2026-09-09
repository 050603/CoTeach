import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth }));
vi.mock("@/lib/platform/repository", () => ({
  listStudentOfferings: mocks.list,
  PlatformError: class PlatformError extends Error {},
}));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({
    claims: { sub: "student-1", role: "student", studentName: "林晓雨", sv: 1 },
  });
  mocks.list.mockResolvedValue([{ id: "course-1", name: "城市生态" }]);
});

describe("student courses route", () => {
  it("returns the viewer with the backward-compatible courses payload", async () => {
    const response = await GET(new Request("https://app.test/api/platform/courses"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      courses: [{ id: "course-1", name: "城市生态" }],
      viewer: { displayName: "林晓雨" },
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
