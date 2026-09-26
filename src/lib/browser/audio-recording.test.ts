import { afterEach, describe, expect, it, vi } from "vitest";
import { audioRecordingFileName, createAudioRecorder } from "./audio-recording";
import { normalizeASRUploadAudio } from "@/lib/openmaic/audio/wav-utils";

afterEach(() => vi.unstubAllGlobals());

describe("browser audio recording formats", () => {
  it.each([
    ["audio/webm;codecs=opus", "recording.webm"],
    ["audio/mp4", "recording.m4a"],
    ["audio/ogg;codecs=opus", "recording.ogg"],
  ])("preserves supported %s audio through upload", async (supported, fileName) => {
    class Recorder {
      static isTypeSupported = (type: string) => type === supported;
      mimeType: string;
      constructor(readonly stream: MediaStream, options?: MediaRecorderOptions) {
        this.mimeType = options?.mimeType ?? "";
      }
    }
    vi.stubGlobal("MediaRecorder", Recorder);
    const recorder = createAudioRecorder({} as MediaStream);
    expect(recorder.mimeType).toBe(supported);
    expect(audioRecordingFileName(recorder.mimeType)).toBe(fileName);
    const blob = new Blob(["recording"], { type: recorder.mimeType });
    const upload = await normalizeASRUploadAudio("openai", blob);
    expect(upload).toEqual({ blob, fileName });
  });

  it("lets the browser choose its default when preferred containers are unsupported", () => {
    const constructor = vi.fn();
    class Recorder {
      static isTypeSupported = () => false;
      constructor(...args: unknown[]) { constructor(...args); }
    }
    vi.stubGlobal("MediaRecorder", Recorder);
    const stream = {} as MediaStream;
    createAudioRecorder(stream);
    expect(constructor).toHaveBeenCalledWith(stream);
  });
});
