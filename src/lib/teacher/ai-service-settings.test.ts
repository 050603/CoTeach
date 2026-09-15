import { describe, expect, it } from "vitest";

import {
  getProviderConnectionPresentation,
  getProviderCredentialError,
  getProviderModelError,
  getProviderStatePresentation,
} from "./ai-service-settings";

describe("getProviderStatePresentation", () => {
  it("marks providers without saved credentials as unconfigured", () => {
    expect(getProviderStatePresentation({ requiresApiKey: true })).toEqual({
      label: "未配置",
      tone: "neutral",
      model: undefined,
    });
  });

  it("keeps no-key providers distinct from configured providers", () => {
    expect(getProviderStatePresentation({ requiresApiKey: false })).toEqual({
      label: "无需密钥",
      tone: "info",
      model: undefined,
    });
  });

  it("shows the active model without changing the configured label", () => {
    expect(getProviderStatePresentation({
      requiresApiKey: true,
      saved: {
        hasApiKey: true,
        defaultModel: "provider/a-very-long-model-name-that-must-not-wrap",
        priority: 2,
      },
    })).toEqual({
      label: "已配置",
      tone: "success",
      model: "provider/a-very-long-model-name-that-must-not-wrap",
    });
  });

  it("marks the highest-priority configured provider as default", () => {
    expect(getProviderStatePresentation({
      requiresApiKey: true,
      saved: {
        hasApiKey: true,
        models: ["fallback-model"],
        priority: 0,
      },
    })).toEqual({
      label: "默认",
      tone: "success",
      model: "fallback-model",
    });
  });
});

describe("getProviderConnectionPresentation", () => {
  it("recognizes the official DeepSeek endpoint", () => {
    expect(getProviderConnectionPresentation({
      providerId: "deepseek",
      providerType: "openai",
      baseUrl: "https://api.deepseek.com/v1/",
      defaultBaseUrl: "https://api.deepseek.com/v1",
    })).toMatchObject({
      mode: "official",
      label: "官方直连",
      protocol: "OpenAI 兼容",
      tone: "success",
    });
  });

  it("warns that an Alibaba-hosted DeepSeek endpoint needs an Alibaba credential", () => {
    const result = getProviderConnectionPresentation({
      providerId: "deepseek",
      providerType: "openai",
      baseUrl: "https://deployment.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      defaultBaseUrl: "https://api.deepseek.com/v1",
    });

    expect(result).toMatchObject({
      mode: "compatible",
      label: "阿里云 Model Studio 专属部署",
      tone: "warning",
    });
    expect(result.credentialHint).toContain("专属部署、账号和地域匹配");
  });

  it("labels other overridden endpoints as custom compatible gateways", () => {
    expect(getProviderConnectionPresentation({
      providerId: "deepseek",
      providerType: "openai",
      baseUrl: "https://gateway.example.com/v1",
      defaultBaseUrl: "https://api.deepseek.com/v1",
    })).toMatchObject({ mode: "compatible", label: "自定义兼容网关", tone: "info" });
  });
});

describe("getProviderCredentialError", () => {
  it("turns an Alibaba credential rejection into an actionable DeepSeek message", () => {
    expect(getProviderCredentialError({
      providerId: "deepseek",
      baseUrl: "https://deployment.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      errorMessage: "Invalid API-key provided",
    })).toEqual({
      message: "阿里云 Model Studio 拒绝了当前密钥。",
      details: expect.stringContaining("专属部署、阿里云账号和地域匹配"),
    });
  });

  it("does not rewrite unrelated provider failures", () => {
    expect(getProviderCredentialError({
      providerId: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      errorMessage: "Model not found",
    })).toBeNull();
  });
});

describe("getProviderModelError", () => {
  it("explains that an Alibaba endpoint only accepts models exposed to its workspace", () => {
    expect(getProviderModelError({
      providerId: "deepseek",
      baseUrl: "https://deployment.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      modelId: "deepseek-v4.1-flash",
      errorMessage: "Model not exist.",
    })).toEqual({
      message: "阿里云 Model Studio 当前业务空间拒绝了模型 deepseek-v4.1-flash。",
      details: expect.stringContaining("原始模型 ID"),
    });
  });

  it("does not rewrite missing-model errors from other endpoints", () => {
    expect(getProviderModelError({
      providerId: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      modelId: "unknown-model",
      errorMessage: "Model not found",
    })).toBeNull();
  });
});
