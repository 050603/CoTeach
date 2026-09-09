import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";

const mocks = vi.hoisted(() => ({
  teacher: vi.fn(),
  instance: vi.fn(),
  owner: vi.fn(),
  participants: vi.fn(),
}));

vi.mock("./access", () => ({ requireTeacherUser: mocks.teacher }));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    classroomInstance: { findUnique: mocks.instance },
    courseTeacher: { findFirst: mocks.owner },
    classroomParticipation: { findMany: mocks.participants },
  },
}));

import { listClassroomParticipants } from "./classroom";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.teacher.mockResolvedValue({ id: "teacher" });
  mocks.owner.mockResolvedValue({ id: "link" });
  mocks.participants.mockResolvedValue([]);
  mocks.instance.mockResolvedValue({
    id: "instance",
    status: "FINISHED",
    activity: { title: "河流调查", chapter: { offeringId: "offering" } },
    templateVersion: {
      snapshot: {
        schemaVersion: 2,
        kind: "pbl-course",
        design: { coverImageUrl: "/classroom-cover.webp" },
      },
    },
  });
});

describe("teacher classroom record cover", () => {
  it("returns the immutable preparation cover with the classroom record", async () => {
    const result = await listClassroomParticipants(
      { sub: "teacher", role: "teacher" } as AuthClaims,
      "instance",
    );
    expect(result.instance).toMatchObject({
      id: "instance",
      coverImageUrl: "/classroom-cover.webp",
    });
  });
});
