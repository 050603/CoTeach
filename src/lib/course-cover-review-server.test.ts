import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const mocks = vi.hoisted(() => ({
  callLLM: vi.fn(), resolveModel: vi.fn(), getServerProviders: vi.fn(),
  findServerDefaultModelString: vi.fn(), getStageRoute: vi.fn(), getModelInfo: vi.fn(),
  qwenReview: vi.fn(),
}));
vi.mock("@openmaic/lib/server/classroom-media-generation", () => ({ reviewGeneratedCourseImage: mocks.qwenReview }));
vi.mock("@openmaic/lib/ai/llm", () => ({ callLLM: mocks.callLLM }));
vi.mock("@openmaic/lib/ai/providers", () => ({
  getModelInfo: mocks.getModelInfo,
  parseModelString: (value: string) => { const [providerId, modelId] = value.split(":"); return { providerId, modelId }; },
}));
vi.mock("@openmaic/lib/server/model-routes", () => ({ getStageRoute: mocks.getStageRoute }));
vi.mock("@openmaic/lib/server/provider-config", () => ({
  getServerProviders: mocks.getServerProviders,
  findServerDefaultModelString: mocks.findServerDefaultModelString,
}));
vi.mock("@openmaic/lib/server/resolve-model", () => ({ resolveModel: mocks.resolveModel }));

import { createCourseCoverImageReviewer } from "./course-cover-review-server";

const imageBuffer = () => sharp({ create: { width: 1600, height: 900, channels: 3, background: "white" } }).png().toBuffer();

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getServerProviders.mockReturnValue({ managed: { defaultModel: "text", models: ["text", "vision", "vision-alternate"] } });
  mocks.findServerDefaultModelString.mockReturnValue("managed:text");
  mocks.getModelInfo.mockImplementation((_provider, model: string) => ({ capabilities: { vision: model.startsWith("vision") } }));
  mocks.resolveModel.mockResolvedValue({ model: "resolved-vision", modelInfo: { capabilities: { vision: true } } });
  mocks.callLLM.mockResolvedValue({ text: '{"pass":true,"issues":[]}' });
});

