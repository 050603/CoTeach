// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unlink } from "node:fs/promises";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  storedNames: [] as string[],
  uploadFileCreate: vi.fn(),
  courseResourceCreate: vi.fn(),
  courseUpdate: vi.fn(),
  courseEventCreate: vi.fn(),
  publishCourseEvent: vi.fn(),
  courseCount: vi.fn(),
  transaction: vi.fn(),
  uploadScope: vi.fn(),
  fileTypeFromBuffer: vi.fn(async () => ({ ext: "png", mime: "image/png" }) as { ext: string; mime: string } | null),
  convertPresentationToPdf: vi.fn(async ({ targetPath }: { targetPath: string }) => {
    await (await import("node:fs/promises")).writeFile(targetPath, "%PDF-preview");
    return { size: 12, mimeType: "application/pdf" as const };
  }),
}));

vi.mock("@/lib/auth/request-guards", () => ({
  authenticateRequest: vi.fn(async () => ({ claims: { sub: "teacher-1", role: "teacher", sv: 1 } })),
  requireSameOrigin: vi.fn(() => null),
}));

vi.mock("@/lib/auth/distributed-rate-limit", () => ({
  checkDistributedRateLimit: vi.fn(async () => ({ allowed: true, retryAfterMs: 0 })),
}));

vi.mock("@/lib/auth/rate-limit", () => ({ rateLimitedResponse: vi.fn() }));

vi.mock("file-type", () => ({
  fileTypeFromBuffer: mocks.fileTypeFromBuffer,
}));

vi.mock("@/lib/uploads/presentation-converter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/uploads/presentation-converter")>()),
  convertPresentationToPdf: mocks.convertPresentationToPdf,
}));

