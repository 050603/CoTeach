import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ save: vi.fn(), get: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/openmaic-bridge/provider-config-editor", () => ({ saveProviderEntry: mocks.save, getProviderEntry: mocks.get, listProviders: mocks.list, deleteProviderEntry: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: async () => ({ claims: { sub: "teacher", role: "teacher" } }), requireSameOrigin: () => null }));
vi.mock("@/lib/openmaic/server/ssrf-guard", () => ({ validateUrlForSSRF: async () => null }));
import { GET, POST } from "./route";
const stored = { apiKey: "synthetic-private-key", baseUrl: "https://api.example.com/v1", models: ["example"], enabled: true };
beforeEach(() => { vi.clearAllMocks(); mocks.get.mockResolvedValue(stored); mocks.list.mockResolvedValue({ deepseek: stored }); });
const request = (apiKey: string) => new Request("http://localhost/api/openmaic/provider-config", { method: "POST", body: JSON.stringify({ section: "providers", providerId: "deepseek", apiKey }) });
describe("provider configuration save receipts", () => {
  it("returns confirmed saved-key state without returning the key", async () => {
    const response = await POST(request("new-test-key")); const result = await response.json();
    expect(response.status).toBe(200);
    expect(result).toMatchObject({ ok: true, providerId: "deepseek", provider: { hasApiKey: true, baseUrl: stored.baseUrl } });
    expect(JSON.stringify(result)).not.toContain(stored.apiKey);
    expect(result.provider).not.toHaveProperty("apiKey");
  });
  it("recognizes a retained existing key when the input is blank", async () => {
    const result = await (await POST(request(""))).json();
    expect(result.provider.hasApiKey).toBe(true);
    expect(mocks.save).toHaveBeenCalledWith("providers", "deepseek", expect.objectContaining({ apiKey: "" }));
  });
  it("does not acknowledge an unreadable saved record as success", async () => {
    mocks.get.mockResolvedValue(null);
    expect((await POST(request("key"))).status).toBe(503);
  });
  it("returns fresh key-presence metadata after reload", async () => {
    const response = await GET(new Request("http://localhost/api/openmaic/provider-config?section=providers"));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const result = await response.json(); expect(result.providers.deepseek.hasApiKey).toBe(true);
    expect(result.providers.deepseek).not.toHaveProperty("apiKey");
  });
});