describe("course cover image quality reviewer", () => {
  it("selects a configured vision model when the default model is text-only and sends the normalized image", async () => {
    const review = await createCourseCoverImageReviewer("A student observes roots filtering rainwater.");
    await review(await imageBuffer());
    expect(mocks.resolveModel).toHaveBeenCalledWith({ modelString: "managed:vision", stage: "course-cover-review" });
    const request = mocks.callLLM.mock.calls[0][0];
    expect(request.messages[0].content.find((part: { type: string }) => part.type === "text").text).toContain("A student observes roots filtering rainwater.");
    expect(request.messages[0].content.filter((part: { type: string }) => part.type === "file")).toHaveLength(5);
    const metadata = await sharp(request.messages[0].content[0].data).metadata();
    expect(metadata).toMatchObject({ width: 1280, format: "jpeg" });
    expect(request).toMatchObject({ maxRetries: 0, abortSignal: expect.any(AbortSignal) });
  });

  it("honors an explicit vision review route", async () => {
    mocks.getStageRoute.mockReturnValue({ model: "managed:vision-alternate" });
    await createCourseCoverImageReviewer("planned scene");
    expect(mocks.resolveModel).toHaveBeenCalledWith({ modelString: "managed:vision-alternate", stage: "course-cover-review" });
  });

  it("prefers a configured default vision model over other candidates", async () => {
    mocks.findServerDefaultModelString.mockReturnValue("managed:vision-alternate");
    await createCourseCoverImageReviewer("planned scene");
    expect(mocks.resolveModel).toHaveBeenCalledWith(expect.objectContaining({ modelString: "managed:vision-alternate" }));
  });

  it("fails explicitly for a text-only route rather than silently overriding operator intent", async () => {
    mocks.getStageRoute.mockReturnValue({ model: "managed:text" });
    await expect(createCourseCoverImageReviewer("planned scene")).rejects.toMatchObject({ code: "COURSE_COVER_REVIEW_UNAVAILABLE" });
    expect(mocks.resolveModel).not.toHaveBeenCalled();
  });

  it("does not select an unconfigured catalog vision model", async () => {
    mocks.getServerProviders.mockReturnValue({ managed: { models: ["text"], defaultModel: "text" } });
    await expect(createCourseCoverImageReviewer("planned scene")).rejects.toMatchObject({ code: "COURSE_COVER_REVIEW_UNAVAILABLE" });
  });

  it.each([
    '{"pass":false,"issues":["上方有标题文字"]}',
    '{"pass":true,"issues":["上方有标题文字"]}',
  ])("rejects images with concrete quality issues: %s", async (text) => {
    mocks.callLLM.mockResolvedValue({ text });
    const review = await createCourseCoverImageReviewer("planned scene");
    await expect(review(await imageBuffer())).rejects.toMatchObject({ code: "COURSE_COVER_QUALITY_REJECTED", issues: ["上方有标题文字"] });
  });

  it.each(["invalid", '{"pass":true}', '{"pass":"true","issues":[]}', '{"pass":true,"issues":[null]}'])
    ("treats malformed reviews as service failures rather than reasons to regenerate: %s", async (text) => {
      mocks.callLLM.mockResolvedValue({ text });
      const review = await createCourseCoverImageReviewer("planned scene");
      await expect(review(await imageBuffer())).rejects.toMatchObject({ code: "COURSE_COVER_REVIEW_FAILED" });
    });

  it("classifies provider failures separately from quality rejection", async () => {
    mocks.callLLM.mockRejectedValue(new Error("service unavailable"));
    const review = await createCourseCoverImageReviewer("planned scene");
    await expect(review(await imageBuffer())).rejects.toMatchObject({ code: "COURSE_COVER_REVIEW_FAILED", issues: [] });
  });

  it("propagates user cancellation without misclassifying the image", async () => {
    const controller = new AbortController();
    const review = await createCourseCoverImageReviewer("planned scene", controller.signal);
    const reason = new DOMException("Cancelled", "AbortError");
    controller.abort(reason);
    await expect(review(await imageBuffer())).rejects.toBe(reason);
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it("combines caller cancellation with its own 60-second review deadline", async () => {
    const controller = new AbortController();
    const deadline = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    try {
      const review = await createCourseCoverImageReviewer("planned scene", controller.signal);
      mocks.callLLM.mockImplementation(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
        deadline.abort(new DOMException("Review deadline reached", "TimeoutError"));
        expect(abortSignal.aborted).toBe(true);
        abortSignal.throwIfAborted();
      });
      await expect(review(await imageBuffer())).rejects.toMatchObject({ code: "COURSE_COVER_REVIEW_FAILED" });
      expect(timeoutSpy).toHaveBeenCalledWith(60_000);
      expect(controller.signal.aborted).toBe(false);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("rejects work before model resolution when already cancelled", async () => {
    await expect(createCourseCoverImageReviewer("planned scene", AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.resolveModel).not.toHaveBeenCalled();
  });
});

describe("managed Qwen cover review", () => {
  const config = { providerId: "qwen-image" as const, apiKey: "test-key" };

  it("uses the existing managed vision service instead of a listed experimental text-provider model", async () => {
    mocks.qwenReview.mockResolvedValue(undefined);
    const review = await createCourseCoverImageReviewer("No text", undefined, config);
    await review(await imageBuffer());
    expect(mocks.qwenReview).toHaveBeenCalledWith(expect.objectContaining({ ...config, requirement: "No text" }));
    expect(mocks.resolveModel).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it("keeps explicit review routes authoritative for Qwen images", async () => {
    mocks.getStageRoute.mockReturnValue({ model: "test:vision" });
    mocks.getServerProviders.mockReturnValue({ test: { models: ["vision"] } });
    const review = await createCourseCoverImageReviewer("No text", undefined, config);
    await review(await imageBuffer());
    expect(mocks.callLLM).toHaveBeenCalled();
    expect(mocks.qwenReview).not.toHaveBeenCalled();
  });

  it("preserves visual feedback and distinguishes a review outage", async () => {
    const review = await createCourseCoverImageReviewer("No text", undefined, config);
    mocks.qwenReview.mockRejectedValueOnce(Object.assign(new Error("rejected"), {
      code: "GENERATED_IMAGE_QUALITY_REJECTED", issues: ["标题文字"],
    }));
    await expect(review(await imageBuffer())).rejects.toMatchObject({
      code: "COURSE_COVER_QUALITY_REJECTED", issues: ["标题文字"],
    });
    mocks.qwenReview.mockRejectedValueOnce(Object.assign(new Error("model unavailable"), { code: "GENERATED_IMAGE_REVIEW_FAILED" }));
    await expect(review(await imageBuffer())).rejects.toMatchObject({ code: "COURSE_COVER_REVIEW_FAILED" });
  });
});
