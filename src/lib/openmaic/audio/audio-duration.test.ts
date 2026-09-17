import { describe, expect, it } from "vitest";
import { audioDurationSec } from "./audio-duration";

function wav(seconds: number, sampleRate = 8_000): Uint8Array {
  const byteRate = sampleRate * 2;
  const dataSize = seconds * byteRate;
  const data = new Uint8Array(44 + dataSize);
  const view = new DataView(data.buffer);
  const ascii = (offset: number, text: string) => [...text].forEach((char, index) => { data[offset + index] = char.charCodeAt(0); });
  ascii(0, "RIFF"); view.setUint32(4, 36 + dataSize, true); ascii(8, "WAVE"); ascii(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, byteRate, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, dataSize, true);
  return data;
}

function mp3Frames(count: number): Uint8Array {
  // MPEG-1 Layer III, 128 kbps, 44.1 kHz, no padding: 417 bytes/frame.
  const data = new Uint8Array(count * 417);
  for (let index = 0; index < count; index += 1) data.set([0xff, 0xfb, 0x90, 0x64], index * 417);
  return data;
}

describe("generated audio duration", () => {
  it("reads WAV data duration", () => expect(audioDurationSec(wav(3), "wav")).toBe(3));
  it("sums MPEG frame durations", () => expect(audioDurationSec(mp3Frames(100), "mp3")).toBeCloseTo(100 * 1_152 / 44_100, 3));
  it("returns undefined for unsupported or malformed audio", () => {
    expect(audioDurationSec(new Uint8Array([1, 2, 3]), "ogg")).toBeUndefined();
    expect(audioDurationSec(new Uint8Array([1, 2, 3]), "wav")).toBeUndefined();
  });
});
