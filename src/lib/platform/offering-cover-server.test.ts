import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";

const mocks = vi.hoisted(() => ({
  teacher: vi.fn(),
  offering: vi.fn(),
  owner: vi.fn(),
  generate: vi.fn(),
  update: vi.fn(),
}));

vi.mock("./access", () => ({ requireTeacherUser: mocks.teacher }));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    courseOffering: { findUnique: mocks.offering },
    courseTeacher: { findFirst: mocks.owner },
  },
}));
vi.mock("@/lib/course-cover-server", () => ({
  generateCourseCoverImageOnServer: mocks.generate,
}));
vi.mock("./repository", async (importOriginal) => {
  const original = await importOriginal<typeof import("./repository")>();
  return { ...original, updateOffering: mocks.update };
});

import { generateOfferingCoverImage } from "./offering-cover-server";

const claims = { sub: "teacher-1", role: "teacher" } as AuthClaims;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.teacher.mockResolvedValue({ id: "teacher-1" });
  mocks.offering.mockResolvedValue({
    id: "offering-1",
    name: "校园雨水花园",
    description: "调查积水并设计雨水花园",
    term: "2026 秋季",
    settings: { outline: "调查、测量、设计与展示" },
    version: 4,
  });
  mocks.owner.mockResolvedValue({ id: "link-1" });
  mocks.generate.mockResolvedValue(
    "/api/openmaic/classroom-media/offering-offering-1/media/course-cover-v5.webp",
  );
  mocks.update.mockResolvedValue({
    id: "offering-1",
    version: 5,
    coverImageUrl: "/api/openmaic/classroom-media/offering-offering-1/media/course-cover-v5.webp",
  });
});

describe("offering cover generation", () => {
  it("uses the shared course-cover generator and persists through versioned offering update", async () => {
    await expect(generateOfferingCoverImage(claims, "offering-1")).resolves.toMatchObject({
      version: 5,
      coverImageUrl: expect.stringContaining("course-cover-v5.webp"),
    });
    expect(mocks.generate).toHaveBeenCalledWith(
      {
        name: "校园雨水花园",
        summary: "调查积水并设计雨水花园",
        term: "2026 秋季",
        outline: "调查、测量、设计与展示",
      },
      "offering-offering-1",
      undefined,
      "course-cover-v5",
    );
    expect(mocks.update).toHaveBeenCalledWith(claims, "offering-1", {
      coverImageUrl: expect.stringContaining("course-cover-v5.webp"),
      version: 4,
    });
  });

  it("does not generate when the teacher does not own the offering", async () => {
    mocks.owner.mockResolvedValue(null);
    await expect(generateOfferingCoverImage(claims, "offering-1")).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not generate for a missing offering", async () => {
    mocks.offering.mockResolvedValue(null);
    await expect(generateOfferingCoverImage(claims, "missing")).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    expect(mocks.owner).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
