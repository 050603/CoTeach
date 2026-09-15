import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateImage: vi.fn(),
  getServerImageProviders: vi.fn(),
  resolveImageApiKey: vi.fn(),
  resolveImageBaseUrl: vi.fn(),
  persistGeneratedClassroomImage: vi.fn(),
  normalizeCourseImageToAspectRatio: vi.fn(),
  plan: vi.fn(),
  createReviewer: vi.fn(),
  review: vi.fn(),
}));

vi.mock("./course-cover-planner-server", () => ({ planCourseCoverImageOnServer: mocks.plan }));

vi.mock("@openmaic/lib/media/image-providers", () => ({
  generateImage: mocks.generateImage,
  IMAGE_PROVIDERS: {
    "openai-image": {
      id: "openai-image",
      requiresApiKey: true,
      models: [{ id: "gpt-image-1", name: "GPT Image" }],
    },
    "qwen-image": {
      id: "qwen-image",
      requiresApiKey: true,
      models: [{ id: "qwen-image-2.0-pro", name: "Qwen Image 2.0 Pro" }],
    },
    lemonade: {
      id: "lemonade",
      requiresApiKey: false,
      models: [{ id: "lemonade", name: "Lemonade" }],
    },
  },
}));
vi.mock("@openmaic/lib/server/provider-config", () => ({
  getServerImageProviders: mocks.getServerImageProviders,
  resolveImageApiKey: mocks.resolveImageApiKey,
  resolveImageBaseUrl: mocks.resolveImageBaseUrl,
}));
vi.mock("@openmaic/lib/server/classroom-media-generation", () => ({
  persistGeneratedClassroomImage: mocks.persistGeneratedClassroomImage,
  normalizeCourseImageToAspectRatio: mocks.normalizeCourseImageToAspectRatio,
}));

import {
  CourseCoverProviderUnavailableError,
  generateCourseCoverImageOnServer,
  persistUploadedCourseCover,
  resolveServerCourseCoverProvider,
} from "@/lib/course-cover-server";

const visualPlan = {
  topicSummary: "自然语言处理中的语义分类",
  visualAnchor: "把不同含义的无字图卡归入对应簇，表达语义分类",
  sceneDescription: "A learner moves a misplaced illustrated card into a matching cluster beside a compact semantic model, viewed from a close oblique angle against a quiet background. All surfaces show only plain shapes.",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getServerImageProviders.mockReturnValue({
    "openai-image": { defaultModel: "gpt-image-1" },
  });
  mocks.resolveImageApiKey.mockReturnValue("server-key");
  mocks.resolveImageBaseUrl.mockReturnValue("https://images.example.test/v1");
  mocks.plan.mockResolvedValue(visualPlan);
  mocks.review.mockResolvedValue(undefined);
  mocks.createReviewer.mockResolvedValue(mocks.review);
  mocks.persistGeneratedClassroomImage.mockImplementation(async (input) => {
    await input.validateBeforePersist?.(Buffer.from("image"));
    return "/api/openmaic/classroom-media/classroom-1/media/course-cover.png";
  });
  mocks.normalizeCourseImageToAspectRatio.mockResolvedValue(Buffer.from("normalized"));
});

