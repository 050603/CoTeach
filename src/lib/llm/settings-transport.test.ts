// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), readFile: vi.fn().mockRejectedValue(new Error("missing")) }));
vi.mock("@/lib/openmaic-bridge/provider-config-editor", () => ({
  listProviders: async () => ({ deepseek: { apiKey: "test-key", defaultModel: "deepseek-chat" } }),
}));
vi.mock("@openmaic/lib/ai/providers", () => ({
  PROVIDERS: { deepseek: { defaultBaseUrl: "https://api.deepseek.com/v1" } },
}));
vi.mock("@openmaic/lib/server/provider-config", () => ({
  resolveProxy: (providerId: string) => providerId === "deepseek" ? "http://managed-proxy.internal:8080" : undefined,
}));

import { getActiveAiSettings, toPublicAiSettings } from "./settings";

describe("legacy LLM server transport configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps the selected provider's proxy server-side without exposing it to the settings UI", async () => {
    vi.stubEnv("OPENPBL_LLM_ENDPOINT", "");
    vi.stubEnv("OPENPBL_LLM_API_KEY", "");
    const settings = await getActiveAiSettings();
    expect(settings).toMatchObject({
      endpoint: "https://api.deepseek.com/v1", model: "deepseek-chat", proxy: "http://managed-proxy.internal:8080",
    });
    expect(toPublicAiSettings(settings)).not.toHaveProperty("proxy");
  });
});
