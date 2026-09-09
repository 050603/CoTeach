import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";

const mocks = vi.hoisted(() => ({
  teacher: vi.fn(),
  offering: vi.fn(),
  owner: vi.fn(),
  generate: vi.fn(),
  persistUpload: vi.fn(),
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
  persistUploadedCourseCover: mocks.persistUpload,
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
  mocks.generate.mockImplementation(async (
    _course: unknown,
    _classroomId: string,
    _signal: AbortSignal | undefined,
    elementId: string,
  ) => `/api/openmaic/classroom-media/offering-offering-1/media/${elementId}.webp`);
  mocks.persistUpload.mockImplementation(async (
    _file: File,
    _classroomId: string,
    elementId: string,
  ) => `/api/openmaic/classroom-media/offering-offering-1/media/${elementId}.webp`);
  mocks.update.mockImplementation(async (
    _claims: AuthClaims,
    _offeringId: string,
    input: { coverImageUrl: string },
  ) => ({ id: "offering-1", version: 5, coverImageUrl: input.coverImageUrl }));
});

describe("offering cover generation", () => {
  it("uses the shared course-cover generator and persists through versioned offering update", async () => {
    await expect(generateOfferingCoverImage(claims, "offering-1")).resolves.toMatchObject({
      version: 5,
      coverImageUrl: expect.stringMatching(/course-cover-v5-[0-9a-f-]{36}\.webp$/),
    });
    expect(mocks.generate).toHaveBeenCalledWith(
      {
        coverKind: "course",
        name: "校园雨水花园",
        summary: "调查积水并设计雨水花园",
        term: "2026 秋季",
        outline: "调查、测量、设计与展示",
      },
      "offering-offering-1",
      undefined,
      expect.stringMatching(/^course-cover-v5-[0-9a-f-]{36}$/),
    );
    expect(mocks.update).toHaveBeenCalledWith(claims, "offering-1", {
      coverImageUrl: expect.stringMatching(/course-cover-v5-[0-9a-f-]{36}\.webp$/),
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

  it("normalizes and persists a teacher-uploaded course cover", async () => {
    const { uploadOfferingCoverImage } = await import("./offering-cover-server");
    const file = new File(["image"], "cover.png", { type: "image/png" });

    await uploadOfferingCoverImage(claims, "offering-1", file);

    expect(mocks.persistUpload).toHaveBeenCalledWith(
      file,
      "offering-offering-1",
      expect.stringMatching(/^course-cover-upload-v5-[0-9a-f-]{36}$/),
    );
    expect(mocks.update).toHaveBeenCalledWith(claims, "offering-1", {
      coverImageUrl: expect.stringMatching(/course-cover-upload-v5-[0-9a-f-]{36}\.webp$/),
      version: 4,
    });
  });
});
