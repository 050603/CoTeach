import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";
import type { ActionEnvelope } from "./contracts";

const mocks = vi.hoisted(() => {
  const tx = {
    classroomInstance: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    domainEvent: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  };
  return {
    tx,
    lockProjectedCourse: vi.fn(),
    publishCourseEvent: vi.fn(),
    canAccessLegacyCourse: vi.fn(),
  };
});

vi.mock("@/lib/db/transaction-retry", () => ({
  runMutationTransaction: async (operation: (tx: typeof mocks.tx) => unknown) => operation(mocks.tx),
}));
vi.mock("@/lib/db/session-repository", () => ({
  lockProjectedCourse: mocks.lockProjectedCourse,
  loadCourse: vi.fn(),
  mutateProjectedCourse: vi.fn(),
}));
vi.mock("@/lib/platform/access", () => ({
  canAccessLegacyCourse: mocks.canAccessLegacyCourse,
}));
vi.mock("@/lib/realtime/event-bus", () => ({
  publishCourseEvent: mocks.publishCourseEvent,
}));

import { executeCourseAction } from "./action-service";

const claims: AuthClaims = {
  role: "teacher",
  sub: "teacher-1",
  username: "teacher",
  displayName: "教师",
  sv: 1,
};

function projectionEnvelope(requestId = "018f47a2-89d4-7c12-a4f4-18f244f6ec0b"): ActionEnvelope {
  return {
    requestId,
    action: {
      type: "SET_UI_STATE",
      payload: {
        courseId: "course-1",
        patch: {
          resourceProjection: {
            resourceId: "resource-1",
            stageKey: "launch",
            title: "课堂视频",
            startedAt: "2026-09-10T00:00:00.000Z",
            viewState: {
              mediaTime: 8,
              mediaPlaying: true,
              updatedAt: "2020-01-01T00:00:00.000Z",
              revision: 2,
            },
          },
        },
      },
    },
  };
}

describe("projection course action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canAccessLegacyCourse.mockResolvedValue(true);
    mocks.tx.domainEvent.findUnique.mockResolvedValue(null);
    mocks.tx.domainEvent.create.mockResolvedValue({});
    mocks.tx.classroomInstance.findUnique.mockResolvedValue({
      runtimeConfig: { version: 5, uiState: { projectionVersion: 7 } },
      activity: { chapter: { offeringId: "offering-1" } },
    });
    mocks.tx.classroomInstance.update.mockResolvedValue({});
    mocks.publishCourseEvent.mockResolvedValue(undefined);
  });

  it("commits a monotonic snapshot before broadcasting it", async () => {
    const ack = await executeCourseAction("course-1", projectionEnvelope(), claims);

    expect(ack.courseVersion).toBe(6);
    expect(ack.projection).toMatchObject({
      projectionVersion: 8,
      courseVersion: 6,
      resourceProjection: {
        viewState: { revision: 8 },
      },
    });
    expect(mocks.tx.classroomInstance.update).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        runtimeConfig: expect.objectContaining({
          version: 6,
          uiState: expect.objectContaining({ projectionVersion: 8 }),
        }),
      },
    }));
    expect(mocks.tx.domainEvent.create).toHaveBeenCalledOnce();
    expect(mocks.publishCourseEvent).toHaveBeenCalledWith(
      "course-1",
      expect.objectContaining({
        type: "projection-changed",
        payload: expect.objectContaining({ projectionVersion: 8 }),
      }),
    );
    expect(mocks.tx.domainEvent.create.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.publishCourseEvent.mock.invocationCallOrder[0]);
  });

  it("returns an idempotent receipt without writing the projection twice", async () => {
    const first = await executeCourseAction("course-1", projectionEnvelope(), claims);
    const storedPayload = mocks.tx.domainEvent.create.mock.calls[0][0].data.payload;
    mocks.tx.domainEvent.findUnique.mockResolvedValue({ payload: storedPayload });

    const second = await executeCourseAction("course-1", projectionEnvelope(), claims);

    expect(second).toEqual(first);
    expect(mocks.tx.classroomInstance.update).toHaveBeenCalledTimes(1);
    expect(mocks.tx.domainEvent.create).toHaveBeenCalledTimes(1);
  });

  it("does not broadcast when the transaction fails", async () => {
    mocks.tx.classroomInstance.update.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(executeCourseAction("course-1", projectionEnvelope(), claims))
      .rejects.toThrow("database unavailable");
    expect(mocks.publishCourseEvent).not.toHaveBeenCalled();
  });

  it("rejects student projection control before entering the transaction", async () => {
    const student: AuthClaims = {
      role: "student",
      sub: "student-1",
      studentName: "学生",
      sv: 1,
    };
    await expect(executeCourseAction("course-1", projectionEnvelope(), student))
      .rejects.toMatchObject({ code: "FORBIDDEN_ACTION", status: 403 });
    expect(mocks.lockProjectedCourse).not.toHaveBeenCalled();
  });
});
