import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  getCourse: vi.fn(),
  canAccessLegacyCourse: vi.fn(),
}));

vi.mock("@/lib/platform/access", () => ({ canAccessLegacyCourse: mocks.canAccessLegacyCourse }));
vi.mock("@/lib/auth/request-guards", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));
vi.mock("@/lib/session/server-store", () => ({
  getCourse: mocks.getCourse,
}));

import { GET } from "./route";

const course = {
  id: "course-1",
  name: "校园,减塑",
  students: [
    { id: "student-1", name: "小林" },
    { id: "student-2", name: "小周" },
  ],
  reflections: [
    {
      id: "reflection-old",
      courseId: "course-1",
      studentId: "student-1",
      studentName: "小林",
      content: "旧",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:01:00.000Z",
    },
    {
      id: "reflection-latest",
      courseId: "course-1",
      studentId: "student-1",
      studentName: "小林",
      content: "新版",
      survey: {
        schemaVersion: 1 as const,
        learningReflection: "=公式应作为文本",
        systemReflection: "带,逗号的反馈",
        aiHelpfulness: 4 as const,
        systemUsability: 5 as const,
        reuseIntention: 4 as const,
      },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:10:00.000Z",
    },
  ],
} as never;

describe("GET /api/courses/:courseId/reflections/export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canAccessLegacyCourse.mockResolvedValue(true);
    mocks.authenticateRequest.mockResolvedValue({
      claims: { sub: "teacher-1", role: "teacher", sv: 1 },
    });
    mocks.getCourse.mockResolvedValue(course);
  });

  it("exports the latest structured response with safe CSV cells", async () => {
    const response = await GET(
      new Request("http://localhost/api/courses/course-1/reflections/export"),
      { params: Promise.resolve({ courseId: "course-1" }) },
    );
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    // Response.text() strips a leading UTF-8 BOM during decoding; the route
    // still emits it for spreadsheet compatibility.
    expect(text.startsWith("course_id,course_name,student_id")).toBe(true);
    expect(text).toContain("student-1");
    expect(text).toContain("小林");
    expect(text).toContain("'=公式应作为文本");
    expect(text).not.toContain("student-2");
    expect(text).not.toContain("reflection-old");
  });

  it("requires a teacher session and handles a missing course", async () => {
    mocks.authenticateRequest.mockResolvedValue({
      response: new Response(JSON.stringify({ error: "UNAUTHORIZED" }), { status: 401 }),
    });
    await expect(GET(
      new Request("http://localhost/api/courses/course-1/reflections/export"),
      { params: Promise.resolve({ courseId: "course-1" }) },
    )).resolves.toMatchObject({ status: 401 });

    mocks.authenticateRequest.mockResolvedValue({ claims: { role: "teacher", sub: "teacher-1", sv: 1 } });
    mocks.getCourse.mockResolvedValue(undefined);
    const response = await GET(
      new Request("http://localhost/api/courses/missing/reflections/export"),
      { params: Promise.resolve({ courseId: "missing" }) },
    );
    expect(response.status).toBe(404);
  });
  it("rejects an unrelated teacher before exporting student responses", async () => {
    mocks.canAccessLegacyCourse.mockResolvedValue(false);
    expect((await GET(new Request("http://localhost/api/export"), { params: Promise.resolve({ courseId: "course-1" }) })).status).toBe(403);
    expect(mocks.getCourse).not.toHaveBeenCalled();
  });
});
