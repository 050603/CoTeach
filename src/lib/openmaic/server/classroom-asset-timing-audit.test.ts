import { describe, expect, it } from "vitest";
import type { SceneOutline } from "@openmaic/lib/types/generation";
import type { Scene } from "@openmaic/lib/types/stage";
import { summarizeTeachingTimingAudit } from "./classroom-asset-generation";

const outlines: SceneOutline[] = [
  {
    id: "teach", type: "slide", title: "讲解", description: "机制与例子", keyPoints: ["机制", "例子", "边界"], order: 0,
    targetDurationSec: 240,
    plannedTiming: { narrationSec: 204, learnerActivitySec: 30, transitionSec: 6, role: "teaching" },
  },
  {
    id: "quiz", type: "quiz", title: "小测", description: "检查理解", keyPoints: ["判断"], order: 1,
    targetDurationSec: 60,
    plannedTiming: { narrationSec: 15, learnerActivitySec: 42, transitionSec: 3, role: "assessment" },
  },
];

const scenes = [
  { id: "scene-teach", outlineId: "teach", type: "slide", actions: [{ id: "speech-1", type: "speech", text: "讲授", audioDurationSec: 198.4 }] },
  { id: "scene-quiz", outlineId: "quiz", type: "quiz", actions: [{ id: "speech-2", type: "speech", text: "读题与反馈", audioDurationSec: 13.2 }] },
] as unknown as Scene[];

describe("classroom teaching timing audit", () => {
  it("separates measured teaching audio from assessment audio", () => {
    expect(summarizeTeachingTimingAudit({ outlines, studentScenes: scenes, enableTTS: true })).toMatchObject({
      totalBudgetSec: 300,
      plannedSubstantiveTeachingSec: 204,
      plannedAssessmentSec: 60,
      plannedLearnerActivitySec: 36,
      substantiveTeachingDurationSec: 198.4,
      assessmentAudioDurationSec: 13.2,
      narrationDurationSource: "actual-audio",
      measuredSegmentCount: 2,
      narrationSegmentCount: 2,
      complete: true,
      substantiveTeachingRatio: 0.6613,
      teachingDurationDeviationRatio: 0.0275,
      teachingDurationToleranceRatio: 0.1,
      teachingRatioValid: true,
    });
  });

  it("uses the approved natural-speed script estimate when TTS is disabled", () => {
    expect(summarizeTeachingTimingAudit({ outlines, studentScenes: scenes, enableTTS: false })).toMatchObject({
      substantiveTeachingDurationSec: 204,
      assessmentAudioDurationSec: 0,
      narrationDurationSource: "estimated-script",
      measuredSegmentCount: 0,
      complete: true,
      substantiveTeachingRatio: 0.68,
      teachingDurationDeviationRatio: 0,
      teachingDurationToleranceRatio: 0.1,
      teachingRatioValid: true,
    });
  });

  it("accepts normal classroom pacing variance around the approved teaching budget", () => {
    const longerTeaching = scenes.map((scene) => scene.outlineId === "teach"
      ? { ...scene, actions: [{ id: "speech-1", type: "speech" as const, text: "讲授", audioDurationSec: 218 }] }
      : scene) as Scene[];
    const audit = summarizeTeachingTimingAudit({ outlines, studentScenes: longerTeaching, enableTTS: true });

    expect(audit.substantiveTeachingRatio).toBeCloseTo(0.7267, 4);
    expect(audit.teachingDurationDeviationRatio).toBeCloseTo(0.0686, 4);
    expect(audit.teachingRatioValid).toBe(true);
  });

  it("does not reintroduce a fixed narration ratio for legacy outlines without a planned split", () => {
    const legacyOutlines = outlines.map(({ plannedTiming: _plannedTiming, ...item }) => item);
    const audit = summarizeTeachingTimingAudit({ outlines: legacyOutlines, studentScenes: scenes, enableTTS: true });

    expect(audit.plannedSubstantiveTeachingSec).toBe(0);
    expect(audit.substantiveTeachingRatio).toBeCloseTo(0.6613, 4);
    expect(audit.teachingRatioValid).toBe(true);
  });

  it("still reports a material actual-audio deviation without requesting automatic regeneration", () => {
    const muchLongerTeaching = scenes.map((scene) => scene.outlineId === "teach"
      ? { ...scene, actions: [{ id: "speech-1", type: "speech" as const, text: "讲授", audioDurationSec: 230 }] }
      : scene) as Scene[];

    expect(summarizeTeachingTimingAudit({ outlines, studentScenes: muchLongerTeaching, enableTTS: true }))
      .toMatchObject({ teachingRatioValid: false, teachingDurationToleranceRatio: 0.1 });
  });
});