vi.mock("@/lib/db/client", () => ({
  isDatabaseConfigured: () => true,
  prisma: {
    courseOffering: { count: mocks.courseCount },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/realtime/event-bus", () => ({
  publishCourseEvent: mocks.publishCourseEvent,
}));

vi.mock("@/lib/platform/access", () => ({ canAccessLegacyCourse: vi.fn(async () => true) }));

vi.mock("@/lib/uploads/scope", () => ({ resolveUploadScope: mocks.uploadScope }));

import { POST } from "./route";

const courseId = "course-1";

describe("teacher course resource upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storedNames.length = 0;
    mocks.courseCount.mockResolvedValue(1);
    mocks.uploadScope.mockResolvedValue({ offeringId: "course-1", templateOwnerId: null });
    process.env.NEXT_PUBLIC_OPENPBL_SYSTEM_MODE = "new";
    process.env.OPENPBL_PPTX_CLASSROOM_CONVERSION_ENABLED = "true";
    mocks.fileTypeFromBuffer.mockResolvedValue({ ext: "png", mime: "image/png" });
    mocks.uploadFileCreate.mockImplementation(async ({ data }: { data: { storageKey: string } }) => {
      mocks.storedNames.push(data.storageKey);
      return { id: data.storageKey, ...data };
    });
    mocks.courseResourceCreate.mockResolvedValue({});
    mocks.courseUpdate.mockResolvedValue({ version: 7 });
    mocks.courseEventCreate.mockResolvedValue({ id: "event-41" });
    mocks.publishCourseEvent.mockResolvedValue(undefined);
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      fileAsset: { create: mocks.uploadFileCreate },
      resource: { create: mocks.courseResourceCreate },
      courseOffering: { update: mocks.courseUpdate },
      domainEvent: { create: mocks.courseEventCreate },
    }));
  });

  it("accepts a UTF-8 source file as an archived student outcome", async () => {
    mocks.fileTypeFromBuffer.mockResolvedValueOnce(null);
    const form = new FormData();
    form.append("file", new File(["print('hello')\n"], "prototype.py", { type: "text/x-python" }));
    form.append("courseId", courseId);

    const response = await POST(new Request("http://localhost:3000/api/uploads", {
      method: "POST",
      headers: { Origin: "http://localhost:3000" },
      body: form,
    }));
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload).toMatchObject({ fileName: "prototype.py", fileType: "PY" });
    expect(mocks.uploadFileCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ mimeType: "text/x-python", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    });
  });
  it("stores a resource package as a private template input with course provenance", async () => {
    mocks.fileTypeFromBuffer.mockResolvedValueOnce({ ext: "zip", mime: "application/zip" });
    mocks.uploadScope.mockResolvedValueOnce({ offeringId: null, templateOwnerId: "teacher-1", templateId: courseId });
    const form = new FormData();
    form.append("file", new File(["PK package"], "完整资源包.zip", { type: "application/zip" }));
    form.append("courseId", courseId);
    form.append("purpose", "course-resource-package");
    const response = await POST(new Request("http://localhost:3000/api/uploads", { method: "POST", headers: { Origin: "http://localhost:3000" }, body: form }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ purpose: "course-resource-package", boundToCourse: false });
    expect(mocks.uploadFileCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ offeringId: null, regenerationRecipe: { schemaVersion: 1, operation: "course-resource-package-upload", courseId } }) });
    expect(mocks.courseResourceCreate).not.toHaveBeenCalled();
  });
  it("rejects publishing the original ZIP as a student classroom resource", async () => {
    const form = new FormData();
    form.append("file", new File(["PK package"], "完整资源包.zip", { type: "application/zip" }));
    form.append("courseId", courseId);
    form.append("purpose", "course-resource-package");
    form.append("bindAsCourseResource", "true");
    const response = await POST(new Request("http://localhost:3000/api/uploads", { method: "POST", headers: { Origin: "http://localhost:3000" }, body: form }));
    expect(response.status).toBe(400);
    expect(mocks.uploadFileCreate).not.toHaveBeenCalled();
  });

  it("stores a teacher knowledge file as a private generation reference", async () => {
    mocks.fileTypeFromBuffer.mockResolvedValueOnce(null);
    const form = new FormData();
    form.append("file", new File(["核心概念与课程边界"], "课程资料.md", { type: "text/markdown" }));
    form.append("courseId", courseId);
    form.append("purpose", "generation-reference");

    const response = await POST(new Request("http://localhost:3000/api/uploads", {
      method: "POST",
      headers: { Origin: "http://localhost:3000" },
      body: form,
    }));
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload).toMatchObject({
      fileName: "课程资料.md",
      purpose: "generation-reference",
      boundToCourse: false,
    });
    expect(mocks.uploadFileCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        offeringId: courseId,
      }),
    });
    expect(mocks.courseResourceCreate).not.toHaveBeenCalled();
  });

  afterEach(async () => {
    await Promise.all(mocks.storedNames.map((storedName) =>
      unlink(path.resolve(".openpbl-data", "uploads", storedName)).catch(() => undefined),
    ));
  });

  it("accepts a legacy string course id and atomically binds the file to the course", async () => {
    const form = new FormData();
    form.append("file", new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], "project.png", { type: "image/png" }));
    form.append("title", "项目图片");
    form.append("courseId", courseId);
    form.append("bindAsCourseResource", "true");
    form.append("stageKey", "showcase");
    const request = new Request("http://localhost:3000/api/uploads", {
      method: "POST",
      headers: { Origin: "http://localhost:3000" },
      body: form,
    });

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload).toMatchObject({ title: "项目图片", fileType: "PNG", boundToCourse: true });
    expect(mocks.uploadFileCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ offeringId: courseId }),
    });
    expect(mocks.courseResourceCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ id: payload.id, offeringId: courseId, title: "项目图片", metadata: { stageKey: "showcase" } }),
    });
    expect(mocks.courseUpdate).toHaveBeenCalledWith({
      where: { id: courseId },
      data: { version: { increment: 1 } },
      select: { version: true },
    });
    expect(mocks.courseEventCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ offeringId: courseId, payload: { source: "resource-upload", offeringVersion: 7 } }),
    }));
    expect(mocks.publishCourseEvent).toHaveBeenCalledWith(
      courseId,
      expect.objectContaining({ payload: expect.objectContaining({ eventCursor: "event-41" }) }),
    );
  });

  it("streams classroom video uploads without multipart parsing", async () => {
    mocks.fileTypeFromBuffer.mockResolvedValueOnce({ ext: "mp4", mime: "video/mp4" });
    const response = await POST(new Request("http://localhost:3000/api/uploads", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "video/mp4",
        "Content-Length": "12",
        "X-OpenPBL-Upload-Mode": "stream",
        "X-Upload-File-Name": encodeURIComponent("课堂实验.mp4"),
        "X-Upload-Title": encodeURIComponent("课堂实验.mp4"),
        "X-Upload-Course-Id": courseId,
        "X-Upload-Stage-Key": "launch",
        "X-Upload-Bind-Course-Resource": "true",
      },
      body: Uint8Array.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109]),
    }));
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload).toMatchObject({ fileName: "课堂实验.mp4", fileType: "MP4", sizeBytes: 12, boundToCourse: true });
    expect(mocks.uploadFileCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ mimeType: "video/mp4", size: BigInt(12), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    });
    expect(mocks.courseResourceCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ offeringId: courseId, metadata: { stageKey: "launch" }, type: "MP4" }),
    });
  });

  it("rejects and removes a video when an upstream truncates its body", async () => {
    const response = await POST(new Request("http://localhost:3000/api/uploads", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "video/mp4",
        "Content-Length": "60",
        "X-OpenPBL-Upload-Mode": "stream",
        "X-Upload-File-Name": "lesson.mp4",
        "X-Upload-Course-Id": courseId,
        "X-Upload-Stage-Key": "launch",
        "X-Upload-Bind-Course-Resource": "true",
      },
      body: Uint8Array.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109]),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "UPLOAD_INCOMPLETE" });
    expect(mocks.uploadFileCreate).not.toHaveBeenCalled();
  });

  it("preserves a PPTX source and binds its generated PDF classroom preview", async () => {
    mocks.fileTypeFromBuffer.mockResolvedValueOnce({
      ext: "pptx",
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    const form = new FormData();
    form.append("file", new File(["pptx-package"], "课堂演示.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }));
    form.append("courseId", courseId);
    form.append("bindAsCourseResource", "true");
    form.append("stageKey", "showcase");

    const response = await POST(new Request("http://localhost:3000/api/uploads", {
      method: "POST",
      headers: { Origin: "http://localhost:3000" },
      body: form,
    }));
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload).toMatchObject({
      fileType: "PPTX",
      convertedToPdf: true,
      previewType: "PDF",
      previewUrl: expect.stringContaining("?variant=classroom"),
    });
    expect(mocks.convertPresentationToPdf).toHaveBeenCalledWith({
      sourcePath: expect.stringMatching(/\.pptx$/),
      targetPath: expect.stringMatching(/\.classroom\.pdf$/),
    });
    expect(mocks.uploadFileCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        originalName: "课堂演示.pptx.pdf",
        storageKey: expect.stringMatching(/\.classroom\.pdf$/),
        mimeType: "application/pdf",
        size: BigInt(12),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        assetRole: "CLASSROOM_PREVIEW",
        backupPolicy: "REGENERATE",
        sourceAssetId: payload.id,
        regenerationRecipe: expect.objectContaining({ operation: "presentation-to-pdf" }),
      }),
    });
    expect(mocks.courseResourceCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "PPTX",
        fileAssetId: payload.id,
        metadata: expect.objectContaining({ previewType: "PDF", previewAssetId: expect.any(String), previewUrl: `/api/uploads/${payload.id}?variant=classroom` }),
      }),
    });
  });

  it("accepts a private replacement PPTX for a course template and generates its classroom preview", async () => {
    process.env.OPENPBL_PPTX_CLASSROOM_CONVERSION_ENABLED = "false";
    mocks.fileTypeFromBuffer.mockResolvedValueOnce({ ext: "pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
    mocks.uploadScope.mockResolvedValueOnce({ offeringId: null, templateOwnerId: "teacher-1", templateId: courseId });
    const form = new FormData();
    form.append("file", new File(["pptx-package"], "新版启动课件.pptx", { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }));
    form.append("courseId", courseId);
    form.append("purpose", "launch-presentation-replacement");
    const response = await POST(new Request("http://localhost:3000/api/uploads", { method: "POST", headers: { Origin: "http://localhost:3000" }, body: form }));
    const payload = await response.json();
    expect(response.status).toBe(201);
    expect(payload).toMatchObject({ convertedToPdf: true, previewType: "PDF", boundToCourse: false });
    expect(mocks.convertPresentationToPdf).toHaveBeenCalledOnce();
    expect(mocks.uploadFileCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      id: payload.id,
      regenerationRecipe: { schemaVersion: 1, operation: "launch-presentation-replacement", courseId },
    }) });
    expect(mocks.courseResourceCreate).not.toHaveBeenCalled();
  });

  it("stores slide playback mode for a teacher-exported presentation PDF", async () => {
    mocks.fileTypeFromBuffer.mockResolvedValueOnce({ ext: "pdf", mime: "application/pdf" });
    const form = new FormData();
    form.append("file", new File(["%PDF-1.7\npresentation"], "课堂演示.pdf", {
      type: "application/pdf",
    }));
    form.append("courseId", courseId);
    form.append("bindAsCourseResource", "true");
    form.append("stageKey", "launch");
    form.append("pdfDisplayMode", "slides");

    const response = await POST(new Request("http://localhost:3000/api/uploads", {
      method: "POST",
      headers: { Origin: "http://localhost:3000" },
      body: form,
    }));
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload).toMatchObject({ fileType: "PDF", displayMode: "slides" });
    expect(mocks.courseResourceCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "PDF",
        metadata: { stageKey: "launch", displayMode: "slides" },
      }),
    });
  });

  it("requires a teacher-exported PDF when automatic PPTX conversion is disabled", async () => {
    process.env.OPENPBL_PPTX_CLASSROOM_CONVERSION_ENABLED = "false";
    const form = new FormData();
    form.append("file", new File(["pptx-package"], "需要保真.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }));
    form.append("courseId", courseId);
    form.append("bindAsCourseResource", "true");
    form.append("stageKey", "launch");

    const response = await POST(new Request("http://localhost:3000/api/uploads", {
      method: "POST",
      headers: { Origin: "http://localhost:3000" },
      body: form,
    }));
    const payload = await response.json();

    expect(response.status).toBe(415);
    expect(payload).toMatchObject({
      code: "PPTX_CLASSROOM_REQUIRES_PDF",
      message: expect.stringContaining("导出 PDF"),
    });
    expect(mocks.convertPresentationToPdf).not.toHaveBeenCalled();
    expect(mocks.uploadFileCreate).not.toHaveBeenCalled();
  });

  it("returns a diagnosable server error when database binding fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.transaction.mockRejectedValueOnce(new Error("database unavailable"));
    const form = new FormData();
    form.append("file", new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], "project.png", { type: "image/png" }));
    form.append("courseId", courseId);
    form.append("bindAsCourseResource", "true");

    const response = await POST(new Request("http://localhost:3000/api/uploads", {
      method: "POST",
      headers: { Origin: "http://localhost:3000", "x-request-id": "upload-test-500" },
      body: form,
    }));
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload).toEqual({
      code: "UPLOAD_SERVICE_ERROR",
      message: "上传服务暂时不可用，请稍后重试。",
      requestId: "upload-test-500",
    });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"requestId":"upload-test-500"'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"failureStage":"bind-database"'));
    errorSpy.mockRestore();
  });
});
