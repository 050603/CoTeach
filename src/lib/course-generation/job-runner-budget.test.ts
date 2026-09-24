import { describe, expect, it } from "vitest";
import type { SceneOutline } from "@/lib/openmaic/types/generation";
import { hasExactTestLessonBudget, hasExactUpdateTargetBudget } from "./job-runner";

const confirmed = [
  { id: "section-a-slide", type: "slide", title: "A", description: "A", keyPoints: [], targetDurationSec: 480, order: 0 },
  { id: "section-a-quiz", type: "quiz", title: "A quiz", description: "A quiz", keyPoints: [], targetDurationSec: 120, order: 1 },
  { id: "section-b-slide", type: "slide", title: "B", description: "B", keyPoints: [], targetDurationSec: 900, order: 2 },
] as SceneOutline[];

describe("partial classroom update budget", () => {
  it("checks a selected section against only its confirmed minutes", () => {
    expect(hasExactUpdateTargetBudget(
      confirmed.slice(0, 2),
      confirmed,
      ["section-a-slide", "section-a-quiz"],
    )).toBe(true);
  });

  it("rejects changed duration, missing pages, and duplicate target ids", () => {
    expect(hasExactUpdateTargetBudget(
      [{ ...confirmed[0]!, targetDurationSec: 420 }, confirmed[1]!],
      confirmed,
      ["section-a-slide", "section-a-quiz"],
    )).toBe(false);
    expect(hasExactUpdateTargetBudget(
      [confirmed[0]!],
      confirmed,
      ["section-a-slide", "section-a-quiz"],
    )).toBe(false);
    expect(hasExactUpdateTargetBudget(
      [confirmed[0]!, confirmed[1]!],
      confirmed,
      ["section-a-slide", "section-a-slide"],
    )).toBe(false);
  });
});

describe("test lesson continuation budget", () => {
  const testLesson = { sceneOutlineIds: ["section-a-slide", "section-a-quiz"], durationSeconds: 600 };
  const expanded = [
    { ...confirmed[0]!, spatialParentId: "section-a-slide", targetDurationSec: 240 },
    { ...confirmed[0]!, id: "section-a-slide--continuation-2", spatialParentId: "section-a-slide", targetDurationSec: 240 },
    ...confirmed.slice(1),
  ];
  it("counts adopted parent pages while summing all continuation durations", () => {
    expect(hasExactTestLessonBudget(confirmed, testLesson, 3)).toBe(true);
    expect(hasExactTestLessonBudget(expanded, testLesson, 3)).toBe(true);
  });
  it("rejects missing continuation time, duplicate pages, and unknown selected parents", () => {
    expect(hasExactTestLessonBudget(expanded.filter((page) => !page.id.includes('continuation')), testLesson, 3)).toBe(false);
    expect(hasExactTestLessonBudget([...expanded, expanded[0]!], testLesson, 3)).toBe(false);
    expect(hasExactTestLessonBudget(expanded, { ...testLesson, sceneOutlineIds: ['unknown'] }, 3)).toBe(false);
  });
});
