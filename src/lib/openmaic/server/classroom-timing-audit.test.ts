import { describe, expect, it, vi } from "vitest";
import type { Scene } from "@openmaic/lib/types/stage";
import { remeasureClassroomSpeech } from "./classroom-timing-audit";

function wav(seconds: number): Uint8Array {
  const dataSize = seconds * 8_000 * 2;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8_000, 24);
  bytes.writeUInt32LE(16_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(dataSize, 40);
  return bytes;
}

describe("classroom speech duration recheck", () => {
  it("remeasures current files and discards stale or missing audio durations", async () => {
    const scenes = [{ id: "slide", actions: [
      { id: "valid", type: "speech", text: "讲授", audioUrl: "/api/openmaic/classroom-media/classroom-1/audio/current.wav", audioDurationSec: 99 },
      { id: "missing", type: "speech", text: "小测", audioUrl: "/api/openmaic/classroom-media/classroom-1/audio/missing.wav", audioDurationSec: 22 },
      { id: "invalidated", type: "speech", text: "新讲稿", audioUrl: "/api/openmaic/classroom-media/classroom-1/audio/old.wav", audioDurationSec: 5, audioInvalidated: true },
      { id: "wrong-classroom", type: "speech", text: "其他课堂", audioUrl: "/api/openmaic/classroom-media/other/audio/current.wav", audioDurationSec: 7 },
    ] }] as unknown as Scene[];
    const readAudio = vi.fn(async (filename: string) => {
      if (filename.endsWith("current.wav")) return wav(2);
      throw new Error("file missing");
    });

    const [measured] = await remeasureClassroomSpeech("classroom-1", scenes, readAudio);
    expect(measured.actions?.map((action) => action.type === "speech" ? action.audioDurationSec : undefined))
      .toEqual([2, undefined, undefined, undefined]);
    expect(readAudio).toHaveBeenCalledTimes(2);
  });
});
