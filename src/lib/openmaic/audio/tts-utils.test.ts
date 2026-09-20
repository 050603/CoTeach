import { describe, expect, it } from "vitest";

import type { Action } from "@openmaic/lib/types/action";
import { splitLongSpeechActions } from "./tts-utils";

describe("splitLongSpeechActions visual anchors", () => {
  it("moves an anchored cue to the generated speech chunk containing its quote", () => {
    const speech = `目标短语${"甲".repeat(700)}。目标短语${"乙".repeat(700)}。`;
    const actions: Action[] = [
      {
        id: "focus",
        type: "spotlight",
        elementId: "element",
        speechId: "speech",
        speechAnchor: { quote: "目标短语", occurrence: 1 },
      },
      { id: "speech", type: "speech", text: speech },
    ];

    const split = splitLongSpeechActions(actions, "glm-tts");
    expect(split.filter((action) => action.type === "speech").map((action) => action.id))
      .toEqual(["speech_tts_1", "speech_tts_2"]);
    expect(split[0]).toMatchObject({
      type: "spotlight",
      speechId: "speech_tts_2",
      speechAnchor: { quote: "目标短语", occurrence: 0 },
    });
  });
});
