// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  getCourse: vi.fn(),
  updateCourse: vi.fn(),
  generate: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("@/lib/platform/template-access", () => ({
  authorizeTemplateRequest: mocks.authorize,
}));
vi.mock("@/lib/session/server-store", () => ({
  getCourse: mocks.getCourse,
  updateCourse: mocks.updateCourse,
}));
vi.mock("@/lib/course-cover-server", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/course-cover-server")>();
  return {
    ...original,
    generateCourseCoverImageOnServer: mocks.generate,
    persistUploadedCourseCover: mocks.upload,
  };
});

import { POST, PUT } from "./route";
import {
  CourseCoverGenerationError,
  CourseCoverProviderUnavailableError,
} from "@/lib/course-cover-server";

const context = { params: Promise.resolve({ courseId: "template-1" }) };
const course = { id: "template-1", name: "校园雨水花园", version: 7 };

function request(method: "POST" | "PUT", file?: File) {
  const body = method === "PUT" ? new FormData() : undefined;
  if (body && file) body.append("file", file);
  return new Request("https://app.test/api/courses/template-1/cover", {
    method,
    headers: { origin: "https://app.test", "x-request-id": "request-1" },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue("teacher-1");
  mocks.getCourse.mockResolvedValue(course);
  mocks.generate.mockResolvedValue("/api/openmaic/classroom-media/template-cover-template-1/media/classroom-cover-v7.webp");
  mocks.upload.mockResolvedValue("/api/openmaic/classroom-media/template-cover-template-1/media/classroom-cover-upload-v7.webp");
  mocks.updateCourse.mockImplementation(async (_id, updater) => updater(course));
});

describe("classroom cover route", () => {
  it("generates, normalizes and persists a classroom cover", async () => {
    const response = await POST(request("POST"), context);

    expect(response.status).toBe(200);
    expect(mocks.generate).toHaveBeenCalledWith(
      course,
      "template-cover-template-1",
      expect.any(AbortSignal),
      expect.stringMatching(/^classroom-cover-v7-[0-9a-f-]{36}$/),
    );
    expect(mocks.updateCourse).toHaveBeenCalledWith(
      "template-1",
      expect.any(Function),
      { actor: { id: "teacher-1", role: "teacher" } },
    );
    await expect(response.json()).resolves.toMatchObject({
      coverImageUrl: expect.stringContaining("classroom-cover-v7.webp"),
    });
  });

  it("accepts an uploaded classroom cover", async () => {
    const file = new File(["image"], "cover.jpg", { type: "image/jpeg" });
    const response = await PUT(request("PUT", file), context);

    expect(response.status).toBe(200);
    expect(mocks.upload).toHaveBeenCalledWith(
      expect.objectContaining({ name: "cover.jpg" }),
      "template-cover-template-1",
      expect.stringMatching(/^classroom-cover-upload-v7-[0-9a-f-]{36}$/),
    );
  });

  it("preserves authorization failures", async () => {
    mocks.authorize.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await POST(request("POST"), context)).status).toBe(403);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("returns an actionable error when AI image generation is not configured", async () => {
    mocks.generate.mockRejectedValue(new CourseCoverProviderUnavailableError());
    const response = await POST(request("POST"), context);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "COURSE_COVER_PROVIDER_UNAVAILABLE",
      message: expect.stringContaining("配置图片模型，或上传本地图片"),
    });
  });

  it("returns a specific Qwen model configuration error", async () => {
    mocks.generate.mockRejectedValue(new CourseCoverGenerationError(
      "COURSE_COVER_MODEL_INCOMPATIBLE",
      "当前图片模型配置不兼容，请在教师设置中重新选择可用的图片模型",
      503,
      new Error("Qwen Image generation failed (400): invalid model"),
    ));
    const response = await POST(request("POST"), context);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "COURSE_COVER_MODEL_INCOMPATIBLE",
      message: expect.stringContaining("图片模型配置不兼容"),
    });
  });

  it("rejects an upload without a file", async () => {
    const response = await PUT(request("PUT"), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "FILE_REQUIRED" });
  });
});
