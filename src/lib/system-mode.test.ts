import { describe, expect, it } from "vitest";
import {
  generationTemplateForSystemMode,
  getStagesForSystemMode,
  mapStageKeyToSystemMode,
  resolveOpenPblSystemMode,
} from "./system-mode";

describe("current system contract", () => {
  it("always exposes the five supported stages", () => {
    expect(resolveOpenPblSystemMode()).toBe("new");
    expect(resolveOpenPblSystemMode("legacy")).toBe("new");
    expect(getStagesForSystemMode().map((stage) => stage.key)).toEqual([
      "launch",
      "ai-learning",
      "make",
      "showcase",
      "reflection",
    ]);
  });

  it("uses the current generation contract and maps removed stages to practice", () => {
    expect(generationTemplateForSystemMode()).toBe("new-ai-learning-only");
    expect(mapStageKeyToSystemMode("proposal")).toBe("make");
    expect(mapStageKeyToSystemMode("showcase")).toBe("showcase");
  });
});
