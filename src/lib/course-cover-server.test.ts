import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateImage: vi.fn(),
  getServerImageProviders: vi.fn(),
  resolveImageApiKey: vi.fn(),
  resolveImageBaseUrl: vi.fn(),
  persistGeneratedClassroomImage: vi.fn(),
}));

vi.mock("@openmaic/lib/media/image-providers", () => ({
  generateImage: mocks.generateImage,
  IMAGE_PROVIDERS: {
    "openai-image": {
      id: "openai-image",
      requiresApiKey: true,
      models: [{ id: "gpt-image-1", name: "GPT Image" }],
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
}));

import {
  generateCourseCoverImageOnServer,
  resolveServerCourseCoverProvider,
} from "@/lib/course-cover-server";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getServerImageProviders.mockReturnValue({
    "openai-image": { defaultModel: "gpt-image-1" },
  });
  mocks.resolveImageApiKey.mockReturnValue("server-key");
  mocks.resolveImageBaseUrl.mockReturnValue("https://images.example.test/v1");
  mocks.persistGeneratedClassroomImage.mockResolvedValue(
    "/api/openmaic/classroom-media/classroom-1/media/course-cover.png",
  );
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
        width: 1024,
        height: 576,
        aspectRatio: "16:9",
        prompt: expect.stringContaining("自然语言处理"),
      }),
    );
    expect(mocks.persistGeneratedClassroomImage).toHaveBeenCalledWith(expect.objectContaining({
      classroomId: "classroom-1",
      elementId: "course-cover",
      aspectRatio: "16:9",
      result: expect.objectContaining({ url: "https://cdn.example.test/cover.png" }),
    }));
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
});
