import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  getCourse: vi.fn(),
  readSessionState: vi.fn(),
  participations: vi.fn(),
  access: vi.fn(),
  scopeCourseForClaims: vi.fn((course: unknown) => course),
}));

vi.mock("@/lib/platform/access", () => ({ canAccessLegacyCourse: mocks.access }));

vi.mock("@/lib/auth/request-guards", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));
vi.mock("@/lib/auth/course-scope", () => ({
  scopeCourseForClaims: mocks.scopeCourseForClaims,
}));
vi.mock("@/lib/db/session-repository", () => ({
  loadCourse: mocks.getCourse,
  loadSessionState: mocks.readSessionState,
  stateFor: (courses: unknown[]) => ({ courses, hydrated: true }),
}));
vi.mock("@/lib/db/client", () => ({ prisma: { classroomParticipation: { findMany: mocks.participations } } }));

import { GET } from "./route";

describe("GET /api/courses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads only the signed-in student's course", async () => {
    const claims = {
      sub: "student-1",
      role: "student",
      studentName: "学生一",
      sv: 1,
    } as const;
    const course = {
      id: "course-1",
      updatedAt: "2026-08-24T10:00:00.000Z",
    };
    mocks.authenticateRequest.mockResolvedValue({ claims });
    mocks.getCourse.mockResolvedValue(course);
    mocks.participations.mockResolvedValue([{ instanceId: "course-1" }]);

    const response = await GET(new Request("http://localhost/api/courses"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getCourse).toHaveBeenCalledWith("course-1");
    expect(mocks.participations).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ enrollment: expect.objectContaining({ userId: "student-1" }) }) }));
    expect(mocks.readSessionState).not.toHaveBeenCalled();
    expect(mocks.scopeCourseForClaims).toHaveBeenCalledWith(course, claims);
    await expect(response.json()).resolves.toMatchObject({
      courses: [course],
      joinedCourseId: "course-1",
      studentId: "student-1",
      hydrated: true,
    });
  });

  it("loads only the authorized teacher classroom requested by a teaching page", async () => {
    mocks.authenticateRequest.mockResolvedValue({ claims: { sub: "teacher-1", role: "teacher", displayName: "教师" } });
    mocks.access.mockResolvedValue(true);
    mocks.getCourse.mockResolvedValue({ id: "course-1" });
    const response = await GET(new Request("http://localhost/api/courses?courseId=course-1"));
    expect(response.status).toBe(200);
    expect(mocks.readSessionState).not.toHaveBeenCalled();
    expect(mocks.getCourse).toHaveBeenCalledWith("course-1");
    mocks.access.mockResolvedValue(false); mocks.getCourse.mockClear();
    expect((await GET(new Request("http://localhost/api/courses?courseId=other"))).status).toBe(403);
    expect(mocks.getCourse).not.toHaveBeenCalled();
  });

  it("filters the teacher dashboard by the signed-in owner", async () => {
    mocks.authenticateRequest.mockResolvedValue({
      claims: {
        sub: "teacher-1",
        role: "teacher",
        username: "teacher",
        displayName: "教师一",
        sv: 1,
      },
    });
    mocks.readSessionState.mockResolvedValue({
      courses: [{ id: "course-1" }, { id: "course-2" }],
      user: { role: "teacher", name: "教师" },
      hydrated: true,
    });

    const response = await GET(new Request("http://localhost/api/courses"));

    expect(response.status).toBe(200);
    expect(mocks.readSessionState).toHaveBeenCalledWith("teacher-1");
    expect(mocks.getCourse).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      courses: [{ id: "course-1" }, { id: "course-2" }],
      user: { role: "teacher", name: "教师一" },
    });
  });
});
