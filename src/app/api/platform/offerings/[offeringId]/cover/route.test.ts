// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  csrf: vi.fn(),
  generate: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("@/lib/auth/request-guards", () => ({
  authenticateRequest: mocks.auth,
  requireSameOrigin: mocks.csrf,
}));
vi.mock("@/lib/platform/offering-cover-server", () => ({
  generateOfferingCoverImage: mocks.generate,
  uploadOfferingCoverImage: mocks.upload,
}));

import { PlatformError } from "@/lib/platform/repository";
import {
  CourseCoverGenerationError,
  CourseCoverProviderUnavailableError,
} from "@/lib/course-cover-server";
import { POST, PUT } from "./route";

const context = { params: Promise.resolve({ offeringId: "offering-1" }) };

function request() {
  return new Request("https://app.test/api/platform/offerings/offering-1/cover", {
    method: "POST",
    headers: { origin: "https://app.test", "x-request-id": "request-1" },
  });
}

function uploadRequest(file?: File) {
  const form = new FormData();
  if (file) form.append("file", file);
  return new Request("https://app.test/api/platform/offerings/offering-1/cover", {
    method: "PUT",
    headers: { origin: "https://app.test", "x-request-id": "request-1" },
    body: form,
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
  mocks.upload.mockResolvedValue({
    id: "offering-1",
    version: 5,
    coverImageUrl: "/api/openmaic/classroom-media/offering-offering-1/media/course-cover-upload-v5.webp",
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
      message: "图片生成服务暂时不可用，请稍后重试或上传本地图片",
    });
  });

  it("explains how to recover when no image provider is configured", async () => {
    mocks.generate.mockRejectedValue(new CourseCoverProviderUnavailableError());
    const response = await POST(request(), context);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "COURSE_COVER_PROVIDER_UNAVAILABLE",
      message: expect.stringContaining("配置图片模型，或上传本地图片"),
    });
  });

  it("returns the actionable provider error instead of hiding it", async () => {
    mocks.generate.mockRejectedValue(new CourseCoverGenerationError(
      "COURSE_COVER_TIMEOUT",
      "图片生成超时，请重试或改用本地图片",
      504,
      new DOMException("The operation timed out", "TimeoutError"),
    ));
    const response = await POST(request(), context);

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({
      code: "COURSE_COVER_TIMEOUT",
      message: "图片生成超时，请重试或改用本地图片",
    });
  });

  it("accepts a teacher-uploaded cover image", async () => {
    const file = new File(["image"], "cover.png", { type: "image/png" });
    const response = await PUT(uploadRequest(file), context);

    expect(response.status).toBe(200);
    expect(mocks.upload).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "teacher-1" }),
      "offering-1",
      expect.objectContaining({ name: "cover.png" }),
    );
    await expect(response.json()).resolves.toMatchObject({
      offering: { coverImageUrl: expect.stringContaining("course-cover-upload-v5.webp") },
    });
  });

  it("rejects an upload without a file", async () => {
    const response = await PUT(uploadRequest(), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "FILE_REQUIRED" });
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
