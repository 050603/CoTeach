import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { AuthClaims } from "@/lib/auth/session";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  teacher: vi.fn(),
  enrollment: vi.fn(),
  template: vi.fn(),
  participation: vi.fn(),
}));

import {
  canAccessLegacyCourse,
  canReadOfferingCover,
  canReadTemplateCover,
  preferredMediaAuthRole,
} from "./access";

const db = {
  user: { findUnique: mocks.user },
  courseTeacher: { findFirst: mocks.teacher },
  enrollment: { findFirst: mocks.enrollment },
  classroomTemplate: { findFirst: mocks.template },
  classroomParticipation: { findFirst: mocks.participation },
} as unknown as PrismaClient;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockImplementation(async ({ where }: { where: { id: string } }) => ({
    id: where.id,
    username: where.id,
    displayName: where.id,
    role: where.id.startsWith("teacher") ? "TEACHER" : "STUDENT",
    status: "ACTIVE",
    sessionVersion: 1,
  }));
});

describe("offering cover media access", () => {
  it("selects the student cookie for image requests coming from student pages", () => {
    expect(preferredMediaAuthRole(new Request("https://app.test/api/image", {
      headers: { referer: "https://app.test/student/courses/offering-1" },
    }))).toBe("student");
    expect(preferredMediaAuthRole(new Request("https://app.test/api/image", {
      headers: { referer: "https://app.test/teacher/classes/offering-1" },
    }))).toBe("teacher");
  });

  it("allows only a teacher linked to the offering", async () => {
    mocks.teacher.mockResolvedValueOnce({ id: "link" }).mockResolvedValueOnce(null);
    const claims = { sub: "teacher-1", role: "teacher" } as AuthClaims;
    await expect(canReadOfferingCover(claims, "offering-1", db)).resolves.toBe(true);
    await expect(canReadOfferingCover(claims, "offering-2", db)).resolves.toBe(false);
  });

  it("allows active or completed enrolled students", async () => {
    mocks.enrollment.mockResolvedValue({ id: "enrollment" });
    const claims = { sub: "student-1", role: "student" } as AuthClaims;
    await expect(canReadOfferingCover(claims, "offering-1", db)).resolves.toBe(true);
    expect(mocks.enrollment).toHaveBeenCalledWith({
      where: {
        offeringId: "offering-1",
        userId: "student-1",
        status: { in: ["ACTIVE", "active", "COMPLETED", "completed"] },
      },
      select: { id: true },
    });
  });

  it("rejects users without an active platform account", async () => {
    mocks.user.mockResolvedValue(null);
    await expect(canReadOfferingCover(
      { sub: "student-1", role: "student" } as AuthClaims,
      "offering-1",
      db,
    )).resolves.toBe(false);
    expect(mocks.enrollment).not.toHaveBeenCalled();
  });

  it("allows a classroom template owner and students enrolled in a matching run", async () => {
    mocks.template.mockResolvedValue({ id: "template-1" });
    await expect(canReadTemplateCover(
      { sub: "teacher-1", role: "teacher" } as AuthClaims,
      "template-1",
      db,
    )).resolves.toBe(true);

    mocks.participation.mockResolvedValue({ id: "participation-1" });
    await expect(canReadTemplateCover(
      { sub: "student-1", role: "student" } as AuthClaims,
      "template-1",
      db,
    )).resolves.toBe(true);
    expect(mocks.participation).toHaveBeenCalledWith({
      where: {
        enrollment: {
          userId: "student-1",
          status: { in: ["ACTIVE", "active", "COMPLETED", "completed"] },
        },
        instance: { templateVersion: { templateId: "template-1" } },
      },
      select: { id: true },
    });
  });
});

describe("offering file access", () => {
  const accessDb = {
    user: { findUnique: mocks.user },
    classroomTemplate: { findUnique: vi.fn().mockResolvedValue(null) },
    courseOffering: { findUnique: vi.fn().mockResolvedValue({ id: "offering-1" }) },
    courseTeacher: { findFirst: mocks.teacher },
    enrollment: { findFirst: mocks.enrollment },
    classroomInstance: { findUnique: vi.fn().mockResolvedValue(null) },
    classroomParticipation: { findFirst: vi.fn() },
  } as unknown as PrismaClient;

  it("allows linked teachers to upload and enrolled students to read offering PDFs", async () => {
    mocks.teacher.mockResolvedValue({ id: "link" });
    await expect(canAccessLegacyCourse({ sub: "teacher-1", role: "teacher" } as AuthClaims, "offering-1", "write", accessDb)).resolves.toBe(true);
    mocks.enrollment.mockResolvedValue({ id: "enrollment" });
    await expect(canAccessLegacyCourse({ sub: "student-1", role: "student" } as AuthClaims, "offering-1", "read", accessDb)).resolves.toBe(true);
    await expect(canAccessLegacyCourse({ sub: "student-1", role: "student" } as AuthClaims, "offering-1", "write", accessDb)).resolves.toBe(false);
  });
});
