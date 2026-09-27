import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { AiInteractionEvent } from "@/lib/session/types";

const mocks = vi.hoisted(() => ({
  loadAiEvents: vi.fn(),
}));
vi.mock("@/lib/ai-collaboration/audit-store", () => ({ loadCourseAiInteractionEvents: mocks.loadAiEvents }));
vi.mock("@/lib/companion/server-store", () => ({ loadCompanionState: vi.fn(async () => ({})) }));
vi.mock("@/lib/showcase/state", () => ({ loadShowcaseState: vi.fn(async () => ({})) }));
vi.mock("@/lib/project-practice/versions", () => ({ listProjectDocumentVersions: vi.fn(async () => []) }));

import { loadInstanceCourse } from "./v2-course-projection";

describe("V2 classroom AI evidence readback", () => {
  it("includes the saved practice transcript in the teacher course projection", async () => {
    const event: AiInteractionEvent = {
      id: "event-1", courseId: "instance", studentId: "student", stageKey: "make",
      conversationId: "conversation", source: "sidebar", eventType: "request",
      actorRole: "student", content: "如何验证？", createdAt: "2026-09-01T01:00:00Z",
    };
    mocks.loadAiEvents.mockResolvedValue([event]);
    const now = new Date("2026-09-01T01:00:00Z");
    const instance = {
      id: "instance", createdAt: now, updatedAt: now, status: "TEACHING", runtimeConfig: {},
      templateVersionId: "version", templateVersion: { templateId: "template", snapshot: {} },
      activityId: "activity", activity: {
        title: "Project", config: {}, chapter: { offeringId: "offering", offering: { invitations: [] } },
      },
      participations: [],
    };
    const empty = { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) };
    const db = new Proxy({}, {
      get: (_, name) => typeof name === "symbol" || name === "then"
        ? undefined
        : name === "classroomInstance" ? { findUnique: vi.fn(async () => instance) } : empty,
    }) as Prisma.TransactionClient;

    const course = await loadInstanceCourse("instance", db);

    expect(mocks.loadAiEvents).toHaveBeenCalledWith("instance", db, undefined);
    expect(course?.aiInteractionEvents).toEqual([event]);
  });
});
