import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { AuthClaims } from "@/lib/auth/session";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  teacher: vi.fn(),
  enrollment: vi.fn(),
}));

import { canReadOfferingCover, preferredMediaAuthRole } from "./access";

const db = {
  user: { findUnique: mocks.user },
  courseTeacher: { findFirst: mocks.teacher },
  enrollment: { findFirst: mocks.enrollment },
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
});
