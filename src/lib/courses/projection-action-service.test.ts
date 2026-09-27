import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";
import type { ActionEnvelope } from "./contracts";

const mocks = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
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
        projectionControl: { clientId: "tab-1" },
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
    mocks.tx.$queryRaw.mockResolvedValue([{
      runtimeConfig: { version: 5, uiState: { projectionVersion: 7 } },
      offeringId: "offering-1", userStatus: "ACTIVE", userRole: "TEACHER",
      sessionVersion: 1, isTeacher: true, receipt: null,
    }]);
    mocks.tx.classroomInstance.update.mockResolvedValue({});
    mocks.publishCourseEvent.mockResolvedValue(undefined);
  });

  it("commits a monotonic snapshot before broadcasting it", async () => {
    const ack = await executeCourseAction("course-1", projectionEnvelope(), claims);

    expect(mocks.canAccessLegacyCourse).not.toHaveBeenCalled();
    expect(mocks.tx.$queryRaw).toHaveBeenCalledOnce();
    expect(mocks.lockProjectedCourse.mock.invocationCallOrder[0]).toBeLessThan(mocks.tx.$queryRaw.mock.invocationCallOrder[0]);
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
    const [scope] = await mocks.tx.$queryRaw();
    scope.receipt = storedPayload;

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

  it("requires explicit takeover for another teacher or browser tab", async () => {
    const [instance] = await mocks.tx.$queryRaw();
    instance.runtimeConfig.uiState.projectionController = { teacherId: "teacher-2", clientId: "tab-2" };
    await expect(executeCourseAction("course-1", projectionEnvelope(), claims))
      .rejects.toMatchObject({ code: "PROJECTION_CONTROL_CONFLICT", status: 409 });
    expect(mocks.tx.classroomInstance.update).not.toHaveBeenCalled();
    const envelope = projectionEnvelope();
    if (envelope.action.type === "SET_UI_STATE") envelope.action.payload.projectionControl = { clientId: "tab-1", takeover: true };
    await executeCourseAction("course-1", envelope, claims);
    expect(mocks.tx.classroomInstance.update).toHaveBeenCalledWith(expect.objectContaining({ data: { runtimeConfig: expect.objectContaining({ uiState: expect.objectContaining({ projectionController: { teacherId: "teacher-1", clientId: "tab-1" } }) }) } }));
  });

  it("releases ownership when the controller stops projecting", async () => {
    const [instance] = await mocks.tx.$queryRaw();
    instance.runtimeConfig.uiState.projectionController = { teacherId: "teacher-1", clientId: "tab-1" };
    const envelope = projectionEnvelope();
    if (envelope.action.type === "SET_UI_STATE") envelope.action.payload.patch = { resourceProjection: null, teacherResourceProjection: null };
    await executeCourseAction("course-1", envelope, claims);
    expect(mocks.tx.classroomInstance.update).toHaveBeenCalledWith(expect.objectContaining({ data: { runtimeConfig: expect.objectContaining({ uiState: expect.objectContaining({ projectionController: null }) }) } }));
  });

  it("rejects forged control ownership and mixed projection patches", async () => {
    const forged = projectionEnvelope();
    if (forged.action.type === "SET_UI_STATE") forged.action.payload.patch.projectionController = { teacherId: "teacher-1", clientId: "tab-1" };
    await expect(executeCourseAction("course-1", forged, claims)).rejects.toMatchObject({ code: "FORBIDDEN_ACTION" });
    const mixed = projectionEnvelope();
    if (mixed.action.type === "SET_UI_STATE") mixed.action.payload.patch.projectionVersion = 100;
    await expect(executeCourseAction("course-1", mixed, claims)).rejects.toMatchObject({ code: "INVALID_PROJECTION_PATCH" });
  });
  it.each([
    { userStatus: "DISABLED" }, { userRole: "STUDENT" },
    { sessionVersion: 2 }, { isTeacher: false },
  ])("rejects changed authorization before new writes and old receipt replay: %j", async change => {
    const envelope = projectionEnvelope();
    await executeCourseAction("course-1", envelope, claims);
    const [scope] = await mocks.tx.$queryRaw();
    Object.assign(scope, change, { receipt: mocks.tx.domainEvent.create.mock.calls[0][0].data.payload });
    await expect(executeCourseAction("course-1", envelope, claims)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    scope.receipt = null;
    await expect(executeCourseAction("course-1", projectionEnvelope("new-request"), claims)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(mocks.tx.classroomInstance.update).toHaveBeenCalledTimes(1);
    expect(mocks.tx.domainEvent.create).toHaveBeenCalledTimes(1);
    expect(mocks.publishCourseEvent).toHaveBeenCalledTimes(1);
  });

  it("denies missing course or current actor without publishing a stored receipt", async () => {
    mocks.tx.$queryRaw.mockResolvedValue([]);
    await expect(executeCourseAction("foreign-course", projectionEnvelope(), claims)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(mocks.tx.classroomInstance.update).not.toHaveBeenCalled();
    expect(mocks.publishCourseEvent).not.toHaveBeenCalled();
  });

});
