// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
const mocks = vi.hoisted(() => ({ load: vi.fn(), persist: vi.fn(), loadTemplate: vi.fn(), saveTemplate: vi.fn() }));
vi.mock("./v2-course-projection", () => ({ loadInstanceCourse: mocks.load, persistInstanceCourse: mocks.persist, json: (value: unknown) => value }));
vi.mock("@/lib/platform/pbl-template-repository", () => ({ loadPblTemplateCourse: mocks.loadTemplate, savePblTemplateCourse: mocks.saveTemplate }));
import { mutateProjectedCourse } from "./session-repository";
import { createPblTemplateCourse } from "@/lib/platform/pbl-template";
import { applySessionAction, initialSessionState } from "@/lib/session/actions";

describe("SET_STAGE action receipt readback", () => {
  beforeEach(() => vi.clearAllMocks());
  it("persists the unchanged reducer transition and returns its committed version without loading evidence again", async () => {
    const before = createPblTemplateCourse("instance", { name: "Course" });
    before.status = "teaching"; before.version = 7;
    before.uiState = { resourceProjection: { resourceId: "resource", stageKey: "launch", title: "Projection", startedAt: "2026-09-27T00:00:00Z" }, projectionController: { teacherId: "teacher", clientId: "tab" } };
    const action = { type: "SET_STAGE" as const, payload: { id: before.id, index: 100 } };
    const tx = { $queryRaw: vi.fn(async () => []), classroomInstance: { findUnique: vi.fn(async () => ({ id: before.id })) } } as unknown as Prisma.TransactionClient;
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-27T01:00:00Z"));
    try {
      const expected = applySessionAction({ ...initialSessionState(), courses: [before] }, action).courses[0];
      const result = await mutateProjectedCourse(tx, action, "teacher", { id: "teacher", role: "teacher" }, before, { skipStageReadback: true });
      expect(mocks.persist).toHaveBeenCalledWith(tx, before, expected, { id: "teacher", role: "teacher" });
      expect(result).toEqual({ ...expected, version: 8 });
      expect(result?.currentStageIndex).toBe(before.stages.length - 1);
      expect(result?.uiState?.projectionController).toBeNull();
      expect(mocks.load).not.toHaveBeenCalled();
      mocks.load.mockResolvedValue({ ...expected, version: 8 });
      expect(await mutateProjectedCourse(tx, action, "teacher", { id: "teacher", role: "teacher" }, before)).toEqual(result);
      expect(mocks.load).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it("keeps ordinary actions on the existing full readback path", async () => {
    const before = createPblTemplateCourse("instance", {});
    const tx = { $queryRaw: vi.fn(async () => []), classroomInstance: { findUnique: vi.fn(async () => ({ id: before.id })) } } as unknown as Prisma.TransactionClient;
    mocks.load.mockResolvedValue(before);
    await mutateProjectedCourse(tx, { type: "SET_UI_STATE", payload: { courseId: before.id, patch: {} } }, "teacher", undefined, before, { skipStageReadback: true });
    expect(mocks.load).toHaveBeenCalledOnce();
  });
});
