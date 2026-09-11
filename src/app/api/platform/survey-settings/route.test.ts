// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), csrf: vi.fn(), get: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth, requireSameOrigin: mocks.csrf }));
vi.mock("@/lib/platform/survey-keyword-settings", () => ({ getSurveyKeywordSettings: mocks.get, saveSurveyKeywordSettings: mocks.save }));

import { GET, POST } from "./route";

function request(body?: unknown) {
  return new Request("https://app.test/api/platform/survey-settings", {
    method: body === undefined ? "GET" : "POST",
    headers: { origin: "https://app.test", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ claims: { sub: "teacher-1", role: "teacher" } });
  mocks.csrf.mockReturnValue(null);
  mocks.get.mockResolvedValue({ mode: "local" });
  mocks.save.mockImplementation((_ownerId, mode) => Promise.resolve({ mode }));
});

describe("teacher survey settings API", () => {
  it("returns only the authenticated teacher's mode without caching", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ mode: "local" });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.auth).toHaveBeenCalledWith(expect.any(Request), "teacher");
    expect(mocks.get).toHaveBeenCalledWith("teacher-1");
  });

  it.each(["local", "llm"])("saves mode %s for the authenticated teacher", async (mode) => {
    const response = await POST(request({ mode }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ mode });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.save).toHaveBeenCalledWith("teacher-1", mode);
  });

  it("rejects a cross-origin write before authentication or persistence", async () => {
    mocks.csrf.mockReturnValue(Response.json({ code: "CSRF_REJECTED" }, { status: 403 }));
    const response = await POST(request({ mode: "llm" }));
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each([GET, POST])("requires an authenticated teacher", async (handler) => {
    mocks.auth.mockResolvedValue({ response: Response.json({ code: "UNAUTHORIZED" }, { status: 401 }) });
    const response = await handler(request({ mode: "llm" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each([null, {}, [], { mode: "remote" }, { mode: true }, { mode: "llm", ownerId: "another-teacher" }])("rejects invalid or extra settings fields: %j", async (body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const response = await POST(new Request("https://app.test/api/platform/survey-settings", { method: "POST", body: "{" }));
    expect(response.status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("reports failed reads and writes without exposing database errors", async () => {
    mocks.get.mockRejectedValue(new Error("private database details"));
    mocks.save.mockRejectedValue(new Error("private database details"));
    for (const response of [await GET(request()), await POST(request({ mode: "llm" }))]) {
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.text()).not.toContain("private database details");
    }
  });
});
