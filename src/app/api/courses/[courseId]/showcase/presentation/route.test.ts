// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeShowcaseAction: vi.fn(),
  getShowcaseData: vi.fn(),
  isDatabaseConfigured: vi.fn(),
  checkDistributedRateLimit: vi.fn(),
}));

vi.mock("@/lib/auth/request-guards", () => ({
  authenticateRequest: vi.fn(async () => ({ claims: { sub: "teacher-1", role: "teacher" as const } })),
  requireSameOrigin: vi.fn(() => null),
}));
vi.mock("@/lib/db/client", () => ({ isDatabaseConfigured: mocks.isDatabaseConfigured }));
vi.mock("@/lib/auth/distributed-rate-limit", () => ({ checkDistributedRateLimit: mocks.checkDistributedRateLimit }));
vi.mock("@/lib/showcase/presentation-service", () => ({
  executeShowcaseAction: mocks.executeShowcaseAction,
  getShowcaseData: mocks.getShowcaseData,
  ShowcasePresentationError: class ShowcasePresentationError extends Error {},
}));

vi.mock("@/lib/platform/access", () => ({ canAccessLegacyCourse: async () => true }));

import { POST } from "./route";

const courseId = "course-1";
const context = { params: Promise.resolve({ courseId }) };

function request(body: unknown) {
  return new Request(`http://localhost:3000/api/courses/${courseId}/showcase/presentation`, {
    method: "POST",
    headers: { Origin: "http://localhost:3000", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("showcase presentation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDatabaseConfigured.mockReturnValue(true);
    mocks.checkDistributedRateLimit.mockResolvedValue({ allowed: true });
    mocks.executeShowcaseAction.mockResolvedValue({ ok: true });
  });

  it("accepts the optional empty evaluation note and dispatches the action", async () => {
    const response = await POST(request({ action: "finish-evaluation", presentationId: "11111111-1111-4111-8111-111111111111", note: "  " }), context);
    expect(response.status).toBe(200);
    expect(mocks.executeShowcaseAction).toHaveBeenCalledWith(courseId, {
      action: "finish-evaluation",
      presentationId: "11111111-1111-4111-8111-111111111111",
      note: "",
    }, expect.anything());
  });

  it("accepts a null note for clients that omit the optional record", async () => {
    const response = await POST(request({ action: "finish-evaluation", presentationId: "11111111-1111-4111-8111-111111111111", note: null }), context);
    expect(response.status).toBe(200);
    expect(mocks.executeShowcaseAction).toHaveBeenCalledWith(courseId, {
      action: "finish-evaluation",
      presentationId: "11111111-1111-4111-8111-111111111111",
      note: null,
    }, expect.anything());
  });

  it("rejects an overlong evaluation note before touching the service", async () => {
    const response = await POST(request({ action: "finish-evaluation", presentationId: "11111111-1111-4111-8111-111111111111", note: "x".repeat(2_001) }), context);
    expect(response.status).toBe(400);
    expect(mocks.executeShowcaseAction).not.toHaveBeenCalled();
  });

  it("accepts a teacher-started projection with an explicit student and artifact", async () => {
    const response = await POST(request({ action: "start", studentId: "student-1", artifactKind: "pdf", artifactVersionId: "artifact-1", displayMode: "slides" }), context);
    expect(response.status).toBe(200);
    expect(mocks.executeShowcaseAction).toHaveBeenCalledWith(courseId, {
      action: "start",
      studentId: "student-1",
      artifactKind: "pdf",
      artifactVersionId: "artifact-1",
      displayMode: "slides",
    }, expect.anything());
  });

  it("no longer accepts student projection requests", async () => {
    const response = await POST(request({ action: "request", artifactKind: "document", artifactVersionId: "artifact-1", displayMode: "continuous" }), context);
    expect(response.status).toBe(400);
    expect(mocks.executeShowcaseAction).not.toHaveBeenCalled();
  });
});
