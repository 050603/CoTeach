import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock("@/lib/auth/request-guards", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));
vi.mock("@/lib/db/client", () => ({
  prisma: { classroomInstance: { findFirst: mocks.findFirst } },
}));
vi.mock("@/lib/observability/http", () => ({
  withHttpMetrics: (_method: string, _route: string, handler: unknown) => handler,
}));

import { GET } from "./route";

describe("projection state endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue({
      claims: { sub: "student-1", role: "student", studentName: "学生", sv: 1 },
    });
  });

  it("returns only the compact authorized projection snapshot", async () => {
    mocks.findFirst.mockResolvedValue({
      runtimeConfig: {
        version: 12,
        secretInternalField: "must-not-leak",
        uiState: {
          projectionVersion: 4,
          projectionUpdatedAt: "2026-09-10T00:00:00.000Z",
          resourceProjection: null,
          teacherResourceProjection: null,
          aiAnalysisPending: true,
        },
      },
    });
    const response = await GET(
      new Request("http://localhost/api/courses/course-1/projection"),
      { params: Promise.resolve({ courseId: "course-1" }) },
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body).toMatchObject({
      courseId: "course-1",
      courseVersion: 12,
      projectionVersion: 4,
      resourceProjection: null,
      teacherResourceProjection: null,
    });
    expect(body).not.toHaveProperty("secretInternalField");
    expect(body).not.toHaveProperty("aiAnalysisPending");
    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "course-1",
        participations: expect.any(Object),
      }),
    }));
  });

  it("does not reveal whether an unauthorized classroom exists", async () => {
    mocks.findFirst.mockResolvedValue(null);
    const response = await GET(
      new Request("http://localhost/api/courses/course-1/projection"),
      { params: Promise.resolve({ courseId: "course-1" }) },
    );
    expect(response.status).toBe(403);
  });
});
