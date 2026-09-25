import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";

const mocks = vi.hoisted(() => ({
  student: vi.fn(),
  enrollments: vi.fn(),
  instances: vi.fn(),
}));

vi.mock("./access", () => ({ requireStudentUser: mocks.student }));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    enrollment: { findMany: mocks.enrollments },
    classroomInstance: { findMany: mocks.instances },
  },
}));

import { listStudentOfferings } from "./repository";

const claims = { sub: "student-1", role: "student" } as AuthClaims;

function enrollment(offeringId: string, coverImageUrl: string | null, classroomCount = 1) {
  return {
    id: `enrollment-${offeringId}`,
    joinedAt: new Date("2026-01-01"),
    activityProgress: [],
    offering: {
      id: offeringId,
      name: "课程",
      description: null,
      coverImageUrl,
      status: "OPEN",
      settings: null,
      term: null,
      startsAt: null,
      endsAt: null,
      teachers: [],
      resources: [],
      chapters: [{
        id: `chapter-${offeringId}`,
        title: "单元",
        description: null,
        position: 1,
        isOpen: true,
        opensAt: null,
        archivedAt: null,
        activities: Array.from({ length: classroomCount }, (_, index) => ({
          id: `activity-${offeringId}-${index}`,
          type: "CLASSROOM",
          title: "课堂",
          description: null,
          position: index + 1,
          isOpen: true,
          opensAt: null,
          archivedAt: null,
          config: null,
        })),
      }],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.student.mockResolvedValue({ id: "student-1" });
  mocks.instances.mockResolvedValue([]);
});

describe("student course cover", () => {
  it("uses the only classroom cover when the offering has no separate cover", async () => {
    mocks.enrollments.mockResolvedValue([enrollment("offering-1", null)]);
    mocks.instances.mockResolvedValue([{
      activityId: "activity-offering-1-0",
      templateVersion: { snapshot: {
        schemaVersion: 2,
        kind: "pbl-course",
        design: { coverImageUrl: "/api/openmaic/classroom-media/template-cover-course-1/media/course-cover.webp" },
      } },
    }]);

    const courses = await listStudentOfferings(claims);
    expect(courses[0].coverImageUrl).toBe("/api/openmaic/classroom-media/template-cover-course-1/media/course-cover.webp");
    expect(mocks.instances).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ activityId: { in: ["activity-offering-1-0"] } }),
    }));
  });

  it("keeps an offering's own cover and avoids choosing between multiple classrooms", async () => {
    mocks.enrollments.mockResolvedValue([
      enrollment("custom", "/custom-cover.webp"),
      enrollment("multiple", null, 2),
    ]);

    const courses = await listStudentOfferings(claims);
    expect(courses.map((course) => course.coverImageUrl)).toEqual(["/custom-cover.webp", null]);
    expect(mocks.instances).not.toHaveBeenCalled();
  });
});
