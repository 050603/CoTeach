import { describe, expect, it } from "vitest";
import { estimateRemainingSeconds } from "./progress-estimate";

describe("course generation remaining-time estimate", () => {
  it("uses observed page throughput without truncating slow pages to 75 seconds", () => {
    const nowMs = Date.parse("2026-09-17T03:10:00.000Z");
    expect(estimateRemainingSeconds({
      startedAt: new Date("2026-09-17T03:00:00.000Z"),
      scenePhaseStartedAt: Date.parse("2026-09-17T03:00:00.000Z"),
      scenePhaseInitialGenerated: 4,
      scenesGenerated: 6,
      totalScenes: 10,
      progress: 40,
      baselineSeconds: 600,
      step: "generating_scenes",
      nowMs,
    })).toBe(1_260);
  });

  it("leaves the estimate unknown until the first page sample is complete", () => {
    expect(estimateRemainingSeconds({
      startedAt: new Date("2026-09-17T03:00:00.000Z"),
      scenePhaseStartedAt: Date.parse("2026-09-17T03:01:00.000Z"),
      scenePhaseInitialGenerated: 4,
      scenesGenerated: 4,
      totalScenes: 11,
      progress: 15,
      baselineSeconds: 900,
      step: "generating_scenes",
      nowMs: Date.parse("2026-09-17T03:05:00.000Z"),
    })).toBeNull();
  });
});
