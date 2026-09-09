import { decodeEventCursor } from "./event-cursor";

export type RealtimeTransportMode = "websocket" | "polling";

/**
 * WebSocket is the low-latency path. The durable database cursor remains the
 * correctness path so a client cannot become permanently stale when an API
 * request and its socket are handled by different server instances.
 */
export const COURSE_EVENT_POLL_INTERVAL_MS: Record<RealtimeTransportMode, number> = {
  // WebSocket events trigger immediate reconciliation. The durable cursor is
  // only a safety net here, so polling every few seconds creates unnecessary
  // database fan-out for a full classroom.
  websocket: 5_000,
  // Keep the outage/development fallback inside the classroom's acceptable
  // control window. Projection events are tiny and are applied locally, so
  // this does not fan out full course snapshots once per second.
  polling: 1_000,
};

export const SESSION_REFRESH_INTERVAL_MS = 15_000;
export const COURSE_SYNC_FAILURE_NOTICE_THRESHOLD = 3;

const COURSE_REFRESH_JITTER_MIN_MS = 250;
const COURSE_REFRESH_JITTER_RANGE_MS = 1_250;

/** Spread one course-wide event across clients instead of refreshing in lockstep. */
export function courseRefreshDelay(
  randomValue = Math.random(),
  priority: "classroom-control" | "standard" = "standard",
): number {
  const bounded = Math.min(1, Math.max(0, randomValue));
  if (priority === "classroom-control") {
    return 50 + Math.floor(bounded * 200);
  }
  return COURSE_REFRESH_JITTER_MIN_MS
    + Math.floor(bounded * COURSE_REFRESH_JITTER_RANGE_MS);
}

const CLASSROOM_CONTROL_ACTIONS = new Set([
  "ADVANCE_STAGE",
  "SET_STAGE",
  "SET_UI_STATE",
  "SET_PRESENTING_GROUP",
  "START_TEACHING",
  "END_TEACHING",
  "RESTART_TEACHING",
]);

export function isClassroomControlEvent(
  eventType: string | undefined,
  actionType: string | undefined,
): boolean {
  return eventType === "stage-changed"
    || eventType === "projection-changed"
    || (actionType !== undefined && CLASSROOM_CONTROL_ACTIONS.has(actionType));
}

export function isRealtimePollingActive(
  visibilityState: DocumentVisibilityState | undefined,
): boolean {
  return visibilityState !== "hidden";
}

export function latestEventCursor(
  ...values: Array<string | undefined>
): string {
  let latest = "0";
  for (const value of values) {
    if (value && decodeEventCursor(value)) {
      if (!decodeEventCursor(latest) || value > latest) latest = value;
      continue;
    }
    if (decodeEventCursor(latest) || !value || !/^\d+$/.test(value)) continue;
    const cursor = value.replace(/^0+(?=\d)/, "");
    if (
      cursor.length > latest.length
      || (cursor.length === latest.length && cursor > latest)
    ) {
      latest = cursor;
    }
  }
  return latest;
}
