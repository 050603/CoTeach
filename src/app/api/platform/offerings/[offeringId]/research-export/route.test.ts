import { beforeEach, expect, it, vi } from "vitest";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), export: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth }));
vi.mock("@/lib/platform/research-export", () => ({ exportOfferingResearch: mocks.export }));
const context = { params: Promise.resolve({ offeringId: "course" }) };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ claims: { role: "teacher", sub: "teacher" } });
  mocks.export.mockResolvedValue({ exportVersion: 1, rows: [], nextCursor: null });
});

it("authenticates teachers and returns exports without caching", async () => {
  const request = new Request("http://localhost/api/platform/offerings/course/research-export?type=submissions&includeContent=true");
  const response = await GET(request, context);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({ exportVersion: 1, rows: [], nextCursor: null });
  expect(mocks.auth).toHaveBeenCalledWith(request, "teacher");
  expect(mocks.export).toHaveBeenCalledWith({ role: "teacher", sub: "teacher" }, "course", { type: "submissions", includeContent: "true" });
});

it("does not export for unauthenticated callers", async () => {
  mocks.auth.mockResolvedValue({ response: new Response(null, { status: 401 }) });
  const response = await GET(new Request("http://localhost/export"), context);
  expect(response.status).toBe(401);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(mocks.export).not.toHaveBeenCalled();
});

it("rejects ambiguous duplicate query parameters", async () => {
  const response = await GET(new Request("http://localhost/export?includeContent=false&includeContent=true"), context);
  expect(response.status).toBe(400);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(mocks.export).not.toHaveBeenCalled();
});
