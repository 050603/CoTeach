import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), csrf: vi.fn(), detail: vi.fn(), submissions: vi.fn(), withdraw: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth, requireSameOrigin: mocks.csrf }));
vi.mock("@/lib/platform/repository", () => ({
  PlatformError: class PlatformError extends Error { constructor(public code: string, message: string, public status: number) { super(message); } },
}));
vi.mock("@/lib/platform/student-records", () => ({
  getOfferingStudentDetail: mocks.detail,
  getStudentActivitySubmissions: mocks.submissions,
  withdrawOfferingStudent: mocks.withdraw,
}));

import { DELETE as withdrawStudent, GET as getDetail } from "./route";
import { GET as getSubmissions } from "./submissions/route";

const context = { params: Promise.resolve({ offeringId: "course", enrollmentId: "enrollment" }) };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.csrf.mockReturnValue(null);
  mocks.auth.mockResolvedValue({ claims: { sub: "teacher", role: "teacher" } });
  mocks.detail.mockResolvedValue({ student: { id: "student" } });
  mocks.withdraw.mockResolvedValue({ enrollmentId: "enrollment", status: "withdrawn" });
  mocks.submissions.mockResolvedValue({ submissions: [], pagination: { page: 1, pageSize: 20, total: 0, hasMore: false } });
});

describe("student detail endpoints", () => {
  it("loads a student through the enrollment scoped to the offering", async () => {
    const response = await getDetail(new Request("http://localhost/detail"), context);
    expect(await response.json()).toEqual({ student: { id: "student" } });
    expect(mocks.detail).toHaveBeenCalledWith(expect.anything(), "course", "enrollment");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("validates activity and page before loading history", async () => {
    const missing = await getSubmissions(new Request("http://localhost/submissions"), context);
    const invalidPage = await getSubmissions(new Request("http://localhost/submissions?activityId=a&page=0"), context);
    expect(missing.status).toBe(400);
    expect(invalidPage.status).toBe(400);
    expect(mocks.submissions).not.toHaveBeenCalled();
  });

  it("loads the requested page of an activity history", async () => {
    const response = await getSubmissions(new Request("http://localhost/submissions?activityId=activity&page=3"), context);
    expect(response.status).toBe(200);
    expect(mocks.submissions).toHaveBeenCalledWith(expect.anything(), "course", "enrollment", "activity", 3);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("withdraws the enrollment while preserving its student records", async () => {
    const response = await withdrawStudent(new Request("http://localhost/detail", { method: "DELETE" }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enrollmentId: "enrollment", status: "withdrawn" });
    expect(mocks.withdraw).toHaveBeenCalledWith(expect.anything(), "course", "enrollment");
  });

  it("checks same-origin before withdrawing a student", async () => {
    mocks.csrf.mockReturnValueOnce(new Response(null, { status: 403 }));
    const response = await withdrawStudent(new Request("http://localhost/detail", { method: "DELETE" }), context);
    expect(response.status).toBe(403);
    expect(mocks.withdraw).not.toHaveBeenCalled();
  });
});
