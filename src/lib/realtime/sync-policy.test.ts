import { describe, expect, it } from "vitest";
import {
  COURSE_EVENT_POLL_INTERVAL_MS,
  courseRefreshDelay,
  isClassroomControlEvent,
  isRealtimePollingActive,
  latestEventCursor,
} from "./sync-policy";

describe("realtime synchronization policy", () => {
  it("keeps durable cursor reconciliation enabled with WebSocket connected", () => {
    expect(COURSE_EVENT_POLL_INTERVAL_MS.polling).toBe(1_000);
    expect(COURSE_EVENT_POLL_INTERVAL_MS.websocket).toBeGreaterThan(0);
    expect(COURSE_EVENT_POLL_INTERVAL_MS.websocket).toBeGreaterThanOrEqual(
      COURSE_EVENT_POLL_INTERVAL_MS.polling,
    );
  });

  it("spreads course-wide refreshes across a bounded jitter window", () => {
    expect(courseRefreshDelay(0)).toBe(250);
    expect(courseRefreshDelay(1)).toBe(1_500);
    expect(courseRefreshDelay(-1)).toBe(250);
    expect(courseRefreshDelay(2)).toBe(1_500);
  });

  it("refreshes classroom control events with low latency", () => {
    expect(courseRefreshDelay(0, "classroom-control")).toBe(50);
    expect(courseRefreshDelay(1, "classroom-control")).toBe(250);
    expect(isClassroomControlEvent("stage-changed", undefined)).toBe(true);
    expect(isClassroomControlEvent("course-updated", "SET_UI_STATE")).toBe(true);
    expect(isClassroomControlEvent("course-updated", "UPSERT_SUBMISSION")).toBe(false);
  });

  it("pauses background polling for hidden tabs", () => {
    expect(isRealtimePollingActive("visible")).toBe(true);
    expect(isRealtimePollingActive("hidden")).toBe(false);
    expect(isRealtimePollingActive(undefined)).toBe(true);
  });

  it("never moves a course event cursor backwards", () => {
    expect(latestEventCursor("18", "21", "19")).toBe("21");
    expect(latestEventCursor("7", undefined, "invalid")).toBe("7");
  });
});

it('compares V2 timestamp/UUID cursors without numeric conversion', () => {
  const first = '2026-09-08T00:00:00.000Z~11111111-1111-4111-8111-111111111111';
  const next = '2026-09-08T00:00:00.000Z~21111111-1111-4111-8111-111111111111';
  expect(latestEventCursor('9999999999999999999', first, next, first)).toBe(next);
});
