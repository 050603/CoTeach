import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  csrf: vi.fn(),
  get: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@/lib/auth/request-guards", () => ({
  authenticateRequest: mocks.auth,
  requireSameOrigin: mocks.csrf,
}));
vi.mock("@/lib/course-quality-review/settings", () => ({
  CourseQualityReviewSettingsError: class CourseQualityReviewSettingsError extends Error {},
  getCourseQualityReviewSettings: mocks.get,
  saveCourseQualityReviewSettings: mocks.save,
}));

import { GET, POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ claims: { sub: "teacher", role: "teacher" } });
  mocks.csrf.mockReturnValue(null);
  mocks.get.mockResolvedValue({});
  mocks.save.mockImplementation(async (value) => value);
});

describe("course quality review settings API", () => {
  it("returns the saved reviewer choice to an authenticated teacher", async () => {
    mocks.get.mockResolvedValue({ modelString: "deepseek:deepseek-v4-flash-vision-exp" });
    const response = await GET(new Request("http://localhost/api/course-quality-review/settings"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      settings: { modelString: "deepseek:deepseek-v4-flash-vision-exp" },
    });
  });

  it("persists an independent reviewer only through the teacher-protected POST", async () => {
    const body = { modelString: "deepseek:deepseek-v4-flash-vision-exp" };
    const response = await POST(new Request("http://localhost/api/course-quality-review/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(200);
    expect(mocks.auth).toHaveBeenCalledWith(expect.any(Request), "teacher");
    expect(mocks.save).toHaveBeenCalledWith(body);
  });
});