describe("server course cover generation", () => {
  it("uses the managed image provider directly without an authenticated HTTP callback", async () => {
    mocks.generateImage.mockResolvedValue({
      url: "https://cdn.example.test/cover.png",
      width: 1024,
      height: 576,
    });

    await expect(generateCourseCoverImageOnServer({
      name: "自然语言处理",
      subject: "人工智能",
      grade: "高中",
    }, "classroom-1")).resolves.toBe(
      "/api/openmaic/classroom-media/classroom-1/media/course-cover.png",
    );

    expect(mocks.generateImage).toHaveBeenCalledWith(
      {
        providerId: "openai-image",
        apiKey: "server-key",
        baseUrl: "https://images.example.test/v1",
        model: "gpt-image-1",
      },
      expect.objectContaining({
        width: 1536,
        height: 1024,
        aspectRatio: "16:9",
        prompt: expect.stringContaining(visualPlan.sceneDescription),
      }),
    );
    expect(mocks.persistGeneratedClassroomImage).toHaveBeenCalledWith(expect.objectContaining({
      classroomId: "classroom-1",
      elementId: "course-cover",
      aspectRatio: "16:9",
      normalizeToAspectRatio: true,
      result: expect.objectContaining({ url: "https://cdn.example.test/cover.png" }),
    }));
    expect(mocks.persistGeneratedClassroomImage.mock.calls[0]?.[0]).not.toHaveProperty(
      "qualityReview",
    );
    expect(mocks.plan).toHaveBeenCalledWith(expect.objectContaining({ name: "自然语言处理" }), expect.any(AbortSignal));
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.plan.mock.invocationCallOrder[0]).toBeLessThan(mocks.generateImage.mock.invocationCallOrder[0]);
    expect(mocks.generateImage.mock.calls[0][1].prompt).not.toContain("自然语言处理");
  });

  it("never generates an image if the text planning stage fails", async () => {
    mocks.plan.mockRejectedValue(Object.assign(new Error("invalid visual plan"), { code: "COURSE_COVER_PLAN_INVALID" }));
    await expect(generateCourseCoverImageOnServer({ name: "课程" }, "classroom-1"))
      .rejects.toMatchObject({ code: "COURSE_COVER_PLAN_INVALID" });
    expect(mocks.generateImage).not.toHaveBeenCalled();
    expect(mocks.persistGeneratedClassroomImage).not.toHaveBeenCalled();
  });

  it("generates once without requiring a vision reviewer", async () => {
    mocks.createReviewer.mockRejectedValue(new Error("no vision model"));
    mocks.generateImage.mockResolvedValue({ base64: "aW1hZ2U=" });
    await expect(generateCourseCoverImageOnServer({ name: "课程" }, "classroom-1"))
      .resolves.toContain("course-cover.png");
    expect(mocks.createReviewer).not.toHaveBeenCalled();
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.plan).toHaveBeenCalledTimes(1);
    expect(mocks.generateImage).toHaveBeenCalledTimes(1);
    expect(mocks.persistGeneratedClassroomImage.mock.calls[0][0]).not.toHaveProperty("validateBeforePersist");
  });

  it("does not redraw an invalid generated file", async () => {
    mocks.generateImage.mockResolvedValue({ base64: "aW1hZ2U=" });
    mocks.persistGeneratedClassroomImage.mockRejectedValue(Object.assign(new Error("图片生成结果格式不受支持"), {
      code: "GENERATED_IMAGE_FORMAT_UNSUPPORTED", isRetryable: false,
    }));
    await expect(generateCourseCoverImageOnServer({ name: "课程" }, "classroom-1"))
      .rejects.toMatchObject({ code: "COURSE_COVER_RESULT_INVALID" });
    expect(mocks.generateImage).toHaveBeenCalledTimes(1);
    expect(mocks.plan).toHaveBeenCalledTimes(1);
  });

  it("stops before drawing when the caller cancels during planning", async () => {
    const controller = new AbortController();
    mocks.plan.mockImplementation(async () => {
      controller.abort();
      return visualPlan;
    });
    await expect(generateCourseCoverImageOnServer({ name: "课程" }, "classroom-1", controller.signal))
      .rejects.toThrow();
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it("uses Qwen Image 2.0 Pro's recommended landscape size without prompt expansion", async () => {
    mocks.getServerImageProviders.mockReturnValue({
      "qwen-image": { defaultModel: "qwen-image-2.0-pro" },
    });
    mocks.generateImage.mockResolvedValue({
      url: "https://cdn.example.test/qwen-cover.png",
      width: 2688,
      height: 1536,
    });

    await generateCourseCoverImageOnServer({ name: "校园雨水花园" }, "classroom-1");

    expect(mocks.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "qwen-image",
        model: "qwen-image-2.0-pro",
      }),
      expect.objectContaining({
        width: 2688,
        height: 1536,
        promptExtend: false,
        seed: expect.any(Number),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("adapts legacy Qwen Image models to their fixed landscape size", async () => {
    mocks.getServerImageProviders.mockReturnValue({
      "qwen-image": { defaultModel: "qwen-image-max" },
    });
    mocks.generateImage.mockResolvedValue({
      url: "https://cdn.example.test/qwen-cover.png",
      width: 1664,
      height: 928,
    });

    await generateCourseCoverImageOnServer({ name: "校园雨水花园" }, "classroom-1");

    expect(mocks.generateImage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ width: 1664, height: 928 }),
    );
  });

  it("reports a generated-image download failure separately from provider generation", async () => {
    mocks.generateImage.mockResolvedValue({
      url: "https://cdn.example.test/expired-cover.png",
      width: 1536,
      height: 1024,
    });
    mocks.persistGeneratedClassroomImage.mockRejectedValue(
      new Error("Generated resource download failed: 403 Forbidden"),
    );

    await expect(generateCourseCoverImageOnServer(
      { name: "校园雨水花园" },
      "classroom-1",
    )).rejects.toMatchObject({
      code: "COURSE_COVER_DOWNLOAD_FAILED",
      status: 502,
      userMessage: expect.stringContaining("服务器无法下载生成结果"),
    });
    expect(mocks.generateImage).toHaveBeenCalledTimes(1);
  });

  it("classifies an invalid Qwen model request as a configuration error", async () => {
    mocks.getServerImageProviders.mockReturnValue({
      "qwen-image": { defaultModel: "qwen-image-2.0-pro" },
    });
    mocks.generateImage.mockRejectedValue(
      Object.assign(new Error("Qwen Image generation failed (400): invalid model"), {
        statusCode: 400,
      }),
    );

    await expect(generateCourseCoverImageOnServer(
      { name: "校园雨水花园" },
      "classroom-1",
    )).rejects.toMatchObject({
      code: "COURSE_COVER_MODEL_INCOMPATIBLE",
      status: 503,
    });
  });

  it("skips configured providers that require a missing key", () => {
    mocks.getServerImageProviders.mockReturnValue({
      "openai-image": { defaultModel: "gpt-image-1" },
      lemonade: { defaultModel: "lemonade" },
    });
    mocks.resolveImageApiKey.mockImplementation((providerId: string) =>
      providerId === "openai-image" ? "" : "",
    );

    expect(resolveServerCourseCoverProvider().providerId).toBe("lemonade");
  });

  it("returns a typed error when no image provider is configured", () => {
    mocks.getServerImageProviders.mockReturnValue({});
    expect(() => resolveServerCourseCoverProvider()).toThrow(CourseCoverProviderUnavailableError);
  });

  it("validates and normalizes uploaded cover images", async () => {
    const file = new File(["image"], "cover.png", { type: "image/png" });
    await persistUploadedCourseCover(file, "classroom-1", "uploaded-cover");

    expect(mocks.persistGeneratedClassroomImage).toHaveBeenCalledWith(
      expect.objectContaining({
        classroomId: "classroom-1",
        elementId: "uploaded-cover",
        result: expect.objectContaining({ width: 1280, height: 720 }),
      }),
    );
  });

  it("rejects unsupported uploaded cover formats", async () => {
    const file = new File(["image"], "cover.gif", { type: "image/gif" });
    await expect(persistUploadedCourseCover(file, "classroom-1", "uploaded-cover"))
      .rejects.toMatchObject({ code: "UNSUPPORTED_IMAGE_TYPE", status: 415 });
    expect(mocks.persistGeneratedClassroomImage).not.toHaveBeenCalled();
  });

  it("supports a versioned filename for offering covers", async () => {
    mocks.generateImage.mockResolvedValue({
      url: "https://cdn.example.test/cover.png",
      width: 1024,
      height: 576,
    });

    await generateCourseCoverImageOnServer(
      { name: "自然语言处理" },
      "offering-offering-1",
      undefined,
      "course-cover-v5",
    );

    expect(mocks.persistGeneratedClassroomImage).toHaveBeenCalledWith(
      expect.objectContaining({
        classroomId: "offering-offering-1",
        elementId: "course-cover-v5",
      }),
    );
  });
});
