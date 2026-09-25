// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), history: vi.fn(), restore: vi.fn() }));
vi.mock("@/lib/platform/template-access", () => ({ authorizeTemplateRequest: mocks.authorize }));
vi.mock("@/lib/platform/pbl-template-repository", () => ({
  getPblTemplateVersionHistory: mocks.history,
  restorePblTemplateVersion: mocks.restore,
}));

import { GET, POST } from "./route";

const context = { params: Promise.resolve({ courseId: "course-1" }) };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorize.mockResolvedValue("teacher-1");
  mocks.history.mockResolvedValue({ versions: [], selected: null });
  mocks.restore.mockResolvedValue({ version: 3, courseVersion: 2 });
});

describe("course version API", () => {
  it("never reads or restores history for an unauthorized request", async () => {
    mocks.authorize.mockResolvedValue(new Response("Forbidden", { status: 403 }));
    expect((await GET(new Request("https://app.test/api/courses/course-1/versions"), context)).status).toBe(403);
    expect((await POST(new Request("https://app.test/api/courses/course-1/versions", {
      method: "POST", body: JSON.stringify({ sourceVersion: 1, expectedCourseVersion: 2 }),
    }), context)).status).toBe(403);
    expect(mocks.history).not.toHaveBeenCalled();
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it("selects only a valid version number", async () => {
    expect((await GET(new Request("https://app.test/api/courses/course-1/versions?version=0"), context)).status).toBe(400);
    expect((await GET(new Request("https://app.test/api/courses/course-1/versions?version=2"), context)).status).toBe(200);
    expect(mocks.history).toHaveBeenCalledWith("course-1", 2);
  });

  it("restores the chosen version with the authenticated owner and concurrency token", async () => {
    const response = await POST(new Request("https://app.test/api/courses/course-1/versions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceVersion: 1, expectedCourseVersion: 2 }),
    }), context);
    expect(response.status).toBe(200);
    expect(mocks.restore).toHaveBeenCalledWith("course-1", "teacher-1", 1, 2);
  });
});
