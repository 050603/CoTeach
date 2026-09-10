import { describe, expect, it } from "vitest";
import {
  estimateServerClockOffset,
  highestKnownProjectionVersion,
  isImmediateProjectionPatch,
  mergeCourseUiStateWithProjectionGuard,
  normalizeProjectionPatch,
  projectionPatchFromAction,
  shouldApplyProjectionVersion,
  withProjectionClockOffset,
  type ProjectionStateSnapshot,
} from "./projection-state";

describe("projection state protocol", () => {
  it("recognizes only projection-only UI actions", () => {
    expect(projectionPatchFromAction({
      type: "SET_UI_STATE",
      payload: { courseId: "course-1", patch: { resourceProjection: null } },
    })).toEqual({ resourceProjection: null });
    expect(projectionPatchFromAction({
      type: "SET_UI_STATE",
      payload: {
        courseId: "course-1",
        patch: { resourceProjection: null, timerRunning: true },
      },
    })).toBeNull();
  });

  it("replaces client timestamps and revisions with monotonic server values", () => {
    const normalized = normalizeProjectionPatch({
      resourceProjection: {
        resourceId: "resource-1",
        stageKey: "launch",
        title: "课件",
        startedAt: "2026-09-10T00:00:00.000Z",
        viewState: {
          mediaTime: 12,
          mediaPlaying: true,
          updatedAt: "2020-01-01T00:00:00.000Z",
          revision: 9,
        },
      },
    }, 42, "2026-09-10T01:00:00.000Z");
    expect(normalized.resourceProjection?.viewState).toMatchObject({
      updatedAt: "2026-09-10T01:00:00.000Z",
      revision: 42,
    });
  });

  it("rejects duplicate and out-of-order versions", () => {
    expect(shouldApplyProjectionVersion(undefined, 0)).toBe(true);
    expect(shouldApplyProjectionVersion(8, 9)).toBe(true);
    expect(shouldApplyProjectionVersion(8, 8)).toBe(false);
    expect(shouldApplyProjectionVersion(8, 7)).toBe(false);
    expect(highestKnownProjectionVersion(undefined, 12, 9)).toBe(12);
    expect(shouldApplyProjectionVersion(
      highestKnownProjectionVersion(undefined, 12),
      11,
    )).toBe(false);
  });

  it("keeps a newer or optimistic projection when a full snapshot arrives late", () => {
    const current = {
      projectionVersion: 9,
      projectionUpdatedAt: "2026-09-10T00:00:09.000Z",
      resourceProjection: null,
      teacherResourceProjection: {
        classroomId: "room-1",
        sceneId: "scene-new",
        stageKey: "launch",
        title: "最新页面",
        sceneType: "slide" as const,
        startedAt: "2026-09-10T00:00:09.000Z",
      },
    };
    const incoming = {
      projectionVersion: 8,
      teacherResourceProjection: null,
    };
    expect(mergeCourseUiStateWithProjectionGuard(current, incoming, false))
      .toMatchObject({ projectionVersion: 9, teacherResourceProjection: { sceneId: "scene-new" } });
    expect(mergeCourseUiStateWithProjectionGuard(current, { projectionVersion: 10 }, true))
      .toMatchObject({ projectionVersion: 10, teacherResourceProjection: { sceneId: "scene-new" } });
  });

  it("treats starts, stops, switches and play-state changes as immediate", () => {
    const base = {
      resourceId: "resource-1",
      stageKey: "launch",
      title: "视频",
      startedAt: "2026-09-10T00:00:00.000Z",
      viewState: {
        mediaPlaying: false,
        updatedAt: "2026-09-10T00:00:00.000Z",
        revision: 1,
      },
    };
    expect(isImmediateProjectionPatch({}, { resourceProjection: base })).toBe(true);
    expect(isImmediateProjectionPatch({ resourceProjection: base }, {
      resourceProjection: { ...base, viewState: { ...base.viewState!, mediaPlaying: true } },
    })).toBe(true);
    expect(isImmediateProjectionPatch({ resourceProjection: base }, {
      resourceProjection: { ...base, viewState: { ...base.viewState!, scrollRatio: 0.5 } },
    })).toBe(false);
    expect(isImmediateProjectionPatch({ resourceProjection: base }, { resourceProjection: null })).toBe(true);
  });

  it("uses the request midpoint to correct server timestamps", () => {
    const offset = estimateServerClockOffset(
      "2026-09-10T00:00:10.100Z",
      Date.parse("2026-09-10T00:00:00.000Z"),
      Date.parse("2026-09-10T00:00:00.200Z"),
    );
    expect(offset).toBe(10_000);
    const snapshot: ProjectionStateSnapshot = {
      courseId: "course-1",
      courseVersion: 2,
      projectionVersion: 1,
      projectionUpdatedAt: "2026-09-10T00:00:10.100Z",
      serverTime: "2026-09-10T00:00:10.100Z",
      teacherResourceProjection: null,
      resourceProjection: {
        resourceId: "resource-1",
        stageKey: "launch",
        title: "视频",
        startedAt: "2026-09-10T00:00:00.000Z",
        viewState: {
          mediaPlaying: true,
          mediaTime: 5,
          updatedAt: "2026-09-10T00:00:10.100Z",
          revision: 1,
        },
      },
    };
    expect(withProjectionClockOffset(snapshot, offset).resourceProjection?.viewState?.updatedAt)
      .toBe("2026-09-10T00:00:00.100Z");
  });
});
