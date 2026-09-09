import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";
const mocks = vi.hoisted(() => ({ user: vi.fn(), instance: vi.fn(), participation: vi.fn(), authenticate: vi.fn(), csrf: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { classroomInstance: { findUnique: mocks.instance }, classroomParticipation: { findFirst: mocks.participation } } }));
vi.mock("@/lib/platform/access", () => ({ getPlatformUser: mocks.user }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.authenticate, requireSameOrigin: mocks.csrf }));
import { authorizeLegacyAiScope, authenticateLegacyAiStudent } from "./legacy-scope";
const claims = { sub: "user", role: "student" } as AuthClaims;
const instance = () => ({ id: "instance", status: "TEACHING", activity: { archivedAt: null, chapter: { offering: { id: "offering", status: "OPEN", teachers: [{ userId: "teacher" }] } } } });
beforeEach(() => {
  vi.resetAllMocks(); mocks.user.mockResolvedValue({ id: "user", role: "student" }); mocks.instance.mockResolvedValue(instance());
  mocks.participation.mockResolvedValue({ id: "participation", enrollment: { status: "ACTIVE" } }); mocks.authenticate.mockResolvedValue({ claims });
});
describe("legacy classroom identity bridge", () => {
  it("uses the JWT subject with the instance instead of requiring old course/student claims", async () => {
    const result = await authenticateLegacyAiStudent(new Request("http://localhost/api", { method: "POST" }), "instance", "user");
    expect(result).toMatchObject({ studentId: "user", participationId: "participation" });
    expect(mocks.participation).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ instanceId: "instance", enrollment: expect.objectContaining({ userId: "user", offeringId: "offering" }) }) }));
  });
  it("rejects requests attempting to impersonate another student", async () => {
    await expect(authorizeLegacyAiScope(claims, "instance", "other")).rejects.toMatchObject({ code: "STUDENT_SCOPE_MISMATCH" });
    expect(mocks.participation).not.toHaveBeenCalled();
  });
  it("requires an actual participation even if a user has an account", async () => {
    mocks.participation.mockResolvedValue(null);
    await expect(authorizeLegacyAiScope(claims, "instance", "user")).rejects.toMatchObject({ code: "STUDENT_SCOPE_MISMATCH" });
  });
  it("allows classroom history reads after class ends while denying writes", async () => {
    const row = instance(); row.status = "ENDED"; mocks.instance.mockResolvedValue(row);
    await expect(authorizeLegacyAiScope(claims, "instance", "user")).resolves.toHaveProperty("participation");
    await expect(authorizeLegacyAiScope(claims, "instance", "user", true)).rejects.toMatchObject({ code: "COURSE_LOCKED" });
  });
  it("restricts teacher monitoring to assigned offerings", async () => {
    mocks.user.mockResolvedValue({ id: "other-teacher", role: "teacher" });
    await expect(authorizeLegacyAiScope({ sub: "other-teacher", role: "teacher" } as AuthClaims, "instance")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("enforces same-origin before authenticating write requests", async () => {
    mocks.csrf.mockReturnValue(new Response(null, { status: 403 }));
    const response = await authenticateLegacyAiStudent(new Request("http://localhost/api", { method: "POST" }), "instance", "user");
    expect(response).toBeInstanceOf(Response); expect(mocks.authenticate).not.toHaveBeenCalled();
  });
});
