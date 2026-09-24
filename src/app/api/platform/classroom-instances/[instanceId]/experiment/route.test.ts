import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), csrf: vi.fn(), submit: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth, requireSameOrigin: mocks.csrf }));
vi.mock("@/lib/platform/experiment-service", () => ({ submitExperimentAssessment: mocks.submit }));
import { POST } from "./route";

const context = { params: Promise.resolve({ instanceId: "run" }) };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ claims: { role: "student", sub: "student" } });
  mocks.csrf.mockReturnValue(null);
});

it("returns only the receipt after a student submits an assessment", async () => {
  mocks.submit.mockResolvedValue({ id: "submission", phase: "pretest", submittedAt: new Date("2026-09-24T10:00:00Z"), questionnaire: { pretest: [{ correctAnswer: "secret" }] }, answers: { q: "private" }, researchKey: "key" });
  const request = new Request("http://localhost/api/platform/classroom-instances/run/experiment", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phase: "pretest", answers: { q: "private" } }) });
  const response = await POST(request, context);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ submission: { id: "submission", phase: "pretest", submittedAt: "2026-09-24T10:00:00.000Z" } });
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(mocks.submit).toHaveBeenCalledWith({ role: "student", sub: "student" }, "run", { phase: "pretest", answers: { q: "private" } });
});

it("checks origin and student authentication before writing", async () => {
  const request = new Request("http://localhost/experiment", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  mocks.csrf.mockReturnValue(new Response(null, { status: 403 }));
  expect((await POST(request, context)).status).toBe(403);
  expect(mocks.auth).not.toHaveBeenCalled();
  mocks.csrf.mockReturnValue(null);
  mocks.auth.mockResolvedValue({ response: new Response(null, { status: 401 }) });
  expect((await POST(request, context)).status).toBe(401);
  expect(mocks.submit).not.toHaveBeenCalled();
});
