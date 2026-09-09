import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), access: vi.fn(), read: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth, requireSameOrigin: () => null }));
vi.mock("@/lib/platform/access", () => ({ canAccessLegacyCourse: mocks.access }));
vi.mock("@/lib/session/server-store", () => ({ getCourse: mocks.read, updateCourse: mocks.write }));
import { POST, PATCH } from "./route";
const request = (body: unknown) => new Request("http://localhost/api/teacher-directives", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ claims: { sub: "teacher", role: "teacher", displayName: "Actual Teacher" } });
  mocks.access.mockResolvedValue(true);
  mocks.read.mockResolvedValue({ id: "instance", students: [{ id: "student" }] });
});
describe("V2 teacher directives", () => {
  it("checks instance ownership before reading students or writing", async () => {
    mocks.access.mockResolvedValue(false);
    expect((await POST(request({ courseId: "instance", stageKey: "make", goal: "Review", instruction: "Explain", targetScope: "course" }))).status).toBe(403);
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
  });
  it("persists the authenticated actor instead of a supplied teacher identity", async () => {
    const response = await POST(request({ courseId: "instance", stageKey: "make", goal: "Review", instruction: "Explain", targetScope: "course", teacherName: "Impersonated" }));
    expect(response.status).toBe(200);
    expect((await response.json()).directive.teacherName).toBe("Actual Teacher");
    expect(mocks.write).toHaveBeenCalledWith("instance", expect.any(Function), { actor: { id: "teacher", role: "teacher" } });
  });
  it("checks instance ownership before changing directive status", async () => {
    mocks.access.mockResolvedValue(false);
    expect((await PATCH(request({ courseId: "instance", directiveId: "d", status: "revoked" }))).status).toBe(403);
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
