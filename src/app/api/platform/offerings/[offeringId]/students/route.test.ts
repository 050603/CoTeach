import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), list: vi.fn(), summary: vi.fn(),
}));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth }));
vi.mock("@/lib/platform/repository", () => ({
  listOfferingStudents: mocks.list,
  PlatformError: class PlatformError extends Error { constructor(public code: string, message: string, public status: number) { super(message); } },
}));
vi.mock("@/lib/platform/student-records", () => ({ getOfferingStudentsSummary: mocks.summary }));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ claims: { sub: "teacher", role: "teacher" } });
  mocks.list.mockResolvedValue([{ id: "student" }]);
  mocks.summary.mockResolvedValue({ offering: { id: "course" }, students: [] });
});

describe("offering students endpoint", () => {
  it("keeps the legacy response shape when view is omitted", async () => {
    const response = await GET(new Request("http://localhost/api/platform/offerings/course/students"), { params: Promise.resolve({ offeringId: "course" }) });
    expect(await response.json()).toEqual({ students: [{ id: "student" }] });
    expect(mocks.list).toHaveBeenCalledWith(expect.anything(), "course");
    expect(mocks.summary).not.toHaveBeenCalled();
  });

  it("returns the new lightweight summary on request", async () => {
    const response = await GET(new Request("http://localhost/api/platform/offerings/course/students?view=summary"), { params: Promise.resolve({ offeringId: "course" }) });
    expect(await response.json()).toEqual({ offering: { id: "course" }, students: [] });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.summary).toHaveBeenCalledWith(expect.anything(), "course");
  });

  it("returns the authentication response without reading student data", async () => {
    mocks.auth.mockResolvedValue({ response: new Response(null, { status: 401 }) });
    const response = await GET(new Request("http://localhost/api/platform/offerings/course/students?view=summary"), { params: Promise.resolve({ offeringId: "course" }) });
    expect(response.status).toBe(401);
    expect(mocks.summary).not.toHaveBeenCalled();
  });
});
