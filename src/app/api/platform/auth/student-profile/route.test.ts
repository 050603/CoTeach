import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), find: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth }));
vi.mock("@/lib/db/client", () => ({ prisma: { user: { findFirst: mocks.find } } }));
import { GET } from "./route";
describe("student profile", () => {
  beforeEach(() => vi.clearAllMocks());
  it("requires a student session", async () => {
    mocks.auth.mockResolvedValue({ response: new Response(null, { status: 401 }) });
    expect((await GET(new Request("http://localhost/api/platform/auth/student-profile"))).status).toBe(401);
    expect(mocks.find).not.toHaveBeenCalled();
  });
  it("reads only the authenticated student's public account fields", async () => {
    mocks.auth.mockResolvedValue({ claims: { sub: "student-1" } });
    mocks.find.mockResolvedValue({ displayName: "小林", username: "lin" });
    const response = await GET(new Request("http://localhost/api/platform/auth/student-profile"));
    expect(mocks.find).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "student-1" }), select: { displayName: true, username: true } }));
    expect(await response.json()).toEqual({ user: { displayName: "小林", username: "lin", role: "student" } });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
