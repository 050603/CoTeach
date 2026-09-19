import { describe, expect, it } from "vitest";
import {
  createLongCourseReplayFixture,
  MemoryPipelineStorage,
  PipelineError,
  runLongCourseReplay,
} from "./index";

describe("V5 fixed long-course replay", () => {
  it("runs slide and narration modules concurrently and resumes entirely from checkpoints", async () => {
    const fixture = createLongCourseReplayFixture(24);
    const storage = new MemoryPipelineStorage();
    const first = await runLongCourseReplay({ fixture, storage, concurrency: 8, runId: "first" });
    expect(first.result.artifacts.get("export")?.value).toMatchObject({ complete: true });
    expect(first.telemetry.maxActive).toBeGreaterThan(1);
    const artifactCount = storage.artifactCount();

    const resumed = await runLongCourseReplay({ fixture, storage, concurrency: 8, runId: "resume" });
    expect(resumed.telemetry.starts).toEqual([]);
    expect(resumed.result.reusedModules).toHaveLength(artifactCount);
    expect(storage.artifactCount()).toBe(artifactCount);
  });

  it("preserves completed stages across an injected fault", async () => {
    const fixture = createLongCourseReplayFixture(18);
    const storage = new MemoryPipelineStorage();
    const failure = await runLongCourseReplay({
      fixture,
      storage,
      concurrency: 6,
      runId: "faulted",
      faults: [{ moduleId: "actions:page-007", attempt: 1, kind: "transport" }],
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PipelineError);
    expect((failure as PipelineError).kind).toBe("transport");
    expect(storage.artifactCount()).toBeGreaterThan(1);

    const resumed = await runLongCourseReplay({
      fixture,
      storage,
      concurrency: 6,
      runId: "fault-resume",
    });
    expect(resumed.result.artifacts.has("export")).toBe(true);
    expect(resumed.result.reusedModules.length).toBeGreaterThan(1);
  });

  it("keeps narration, quiz, and audio after a slide-only page change", async () => {
    const fixture = createLongCourseReplayFixture(12);
    const storage = new MemoryPipelineStorage();
    await runLongCourseReplay({ fixture, storage, concurrency: 8, runId: "before-layout" });
    const changed = structuredClone(fixture);
    changed.pages[4].title = "固定课程第 5 页（布局调整）";

    const replay = await runLongCourseReplay({
      fixture: changed,
      storage,
      concurrency: 8,
      runId: "after-layout",
    });
    expect(replay.telemetry.starts).toEqual(expect.arrayContaining([
      "plan",
      "slide:page-005",
      "actions:page-005",
      "review:page-005",
      "export",
    ]));
    expect(replay.telemetry.starts).not.toContain("narration:page-005");
    expect(replay.telemetry.starts).not.toContain("audio:page-005");
    expect(replay.telemetry.starts).not.toContain("quiz");
    expect(replay.telemetry.starts).not.toContain("slide:page-004");
  });
});

