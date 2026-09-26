import type { SessionAction } from "@/lib/session/actions";
import type {
  ClassroomResourceProjection,
  CourseUiState,
  TeacherResourceProjection,
} from "@/lib/session/types";

// Leave enough time inside the one-second classroom SLO for request handling,
// React rendering and media playback when a WebSocket is unavailable. A
// healthy subscribed socket uses the slower watchdog interval below.
export const PROJECTION_POLL_INTERVAL_MS = 500;
export const PROJECTION_CONNECTED_CHECK_INTERVAL_MS = 15_000;
export const PROJECTION_REQUEST_TIMEOUT_MS = 750;
export const PROJECTION_COALESCE_MS = 100;

export type ProjectionPatch = Pick<
  CourseUiState,
  "resourceProjection" | "teacherResourceProjection"
>;

export type ProjectionStateSnapshot = ProjectionPatch & {
  courseId: string;
  courseVersion: number;
  projectionVersion: number;
  projectionUpdatedAt: string;
  serverTime: string;
  projectionController?: CourseUiState["projectionController"];
};

export function projectionPatchFromAction(
  action: SessionAction,
): ProjectionPatch | null {
  if (action.type !== "SET_UI_STATE") return null;
  const payload = action.payload as unknown;
  if (!isRecord(payload) || !isRecord(payload.patch)) return null;
  const patch = payload.patch;
  const keys = Object.keys(patch);
  if (
    keys.length === 0
    || keys.some((key) => key !== "resourceProjection" && key !== "teacherResourceProjection")
  ) {
    return null;
  }
  const result: ProjectionPatch = {};
  if (Object.hasOwn(patch, "resourceProjection")) {
    result.resourceProjection = patch.resourceProjection as CourseUiState["resourceProjection"];
  }
  if (Object.hasOwn(patch, "teacherResourceProjection")) {
    result.teacherResourceProjection = patch.teacherResourceProjection as CourseUiState["teacherResourceProjection"];
  }
  return result;
}

export function isProjectionOnlyAction(action: SessionAction): boolean {
  return projectionPatchFromAction(action) !== null;
}

export function normalizeProjectionPatch(
  patch: ProjectionPatch,
  projectionVersion: number,
  serverTime: string,
): ProjectionPatch {
  const result: ProjectionPatch = {};
  if (Object.hasOwn(patch, "resourceProjection")) {
    const projection = patch.resourceProjection;
    result.resourceProjection = projection
      ? {
          ...projection,
          ...(projection.viewState
            ? {
                viewState: {
                  ...projection.viewState,
                  updatedAt: serverTime,
                  revision: projectionVersion,
                },
              }
            : {}),
        }
      : null;
  }
  if (Object.hasOwn(patch, "teacherResourceProjection")) {
    const projection = patch.teacherResourceProjection;
    result.teacherResourceProjection = projection
      ? { ...projection, updatedAt: serverTime }
      : null;
  }
  return result;
}

export function projectionSnapshotFromUiState(input: {
  courseId: string;
  courseVersion: number;
  uiState: CourseUiState | undefined;
  serverTime?: string;
}): ProjectionStateSnapshot {
  const serverTime = input.serverTime ?? new Date().toISOString();
  return {
    courseId: input.courseId,
    courseVersion: input.courseVersion,
    projectionVersion: validVersion(input.uiState?.projectionVersion),
    projectionUpdatedAt: input.uiState?.projectionUpdatedAt ?? serverTime,
    serverTime,
    projectionController: input.uiState?.projectionController ?? null,
    resourceProjection: input.uiState?.resourceProjection ?? null,
    teacherResourceProjection: input.uiState?.teacherResourceProjection ?? null,
  };
}

export function estimateServerClockOffset(
  serverTime: string,
  requestStartedAt: number,
  responseReceivedAt: number,
): number {
  const parsed = Date.parse(serverTime);
  if (!Number.isFinite(parsed)) return 0;
  return parsed - (requestStartedAt + responseReceivedAt) / 2;
}

export function shouldApplyProjectionVersion(
  currentVersion: number | undefined,
  incomingVersion: number,
): boolean {
  return Number.isSafeInteger(incomingVersion)
    && incomingVersion >= 0
    && (currentVersion === undefined || incomingVersion > validVersion(currentVersion));
}

export function highestKnownProjectionVersion(
  ...versions: Array<number | undefined>
): number | undefined {
  const valid = versions.filter(
    (value): value is number => Number.isSafeInteger(value) && value! >= 0,
  );
  return valid.length ? Math.max(...valid) : undefined;
}

export function isImmediateProjectionPatch(
  previous: CourseUiState | undefined,
  patch: ProjectionPatch,
): boolean {
  if (Object.hasOwn(patch, "resourceProjection")) {
    const before = previous?.resourceProjection;
    const after = patch.resourceProjection;
    if (!before || !after || before.resourceId !== after.resourceId) return true;
    if (before.viewState?.mediaPlaying !== after.viewState?.mediaPlaying) return true;
  }
  if (Object.hasOwn(patch, "teacherResourceProjection")) {
    const before = previous?.teacherResourceProjection;
    const after = patch.teacherResourceProjection;
    if (!before || !after || before.sceneId !== after.sceneId) return true;
    if (before.engineMode !== after.engineMode) return true;
  }
  return false;
}

export function mergeCourseUiStateWithProjectionGuard(
  current: CourseUiState | undefined,
  incoming: CourseUiState | undefined,
  projectionWritePending: boolean,
): CourseUiState | undefined {
  const currentVersion = validVersion(current?.projectionVersion);
  const incomingVersion = validVersion(incoming?.projectionVersion);
  if (!projectionWritePending && currentVersion <= incomingVersion) return incoming;
  return {
    ...incoming,
    resourceProjection: current?.resourceProjection ?? null,
    teacherResourceProjection: current?.teacherResourceProjection ?? null,
    projectionVersion: Math.max(currentVersion, incomingVersion),
    projectionUpdatedAt: current?.projectionUpdatedAt,
    projectionClockOffsetMs: current?.projectionClockOffsetMs,
    projectionController: current?.projectionController,
  };
}

export function withProjectionClockOffset<T extends ProjectionStateSnapshot>(
  snapshot: T,
  offsetMs: number,
): T {
  const resourceProjection = adjustResourceProjectionTime(
    snapshot.resourceProjection,
    offsetMs,
  );
  const teacherResourceProjection = adjustTeacherProjectionTime(
    snapshot.teacherResourceProjection,
    offsetMs,
  );
  return { ...snapshot, resourceProjection, teacherResourceProjection };
}

function adjustResourceProjectionTime(
  projection: ClassroomResourceProjection | null | undefined,
  offsetMs: number,
): ClassroomResourceProjection | null {
  if (!projection) return null;
  const updatedAt = projection.viewState?.updatedAt;
  if (!updatedAt) return projection;
  return {
    ...projection,
    viewState: {
      ...projection.viewState!,
      updatedAt: adjustServerTime(updatedAt, offsetMs),
    },
  };
}

function adjustTeacherProjectionTime(
  projection: TeacherResourceProjection | null | undefined,
  offsetMs: number,
): TeacherResourceProjection | null {
  if (!projection?.updatedAt) return projection ?? null;
  return { ...projection, updatedAt: adjustServerTime(projection.updatedAt, offsetMs) };
}

function adjustServerTime(value: string, offsetMs: number): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? new Date(parsed - offsetMs).toISOString()
    : value;
}

function validVersion(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) >= 0 ? value! : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
