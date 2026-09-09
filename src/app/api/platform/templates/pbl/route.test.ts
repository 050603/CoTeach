import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), csrf: vi.fn(), teacher: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth, requireSameOrigin: mocks.csrf }));
vi.mock("@/lib/platform/access", () => ({ requireTeacherUser: mocks.teacher }));
vi.mock("@/lib/platform/pbl-template-repository", () => ({ savePblTemplateCourse: mocks.save }));
import { POST } from "./route";
beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({ claims: { role: "teacher", sub: "teacher" } }); mocks.teacher.mockResolvedValue({ id: "teacher" }); mocks.save.mockImplementation(async (course) => course); });
describe("PBL template authoring entry", () => {
  it("creates the blank draft required by the existing quick generator", async () => {
    const response = await POST(new Request("https://app.test/api", { method: "POST", body: "{}" }));
    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.course.name).toBe("未命名课程");
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ name: "未命名课程", status: "draft" }), "teacher");
  });
  it("creates a teacher-owned five-stage draft without client-supplied ownership", async () => {
    const response = await POST(new Request("https://app.test/api", { method: "POST", body: JSON.stringify({ name: "Project", ownerId: "other" }) }));
    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.course.stages).toHaveLength(5); expect(data.course.students).toEqual([]);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ name: "Project", status: "draft" }), "teacher");
  });
  it("rejects invalid input before creating any template", async () => {
    const response = await POST(new Request("https://app.test/api", { method: "POST", body: JSON.stringify({ name: "", hours: -1 }) }));
    expect(response.status).toBe(400); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("enforces same-origin requests", async () => {
    mocks.csrf.mockReturnValue(new Response(null, { status: 403 }));
    expect((await POST(new Request("https://app.test/api", { method: "POST" }))).status).toBe(403);
    expect(mocks.auth).not.toHaveBeenCalled();
  });
});
