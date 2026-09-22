import { describe, expect, it } from "vitest";
import type { SceneOutline } from "@/lib/openmaic/types/generation";
import { hasExactUpdateTargetBudget } from "./job-runner";

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
