import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ origin: vi.fn(), auth: vi.fn(), ingest: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ requireSameOrigin: mocks.origin, authenticateRequest: mocks.auth }));
vi.mock("@/lib/learning-analytics/ingest", () => ({ ingestClassroomLearningEvents: mocks.ingest }));
import { PlatformError } from "@/lib/platform/repository";
import { POST } from "./route";
beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({ claims: { sub: "student", role: "student" } }); });
const request = (body = "{}") => new Request("http://localhost/api/learning-events", { method: "POST", body });
it("returns the durable acknowledgement and signals unchanged", async () => {
  const result = { acceptedIds: ["original-id"], duplicateCount: 1, signals: [], commonIssues: [] }; mocks.ingest.mockResolvedValue(result);
  expect(await (await POST(request())).json()).toEqual(result);
});
it("rejects invalid JSON, origin and unauthenticated requests before persistence", async () => {
  expect((await POST(request("{"))).status).toBe(400);
  mocks.origin.mockReturnValue(new Response(null, { status: 403 })); expect((await POST(request())).status).toBe(403); mocks.origin.mockReset();
  mocks.auth.mockResolvedValue({ response: new Response(null, { status: 401 }) }); expect((await POST(request())).status).toBe(401);
  expect(mocks.ingest).not.toHaveBeenCalled();
});
it("maps closed/conflicting requests to 409 and rolled-back transactions to retryable 503", async () => {
  for (const code of ["COURSE_LOCKED", "LEARNING_EVENT_CONFLICT"]) { mocks.ingest.mockRejectedValue(new PlatformError(code, code, 409)); const response = await POST(request()); expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: code }); }
  mocks.ingest.mockRejectedValue(new Error("database failure")); const response = await POST(request()); expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ error: "DATABASE_UNAVAILABLE" });
});
