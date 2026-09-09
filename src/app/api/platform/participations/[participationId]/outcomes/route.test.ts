import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), csrf: vi.fn(), get: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth, requireSameOrigin: mocks.csrf }));
vi.mock("@/lib/platform/classroom-outcomes", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/platform/classroom-outcomes")>(), getClassroomOutcomes: mocks.get, saveClassroomOutcome: mocks.save }));
import { GET, POST } from "./route";
import { PlatformError } from "@/lib/platform/repository";
const context = { params: Promise.resolve({ participationId: "p" }) };
beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({ claims: { sub: "student", role: "student" } }); });
describe("classroom outcomes route", () => {
  it("prevents personal outcome responses from being cached", async () => {
    mocks.get.mockResolvedValue({ submissions: [] });
    const response = await GET(new Request("https://app.test/api"), context);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ submissions: [] });
  });
  it("rejects unauthenticated reads before querying results", async () => {
    mocks.auth.mockResolvedValue({ response: new Response(null, { status: 401 }) });
    expect((await GET(new Request("https://app.test/api"), context)).status).toBe(401);
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it("blocks cross-origin writes before parsing or saving", async () => {
    mocks.csrf.mockReturnValue(new Response(null, { status: 403 }));
    expect((await POST(new Request("https://app.test/api", { method: "POST" }), context)).status).toBe(403);
    expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("rejects malformed JSON with a validation response", async () => {
    expect((await POST(new Request("https://app.test/api", { method: "POST", body: "{" }), context)).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("preserves the domain authorization error", async () => {
    mocks.get.mockRejectedValue(new PlatformError("FORBIDDEN", "无权访问", 403));
    expect((await GET(new Request("https://app.test/api"), context)).status).toBe(403);
  });
  it("validates and forwards the participation identifier and retry key", async () => {
    const body = { action: "reflect", content: "My reflection", idempotencyKey: "ac640a7e-3113-4360-a71f-1ecfc8895a19" };
    mocks.save.mockResolvedValue({ id: "reflection" });
    const response = await POST(new Request("https://app.test/api", { method: "POST", body: JSON.stringify(body) }), context);
    expect(await response.json()).toEqual({ outcome: { id: "reflection" } });
    expect(mocks.save).toHaveBeenCalledWith({ sub: "student", role: "student" }, "p", body);
  });
});
