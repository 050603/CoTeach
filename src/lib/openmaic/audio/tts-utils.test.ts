import { describe, expect, it } from "vitest";

import type { Action } from "@openmaic/lib/types/action";
import { splitLongSpeechActions, splitLongSpeechText } from "./tts-utils";

describe("splitLongSpeechText", () => {
  it("preserves whitespace, punctuation and surrogate pairs across chunks", () => {
    const original = "  甲。 \n乙，丙😀丁；戊  ";
    const chunks = splitLongSpeechText(original, 6);
    expect(chunks.join("")).toBe(original);
    expect(chunks.every((chunk) => chunk.length <= 6)).toBe(true);
    expect(chunks.every((chunk) => !chunk.startsWith("\uDE00") && !chunk.endsWith("\uD83D"))).toBe(true);
  });
});

describe("splitLongSpeechActions visual anchors", () => {
  it("keeps an existing long clip and its visual bindings intact when resuming", () => {
    const actions: Action[] = [
      { id: "focus", type: "spotlight", elementId: "element", speechId: "speech" },
      { id: "speech", type: "speech", text: "甲".repeat(2000), audioUrl: "/api/openmaic/classroom-media/test/audio/reused.wav" },
    ];
    expect(splitLongSpeechActions(actions, "glm-tts")).toBe(actions);
  });

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

  it("keeps a complete quote in one chunk and rebinds its actual local occurrence", () => {
    const speech = "目标。".repeat(330) + "目标解释" + "甲".repeat(100);
    const actions: Action[] = [
      {
        id: "focus", type: "spotlight", elementId: "element", speechId: "speech",
        speechAnchor: { quote: "目标解释" },
      },
      { id: "speech", type: "speech", text: speech },
    ];
    const split = splitLongSpeechActions(actions, "glm-tts");
    const target = split.find((action) => action.id === "focus");
    expect(target).toMatchObject({
      type: "spotlight",
      speechId: "speech_tts_2",
      speechAnchor: { quote: "目标解释", occurrence: 0 },
    });
    expect(split.filter((action) => action.type === "speech").map((action) => action.text).join(""))
      .toBe(speech);
  });

  it("creates a cue for every covered clip and keeps the final end anchor in its own clip", () => {
    const speech = "先看这里。" + "甲".repeat(1100) + "再看这里。";
    const actions: Action[] = [
      {
        id: "focus", type: "spotlight", elementId: "element", speechId: "speech",
        speechAnchor: { quote: "先看这里" },
        endSpeechAnchor: { quote: "再看这里" },
        speechOffsetMs: 200,
        endSpeechOffsetMs: 9000,
      },
      { id: "speech", type: "speech", text: speech },
    ];
    const split = splitLongSpeechActions(actions, "glm-tts");
    const cues = split.filter((action) => action.type === "spotlight");
    expect(cues.length).toBeGreaterThan(1);
    expect(cues[0]).toMatchObject({
      speechId: "speech_tts_1",
      speechAnchor: { quote: "先看这里", occurrence: 0 },
    });
    expect(cues[0]?.endSpeechAnchor?.quote).toMatch(/[甲。]$/u);
    expect(cues[0]?.endSpeechAnchor).toBeDefined();
    expect(cues.at(-1)).toMatchObject({
      speechId: "speech_tts_3",
      endSpeechAnchor: { quote: "再看这里", occurrence: 0 },
    });
    expect(cues.at(-1)?.speechAnchor).toBeUndefined();
    expect(cues.every((cue) => cue.speechOffsetMs === undefined && cue.endSpeechOffsetMs === undefined))
      .toBe(true);
  });

  it("does not extend an implicitly ended spotlight across later sentences", () => {
    const speech = "这里是起点。接下来讲别的内容。" + "甲".repeat(1100);
    const actions: Action[] = [
      {
        id: "focus", type: "spotlight", elementId: "element",
        speechId: "speech", endSpeechId: "speech",
        speechAnchor: { quote: "这里是起点" },
      },
      { id: "speech", type: "speech", text: speech },
    ];
    const split = splitLongSpeechActions(actions, "glm-tts");
    const cues = split.filter((action) => action.type === "spotlight");
    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ speechId: "speech_tts_1" });
  });

  it("keeps the punctuation at a covered clip boundary inside its end anchor", () => {
    const speech = "起点。" + "甲".repeat(1018) + "。" + "乙".repeat(20) + "终点。";
    const split = splitLongSpeechActions([
      {
        id: "focus", type: "spotlight", elementId: "element", speechId: "speech",
        speechAnchor: { quote: "起点" }, endSpeechAnchor: { quote: "终点" },
      },
      { id: "speech", type: "speech", text: speech },
    ], "glm-tts");
    const cues = split.filter((action) => action.type === "spotlight");
    expect(cues).toHaveLength(2);
    expect(cues[0]?.endSpeechAnchor?.quote.endsWith("。")).toBe(true);
  });

  it("carries each laser target across clips and keeps waypoint order", () => {
    const speech = "甲步" + "甲".repeat(1019) + "。"
      + "过渡。乙步" + "乙".repeat(1018) + "。"
      + "再看。丙步" + "丙".repeat(995) + "。";
    const actions: Action[] = [
      {
        id: "path", type: "laser", elementId: "a", speechId: "speech",
        speechAnchor: { quote: "甲步" },
        waypoints: [
          { elementId: "b", speechAnchor: { quote: "乙步" }, speechOffsetMs: 2000 },
          { elementId: "c", speechAnchor: { quote: "丙步" }, speechOffsetMs: 4000 },
        ],
      },
      { id: "speech", type: "speech", text: speech },
    ];
    const split = splitLongSpeechActions(actions, "glm-tts");
    const cues = split.filter((action) => action.type === "laser");
    expect(cues).toHaveLength(3);
    expect(cues.map((cue) => cue.speechId)).toEqual([
      "speech_tts_1", "speech_tts_2", "speech_tts_3",
    ]);
    expect(cues.map((cue) => cue.elementId)).toEqual(["a", "a", "b"]);
    expect(cues[1]?.speechAnchor).toBeUndefined();
    expect(cues[1]?.waypoints?.map((waypoint) => waypoint.elementId)).toEqual(["b"]);
    expect(cues[2]?.waypoints?.map((waypoint) => waypoint.elementId)).toEqual(["c"]);
    expect(cues.flatMap((cue) => cue.waypoints ?? []).every((waypoint) => waypoint.speechOffsetMs === undefined))
      .toBe(true);
  });

  it("locates a repeated final laser phrase by its original character position", () => {
    const speech = "起点" + "甲".repeat(1000) + "。"
      + "再说起点，然后转到终点" + "乙".repeat(1000) + "。";
    const actions: Action[] = [
      {
        id: "path", type: "laser", elementId: "a", speechId: "speech",
        speechAnchor: { quote: "起点", occurrence: 0 },
        waypoints: [{ elementId: "b", speechAnchor: { quote: "终点" } }],
      },
      { id: "speech", type: "speech", text: speech },
    ];
    const split = splitLongSpeechActions(actions, "glm-tts");
    const cues = split.filter((action) => action.type === "laser");
    expect(cues.at(-1)?.waypoints?.[0]?.speechAnchor).toMatchObject({ quote: "终点", occurrence: 0 });
    expect(cues.at(-1)?.speechId).toBe("speech_tts_2");
  });

  it("omits cues with missing or uncontainable anchors instead of binding the first clip", () => {
    const speech = "甲".repeat(2200);
    const actions: Action[] = [
      {
        id: "missing", type: "spotlight", elementId: "element",
        speechId: "speech", speechAnchor: { quote: "不存在" },
      },
      {
        id: "too-long", type: "laser", elementId: "element",
        speechId: "speech", speechAnchor: { quote: "甲".repeat(1100) },
      },
      { id: "speech", type: "speech", text: speech },
    ];
    const split = splitLongSpeechActions(actions, "glm-tts");
    expect(split.some((action) => action.id === "missing" || action.id === "too-long")).toBe(false);
  });

  it("removes stale media and alignment when invalidated audio is split", () => {
    const actions: Action[] = [
      {
        id: "speech", type: "speech", text: "甲".repeat(1200),
        audioUrl: "/old.wav", audioInvalidated: true, audioDurationSec: 50,
        speechAlignment: {
          version: "1", status: "aligned", textHash: "old", audioHash: "old", spans: [],
        },
      },
    ];
    const split = splitLongSpeechActions(actions, "glm-tts");
    expect(split.filter((action) => action.type === "speech")).toHaveLength(2);
    for (const action of split) {
      if (action.type !== "speech") continue;
      expect(action.audioUrl).toBeUndefined();
      expect(action.audioDurationSec).toBeUndefined();
      expect(action.speechAlignment).toBeUndefined();
    }
  });
});
