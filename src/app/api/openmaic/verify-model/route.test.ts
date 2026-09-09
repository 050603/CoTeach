// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  callLLM: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@openmaic/lib/server/resolve-model", () => ({ resolveModel: mocks.resolveModel }));
vi.mock("@openmaic/lib/ai/llm", () => ({ callLLM: mocks.callLLM }));
vi.mock("@openmaic/lib/logger", () => ({
  createLogger: () => ({ error: mocks.logError }),
}));

import { POST } from "./route";

describe("model connection verification errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveModel.mockResolvedValue({
      model: {},
      providerId: "deepseek",
      baseUrl: "https://deployment.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    });
  });

  it("explains that an Alibaba endpoint cannot use a DeepSeek platform key", async () => {
    mocks.callLLM.mockRejectedValue(new Error("Invalid API-key provided"));
    const response = await POST(new Request("http://localhost/api/openmaic/verify-model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek:deepseek-v4-flash" }),
    }) as never);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: "INVALID_REQUEST",
      error: "阿里云 Model Studio 拒绝了当前密钥。",
      details: expect.stringContaining("专属部署、阿里云账号和地域匹配"),
    });
  });
});
