import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  csrf: vi.fn(),
  generate: vi.fn(),
}));

vi.mock("@/lib/auth/request-guards", () => ({
  authenticateRequest: mocks.auth,
  requireSameOrigin: mocks.csrf,
}));
vi.mock("@/lib/platform/offering-cover-server", () => ({
  generateOfferingCoverImage: mocks.generate,
}));

import { PlatformError } from "@/lib/platform/repository";
import { POST } from "./route";

const context = { params: Promise.resolve({ offeringId: "offering-1" }) };

function request() {
  return new Request("https://app.test/api/platform/offerings/offering-1/cover", {
    method: "POST",
    headers: { origin: "https://app.test", "x-request-id": "request-1" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.csrf.mockReturnValue(null);
  mocks.auth.mockResolvedValue({ claims: { sub: "teacher-1", role: "teacher" } });
  mocks.generate.mockResolvedValue({
    id: "offering-1",
    version: 5,
    coverImageUrl: "/api/openmaic/classroom-media/offering-offering-1/media/course-cover-v5.webp",
  });
});

describe("offering cover route", () => {
  it("returns the persisted offering and disables private response caching", async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      offering: expect.objectContaining({
        id: "offering-1",
        version: 5,
        coverImageUrl: expect.stringContaining("course-cover-v5.webp"),
      }),
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.auth).toHaveBeenCalledWith(expect.any(Request), "teacher");
  });

  it("enforces same-origin before authentication or generation", async () => {
    mocks.csrf.mockReturnValue(new Response(null, { status: 403 }));
    expect((await POST(request(), context)).status).toBe(403);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("requires an authenticated teacher", async () => {
    mocks.auth.mockResolvedValue({ response: new Response(null, { status: 401 }) });
    expect((await POST(request(), context)).status).toBe(401);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("preserves repository permission and version errors", async () => {
    mocks.generate.mockRejectedValue(
      new PlatformError("VERSION_CONFLICT", "教学班已被其他操作更新", 409),
    );
    const response = await POST(request(), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "VERSION_CONFLICT",
      message: "教学班已被其他操作更新",
      requestId: "request-1",
    });
  });

  it("returns a stable platform error for provider failures", async () => {
    mocks.generate.mockRejectedValue(new Error("provider unavailable"));
    const response = await POST(request(), context);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "OFFERING_COVER_GENERATION_FAILED",
      message: "课程封面生成失败，请稍后重试",
    });
  });
});
